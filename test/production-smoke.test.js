import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const accountIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
const messageId = '33333333-3333-4333-8333-333333333333'
const recipientId = '44444444-4444-4444-8444-444444444444'
const jobId = '55555555-5555-4555-8555-555555555555'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function launch(cwd, port) {
  const signalHook = Buffer.from("process.on('message', signal => process.emit(signal))").toString('base64')
  const env = { ...process.env, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: String(port), DASHBOARD_TRUST_PROXY: 'loopback' }
  delete env.DASHBOARD_PASSWORD
  delete env.DASHBOARD_PASSWORD_HASH
  const child = spawn(process.execPath, ['--import', `data:text/javascript;base64,${signalHook}`, path.join(root, 'bot.js')], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let output = ''
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-20000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-20000) })
  return { child, get output() { return output } }
}

async function waitForServer(base, child) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Bot exited during startup: ${child.exitCode}`)
    try { if ((await fetch(`${base}/login`)).status === 200) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Bot dashboard did not start within 10 seconds.')
}

function stop(child, signal = 'SIGTERM') {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Bot did not stop promptly.')) }, 12000)
    child.once('exit', (code, exitSignal) => { clearTimeout(timer); resolve(code ?? exitSignal) })
    child.send(signal)
  })
}

test('dashboard, account data isolation, health protection, recovery, and graceful shutdown', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-production-test-'))
  const port = await freePort()
  const now = new Date().toISOString()
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  fs.writeFileSync(path.join(dir, 'messages.local.json'), '{ invalid json')
  fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify({ timezone: 'Africa/Lagos', delaySeconds: [5, 15], statusRecipients: [], groupLists: {}, jobs: [], dashboardPassword: 'legacy-config-value-must-be-ignored' }))
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(accountIds.map((id, index) => ({
    id, name: `Business ${index + 1}`, phone: `23480123456${index}`, status: 'disconnected',
    everConnected: false, createdAt: now, updatedAt: now
  }))))
  const accountRoot = path.join(dir, 'accounts')
  for (const id of accountIds) fs.mkdirSync(path.join(accountRoot, id), { recursive: true })
  fs.mkdirSync(path.join(accountRoot, accountIds[0], 'auth'), { recursive: true })
  fs.writeFileSync(path.join(accountRoot, accountIds[0], 'auth', 'migration-fixture'), 'test-only-session-fixture')
  fs.writeFileSync(path.join(accountRoot, accountIds[0], 'automation.json'), JSON.stringify({
    timezone: 'Africa/Lagos', delaySeconds: [5, 15], statusRecipients: [], groupLists: {},
    recipients: [{ id: recipientId, name: 'Recipient', phone: '2348012345678' }],
    messages: [{ id: messageId, name: 'Saved', texts: ['private A'], media: '' }],
    jobs: [{ id: jobId, name: 'Interrupted', messageId, toLists: [], toRecipients: [recipientId], repeatCount: 1,
      delaySeconds: [0, 0], cron: '', scheduleAt: '', status: 'running', progress: 1, total: 3, createdAt: now }]
  }))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const base = `http://127.0.0.1:${port}`
  let app = launch(dir, port)
  t.after(context => {
    if (app?.child.exitCode === null) {
      app.child.kill('SIGKILL')
      app.child.stdout.destroy()
      app.child.stderr.destroy()
      app.child.unref()
    }
    context.diagnostic(app?.output || '')
  })
  await waitForServer(base, app.child)
  const loginPage = await (await fetch(`${base}/login`)).text()
  assert.match(loginPage, /type="email"/)
  assert.doesNotMatch(loginPage, /admin|Basic realm/i)
  assert.equal((await fetch(base, { headers: { authorization: 'Basic dGVzdDp0ZXN0' }, redirect: 'manual' })).headers.has('www-authenticate'), false, 'the server never issues an HTTP Basic challenge')
  assert.match(await (await fetch(`${base}/signup`)).text(), /Create your account/)
  assert.match(await (await fetch(`${base}/forgot-password`)).text(), /Reset your password/)
  assert.match(await (await fetch(`${base}/reset-password`)).text(), /Choose a new password/)
  assert.match((await fetch(base)).url, /\/login$/)
  assert.equal((await fetch(`${base}/health`)).status, 401, 'health is dashboard-authenticated')

  const emailA = 'owner-a@example.test', passwordA = 'temporary-valid-password-A-2026'
  let response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: emailA, password: passwordA })
  })
  assert.equal(response.status, 401, 'unknown users cannot sign in')
  response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: emailA, password: 'wrong-password' })
  })
  assert.equal(response.status, 401, 'incorrect passwords receive a generic error')

  response = await fetch(`${base}/api/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ fullName: 'Workspace Owner', email: emailA, password: passwordA, confirmPassword: passwordA })
  })
  assert.equal(response.status, 201)
  const cookie = response.headers.get('set-cookie')
  let cookiePair = cookie.split(';')[0]
  const proxyHeaders = { 'x-forwarded-proto': 'https', cookie: cookiePair }
  const firstUser = (await (await fetch(`${base}/api/session`, { headers: { cookie: cookiePair } })).json()).user
  assert.equal(fs.existsSync(path.join(accountRoot, firstUser.id, accountIds[0], 'auth', 'migration-fixture')), true, 'existing WhatsApp session storage is moved under its first owner')
  response = await fetch(`${base}/api/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ fullName: 'Duplicate User', email: emailA.toUpperCase(), password: passwordA, confirmPassword: passwordA })
  })
  assert.equal(response.status, 409, 'email addresses are unique regardless of case')
  response = await fetch(`${base}/api/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ fullName: 'Weak User', email: 'weak@example.test', password: 'short', confirmPassword: 'short' })
  })
  assert.equal(response.status, 400, 'signup enforces password requirements')
  const restoreDeadline = Date.now() + 5000
  let initialHealth
  while (Date.now() < restoreDeadline) {
    const check = await fetch(`${base}/health`, { headers: proxyHeaders })
    if (check.ok) initialHealth = await check.json()
    if (initialHealth?.scheduler === 'running') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(initialHealth?.scheduler, 'running')
  response = await fetch(`${base}/api/session`, { headers: proxyHeaders })
  assert.equal(response.status, 200)
  const firstSession = await response.json()
  let { csrfToken } = firstSession
  assert.equal('passwordHash' in firstSession.user, false, 'authentication hashes are never returned in the session API')
  response = await fetch(`${base}/health`, { headers: proxyHeaders })
  assert.equal(response.status, 200)
  const health = await response.json()
  assert.equal(health.configuredAccounts, 2)
  assert.equal(health.scheduler, 'running')
  assert.equal(JSON.stringify(health).includes('11111111'), false, 'health does not expose account identifiers')
  const recoveredState = await (await fetch(`${base}/api/state?accountId=${accountIds[0]}`, { headers: proxyHeaders })).json()
  assert.equal(recoveredState.cfg.jobs[0].status, 'paused', 'interrupted job recovers paused')
  assert.equal(recoveredState.cfg.jobs[0].progress, 1, 'saved delivery progress is retained')

  const genericForgot = await fetch(`${base}/api/forgot-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'missing@example.test' })
  })
  const genericForgotBody = await genericForgot.json()
  assert.equal(genericForgot.status, 200)
  assert.equal(genericForgotBody.message, 'If an account matches that email, we will send password reset instructions.')
  assert.equal(JSON.stringify(genericForgotBody).includes('token'), false, 'reset tokens are never returned by the request endpoint')
  const registeredForgot = await fetch(`${base}/api/forgot-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: emailA })
  })
  assert.equal((await registeredForgot.json()).message, genericForgotBody.message, 'forgot-password does not reveal account existence')

  const putAccount = async (id, label) => {
    const data = {
      timezone: 'Africa/Lagos', delaySeconds: [0, 0], statusRecipients: [],
      recipients: label === 'A' ? [{ id: recipientId, name: 'Recipient A', phone: '2348012345678' }] : [],
      groupLists: { [`${label} list`]: [] },
      messages: [{ id: messageId, name: label, texts: [`private ${label}`], media: '' }], jobs: []
    }
    const result = await fetch(`${base}/api/accounts/${id}/data`, {
      method: 'PUT', headers: { ...proxyHeaders, origin: `https://127.0.0.1:${port}`, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify(data)
    })
    const body = await result.text()
    const logs = result.status === 200 ? '' : (await (await fetch(`${base}/api/log`, { headers: proxyHeaders })).json()).log
    assert.equal(result.status, 200, `account ${label} data saved through HTTPS proxy origin (${body}; ${logs})`)
  }
  await putAccount(accountIds[0], 'A')
  await putAccount(accountIds[1], 'B')

  response = await fetch(`${base}/api/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ fullName: 'Second User', email: 'owner-b@example.test', password: 'temporary-valid-password-B-2026', confirmPassword: 'temporary-valid-password-B-2026' })
  })
  assert.equal(response.status, 201)
  const userBCookie = response.headers.get('set-cookie').split(';')[0]
  const userBCsrf = (await (await fetch(`${base}/api/session`, { headers: { cookie: userBCookie } })).json()).csrfToken
  const userBHeaders = { cookie: userBCookie, 'x-csrf-token': userBCsrf }
  const userBAccounts = await (await fetch(`${base}/api/accounts`, { headers: userBHeaders })).json()
  assert.deepEqual(userBAccounts.accounts, [], 'new users cannot see another workspace accounts')
  assert.equal((await fetch(`${base}/api/accounts/${accountIds[0]}`, { headers: userBHeaders })).status, 404)
  assert.equal((await fetch(`${base}/api/state?accountId=${accountIds[0]}`, { headers: userBHeaders })).status, 404)
  assert.equal((await fetch(`${base}/api/accounts/${accountIds[0]}/groups`, { headers: userBHeaders })).status, 404)
  response = await fetch(`${base}/api/upload`, {
    method: 'POST', headers: { ...userBHeaders, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ accountId: accountIds[0], name: 'test.jpg', data: 'AA==' })
  })
  assert.equal(response.status, 404, 'uploads enforce account ownership')
  const userBState = await (await fetch(`${base}/api/state`, { headers: userBHeaders })).json()
  assert.equal(userBState.accounts.length, 0)

  response = await fetch(`${base}/api/logout`, { method: 'POST', headers: { ...proxyHeaders, origin: `https://127.0.0.1:${port}`, 'x-csrf-token': csrfToken } })
  assert.equal(response.status, 200)
  assert.equal((await fetch(`${base}/api/accounts`, { headers: proxyHeaders })).status, 401, 'logout revokes the persistent session')
  response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `https://127.0.0.1:${port}`, 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ email: emailA, password: passwordA, remember: true })
  })
  assert.equal(response.status, 200, await response.text())
  assert.match(response.headers.get('set-cookie'), /; Secure(?:;|$)/, 'HTTPS receives a Secure cookie')
  assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/, 'remembered sessions use a 30-day lifetime')
  cookiePair = response.headers.get('set-cookie').split(';')[0]
  proxyHeaders.cookie = cookiePair
  csrfToken = (await (await fetch(`${base}/api/session`, { headers: proxyHeaders })).json()).csrfToken
  assert.equal((await fetch(`${base}/api/accounts`, { headers: { cookie: cookiePair } })).status, 200)
  const jobHeaders = { ...proxyHeaders, origin: `https://127.0.0.1:${port}`, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }
  response = await fetch(`${base}/api/accounts/${accountIds[0]}/jobs`, {
    method: 'POST', headers: jobHeaders,
    body: JSON.stringify({ name: 'Lifecycle test', messageId, toLists: [], toRecipients: [recipientId], repeatCount: 1,
      delaySeconds: [0, 0], scheduleAt: future })
  })
  assert.equal(response.status, 201, 'a scheduled job can be created without an active send')
  const lifecycleJobId = (await response.json()).job.id
  for (const [action, expected] of [['pause', 'paused'], ['resume', 'scheduled'], ['cancel', 'cancelled']]) {
    response = await fetch(`${base}/api/accounts/${accountIds[0]}/jobs/${lifecycleJobId}/${action}`, { method: 'POST', headers: jobHeaders, body: '{}' })
    assert.equal(response.status, 200, `${action} request succeeds`)
    assert.equal((await response.json()).job.status, expected)
  }

  const scheduled = {
    timezone: 'Africa/Lagos', delaySeconds: [5, 15], statusRecipients: [], groupLists: { 'B list': [] },
    recipients: [{ id: recipientId, name: 'Recipient', phone: '2348012345678' }],
    messages: [{ id: messageId, name: 'Saved', texts: ['private B'], media: '' }],
    jobs: [{ id: jobId, name: 'Future schedule', messageId, toLists: [], toRecipients: [recipientId], repeatCount: 1,
      delaySeconds: [5, 15], cron: '', scheduleAt: future, status: 'scheduled', progress: 0, total: 0, createdAt: now, scheduledAt: future }]
  }
  response = await fetch(`${base}/api/accounts/${accountIds[1]}/data`, {
    method: 'PUT', headers: { ...proxyHeaders, origin: `https://127.0.0.1:${port}`, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(scheduled)
  })
  assert.equal(response.status, 200)
  const stateA = await (await fetch(`${base}/api/state?accountId=${accountIds[0]}`, { headers: proxyHeaders })).json()
  const stateB = await (await fetch(`${base}/api/state?accountId=${accountIds[1]}`, { headers: proxyHeaders })).json()
  assert.equal(stateA.cfg.messages[0].texts[0], 'private A')
  assert.equal(stateB.cfg.messages[0].texts[0], 'private B')
  assert.deepEqual(Object.keys(stateA.cfg.groupLists), ['A list'])
  assert.deepEqual(Object.keys(stateB.cfg.groupLists), ['B list'])
  assert.equal(stateA.cfg.jobs[0].status, 'cancelled')
  assert.equal(stateB.cfg.jobs[0].status, 'scheduled')
  assert.equal(JSON.stringify(stateA).includes(passwordA), false)
  assert.match((await (await fetch(base, { headers: { cookie: cookiePair } })).text()), /Connect WhatsApp/)

  assert.equal(await stop(app.child, 'SIGINT'), 0)
  assert.match(app.output, /Graceful shutdown complete/)
  app = launch(dir, port)
  await waitForServer(base, app.child)
  assert.equal((await fetch(`${base}/api/accounts`, { headers: { cookie: cookiePair } })).status, 200, 'remembered sessions persist across process restarts')
  const loginAgain = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: emailA, password: passwordA }) })
  const restartCookie = loginAgain.headers.get('set-cookie').split(';')[0]
  const restartedA = await (await fetch(`${base}/api/state?accountId=${accountIds[0]}`, { headers: { cookie: restartCookie } })).json()
  const restartedB = await (await fetch(`${base}/api/state?accountId=${accountIds[1]}`, { headers: { cookie: restartCookie } })).json()
  assert.equal(restartedA.cfg.messages[0].texts[0], 'private A')
  assert.equal(restartedB.cfg.messages[0].texts[0], 'private B')
  assert.equal(restartedA.cfg.jobs[0].status, 'cancelled')
  assert.equal(restartedB.cfg.jobs[0].status, 'scheduled')
  assert.equal(restartedB.cfg.jobs[0].scheduleAt, future)
  await stop(app.child)
  assert.equal(app.output.includes(passwordA), false, 'password is never written to process logs')
})
