import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const privateItems = ['.env', 'accounts.json', 'accounts', 'auth', 'messages.local.json', 'messages.json', 'images', 'uploads', 'groups.txt']
const defaults = { maxRounds: 4, maxFileAttempts: 4, maxInventoryAttempts: 3, retryDelayMs: 100, maxDurationMs: 300000 }
const retryable = error => ['ENOENT', 'ESTALE', 'EBUSY', 'file_changed', 'invalid_json'].includes(error.code)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
export class BackupError extends Error {
  constructor(code) { super('Production backup could not be verified (' + code + ').'); this.code = code }
}
function processState(source) {
  const apps = JSON.parse(execFileSync('pm2', ['jlist'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).filter(app => app.name === 'whatsapp-bot')
  if (apps.length !== 1 || apps[0].pm2_env.status !== 'online') throw new BackupError('pm2_not_online')
  return { pid: apps[0].pid, cwd: apps[0].pm2_env.pm_cwd, database: apps[0].pm2_env.AUTH_DATABASE_PATH || 'auth.sqlite' }
}
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function regular(file) {
  const stat = fs.lstatSync(file, { bigint: true })
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new BackupError('unsafe_storage')
  return stat
}
function noSymlinkParents(file) {
  let current = path.resolve(file)
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new BackupError('unsafe_storage')
    const parent = path.dirname(current); if (parent === current) break; current = parent
  }
}
function inventory(source, check) {
  const files = Object.create(null), directories = Object.create(null), roots = Object.create(null)
  const visit = file => {
    check(); const stat = regular(file), name = path.relative(source, file)
    if (stat.isDirectory()) {
      const before = version(stat)
      for (const entry of fs.readdirSync(file).sort()) visit(path.join(file, entry))
      if (version(regular(file)) !== before) throw new BackupError('file_changed')
      directories[name] = before
    } else files[name] = { version: version(stat), bytes: Number(stat.size) }
  }
  for (const name of privateItems) {
    const file = path.join(source, name)
    try { roots[name] = regular(file).isDirectory() ? 'directory' : 'file' }
    catch (error) { if (error.code !== 'ENOENT') throw error; roots[name] = 'absent'; continue }
    visit(file)
  }
  return { files, directories, roots }
}
function digest(file, check = () => {}) {
  const hash = crypto.createHash('sha256'), descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), block = Buffer.alloc(65536)
  try { let bytes; while ((bytes = fs.readSync(descriptor, block)) > 0) { check(); hash.update(block.subarray(0, bytes)) } return hash.digest('hex') }
  finally { fs.closeSync(descriptor) }
}
function validateJson(file, name = file) {
  if (!name.endsWith('.json')) return
  if (fs.statSync(file).size > 32 * 1024 * 1024) throw new BackupError('json_too_large')
  try { JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new BackupError('invalid_json') }
}
function copyStable(source, data, name, check) {
  const original = path.join(source, name), target = path.join(data, name)
  const temporary = target + '.copy-' + crypto.randomBytes(8).toString('hex')
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  let input, output
  try {
    check(); const before = regular(original)
    if (!before.isFile()) throw new BackupError('file_changed')
    input = fs.openSync(original, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    if (version(fs.fstatSync(input, { bigint: true })) !== version(before)) throw new BackupError('file_changed')
    output = fs.openSync(temporary, 'wx', 0o600)
    const hash = crypto.createHash('sha256'), block = Buffer.alloc(65536); let bytes = 0, count
    while ((count = fs.readSync(input, block)) > 0) {
      check(); hash.update(block.subarray(0, count)); bytes += count
      let written = 0; while (written < count) { check(); written += fs.writeSync(output, block, written, count - written) }
    }
    fs.closeSync(output); output = undefined
    if (version(fs.fstatSync(input, { bigint: true })) !== version(before) || version(regular(original)) !== version(before) || bytes !== Number(before.size)) throw new BackupError('file_changed')
    validateJson(temporary, name)
    const sha256 = hash.digest('hex')
    if (digest(temporary, check) !== sha256) throw new BackupError('copy_hash_mismatch')
    fs.renameSync(temporary, target)
    return { version: version(before), bytes, sha256 }
  } finally {
    if (input !== undefined) fs.closeSync(input)
    if (output !== undefined) fs.closeSync(output)
    // Only our temporary copy in this fresh backup is removed.
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
function matches(scan, files, baseline) {
  return same(scan.directories, baseline.directories) && same(scan.roots, baseline.roots) && Object.keys(scan.files).length === Object.keys(files).length && Object.entries(scan.files).every(([name, value]) => files[name]?.version === value.version)
}
function pruneCopies(data, files, directories) {
  const visit = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new BackupError('unsafe_storage')
    if (entry.isDirectory()) { visit(file); if (!Object.hasOwn(directories, path.relative(data, file))) fs.rmdirSync(file) }
    else if (!Object.hasOwn(files, path.relative(data, file))) fs.unlinkSync(file)
  } }
  visit(data)
}
function verifyCopies(data, files, check) {
  for (const [name, expected] of Object.entries(files)) {
    check(); const file = path.join(data, name), stat = regular(file)
    if (!stat.isFile() || Number(stat.size) !== expected.bytes || digest(file, check) !== expected.sha256) throw new BackupError('copy_hash_mismatch')
    validateJson(file)
  }
}
function sqliteIntegrity(file) {
  const saved = new DatabaseSync(file, { readOnly: true })
  try { if (Object.values(saved.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new BackupError('sqlite_integrity_failed') } finally { saved.close() }
}
export function verifyPredeploymentBackup(directory, { check = () => {}, requireMarker = true } = {}) {
  directory = path.resolve(directory); noSymlinkParents(directory)
  if (requireMarker && !fs.existsSync(path.join(directory, 'VERIFIED'))) throw new BackupError('backup_not_verified')
  const manifestFile = path.join(directory, 'manifest.json'); regular(manifestFile)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), data = path.join(directory, 'data')
  if (manifest.format !== 2 || !manifest.liveFileSnapshotVerified || !Array.isArray(manifest.directories)) throw new BackupError('invalid_manifest')
  for (const name of [...Object.keys(manifest.files), ...manifest.directories]) {
    if (!name || path.isAbsolute(name) || path.relative(data, path.resolve(data, name)) !== name || name === 'auth.sqlite') throw new BackupError('invalid_manifest')
  }
  for (const name of manifest.directories) { noSymlinkParents(path.join(data, name)); if (!regular(path.join(data, name)).isDirectory()) throw new BackupError('invalid_manifest') }
  verifyCopies(data, manifest.files, check)
  const sqliteCopy = path.join(data, 'auth.sqlite'); noSymlinkParents(sqliteCopy)
  if (digest(sqliteCopy, check) !== manifest.sqliteSha256) throw new BackupError('copy_hash_mismatch')
  sqliteIntegrity(sqliteCopy)
  let count = 0; const expectedDirectories = new Set(manifest.directories), actualDirectories = new Set()
  const visit = dir => { for (const name of fs.readdirSync(dir)) { check(); const file = path.join(dir, name), stat = regular(file)
    if (process.platform !== 'win32' && (Number(stat.mode) & 0o077)) throw new BackupError('unsafe_backup_permissions')
    if (stat.isDirectory()) { if (file !== data) { const relative = path.relative(data, file); if (!expectedDirectories.has(relative)) throw new BackupError('unexpected_backup_file'); actualDirectories.add(relative) } visit(file) }
    else if (dir === directory) { if (!['manifest.json', 'VERIFIED'].includes(name)) throw new BackupError('unexpected_backup_file') }
    else { const relative = path.relative(data, file); if (relative !== 'auth.sqlite' && !Object.hasOwn(manifest.files, relative)) throw new BackupError('unexpected_backup_file'); count++ }
  } }
  if (process.platform !== 'win32' && (fs.statSync(directory).mode & 0o077)) throw new BackupError('unsafe_backup_permissions')
  visit(directory)
  if (count !== Object.keys(manifest.files).length + 1 || actualDirectories.size !== expectedDirectories.size) throw new BackupError('invalid_manifest')
  return { backupVerified: true, sqliteIntegrity: 'ok', privateFiles: Object.keys(manifest.files).length }
}
export async function createPredeploymentBackup({ source = '/home/ec2-user/whatsapp-bot', backups = '/home/ec2-user/.whatsapp-bot-backups', readProcessState = processState, limits = {}, onProgress = () => {} } = {}) {
  const options = { ...defaults, ...limits }
  for (const [key, value] of Object.entries(options)) if (!Number.isInteger(value) || value < (key === 'retryDelayMs' ? 0 : 1) || value > ({ maxRounds: 8, maxFileAttempts: 8, maxInventoryAttempts: 8, retryDelayMs: 2000, maxDurationMs: 480000 }[key] || 0)) throw new BackupError('invalid_limits')
  const deadline = Date.now() + options.maxDurationMs, check = () => { if (Date.now() >= deadline) throw new BackupError('deadline_exceeded') }
  const counters = { fileRetries: 0, inventoryRetries: 0, rounds: 0, copiedFiles: 0 }
  const emit = phase => onProgress({ phase, ...counters })
  const scan = async () => { for (let attempt = 0; attempt < options.maxInventoryAttempts; attempt++) {
    try { return inventory(source, check) } catch (error) { if (!retryable(error)) throw error; counters.inventoryRetries++; emit('retrying-inventory'); await wait(options.retryDelayMs) }
  } throw new BackupError('live_files_changing') }
  const previousUmask = process.umask(0o077)
  try {
    source = path.resolve(source); backups = path.resolve(backups); noSymlinkParents(source); noSymlinkParents(backups)
    const relative = path.relative(source, backups)
    if (!fs.existsSync(source) || !regular(source).isDirectory() || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new BackupError('unsafe_storage')
    const before = readProcessState(source)
    if (path.resolve(before.cwd) !== source) throw new BackupError('unexpected_pm2_checkout')
    const database = path.resolve(source, before.database); noSymlinkParents(database)
    if (!regular(database).isFile()) throw new BackupError('invalid_database')
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 }); fs.chmodSync(backups, 0o700)
    const directory = path.join(backups, 'predeployment-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(directory, { mode: 0o700 }); const data = path.join(directory, 'data'); fs.mkdirSync(data, { mode: 0o700 })
    emit('scanning'); let baseline = await scan()
    const disk = fs.statfsSync(backups), required = Object.values(baseline.files).reduce((sum, file) => sum + file.bytes, 0) * 2 + fs.statSync(database).size * 2 + 128 * 1024 * 1024
    if (disk.bavail * disk.bsize < required) throw new BackupError('insufficient_disk_space')
    const files = Object.create(null); let lastFailure = 'live_files_changing', lastProgress = Date.now()
    for (let round = 0; round < options.maxRounds; round++) {
      check(); counters.rounds++; if (round) baseline = await scan(); emit('copying')
      for (const name of Object.keys(baseline.directories)) fs.mkdirSync(path.join(data, name), { recursive: true, mode: 0o700 })
      for (const name of Object.keys(files)) if (!Object.hasOwn(baseline.files, name)) delete files[name]
      for (const [name, metadata] of Object.entries(baseline.files)) {
        if (files[name]?.version === metadata.version) continue
        for (let attempt = 0; attempt < options.maxFileAttempts; attempt++) {
          try { files[name] = copyStable(source, data, name, check); counters.copiedFiles++; break }
          catch (error) { if (!retryable(error)) throw error; lastFailure = error.code === 'invalid_json' ? 'invalid_json' : 'live_files_changing'; counters.fileRetries++; emit('retrying-file'); await wait(options.retryDelayMs * (attempt + 1)) }
        }
        if (Date.now() - lastProgress > 10000) { emit('copying'); lastProgress = Date.now() }
      }
      emit('checking-consistency'); const observed = await scan()
      if (!matches(observed, files, baseline)) { await wait(options.retryDelayMs); continue }
      // Only stale files inside this newly-created backup are removed.
      pruneCopies(data, files, baseline.directories)
      const sqliteCopy = path.join(data, 'auth.sqlite'), live = new DatabaseSync(database, { readOnly: true })
      emit('backing-up-sqlite')
      try { await sqliteBackup(live, sqliteCopy, { rate: 512, progress: check }) } finally { live.close() }
      // Make the private SQLite copy self-contained; never checkpoint the live DB.
      const saved = new DatabaseSync(sqliteCopy)
      try { saved.exec('PRAGMA journal_mode=DELETE') } finally { saved.close() }
      fs.chmodSync(sqliteCopy, 0o600); sqliteIntegrity(sqliteCopy)
      emit('checking-consistency'); const finalScan = await scan()
      if (!matches(finalScan, files, observed)) continue
      const unchanged = () => {
        const after = readProcessState(source)
        if (after.pid !== before.pid || after.cwd !== before.cwd || after.database !== before.database) throw new BackupError('pm2_process_changed')
        return after
      }
      const after = unchanged()
      const manifest = { format: 2, createdAt: new Date().toISOString(), source, productionPid: after.pid, sqliteSource: database, sqliteIntegrity: 'ok', sqliteSha256: digest(sqliteCopy, check), files, directories: Object.keys(finalScan.directories), liveFileSnapshotVerified: true, mode: 'online-predeployment', counters }
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
      emit('verifying-manifest'); verifyPredeploymentBackup(directory, { check, requireMarker: false }); unchanged()
      // VERIFIED is the last write. Failed/interrupted runs never create it.
      fs.writeFileSync(path.join(directory, 'VERIFIED'), 'SQLite, JSON, file versions, membership and SHA-256 verified.\n', { mode: 0o600 })
      emit('verified')
      return { backupVerified: true, backupDirectory: directory, sqliteIntegrity: 'ok', privateFiles: Object.keys(files).length, pm2: 'online', pidUnchanged: true, counters }
    }
    throw new BackupError(lastFailure)
  } finally { process.umask(previousUmask) }
}
if (process.argv[1] === '-' || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(await createPredeploymentBackup({ onProgress: event => console.log(JSON.stringify({ backupProgress: event })) }))) }
  catch (error) { console.log(JSON.stringify({ backupVerified: false, reasonCode: error instanceof BackupError ? error.code : 'backup_io_failed', productionModified: false })); process.exitCode = 1 }
}
