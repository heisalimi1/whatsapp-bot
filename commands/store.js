import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { COMMANDS, COMMAND_BY_NAME } from './catalog.js'
import { accountDefaults, groupDefaults, validateAccountSettings, validateGroupSettings, groupJid, userJid } from './settings.js'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export function createCommandStore(databasePath, { now = Date.now } = {}) {
  const file = path.resolve(databasePath)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('Command database cannot be a symbolic link.')
  const db = new DatabaseSync(file)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_command_settings(workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,revision INTEGER NOT NULL,config TEXT NOT NULL,PRIMARY KEY(workspace_id,account_id));
    CREATE TABLE IF NOT EXISTS bot_group_settings(workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,group_jid TEXT NOT NULL,config TEXT NOT NULL,PRIMARY KEY(workspace_id,account_id,group_jid));
    CREATE TABLE IF NOT EXISTS bot_warnings(workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,group_jid TEXT NOT NULL,member_jid TEXT NOT NULL,count INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,account_id,group_jid,member_jid));
    CREATE TABLE IF NOT EXISTS bot_command_receipts(workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,event_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,account_id,event_hash));
    CREATE INDEX IF NOT EXISTS bot_receipts_expiry ON bot_command_receipts(created_at);
    CREATE TABLE IF NOT EXISTS bot_command_statistics(workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,command TEXT NOT NULL,successes INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workspace_id,account_id,command));
    CREATE TABLE IF NOT EXISTS bot_welcome_receipts(workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,group_jid TEXT NOT NULL,member_jid TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,account_id,group_jid,member_jid));
    CREATE TABLE IF NOT EXISTS bot_broadcast_confirmations(workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,token_hash TEXT NOT NULL,chat TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,account_id,token_hash));
  `)
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,?)').run(now())
  const scope = (workspaceId, accountId) => { if (!uuid.test(workspaceId || '') || !uuid.test(accountId || '')) throw Error('Invalid command account scope.'); return [workspaceId, accountId] }
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e } }
  function settings(w, a) {
    const row = db.prepare('SELECT revision,config FROM bot_command_settings WHERE workspace_id=? AND account_id=?').get(...scope(w, a))
    const defaults = accountDefaults(), stored = row ? JSON.parse(row.config) : defaults
    // Project only current commands without rewriting existing database records.
    // Old saved settings remain usable after catalog entries are retired.
    const commands = Object.fromEntries(COMMANDS.map(c => [c.name, stored.commands?.[c.name] || defaults.commands[c.name]]))
    return { revision: row?.revision || 0, config: { ...defaults, ...stored, commands } }
  }
  function saveSettings(w, a, config, revision) {
    const value = validateAccountSettings(config)
    return transaction(() => {
      const current = settings(w, a)
      if (!Number.isSafeInteger(revision) || current.revision !== revision) { const e = Error('Command settings changed on another device. Reload before saving.'); e.status = 409; throw e }
      db.prepare('INSERT INTO bot_command_settings VALUES(?,?,?,?) ON CONFLICT(workspace_id,account_id) DO UPDATE SET revision=excluded.revision,config=excluded.config').run(...scope(w, a), revision + 1, JSON.stringify(value))
      return { revision: revision + 1, config: value }
    })
  }
  const group = (w, a, jid) => {
    if (!groupJid(jid)) throw Error('Invalid group identifier.')
    const row = db.prepare('SELECT config FROM bot_group_settings WHERE workspace_id=? AND account_id=? AND group_jid=?').get(...scope(w, a), jid)
    return { ...groupDefaults(), ...(row ? JSON.parse(row.config) : {}) }
  }
  const saveGroup = (w, a, jid, config, revision) => transaction(() => {
    if (!groupJid(jid)) throw Error('Invalid group identifier.')
    const current = settings(w, a)
    if (revision !== undefined && revision !== current.revision) { const e = Error('Group settings changed on another device. Reload before saving.'); e.status = 409; throw e }
    const value = validateGroupSettings(config)
    db.prepare('INSERT INTO bot_group_settings VALUES(?,?,?,?) ON CONFLICT(workspace_id,account_id,group_jid) DO UPDATE SET config=excluded.config').run(...scope(w, a), jid, JSON.stringify(value))
    db.prepare('INSERT INTO bot_command_settings VALUES(?,?,?,?) ON CONFLICT(workspace_id,account_id) DO UPDATE SET revision=excluded.revision').run(...scope(w, a), current.revision + 1, JSON.stringify(current.config))
    return value
  })
  function warn(w, a, jid, member) {
    if (!groupJid(jid) || !userJid(member)) throw Error('Invalid warning target.')
    const row = db.prepare('INSERT INTO bot_warnings VALUES(?,?,?,?,1,?) ON CONFLICT(workspace_id,account_id,group_jid,member_jid) DO UPDATE SET count=count+1,updated_at=excluded.updated_at RETURNING count').get(...scope(w, a), jid, userJid(member), now())
    return row.count
  }
  let lastCleanup = 0
  function claim(w, a, event) {
    if (now() - lastCleanup > 60000) {
      // Commands older than seven days are rejected by the router, even after receipt expiry.
      db.prepare('DELETE FROM bot_command_receipts WHERE created_at<?').run(now() - 8 * 86400000)
      db.prepare('DELETE FROM bot_welcome_receipts WHERE created_at<?').run(now() - 86400000)
      lastCleanup = now()
    }
    const hash = crypto.createHash('sha256').update(event).digest('hex')
    return db.prepare('INSERT OR IGNORE INTO bot_command_receipts VALUES(?,?,?,?)').run(...scope(w, a), hash, now()).changes === 1
  }
  return { settings, saveSettings, group, saveGroup, warn, claim,
    warnings(w, a, jid) { return db.prepare('SELECT member_jid AS member,count,updated_at AS updatedAt FROM bot_warnings WHERE workspace_id=? AND account_id=? AND group_jid=? ORDER BY updated_at DESC LIMIT 1000').all(...scope(w, a), jid) },
    resetWarnings(w, a, jid, member) { if (!groupJid(jid) || !userJid(member)) throw Error('Invalid warning target.'); db.prepare('DELETE FROM bot_warnings WHERE workspace_id=? AND account_id=? AND group_jid=? AND member_jid=?').run(...scope(w, a), jid, userJid(member)) },
    welcome(w, a, jid, member) {
      if (!groupJid(jid) || !userJid(member)) return false
      return db.prepare('INSERT INTO bot_welcome_receipts VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,account_id,group_jid,member_jid) DO UPDATE SET created_at=excluded.created_at WHERE created_at<?').run(...scope(w, a), jid, userJid(member), now(), now() - 600000).changes === 1
    },
    statistic(w, a, command, success) { db.prepare('INSERT INTO bot_command_statistics VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,account_id,command) DO UPDATE SET successes=successes+excluded.successes,failures=failures+excluded.failures').run(...scope(w, a), command, success ? 1 : 0, success ? 0 : 1) },
    statistics(w, a) { return db.prepare('SELECT command,successes,failures FROM bot_command_statistics WHERE workspace_id=? AND account_id=?').all(...scope(w, a)).filter(row => COMMAND_BY_NAME.has(row.command)) },
    prepareBroadcast(w, a, chat, payload) {
      const token = crypto.randomBytes(12).toString('hex'), hash = crypto.createHash('sha256').update(token).digest('hex')
      transaction(() => {
        db.prepare('DELETE FROM bot_broadcast_confirmations WHERE expires_at<? OR (workspace_id=? AND account_id=?)').run(now(), ...scope(w, a))
        db.prepare('INSERT INTO bot_broadcast_confirmations VALUES(?,?,?,?,?,?)').run(...scope(w, a), hash, chat, JSON.stringify(payload), now() + 120000)
      })
      return token
    },
    consumeBroadcast(w, a, chat, token) {
      if (!/^[0-9a-f]{24}$/.test(token)) throw Error('Invalid broadcast confirmation.')
      return transaction(() => {
        const hash = crypto.createHash('sha256').update(token).digest('hex')
        const row = db.prepare('SELECT payload FROM bot_broadcast_confirmations WHERE workspace_id=? AND account_id=? AND token_hash=? AND chat=? AND expires_at>?').get(...scope(w, a), hash, chat, now())
        if (!row) throw Error('Broadcast confirmation expired or was already used.')
        db.prepare('DELETE FROM bot_broadcast_confirmations WHERE workspace_id=? AND account_id=? AND token_hash=?').run(...scope(w, a), hash)
        return JSON.parse(row.payload)
      })
    },
    close() { db.close() }
  }
}
