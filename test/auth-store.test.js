import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

test('local auth database hashes passwords and enforces single-use, expiring reset tokens', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-auth-test-'))
  const dbPath = path.join(dir, 'auth.sqlite')
  const previousPath = process.env.AUTH_DATABASE_PATH
  process.env.AUTH_DATABASE_PATH = dbPath
  const storeUrl = `${pathToFileURL(path.resolve('auth-store.js')).href}?test=${crypto.randomUUID()}`
  const store = await import(storeUrl)
  t.after(() => {
    try { store.closeAuthStore() } catch {}
    if (previousPath === undefined) delete process.env.AUTH_DATABASE_PATH
    else process.env.AUTH_DATABASE_PATH = previousPath
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const rawPassword = 'temporary-auth-password-2026'
  const nextPassword = 'temporary-reset-password-2026'
  const { user, firstUser } = await store.createUser({ fullName: 'Test Owner', email: 'owner@example.test', password: rawPassword })
  assert.equal(firstUser, true)
  const stored = store.findUser('OWNER@example.test')
  assert.notEqual(stored.passwordHash, rawPassword)
  assert.equal(await store.verifyUserPassword(rawPassword, stored.passwordHash), true)

  const session = store.createSession(user.id, true)
  const request = { headers: { cookie: `wa_dashboard_session=${session.id}` } }
  assert.equal(store.sessionForRequest(request).user.id, user.id)

  const expired = store.createPasswordReset(user.email)
  const directDb = new DatabaseSync(dbPath)
  directDb.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, crypto.createHash('sha256').update(expired.token).digest('hex'))
  assert.equal(await store.consumePasswordReset(expired.token, nextPassword), false)

  const valid = store.createPasswordReset(user.email)
  assert.equal(await store.consumePasswordReset(valid.token, nextPassword), true)
  assert.equal(await store.consumePasswordReset(valid.token, rawPassword), false, 'reset token cannot be reused')
  assert.equal(await store.verifyUserPassword(rawPassword, store.findUser(user.email).passwordHash), false)
  assert.equal(await store.verifyUserPassword(nextPassword, store.findUser(user.email).passwordHash), true)
  assert.equal(store.sessionForRequest(request), null, 'password reset revokes existing sessions')
  directDb.close()
})
