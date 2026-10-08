import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const root = path.resolve('accounts')
const defaults = () => ({
  revision: 0, timezone: 'Africa/Lagos', delaySeconds: [5, 15], statusRecipients: [], recipients: [],
  groupLists: {}, messages: [], jobs: []
})

function fileFor(accountId) {
  const id = String(accountId)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid account ID.')
  const accountDir = path.resolve(root, id)
  if (!accountDir.startsWith(root + path.sep)) throw new Error('Invalid account storage path.')
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Account storage root cannot be a symbolic link.')
  if (fs.existsSync(accountDir) && fs.lstatSync(accountDir).isSymbolicLink()) throw new Error('Account storage directory cannot be a symbolic link.')
  const file = path.join(accountDir, 'automation.json')
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Account automation data cannot be a symbolic link.')
  return file
}

export function loadAutomation(accountId, legacy = {}) {
  const file = fileFor(accountId)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (fs.existsSync(file)) {
    try { return { ...defaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } }
    catch { throw new Error('Account automation data is corrupt. Repair its local automation.json file.') }
  }
  const data = { ...defaults(), ...legacy }
  const migratedJobs = []
  const messages = []
  for (const [i, old] of (legacy.jobs || []).entries()) {
    const messageId = crypto.randomUUID()
    messages.push({ id: messageId, name: old.name || `Message ${i + 1}`, texts: Array.isArray(old.texts) ? old.texts : [old.text || ''], media: old.media || old.image || '', createdAt: new Date().toISOString() })
    migratedJobs.push({ ...old, id: crypto.randomUUID(), messageId, repeatCount: 1, delaySeconds: legacy.delaySeconds || [5, 15], status: old.enabled === false ? 'paused' : 'scheduled', progress: 0, completed: 0, createdAt: new Date().toISOString(), scheduledAt: old.cron || '' })
  }
  if (migratedJobs.length) { data.messages = messages; data.jobs = migratedJobs }
  saveAutomation(accountId, data)
  return data
}

export function saveAutomation(accountId, data) {
  data.revision = (Number.isSafeInteger(data.revision) ? data.revision : 0) + 1
  const file = fileFor(accountId)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  const descriptor = fs.openSync(tmp, 'wx', 0o600)
  try { fs.writeFileSync(descriptor, JSON.stringify(data, null, 2)); fs.fsyncSync(descriptor) }
  finally { fs.closeSync(descriptor) }
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) { fs.rmSync(tmp, { force: true }); throw new Error('Account automation data cannot be a symbolic link.') }
  fs.renameSync(tmp, file)
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  }
}

export function makeId() { return crypto.randomUUID() }

export function loadGroupSnapshot(accountId) {
  const file = path.join(path.dirname(fileFor(accountId)), 'groups.json')
  if (!fs.existsSync(file)) return { groups: [], syncedAt: null }
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid group storage file.')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(saved.groups)) throw new Error('Invalid saved group snapshot.')
  return { groups: saved.groups.filter(g => typeof g.id === 'string' && typeof g.subject === 'string').map(({ id, subject }) => ({ id, subject })), syncedAt: saved.syncedAt || null }
}
export function saveGroupSnapshot(accountId, groups) {
  const file = path.join(path.dirname(fileFor(accountId)), 'groups.json')
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid group storage file.')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const snapshot = { groups, syncedAt: new Date().toISOString() }, tmp = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
  return snapshot
}
