import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const settingsPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'WhatsAppBot', 'ssm-tools', 'config.json')
if (!fs.existsSync(settingsPath)) throw new Error('Session Manager local configuration is missing. Complete the local setup first.')
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
const environment = { ...process.env, PATH: settings.pluginBin + path.delimiter + process.env.PATH, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' }
const ssh = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe') : 'ssh'
const action = process.argv[2] || 'check'

function aws(args) {
  const result = spawnSync(settings.awsPath, [...args, '--profile', settings.profile, '--region', settings.region, '--no-cli-pager'], {
    env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1048576
  })
  if (result.status !== 0) {
    if (/AccessDenied|not authorized/i.test(result.stderr || '')) throw new Error('AWS denied this operation. The signed-in identity needs the corresponding Session Manager permissions.')
    throw new Error('AWS authentication or connectivity failed. Run the AWS: Sign in task and try again.')
  }
  return JSON.parse(result.stdout)
}

function check() {
  aws(['sts', 'get-caller-identity'])
  const nodes = aws(['ssm', 'describe-instance-information', '--filters', 'Key=InstanceIds,Values=' + settings.instanceId])
  const node = nodes.InstanceInformationList.find(item => item.InstanceId === settings.instanceId)
  if (node?.PingStatus !== 'Online') throw new Error('The instance is not Online in Systems Manager. Check its instance role, SSM Agent and outbound HTTPS access.')
  console.log(JSON.stringify({ authenticated: true, region: settings.region, instanceId: settings.instanceId, systemsManager: node.PingStatus, agentVersion: node.AgentVersion }))
}

function sshScript(script) {
  const result = spawnSync(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', settings.sshHost, 'bash -s'], {
    env: environment, input: script.replace(/\r/g, ''), encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 1048576
  })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) throw new Error('The SSH connection through Session Manager failed. No direct-IP fallback was attempted.')
}

try {
if (action === 'login') {
  console.log('Complete AWS sign-in in the browser. No passwords, access keys or authentication URLs will be printed here.')
  const child = spawn(settings.awsPath, ['login', '--profile', settings.profile, '--region', settings.region, '--no-cli-pager'], {
    env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })
  let loginOutput = '', answered = false
  const inspectLogin = chunk => {
    // Keep URLs/tokens and CLI diagnostic details out of user-visible logs.
    loginOutput = (loginOutput + chunk).slice(-16000)
    if (!answered && /Do you want to overwrite[\s\S]*\(y\/n\)/i.test(loginOutput)) {
      answered = true
      const identities = [...loginOutput.matchAll(/arn:aws:(?:iam|sts)::(\d{12}):[^\s]+/g)].map(match => match[1])
      if (identities.length >= 2 && identities.every(account => account === identities[0])) {
        console.log('Updating the local sign-in profile to the identity selected in the same AWS account.')
        child.stdin.write('y\n')
      } else { child.stdin.write('n\n'); console.log('The selected sign-in belongs to a different AWS account; the existing local profile was preserved.') }
    }
  }
  child.stdout.on('data', inspectLogin)
  child.stderr.on('data', inspectLogin)
  child.on('error', () => { console.error('AWS browser sign-in could not start.'); process.exitCode = 1 })
  child.on('close', code => {
    console.log(code === 0 ? 'AWS sign-in completed.' : /AccessDenied|not authorized/i.test(loginOutput) ? 'AWS denied the local sign-in request. Check SignInLocalDevelopmentAccess permissions.' : /expired|timed out|timeout/i.test(loginOutput) ? 'AWS sign-in timed out before authorization completed.' : 'AWS sign-in failed. Check the browser for its error message.')
    process.exitCode = code === 0 ? 0 : 1
  })
} else if (action === 'connect') {
  check()
  const child = spawn(ssh, [settings.sshHost], { env: environment, stdio: 'inherit' })
  child.on('error', () => { console.error('Session Manager SSH could not start.'); process.exitCode = 1 })
  child.on('close', code => { process.exitCode = code ?? 1 })
} else if (action === 'check' || action === 'deploy' || action === 'preflight' || action === 'backup') {
  check()
  if (action === 'backup') {
    const backup = fs.readFileSync(path.join(root, 'deploy', 'ssm-predeployment-backup.js'), 'utf8')
    sshScript('set -eu\nexport PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"\nnode --input-type=module - <<\'BACKUP_NODE\'\n' + backup + '\nBACKUP_NODE\n')
  } else if (action === 'deploy' || action === 'preflight') {
    // Preflight verifies deployment access without stopping or restarting PM2.
    const script = fs.readFileSync(path.join(root, 'deploy', 'ssm-deploy.sh'), 'utf8')
    sshScript((action === 'preflight' ? 'set -- --check\n' : '') + script)
  } else {
    sshScript(`set -eu
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
cd /home/ec2-user/whatsapp-bot
node --input-type=module <<'NODE'
import cp from 'node:child_process';
import assert from 'node:assert/strict';
const apps=JSON.parse(cp.execFileSync('pm2',['jlist'],{encoding:'utf8'})).filter(a=>a.name==='whatsapp-bot');
assert.equal(apps.length,1,'Expected one WhatsApp bot process');
assert.equal(apps[0].pm2_env.status,'online','WhatsApp bot must be online');
console.log(JSON.stringify({transport:'SSH over Session Manager',pm2:'online',pid:apps[0].pid,commit:cp.execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim()}));
NODE
curl --silent --fail --max-time 5 --output /dev/null --write-out 'Local dashboard: %{http_code}\\n' http://127.0.0.1:3000/login
`)
  }
} else {
  throw new Error('Use login, check, connect, preflight, backup or deploy.')
}
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
