import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
function checkedPath(root, parts) {
  let current = path.resolve(root)
  if (!fs.existsSync(current) || fs.lstatSync(current).isSymbolicLink()) throw new Error('Recovery root is missing or unsafe.')
  for (const part of parts) {
    current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Recovery refuses symbolic links.')
  }
  return current
}
function inventory(root) {
  const files = []
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Recovery refuses symbolic links.')
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) files.push({ relative: path.relative(root, file), digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })
      else throw new Error('Recovery refuses nonregular session files.')
    }
  }
  visit(root)
  return files
}

/** Offline, opt-in recovery. Does not read .env, modify SQLite, or start sockets. */
export function recoverMissingSessions({ root, backupRoot, apply = false, stopped = false }) {
  if (apply && !stopped) throw new Error('Stop the application before applying recovery.')
  root = path.resolve(root)
  backupRoot = path.resolve(backupRoot)
  if (root === backupRoot) throw new Error('Use a separate private backup directory.')
  const metadata = checkedPath(root, ['accounts.json'])
  const savedMetadata = checkedPath(backupRoot, ['accounts.json'])
  const current = JSON.parse(fs.readFileSync(metadata, 'utf8'))
  const saved = JSON.parse(fs.readFileSync(savedMetadata, 'utf8'))
  if (!Array.isArray(current) || !Array.isArray(saved)) throw new Error('Invalid account metadata.')
  const plans = []
  let skippedExisting = 0
  for (const account of current) {
    if (!uuid.test(account.id || '') || !uuid.test(account.ownerId || '')) throw new Error('Invalid account storage identity.')
    const generation = account.authGeneration || ''
    if (generation && !uuid.test(generation)) throw new Error('Invalid authentication generation.')
    const suffix = generation ? ['sessions', generation, 'auth'] : ['auth']
    const parts = ['accounts', account.ownerId, account.id, ...suffix]
    const target = checkedPath(root, parts)
    if (fs.existsSync(target)) { skippedExisting++; continue }
    const old = saved.find(item => item.id === account.id && item.ownerId === account.ownerId)
    if (!old || (old.authGeneration || '') !== generation) throw new Error('Backup identity or authentication generation does not match.')
    const source = checkedPath(backupRoot, parts)
    if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory()) throw new Error('Matching backup session is missing.')
    const files = inventory(source)
    const credentials = checkedPath(source, ['creds.json'])
    if (JSON.parse(fs.readFileSync(credentials, 'utf8')).registered !== true) throw new Error('Backup has no registered WhatsApp session.')
    plans.push({ account, source, target, files })
  }
  const summary = { planned: plans.length, restored: 0, skippedExisting, files: plans.reduce((total, p) => total + p.files.length, 0) }
  if (!apply || !plans.length) return summary
  process.umask(0o077)
  // Keep the latest metadata privately before changing reconnect flags.
  const recoveryRoot = checkedPath(root, ['accounts'])
  fs.mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 })
  const metadataBackup = path.join(recoveryRoot, `metadata-before-recovery-${crypto.randomUUID()}.json`)
  fs.copyFileSync(metadata, metadataBackup, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(metadataBackup, 0o600)
  for (const plan of plans) {
    const parent = path.dirname(plan.target)
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    const staging = path.join(parent, `.auth-recovery-${crypto.randomUUID()}`)
    fs.mkdirSync(staging, { mode: 0o700 })
    for (const file of plan.files) {
      const destination = path.join(staging, file.relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(path.join(plan.source, file.relative), destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, 0o600)
      const digest = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
      if (digest !== file.digest) throw new Error('Restored session verification failed; staged files preserved.')
    }
    if (fs.existsSync(plan.target)) throw new Error('Session appeared during recovery; refusing to overwrite it.')
    fs.renameSync(staging, plan.target)
    Object.assign(plan.account, { status: 'disconnected', requiresPairing: false, autoConnect: true, updatedAt: new Date().toISOString() })
    summary.restored++
  }
  const temporary = metadata + '.' + crypto.randomUUID() + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(current, null, 2), { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, metadata)
  return summary
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = name => args[args.indexOf(name) + 1]
  try {
    if (!args.includes('--backup') || !value('--backup')) throw new Error('Specify the private backup data directory with --backup.')
    console.log(JSON.stringify(recoverMissingSessions({ root: args.includes('--root') ? value('--root') : process.cwd(), backupRoot: value('--backup'), apply: args.includes('--apply'), stopped: args.includes('--stopped') })))
  } catch (error) {
    // Errors contain no paths, credentials, phone numbers or account identifiers.
    console.error('Recovery refused or failed. Check the private backup and storage permissions; no existing session was overwritten.')
    process.exitCode = 1
  }
}
