import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const bcryptCost = 12
const normalSessionMs = 12 * 60 * 60 * 1000
const rememberedSessionMs = 30 * 24 * 60 * 60 * 1000
const databasePath = path.resolve(process.env.AUTH_DATABASE_PATH || 'auth.sqlite')
fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
if (fs.existsSync(databasePath) && fs.lstatSync(databasePath).isSymbolicLink()) throw new Error('Authentication database cannot be a symbolic link.')
const db = new DatabaseSync(databasePath)
if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    password_changed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS reset_token_user_id ON password_reset_tokens(user_id);
`)
db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, Date.now())

const publicUser = row => row && ({ id: row.id, fullName: row.full_name, email: row.email })
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex')
const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?')
const findUserById = db.prepare('SELECT * FROM users WHERE id = ?')
const countUsers = db.prepare('SELECT count(*) AS count FROM users')
const insertUser = db.prepare('INSERT INTO users (id, full_name, email, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)')
const insertSession = db.prepare('INSERT INTO sessions (token_hash, csrf_token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
const sessionQuery = db.prepare('SELECT s.*, u.id AS user_id, u.full_name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
function transaction(callback) {
  db.exec('BEGIN IMMEDIATE')
  try { const value = callback(); db.exec('COMMIT'); return value }
  catch (error) { try { db.exec('ROLLBACK') } catch {}; throw error }
}

export function normalizeEmail(email) { return String(email || '').trim().toLowerCase() }

export async function hashUserPassword(password) { return bcrypt.hash(password, bcryptCost) }
export async function verifyUserPassword(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string') return false
  try { return await bcrypt.compare(password, hash) } catch { return false }
}

export async function createUser({ fullName, email, password }) {
  const name = String(fullName || '').trim().replace(/\s+/g, ' ')
  const normalizedEmail = normalizeEmail(email)
  const passwordHash = await hashUserPassword(password)
  const timestamp = Date.now()
  const id = crypto.randomUUID()
  const insert = () => transaction(() => {
    const firstUser = countUsers.get().count === 0
    if (findUserByEmail.get(normalizedEmail)) {
      const error = new Error('Email already registered.')
      error.code = 'EMAIL_EXISTS'
      throw error
    }
    insertUser.run(id, name, normalizedEmail, passwordHash, timestamp, timestamp)
    return firstUser
  })
  const firstUser = insert()
  return { user: { id, fullName: name, email: normalizedEmail }, firstUser }
}

export function findUser(email) {
  const row = findUserByEmail.get(normalizeEmail(email))
  return row ? { ...publicUser(row), passwordHash: row.password_hash } : null
}

export function userById(id) { return publicUser(findUserById.get(id)) }

export function createSession(userId, remember = false) {
  const token = crypto.randomBytes(32).toString('base64url')
  const csrfToken = crypto.randomBytes(32).toString('base64url')
  const now = Date.now(), expiresAt = now + (remember ? rememberedSessionMs : normalSessionMs)
  insertSession.run(hashToken(token), csrfToken, userId, now, expiresAt)
  return { id: token, csrfToken, expiresAt, remember }
}

function cookieValue(header, name) {
  for (const item of String(header || '').split(';')) {
    const i = item.indexOf('=')
    if (i >= 0 && item.slice(0, i).trim() === name) {
      try { return decodeURIComponent(item.slice(i + 1).trim()) } catch { return '' }
    }
  }
  return ''
}

export function sessionForRequest(req) {
  const token = cookieValue(req.headers.cookie, 'wa_dashboard_session')
  if (!token) return null
  const session = sessionQuery.get(hashToken(token))
  if (!session) return null
  if (session.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
    return null
  }
  return {
    id: token, tokenHash: hashToken(token), csrfToken: session.csrf_token,
    expiresAt: session.expires_at, user: { id: session.user_id, fullName: session.full_name, email: session.email }
  }
}

export function destroySession(req) {
  const session = sessionForRequest(req)
  if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash)
}

export function createPasswordReset(email) {
  const user = findUserByEmail.get(normalizeEmail(email))
  if (!user) return null
  const token = crypto.randomBytes(32).toString('base64url')
  const now = Date.now()
  const save = () => transaction(() => {
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id)
    db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hashToken(token), user.id, now, now + 60 * 60 * 1000)
  })
  save()
  return { token, email: user.email, fullName: user.full_name }
}

export async function consumePasswordReset(token, password) {
  if (typeof token !== 'string' || token.length < 30 || token.length > 100) return false
  const passwordHash = await hashUserPassword(password)
  const now = Date.now()
  const consume = () => transaction(() => {
    const row = db.prepare('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?').get(hashToken(token), now)
    if (!row) return false
    const changed = db.prepare('UPDATE password_reset_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?').run(now, hashToken(token), now)
    if (changed.changes !== 1) return false
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(passwordHash, now, row.user_id)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id)
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(row.user_id)
    return true
  })
  return consume()
}

export function cleanupExpiredAuthRecords() {
  const now = Date.now()
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
  db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(now)
}

export function closeAuthStore() { db.close() }
