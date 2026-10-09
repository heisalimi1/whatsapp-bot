import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPredeploymentBackup, verifyPredeploymentBackup, BackupError } from '../deploy/ssm-predeployment-backup.js'
import { privateReleasePath, inspectReleaseText } from '../scripts/production-preflight.js'

test('release path checks exclude private settings, databases, credentials, backups and sandbox data', () => {
  for (const file of ['.env', '.env.production', 'private.sqlite', 'private.sqlite-wal', 'private.db', 'key.pem', 'key.key', 'accounts.json', 'accounts/a/auth/creds.json', 'messages.local.json', 'backups/data.json', '.sandbox/data.json', 'sandbox-data/auth.sqlite', 'application.log', '../outside.js']) assert.equal(privateReleasePath(file), true, file)
  for (const file of ['.env.example', 'bot.js', 'commands/media.js', 'scripts/local-command-sandbox.js', 'test/local-command-sandbox.test.js']) assert.equal(privateReleasePath(file), false, file)
})
test('release checks report finding types without leaking matched values and reject secret defaults', () => {
  const simulated = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
  const findings = inspectReleaseText('example.js', simulated)
  assert.deepEqual(findings, ['private key']); assert.equal(JSON.stringify(findings).includes(simulated), false)
  assert.deepEqual(inspectReleaseText('messages.json', JSON.stringify({ phone: 'synthetic', dashboardPassword: 'synthetic' })), ['obsolete/private defaults'])
  assert.deepEqual(inspectReleaseText('messages.json', JSON.stringify({ timezone: 'Africa/Lagos', jobs: [] })), [])
})
test('online pre-deployment backup uses SQLite backup API and cannot restart or deploy the bot', () => {
  const source = fs.readFileSync(new URL('../deploy/ssm-predeployment-backup.js', import.meta.url), 'utf8')
  assert.match(source, /sqliteBackup\(live, sqliteCopy/); assert.match(source, /PRAGMA integrity_check/)
  assert.match(source, /readOnly: true/); assert.match(source, /after\.pid !== before\.pid/)
  assert.doesNotMatch(source, /pm2 (?:stop|restart)|git (?:pull|merge|reset)|npm ci/)
})
test('online backup includes committed WAL records and preserves original sessions and automation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-predeployment-test-')), source = path.join(root, 'production'), backups = path.join(root, 'backups')
  fs.mkdirSync(path.join(source, 'accounts', 'fixture', 'auth'), { recursive: true })
  const auth = path.join(source, 'accounts', 'fixture', 'auth', 'creds.json'), automation = path.join(source, 'accounts', 'fixture', 'automation.json')
  fs.writeFileSync(auth, JSON.stringify({ registered: true, synthetic: true })); fs.writeFileSync(automation, JSON.stringify({ jobs: [{ id: 'synthetic', status: 'scheduled' }], messages: [{ id: 'fixture' }] }))
  const db = new DatabaseSync(path.join(source, 'auth.sqlite')); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixtures(id INTEGER);INSERT INTO fixtures VALUES(42)")
  try {
    const result = await createPredeploymentBackup({ source, backups, readProcessState: () => ({ pid: 12345, cwd: source, database: 'auth.sqlite' }) })
    assert.equal(result.backupVerified, true); assert.equal(result.pidUnchanged, true)
    const saved = new DatabaseSync(path.join(result.backupDirectory, 'data', 'auth.sqlite'), { readOnly: true })
    try { assert.equal(saved.prepare('SELECT id FROM fixtures').get().id, 42) } finally { saved.close() }
    assert.equal(fs.readFileSync(auth, 'utf8'), fs.readFileSync(path.join(result.backupDirectory, 'data', path.relative(source, auth)), 'utf8'))
    assert.equal(JSON.parse(fs.readFileSync(automation, 'utf8')).jobs[0].status, 'scheduled')
    assert.equal(fs.existsSync(path.join(result.backupDirectory, 'VERIFIED')), true)
  } finally { db.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) }
})

function backupFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-race-')), source = path.join(root, 'production'), backups = path.join(root, 'backups')
  const authDir = path.join(source, 'accounts', 'fixture', 'auth'), auth = path.join(authDir, 'creds.json')
  fs.mkdirSync(authDir, { recursive: true }); fs.mkdirSync(path.join(source, 'uploads', 'empty'), { recursive: true })
  fs.writeFileSync(auth, JSON.stringify({ registered: true, synthetic: true, revision: 1 }))
  fs.writeFileSync(path.join(source, '.env'), 'EXAMPLE_SETTING=synthetic\n')
  fs.writeFileSync(path.join(source, 'groups.txt'), 'Synthetic group fixture\n')
  const db = new DatabaseSync(path.join(source, 'auth.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixtures(id INTEGER); INSERT INTO fixtures VALUES(42)')
  t.after(() => { db.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) })
  const options = { source, backups, readProcessState: () => ({ pid: 12345, cwd: source, database: 'auth.sqlite' }), limits: { retryDelayMs: 1, maxDurationMs: 10000 } }
  return { root, source, backups, auth, authDir, options }
}
const noVerifiedBackup = backups => assert.equal(fs.readdirSync(backups).some(name => fs.existsSync(path.join(backups, name, 'VERIFIED'))), false)

test('truncated JSON is retried and only a valid stable copy is published', async t => {
  const fixture = backupFixture(t), valid = fs.readFileSync(fixture.auth, 'utf8'), events = []
  fs.writeFileSync(fixture.auth, '{')
  const result = await createPredeploymentBackup({ ...fixture.options, onProgress: event => {
    events.push(event); if (event.phase === 'retrying-file') fs.writeFileSync(fixture.auth, valid)
  } })
  assert(result.counters.fileRetries >= 1); assert.equal(verifyPredeploymentBackup(result.backupDirectory).backupVerified, true)
  assert.equal(fs.readFileSync(fixture.auth, 'utf8'), valid)
  assert.equal(JSON.stringify(events).includes('creds.json'), false)
  assert.equal(fs.readdirSync(path.join(result.backupDirectory, 'data', 'accounts', 'fixture', 'auth')).some(name => name.includes('.copy-')), false)
})

test('a session modified while its bytes are being read is detected and retried', async t => {
  const fixture = backupFixture(t), originalOpen = fs.openSync, originalRead = fs.readSync
  let descriptor, injected = false
  t.mock.method(fs, 'openSync', function(file, ...args) { const fd = originalOpen.call(fs, file, ...args); if (file === fixture.auth) descriptor = fd; return fd })
  t.mock.method(fs, 'readSync', function(fd, ...args) {
    const count = originalRead.call(fs, fd, ...args)
    if (fd === descriptor && count && !injected) { injected = true; fs.writeFileSync(fixture.auth, JSON.stringify({ registered: true, synthetic: true, revision: 222 })) }
    return count
  })
  const result = await createPredeploymentBackup(fixture.options)
  assert.equal(injected, true); assert(result.counters.fileRetries >= 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backupDirectory, 'data', path.relative(fixture.source, fixture.auth)), 'utf8')).revision, 222)
})

test('changed session files are refreshed in the next consistency round', async t => {
  const fixture = backupFixture(t); let changed = false
  const result = await createPredeploymentBackup({ ...fixture.options, onProgress: event => {
    if (event.phase === 'checking-consistency' && !changed) { changed = true; fs.writeFileSync(fixture.auth, JSON.stringify({ registered: true, synthetic: true, revision: 2 })) }
  } })
  assert.equal(result.counters.rounds, 2); assert.equal(verifyPredeploymentBackup(result.backupDirectory).backupVerified, true)
  assert.equal(fs.readFileSync(fixture.auth, 'utf8'), fs.readFileSync(path.join(result.backupDirectory, 'data', path.relative(fixture.source, fixture.auth)), 'utf8'))
  assert(fs.existsSync(path.join(result.backupDirectory, 'data', 'uploads', 'empty')))
  assert.equal(fs.readFileSync(path.join(result.backupDirectory, 'data', 'groups.txt'), 'utf8'), 'Synthetic group fixture\n')
})

test('concurrent key deletion and creation reconcile only the new backup', async t => {
  const fixture = backupFixture(t), oldKey = path.join(fixture.authDir, 'old-key.json'), newKey = path.join(fixture.authDir, 'new-key.json')
  fs.writeFileSync(oldKey, '{}'); let changed = false
  const result = await createPredeploymentBackup({ ...fixture.options, onProgress: event => {
    if (event.phase === 'checking-consistency' && !changed) { changed = true; fs.unlinkSync(oldKey); fs.writeFileSync(newKey, '{"synthetic":true}') }
  } })
  const savedDir = path.join(result.backupDirectory, 'data', path.relative(fixture.source, fixture.authDir))
  assert.equal(result.counters.rounds, 2); assert.equal(fs.existsSync(path.join(savedDir, 'old-key.json')), false)
  assert.equal(fs.readFileSync(path.join(savedDir, 'new-key.json'), 'utf8'), fs.readFileSync(newKey, 'utf8'))
  assert.equal(JSON.parse(fs.readFileSync(fixture.auth, 'utf8')).registered, true)
})

test('a key deleted during reading does not abort the inventory retries', async t => {
  const fixture = backupFixture(t), key = path.join(fixture.authDir, 'ephemeral.json')
  fs.writeFileSync(key, '{}'); const originalOpen = fs.openSync, originalRead = fs.readSync
  let descriptor, deleted = false
  t.mock.method(fs, 'openSync', function(file, ...args) { const fd = originalOpen.call(fs, file, ...args); if (file === key) descriptor = fd; return fd })
  t.mock.method(fs, 'readSync', function(fd, ...args) { const count = originalRead.call(fs, fd, ...args); if (fd === descriptor && count && !deleted) { deleted = true; fs.unlinkSync(key) } return count })
  const result = await createPredeploymentBackup(fixture.options)
  assert(deleted); assert(result.counters.fileRetries > 0); assert.equal(result.counters.rounds, 2)
  assert.equal(fs.existsSync(path.join(result.backupDirectory, 'data', path.relative(fixture.source, key))), false)
  assert.equal(verifyPredeploymentBackup(result.backupDirectory).backupVerified, true)
})

test('persistent invalid JSON exhausts bounded retries without leaking data or creating VERIFIED', async t => {
  const fixture = backupFixture(t), invalid = '{"synthetic-sensitive-marker":'
  fs.writeFileSync(fixture.auth, invalid); let retries = 0
  await assert.rejects(createPredeploymentBackup({ ...fixture.options, limits: { maxRounds: 2, maxFileAttempts: 2, retryDelayMs: 0 }, onProgress: event => { if (event.phase === 'retrying-file') retries++ } }), error => {
    assert(error instanceof BackupError); assert.equal(error.code, 'invalid_json'); assert.equal(error.message.includes('synthetic-sensitive-marker'), false); assert.equal(error.message.includes(fixture.auth), false); return true
  })
  assert.equal(retries, 4); noVerifiedBackup(fixture.backups); assert.equal(fs.readFileSync(fixture.auth, 'utf8'), invalid)
})

test('continuous writes fail closed after the configured round limit', async t => {
  const fixture = backupFixture(t); let revision = 10
  await assert.rejects(createPredeploymentBackup({ ...fixture.options, limits: { maxRounds: 2, retryDelayMs: 0 }, onProgress: event => {
    if (event.phase === 'checking-consistency') fs.writeFileSync(fixture.auth, JSON.stringify({ synthetic: true, revision: ++revision }))
  } }), { code: 'live_files_changing' })
  assert.equal(revision, 12); noVerifiedBackup(fixture.backups)
})

test('writes during the SQLite snapshot are caught by the final source consistency pass', async t => {
  const fixture = backupFixture(t); let changed = false
  const result = await createPredeploymentBackup({ ...fixture.options, onProgress: event => {
    if (event.phase === 'backing-up-sqlite' && !changed) { changed = true; fs.writeFileSync(fixture.auth, '{"synthetic":true,"revision":5}') }
  } })
  assert.equal(result.counters.rounds, 2); assert.equal(verifyPredeploymentBackup(result.backupDirectory).backupVerified, true)
})

test('a changed PM2 PID prevents verification and never changes production files', async t => {
  const fixture = backupFixture(t), before = fs.readFileSync(fixture.auth, 'utf8'); let calls = 0
  await assert.rejects(createPredeploymentBackup({ ...fixture.options, readProcessState: () => ({ pid: ++calls === 1 ? 12345 : 54321, cwd: fixture.source, database: 'auth.sqlite' }) }), { code: 'pm2_process_changed' })
  noVerifiedBackup(fixture.backups); assert.equal(fs.readFileSync(fixture.auth, 'utf8'), before)
})

test('backup checksum tampering, unlisted files and traversal manifests are rejected', async t => {
  const fixture = backupFixture(t), result = await createPredeploymentBackup(fixture.options), dir = result.backupDirectory
  const savedAuth = path.join(dir, 'data', path.relative(fixture.source, fixture.auth)), original = fs.readFileSync(savedAuth)
  fs.writeFileSync(savedAuth, '{}'); assert.throws(() => verifyPredeploymentBackup(dir), { code: 'copy_hash_mismatch' }); fs.writeFileSync(savedAuth, original)
  const extra = path.join(dir, 'data', 'extra.txt'); fs.writeFileSync(extra, 'synthetic', { mode: 0o600 })
  assert.throws(() => verifyPredeploymentBackup(dir), { code: 'unexpected_backup_file' }); fs.unlinkSync(extra)
  const manifestFile = path.join(dir, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.files['../outside.json'] = { bytes: 1, sha256: 'synthetic' }; fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  assert.throws(() => verifyPredeploymentBackup(dir), { code: 'invalid_manifest' })
})

test('backup destinations inside production and storage symlinks are refused', async t => {
  const fixture = backupFixture(t)
  await assert.rejects(createPredeploymentBackup({ ...fixture.options, backups: path.join(fixture.source, 'private-backup') }), { code: 'unsafe_storage' })
  const linked = path.join(fixture.root, 'linked-production'); fs.symlinkSync(fixture.source, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createPredeploymentBackup({ ...fixture.options, source: linked }), { code: 'unsafe_storage' })
})

test('deadline and attempt limits are bounded, and failed copies create no marker', async t => {
  const fixture = backupFixture(t)
  await assert.rejects(createPredeploymentBackup({ ...fixture.options, limits: { maxFileAttempts: 999 } }), { code: 'invalid_limits' })
  await assert.rejects(createPredeploymentBackup({ ...fixture.options, limits: { maxDurationMs: 5 }, onProgress: event => {
    if (event.phase === 'scanning') { const end = Date.now() + 10; while (Date.now() < end) {} }
  } }), { code: 'deadline_exceeded' })
  noVerifiedBackup(fixture.backups)
})

test('SQLite backup progress rejects an expired deadline without stopping or changing the source', async t => {
  const fixture = backupFixture(t), before = fs.readFileSync(fixture.auth, 'utf8'); let clock = 1000
  t.mock.method(Date, 'now', () => clock)
  await assert.rejects(createPredeploymentBackup({ ...fixture.options, limits: { maxDurationMs: 100 }, onProgress: event => {
    if (event.phase === 'backing-up-sqlite') clock = 1200
  } }), { code: 'deadline_exceeded' })
  noVerifiedBackup(fixture.backups); assert.equal(fs.readFileSync(fixture.auth, 'utf8'), before)
})
