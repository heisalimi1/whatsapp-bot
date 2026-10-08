import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import path from 'node:path'
import { userById } from './auth-store.js'

const db = new DatabaseSync(path.resolve(process.env.AUTH_DATABASE_PATH || 'auth.sqlite'))
db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner','member')), joined_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,user_id));
  CREATE TABLE IF NOT EXISTS workspace_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS workspace_invites (
    token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE, expires_at INTEGER NOT NULL, accepted_at INTEGER);
  CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members(user_id);
`)
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = fn(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex')
const list = db.prepare('SELECT w.id,w.name,m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY m.joined_at,w.id')
const preference = db.prepare('SELECT workspace_id FROM workspace_preferences WHERE user_id=?')
const setPreference = db.prepare('INSERT INTO workspace_preferences(user_id,workspace_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET workspace_id=excluded.workspace_id')

export function ensureWorkspace(userId) {
  const user = userById(userId)
  if (!user) throw new Error('Sign in again.')
  // Legacy owner IDs become stable workspace IDs; no session directories are moved.
  transaction(() => {
    db.prepare('INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES (?,?,?)').run(userId, `${user.fullName}'s business`, Date.now())
    db.prepare("INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES (?,?,'owner',?)").run(userId, userId, Date.now())
  })
}
for (const { id } of db.prepare('SELECT id FROM users').all()) ensureWorkspace(id)
db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (2,?)').run(Date.now())

export function workspaceContext(userId) {
  ensureWorkspace(userId)
  const workspaces = list.all(userId)
  const preferred = preference.get(userId)?.workspace_id
  return { workspace: workspaces.find(w => w.id === preferred) || workspaces.find(w => w.id === userId) || workspaces[0], workspaces }
}
export function selectWorkspace(userId, workspaceId) {
  const context = workspaceContext(userId)
  const workspace = context.workspaces.find(w => w.id === workspaceId)
  if (!workspace) throw new Error('Business workspace not found.')
  setPreference.run(userId, workspaceId)
  return workspace
}
function requireOwner(userId, workspaceId) {
  if (!list.all(userId).some(w => w.id === workspaceId && w.role === 'owner')) throw new Error('Only the business owner can manage members.')
}
export function workspaceMembers(userId, workspaceId) {
  requireOwner(userId, workspaceId)
  return db.prepare('SELECT u.id,u.full_name AS fullName,u.email,m.role FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.joined_at').all(workspaceId)
}
export function createWorkspaceInvite(userId, workspaceId, email) {
  requireOwner(userId, workspaceId)
  const normalized = String(email || '').trim().toLowerCase()
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Enter a valid member email.')
  const token = crypto.randomBytes(32).toString('base64url'), expiresAt = Date.now() + 24 * 60 * 60 * 1000
  transaction(() => {
    db.prepare('DELETE FROM workspace_invites WHERE workspace_id=? AND email=?').run(workspaceId, normalized)
    db.prepare('INSERT INTO workspace_invites(token_hash,workspace_id,email,expires_at) VALUES (?,?,?,?)').run(tokenHash(token), workspaceId, normalized, expiresAt)
  })
  return { code: token, expiresAt }
}
export function acceptWorkspaceInvite(userId, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Enter a valid invitation code.')
  const user = userById(userId)
  return transaction(() => {
    const invite = db.prepare('SELECT * FROM workspace_invites WHERE token_hash=? AND accepted_at IS NULL AND expires_at>?').get(tokenHash(token), Date.now())
    if (!invite || invite.email !== user?.email.toLowerCase()) throw new Error('This invitation is invalid, expired, or belongs to another email.')
    db.prepare("INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES (?,?,'member',?)").run(invite.workspace_id, userId, Date.now())
    db.prepare('UPDATE workspace_invites SET accepted_at=? WHERE token_hash=?').run(Date.now(), tokenHash(token))
    setPreference.run(userId, invite.workspace_id)
    return { workspaceId: invite.workspace_id }
  })
}
export function removeWorkspaceMember(userId, workspaceId, memberId) {
  requireOwner(userId, workspaceId)
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, memberId)
  if (!member || member.role === 'owner') throw new Error('Only existing non-owner members can be removed.')
  transaction(() => {
    db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(workspaceId, memberId)
    db.prepare('DELETE FROM workspace_preferences WHERE workspace_id=? AND user_id=?').run(workspaceId, memberId)
  })
}
export function renameWorkspace(userId, workspaceId, name) {
  requireOwner(userId, workspaceId)
  const value = String(name || '').trim()
  if (!value || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Use a business name from 1 to 80 printable characters.')
  db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(value, workspaceId)
}
export function closeWorkspaceStore() { db.close() }
