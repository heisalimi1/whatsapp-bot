import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkDashboardBrowser } from '../test-support/dashboard-browser.js'

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
      groupLists: { [`${label} list`]: ['test-group@g.us'] },
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
  const messageHeaders = { ...proxyHeaders, origin: 'https://127.0.0.1:' + port, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }
  let messageResponse = await fetch(base + '/api/accounts/' + accountIds[0] + '/messages', {
    method: 'POST', headers: messageHeaders,
    body: JSON.stringify({ name: 'Saved from Messages page', texts: ['Saved text for automation'], media: '' })
  })
  assert.equal(messageResponse.status, 201, 'the authenticated account can save a new message')
  const createdMessage = (await messageResponse.json()).savedMessage
  assert.match(createdMessage.id, /^[a-f0-9-]{36}$/i, 'the server assigns a message ID without browser crypto')
  const refreshedState = await (await fetch(base + '/api/state?accountId=' + accountIds[0], { headers: proxyHeaders })).json()
  assert.deepEqual(refreshedState.cfg.messages.find(message => message.id === createdMessage.id).texts, ['Saved text for automation'], 'the saved message remains after reloading account state')
  const editResponse = await fetch(base + '/api/accounts/' + accountIds[0] + '/messages/' + createdMessage.id, {
    method: 'PUT', headers: messageHeaders,
    body: JSON.stringify({ name: 'Saved from Messages page', texts: ['Updated saved text'], media: '' })
  })
  assert.equal(editResponse.status, 200, 'editing a saved message succeeds')
  assert.equal((await editResponse.json()).savedMessage.id, createdMessage.id, 'editing preserves the selected message ID')
  const editedState = await (await fetch(base + '/api/state?accountId=' + accountIds[0], { headers: proxyHeaders })).json()
  assert.deepEqual(editedState.cfg.messages.find(message => message.id === createdMessage.id).texts, ['Updated saved text'], 'message edits persist after reload')

  const dashboardResponse = await fetch(base, { headers: proxyHeaders, redirect: 'manual' })
  assert.match(dashboardResponse.headers.get('cache-control') || '', /no-store/, 'the browser always receives the deployed dashboard script')
  const dashboardMarkup = await dashboardResponse.text()
  const dashboardScript = dashboardMarkup.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(dashboardScript, 'the dashboard includes its interactive script')
  new vm.Script(dashboardScript, { filename: 'dashboard-inline.js' })
  const saveButtonMatch = dashboardMarkup.match(/<button onclick="([^"]+)">Save message<\/button>/)
  assert.equal(saveButtonMatch?.[1], 'saveMessage()', 'the Messages page button calls the save handler')
  const browserElements = new Map()
  const selectedBrowserLists = [{ value: 'A list', checked: true }]
  const selectedBrowserContacts = [{ value: recipientId, checked: true }]
  const browserElement = id => {
    if (!browserElements.has(id)) browserElements.set(id, { id, value: '', textContent: '', innerHTML: '', className: '', style: {}, disabled: false, checked: false, classList: { toggle() {} } })
    return browserElements.get(id)
  }
  const saveButton = { disabled: false }
  const browserRequests = []
  const browserConsoleErrors = []
  const browserFetch = (url, options = {}) => {
    const target = new URL(String(url), base)
    const headers = { ...(options.headers || {}), cookie: cookiePair, origin: 'https://127.0.0.1:' + port, 'x-forwarded-proto': 'https' }
    browserRequests.push({ path: target.pathname, method: options.method || 'GET', csrf: headers['X-CSRF-Token'] || headers['x-csrf-token'] || '' })
    return fetch(target, { ...options, headers })
  }
  const browserContext = vm.createContext({
    document: {
      getElementById: browserElement,
      querySelector: () => saveButton,
      querySelectorAll: selector => selector === '.jobList:checked' ? selectedBrowserLists.filter(item => item.checked) : selector === '.jobRecipient:checked' ? selectedBrowserContacts.filter(item => item.checked) : selector === '.jobList,.jobRecipient' ? [...selectedBrowserLists, ...selectedBrowserContacts] : [],
      addEventListener() {},
      activeElement: { tagName: 'BODY' },
      hidden: false
    },
    window: { scrollTo() {} },
    location: { assign() {} },
    fetch: browserFetch,
    console: { error: (...args) => browserConsoleErrors.push(args), warn() {}, log() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    crypto: undefined,
    URL,
    Date,
    Math,
    JSON,
    Promise,
    Array,
    String,
    Number,
    Object,
    RegExp,
    Error
  })
  new vm.Script(dashboardScript.slice(0, dashboardScript.indexOf("fetch('/api/session')")), { filename: 'dashboard-click-flow.js' }).runInContext(browserContext)
  browserContext.accountId = accountIds[0]
  browserContext.csrfToken = csrfToken
  browserElement('messageName').value = 'testing'
  browserElement('messageText').value = 'hi this is test message'
  vm.runInContext(saveButtonMatch[1], browserContext)
  const saveDeadline = Date.now() + 5000
  while (saveButton.disabled && Date.now() < saveDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(saveButton.disabled, false, 'the Save Message click request completes')
  assert.equal(browserConsoleErrors.length, 0, 'the dashboard click handler reports no browser console errors')
  assert.equal(browserElement('toast').textContent, 'Message saved successfully.', 'the Messages page shows a clear success message')
  assert(browserRequests.some(request => request.path === '/api/accounts/' + accountIds[0] + '/messages' && request.method === 'POST' && request.csrf), 'the button sends an authenticated, CSRF-protected create request')
  assert.match(browserElement('messageCards').innerHTML, /<h3>testing<\/h3>/, 'the new message appears in the saved messages list')
  const testingMessage = browserContext.S.cfg.messages.find(message => message.name === 'testing' && message.texts.includes('hi this is test message'))
  assert(testingMessage, 'the saved message is returned to the page after the request')
  const persistedAutomation = JSON.parse(fs.readFileSync(path.join(accountRoot, accountIds[0], 'automation.json'), 'utf8'))
  assert(persistedAutomation.messages.some(message => message.id === testingMessage.id && message.name === 'testing' && message.texts.includes('hi this is test message')), 'the exact test message is persisted to disk')
  const serverLog = await (await fetch(base + '/api/log', { headers: proxyHeaders })).json()
  assert.doesNotMatch(serverLog.log, /Unable to (create|update) account message/, 'the server reports no message-save error')
  assert(browserElement('jobMessage').innerHTML.includes('value="' + testingMessage.id + '">testing</option>'), 'the saved message appears in the Automations dropdown')
  browserElement('jobMessage').value = testingMessage.id
  assert.equal(browserElement('jobMessage').value, testingMessage.id, 'the Automations dropdown can select the saved message')
  await vm.runInContext('loadState()', browserContext)
  assert(browserContext.S.cfg.messages.some(message => message.id === testingMessage.id), 'the message remains after refreshing account state')
  assert(browserElement('messageCards').innerHTML.includes('<h3>testing</h3>'), 'the message remains in the list after refreshing')
  assert(browserElement('jobMessage').innerHTML.includes('value="' + testingMessage.id + '">testing</option>'), 'the refreshed Automations dropdown retains the saved message')
  assert.match(dashboardMarkup, /messageSelect\.innerHTML=\(S\.cfg\.messages\|\|\[\]\)\.map/, 'Automations renders saved account messages as selectable options')
  assert(dashboardMarkup.includes("var target='/api/accounts/'+encodeURIComponent(accountId)+'/messages'"), 'Save Message uses the account-scoped message API')

  // Exercise the served creation handler against real authenticated HTTP routes.
  const missingAudience = await fetch(base + '/api/accounts/' + accountIds[0] + '/jobs', {
    method: 'POST', headers: messageHeaders,
    body: JSON.stringify({ name: 'Missing viewers', messageId, toStatus: true, repeatCount: 1, delaySeconds: [0, 0], scheduleAt: future })
  })
  assert.equal(missingAudience.status, 201, 'Status can be scheduled without entering viewer numbers')
  assert.equal((await missingAudience.json()).job.toStatus, true)
  assert.doesNotMatch(dashboardMarkup, /textarea id="statusRecipients"|Add status viewers|Manage status viewers/)
  assert.match(dashboardMarkup, /Sync WhatsApp contacts/)
  const disconnectedSync = await fetch(base + '/api/accounts/' + accountIds[0] + '/contacts/sync', { method: 'POST', headers: messageHeaders, body: '{}' })
  assert.equal(disconnectedSync.status, 409, 'contact sync needs the selected account to be connected')
  browserElement('jobMessage').value = testingMessage.id
  browserElement('jobRepeat').value = '1'
  browserElement('jobPacing').value = 'random'
  browserElement('jobMinDelay').value = '0'
  browserElement('jobMaxDelay').value = '0'
  browserElement('jobMode').value = 'at'
  browserElement('jobDate').value = future
  const destinationJobIds = []
  for (const [label, groups, status, contacts] of [
    ['Groups only', true, false, false],
    ['Status only', false, true, false],
    ['Groups and Status', true, true, false],
    ['Contacts only', false, false, true]
  ]) {
    browserElement('jobSendGroups').checked = groups
    browserElement('jobToStatus').checked = status
    browserElement('jobSendContacts').checked = contacts
    browserElement('jobName').value = label
    vm.runInContext('destinationMode()', browserContext)
    assert.equal(browserElement('jobSendGroups').checked, groups, 'Status selection leaves Groups independent')
    assert.equal(browserElement('jobToStatus').checked, status, 'Groups selection leaves Status independent')
    await vm.runInContext('createJob()', browserContext)
    assert.equal(browserElement('jobFeedback').textContent, 'Automation scheduled successfully.', label + ' shows success')
    const saved = browserContext.S.cfg.jobs.find(job => job.name === label)
    assert.ok(saved, label + ' appears after the server/UI refresh')
    assert.equal(saved.toStatus, status)
    assert.deepEqual(Array.from(saved.toLists), groups ? ['A list'] : [], 'unselected group destinations are omitted even when their list remains checked')
    assert.deepEqual(Array.from(saved.toRecipients), contacts ? [recipientId] : [])
    destinationJobIds.push(saved.id)
  }
  const savedDestinations = JSON.parse(fs.readFileSync(path.join(accountRoot, accountIds[0], 'automation.json'), 'utf8')).jobs
  assert(savedDestinations.some(job => job.name === 'Status only' && job.toStatus && !job.toLists.length && !job.toRecipients.length), 'Status-only choice persists to disk')
  assert(savedDestinations.some(job => job.name === 'Groups and Status' && job.toStatus && job.toLists.includes('A list')), 'combined destinations persist to disk')
  assert.match(browserElement('jobCards').innerHTML, /WhatsApp Status/, 'automation cards clearly show Status')
  browserElement('jobSendGroups').checked = false
  browserElement('jobToStatus').checked = true
  browserElement('jobSendContacts').checked = false
  browserElement('jobPacing').value = 'fixed'
  browserElement('jobSendInterval').value = '0.5'
  browserElement('jobIntervalUnit').value = '60'
  browserElement('jobMode').value = 'interval'
  browserElement('jobInterval').value = '*/15 * * * *'
  browserElement('jobName').value = 'Status every 15 minutes'
  await vm.runInContext('createJob()', browserContext)
  const recurringStatus = browserContext.S.cfg.jobs.find(job => job.name === 'Status every 15 minutes')
  assert(recurringStatus)
  assert.equal(recurringStatus.cron, '*/15 * * * *')
  assert.deepEqual(Array.from(recurringStatus.delaySeconds), [30, 30], 'fixed interval in minutes converts to persisted seconds')
  await vm.runInContext('loadState()', browserContext)
  assert.equal(browserContext.S.cfg.jobs.find(job => job.id === recurringStatus.id).cron, '*/15 * * * *', 'the recurring interval remains after refresh')
  browserElement('jobSendInterval').value = '-1'
  browserElement('jobName').value = 'Invalid sending interval'
  await vm.runInContext('createJob()', browserContext)
  assert.match(browserElement('jobFeedback').textContent, /Choose a sending interval/)
  browserElement('jobPacing').value = 'random'
  browserElement('jobSendGroups').checked = false
  browserElement('jobToStatus').checked = false
  browserElement('jobSendContacts').checked = false
  const requestsBeforeValidation = browserRequests.length
  await vm.runInContext('createJob()', browserContext)
  assert.match(browserElement('jobFeedback').textContent, /Choose Groups/)
  assert.equal(browserRequests.length, requestsBeforeValidation, 'empty destination form gives feedback without a request')
  browserElement('jobSendGroups').checked = true
  browserElement('jobToStatus').checked = true
  selectedBrowserLists[0].checked = false
  await vm.runInContext('createJob()', browserContext)
  assert.match(browserElement('jobFeedback').textContent, /Choose at least one group list/)
  assert.equal(browserRequests.length, requestsBeforeValidation)
  selectedBrowserLists[0].checked = true
  const invalidDestination = await fetch(base + '/api/accounts/' + accountIds[0] + '/jobs', {
    method: 'POST', headers: messageHeaders,
    body: JSON.stringify({ name: 'Invalid list', messageId, toLists: ['missing'], toStatus: true, repeatCount: 1, delaySeconds: [0, 0], scheduleAt: future })
  })
  assert.equal(invalidDestination.status, 400, 'the API validates selected groups even with Status enabled')
  assert.equal(browserConsoleErrors.length, 0)
  const checkedBrowser = await checkDashboardBrowser({
    base, cookie: cookiePair, accountId: accountIds[0], messageId: testingMessage.id,
    screenshotDir: process.env.DASHBOARD_TEST_SCREENSHOTS
  })
  t.diagnostic(checkedBrowser ? 'Real Chromium: separate/combined destinations, refresh, desktop/mobile layouts and console passed.' : 'Real Chromium unavailable; HTTP and dashboard handler coverage passed.')
  const mediaUpload = await fetch(base + '/api/upload', {
    method: 'POST', headers: messageHeaders,
    body: JSON.stringify({ accountId: accountIds[0], name: 'message-test.png', data: 'iVBORw0KGgo=' })
  })
  assert.equal(mediaUpload.status, 200, 'the existing account media upload route still works')
  const mediaPath = (await mediaUpload.json()).path
  const mediaMessageResponse = await fetch(base + '/api/accounts/' + accountIds[0] + '/messages', {
    method: 'POST', headers: messageHeaders,
    body: JSON.stringify({ name: 'Uploaded media message', texts: [], media: mediaPath })
  })
  assert.equal(mediaMessageResponse.status, 201, 'a message can still save uploaded media')

  const automationResponse = await fetch(base + '/api/accounts/' + accountIds[0] + '/jobs', {
    method: 'POST', headers: messageHeaders,
    body: JSON.stringify({
      name: 'Select saved message', messageId: createdMessage.id, toLists: [], toRecipients: [recipientId],
      repeatCount: 1, delaySeconds: [0, 0], scheduleAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    })
  })
  assert.equal(automationResponse.status, 201, 'the saved message can be selected for an automation')
  assert.equal((await automationResponse.json()).job.messageId, createdMessage.id)
  const finalRefreshedState = await (await fetch(base + '/api/state?accountId=' + accountIds[0], { headers: proxyHeaders })).json()
  assert(finalRefreshedState.cfg.messages.some(message => message.id === createdMessage.id), 'the message remains available after another refresh')
  assert(finalRefreshedState.cfg.jobs.some(job => job.messageId === createdMessage.id), 'the automation retains the selected saved message')

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
  assert.equal(stateA.cfg.jobs.find(job => job.id === lifecycleJobId).status, 'cancelled')
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
  assert.equal(restartedA.cfg.jobs.find(job => job.id === lifecycleJobId).status, 'cancelled')
  assert.equal(restartedB.cfg.jobs[0].status, 'scheduled')
  assert.equal(restartedB.cfg.jobs[0].scheduleAt, future)
  for (const id of destinationJobIds) assert(restartedA.cfg.jobs.some(job => job.id === id), 'independent destination automations survive restart')
  await stop(app.child)
  assert.equal(app.output.includes(passwordA), false, 'password is never written to process logs')
})
