import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
export const sandboxRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'WhatsAppBot', 'command-sandbox', hash(repository))
const endpoint = root => process.platform === 'win32' ? `\\\\.\\pipe\\whatsapp-command-sandbox-${hash(root)}` : path.join(root, 'control.sock')
const stateFile = root => path.join(root, 'process.json')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

export function prepareSandbox({ root = sandboxRoot, source = repository, environment = process.env } = {}) {
  root = path.resolve(root); source = path.resolve(source)
  const relative = path.relative(source, root)
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw Error('Sandbox data must be outside the repository.')
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw Error('Sandbox data cannot use a symbolic link.')
  const markerFile = path.join(root, 'sandbox.json')
  if (fs.existsSync(root) && fs.readdirSync(root).length && !fs.existsSync(markerFile)) throw Error('Refusing to use a directory that is not an initialized command sandbox.')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(markerFile)) fs.writeFileSync(markerFile, JSON.stringify({ kind: 'whatsapp-command-sandbox', version: 1, source }), { mode: 0o600, flag: 'wx' })
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  if (marker.kind !== 'whatsapp-command-sandbox' || marker.source !== source) throw Error('The sandbox belongs to another project.')
  if (fs.existsSync(path.join(root, '.env'))) throw Error('This isolated sandbox does not load .env files.')
  const config = path.join(root, 'messages.json')
  if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify({ timezone: 'Africa/Lagos', delaySeconds: [5, 15], statusRecipients: [], groupLists: {}, jobs: [] }, null, 2), { mode: 0o600, flag: 'wx' })
  const temp = path.join(root, 'temp')
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 })
  // Deliberately omit AWS, SMTP, TLS, dashboard credentials, NODE_OPTIONS and
  // all production settings. Only basic OS variables cross the boundary.
  const env = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) if (environment[key]) env[key] = environment[key]
  Object.assign(env, { AUTH_DATABASE_PATH: path.join(root, 'auth.sqlite'), DASHBOARD_HOST: '127.0.0.1', TEMP: temp, TMP: temp, TMPDIR: temp })
  return { root, source, env }
}

export async function choosePort(first = 3001) {
  for (let port = first; port < first + 10; port++) {
    const free = await new Promise(resolve => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw Error('No free local sandbox port is available. Existing processes were left running.')
}

export async function controlSandbox(action, root = sandboxRoot) {
  if (!['status', 'stop'].includes(action)) throw Error('Unknown sandbox action.')
  if (!fs.existsSync(stateFile(root))) return { running: false }
  const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'))
  if (!Number.isInteger(state.pid) || !alive(state.pid)) return { running: false }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint(root)); let reply = ''
    socket.setTimeout(3000, () => socket.destroy(Error('Sandbox control timed out.')))
    socket.on('error', reject)
    socket.on('connect', () => socket.end(JSON.stringify({ action, nonce: state.nonce }) + '\n'))
    socket.on('data', chunk => { reply += chunk; if (reply.length > 4096) socket.destroy(Error('Invalid sandbox control response.')) })
    socket.on('end', () => { try { resolve(JSON.parse(reply)) } catch { reject(Error('Invalid sandbox control response.')) } })
  })
}

export async function runSandbox(options = {}) {
  const prepared = prepareSandbox(options), { root, source, env } = prepared
  if (fs.existsSync(stateFile(root))) {
    const previous = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'))
    if (Number.isInteger(previous.pid) && alive(previous.pid)) throw Error('The local sandbox is already running. Use npm run sandbox:status to see its URL.')
    fs.unlinkSync(stateFile(root))
  }
  const nonce = crypto.randomBytes(32).toString('hex')
  // Exclusive creation prevents a second bot process from opening this data.
  fs.writeFileSync(stateFile(root), JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 })
  let child, server, ready = false, stopping = false, logFile
  const stopChild = () => { if (!stopping && child?.connected) { stopping = true; child.send('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 30000); timer.unref(); child.once('exit', () => clearTimeout(timer)) } }
  const interrupt = () => stopChild()
  try {
    const port = await choosePort(options.firstPort || 3001), url = `http://localhost:${port}`
    env.DASHBOARD_PORT = String(port); env.PUBLIC_BASE_URL = url
    logFile = fs.openSync(path.join(root, 'application.log'), 'a', 0o600)
    const signalHook = Buffer.from("process.on('message', signal => { if(signal === 'SIGTERM' || signal === 'SIGINT') process.emit(signal) })").toString('base64')
    child = spawn(process.execPath, ['--import', `data:text/javascript;base64,${signalHook}`, path.join(source, 'bot.js')], { cwd: root, env, windowsHide: true, stdio: ['ignore', logFile, logFile, 'ipc'] })
    let childError
    const exited = new Promise(resolve => { child.once('exit', code => resolve(code)); child.once('error', error => { childError = error; resolve(-1) }) })
    fs.writeFileSync(stateFile(root), JSON.stringify({ pid: process.pid, childPid: child.pid, nonce, url, port }), { mode: 0o600 })
    const socketPath = endpoint(root)
    if (process.platform !== 'win32' && fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
    server = net.createServer(socket => {
      let input = ''
      socket.setTimeout(3000, () => socket.destroy()); socket.on('error', () => {})
      socket.on('data', chunk => {
        input += chunk; if (input.length > 2048) { socket.destroy(); return }
        if (!input.includes('\n')) return
        try {
          const request = JSON.parse(input.trim())
          if (request.nonce !== nonce || !['status', 'stop'].includes(request.action)) { socket.end(JSON.stringify({ error: 'Invalid local control request.' })); return }
          socket.end(JSON.stringify({ running: child.exitCode === null && child.signalCode === null, ready, url, dataDirectory: root }))
          if (request.action === 'stop') stopChild()
        } catch { socket.destroy() }
      })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600)
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !childError) {
      try { if ((await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(1000) })).status === 200) { ready = true; break } } catch {}
      await pause(100)
    }
    if (!ready) throw Error('The isolated dashboard did not start. Check its private application.log; no production process was changed.')
    console.log(`Isolated command dashboard ready: ${url}/`)
    const code = await exited
    if (code !== 0 && !stopping) throw Error('The sandbox application stopped unexpectedly.')
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
    stopChild()
    if (child && child.exitCode === null && child.signalCode === null && child.pid && !childError) await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 31000).unref() })
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (logFile !== undefined) fs.closeSync(logFile)
    if (fs.existsSync(stateFile(root)) && JSON.parse(fs.readFileSync(stateFile(root), 'utf8')).nonce === nonce) fs.unlinkSync(stateFile(root))
    // Accounts, SQLite, media and spare-account auth are intentionally retained.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || 'start'
  try {
    if (action === 'start') await runSandbox()
    else if (['status', 'stop'].includes(action)) {
      const result = await controlSandbox(action)
      console.log(result.running ? (action === 'stop' ? 'Stopping only the local command sandbox; test data is preserved.' : `${result.ready ? 'Ready' : 'Starting'}: ${result.url}/`) : 'The local command sandbox is not running.')
    } else throw Error('Use start, status or stop.')
  } catch (error) { console.error(error instanceof SyntaxError ? 'The local sandbox metadata is invalid. Test data was preserved.' : error.message); process.exitCode = 1 }
}
