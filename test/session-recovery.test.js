import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { recoverMissingSessions } from '../scripts/recover-missing-sessions.js'

test('offline recovery verifies matching auth and preserves existing sessions and unrelated data', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-recovery-test-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'app'), backupRoot = path.join(temp, 'backup')
  const ownerId = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222'
  for (const dir of [root, backupRoot]) {
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{ id, ownerId, status: 'logged_out', everConnected: true }]))
  }
  const auth = path.join(backupRoot, 'accounts', ownerId, id, 'auth')
  fs.mkdirSync(auth, { recursive: true })
  fs.writeFileSync(path.join(auth, 'creds.json'), JSON.stringify({ registered: true, fixtureOnly: true }))
  fs.writeFileSync(path.join(auth, 'session-fixture'), 'fixture-only')
  fs.writeFileSync(path.join(root, '.env'), 'FIXTURE_ONLY=preserve')
  fs.writeFileSync(path.join(root, 'auth.sqlite'), 'fixture-user-data')
  fs.mkdirSync(path.join(root, 'accounts', id), { recursive: true })
  fs.writeFileSync(path.join(root, 'accounts', id, 'automation.json'), 'fixture-automation-data')
  const before = fs.readFileSync(path.join(root, 'accounts.json'), 'utf8')
  assert.deepEqual(recoverMissingSessions({ root, backupRoot }), { planned: 1, restored: 0, skippedExisting: 0, files: 2 })
  assert.equal(fs.readFileSync(path.join(root, 'accounts.json'), 'utf8'), before, 'dry run makes no writes')
  assert.throws(() => recoverMissingSessions({ root, backupRoot, apply: true }), /Stop the application/)
  const result = recoverMissingSessions({ root, backupRoot, apply: true, stopped: true })
  assert.equal(result.restored, 1)
  const target = path.join(root, 'accounts', ownerId, id, 'auth')
  assert.equal(fs.readFileSync(path.join(target, 'session-fixture'), 'utf8'), 'fixture-only')
  const updated = JSON.parse(fs.readFileSync(path.join(root, 'accounts.json'), 'utf8'))[0]
  assert.equal(updated.requiresPairing, false)
  assert.equal(updated.autoConnect, true)
  for (const [file, expected] of [['.env', 'FIXTURE_ONLY=preserve'], ['auth.sqlite', 'fixture-user-data'], [path.join('accounts', id, 'automation.json'), 'fixture-automation-data']]) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), expected)
  assert.equal(recoverMissingSessions({ root, backupRoot, apply: true, stopped: true }).skippedExisting, 1)
  assert.equal(fs.readFileSync(path.join(target, 'session-fixture'), 'utf8'), 'fixture-only', 'existing auth is never overwritten')
  fs.renameSync(target, target + '-preserved')
  fs.writeFileSync(path.join(backupRoot, 'accounts.json'), JSON.stringify([{ id, ownerId: '33333333-3333-4333-8333-333333333333' }]))
  assert.throws(() => recoverMissingSessions({ root, backupRoot }), /identity/)
})
