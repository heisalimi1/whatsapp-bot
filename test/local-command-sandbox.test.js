import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareSandbox, choosePort, controlSandbox } from '../scripts/local-command-sandbox.js'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-isolated-sandbox-test-'))
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) })
  return root
}
const bind = () => new Promise(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => resolve(server))
})
async function until(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw Error('The isolated sandbox did not become ready.')
}

test('sandbox creates separate empty data, excludes production environment and retains test sessions', t => {
  const root = temporaryRoot(t)
  const prepared = prepareSandbox({ root, environment: { PATH: process.env.PATH, SMTP_HOST: 'must-not-be-inherited.test', AUTH_DATABASE_PATH: 'production.sqlite', AWS_PROFILE: 'must-not-be-inherited', NODE_OPTIONS: '--inspect', DASHBOARD_PORT: '3000' } })
  assert.equal(prepared.root, root); assert.equal(prepared.env.AUTH_DATABASE_PATH, path.join(root, 'auth.sqlite'))
  assert.equal(prepared.env.DASHBOARD_HOST, '127.0.0.1')
  assert.equal(prepared.env.SMTP_HOST, undefined); assert.equal(prepared.env.AWS_PROFILE, undefined); assert.equal(prepared.env.NODE_OPTIONS, undefined)
  assert.equal(prepared.env.DASHBOARD_PORT, undefined)
  const data = JSON.parse(fs.readFileSync(path.join(root, 'messages.json'), 'utf8'))
  assert.deepEqual(data.jobs, []); assert.deepEqual(data.groupLists, {}); assert.deepEqual(data.statusRecipients, [])
  assert.equal(fs.existsSync(path.join(root, 'accounts.json')), false)
  assert.equal(fs.existsSync(path.join(root, '.env')), false)
  const marker = path.join(root, 'test-session-marker'); fs.writeFileSync(marker, 'preserve-synthetic-session')
  prepareSandbox({ root }); assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve-synthetic-session')
})

test('sandbox refuses repository data, unknown directories and local env files; occupied ports survive', async t => {
  assert.throws(() => prepareSandbox({ root: repository }), /outside/)
  assert.throws(() => prepareSandbox({ root: path.join(repository, 'test-data') }), /outside/)
  const root = temporaryRoot(t), other = path.join(root, 'unrecognized'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'marker'), 'keep')
  assert.throws(() => prepareSandbox({ root: other }), /not an initialized/)
  assert.equal(fs.readFileSync(path.join(other, 'marker'), 'utf8'), 'keep')
  const isolated = path.join(root, 'isolated'); prepareSandbox({ root: isolated }); fs.writeFileSync(path.join(isolated, '.env'), '# synthetic test')
  assert.throws(() => prepareSandbox({ root: isolated }), /does not load/)
  const occupied = await bind(); t.after(() => new Promise(resolve => occupied.close(resolve)))
  const first = occupied.address().port, chosen = await choosePort(first)
  assert(chosen > first); assert.equal(occupied.listening, true)
})

test('isolated real application starts, supports signup without SMTP, stops and preserves its database', async t => {
  const root = temporaryRoot(t), reservation = await bind(), port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const script = new URL('../scripts/local-command-sandbox.js', import.meta.url).href
  let supervisor
  const launch = () => {
    supervisor = spawn(process.execPath, ['--input-type=module', '-e', `import { runSandbox } from ${JSON.stringify(script)}; await runSandbox({ root: ${JSON.stringify(root)}, firstPort: ${port} });`], { windowsHide: true, stdio: 'ignore' })
    return new Promise(resolve => supervisor.once('exit', code => resolve(code)))
  }
  // Cleanup runs before the temporary-root removal hook registered above.
  let exited = launch()
  try {
    let state
    await until(async () => { try { state = await controlSandbox('status', root); return state.ready } catch { return false } })
    assert.equal(state.dataDirectory, root); assert.equal(state.running, true)
    const base = state.url
    assert.equal((await fetch(base + '/login')).status, 200)
    assert.equal((await fetch(base + '/health')).status, 401)
    const password = 'Synthetic-test-password-2026'
    const signup = await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ fullName: 'Isolated tester', email: 'isolated@example.test', password, confirmPassword: password }) })
    assert.equal(signup.status, 201)
    const cookie = signup.headers.get('set-cookie').split(';')[0]
    const accounts = await (await fetch(base + '/api/accounts', { headers: { cookie } })).json()
    assert.deepEqual(accounts.accounts, [], 'no production or preconnected WhatsApp accounts are imported')
    const authMarker = path.join(root, 'accounts', 'spare-session-test-marker'); fs.writeFileSync(authMarker, 'synthetic session, retain on stop')
    const stopped = await controlSandbox('stop', root); assert.equal(stopped.running, true)
    assert.equal(await exited, 0); assert.equal(fs.existsSync(path.join(root, 'auth.sqlite')), true)
    assert.equal(fs.readFileSync(authMarker, 'utf8'), 'synthetic session, retain on stop')
    assert.equal((await controlSandbox('status', root)).running, false)
    exited = launch()
    await until(async () => { try { state = await controlSandbox('status', root); return state.ready } catch { return false } })
    const login = await fetch(state.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: state.url }, body: JSON.stringify({ email: 'isolated@example.test', password }) })
    assert.equal(login.status, 200, 'the separate login database survives a local sandbox restart')
    await controlSandbox('stop', root); assert.equal(await exited, 0)
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      try { await controlSandbox('stop', root); await exited } catch { supervisor.kill() }
    }
  }
})
