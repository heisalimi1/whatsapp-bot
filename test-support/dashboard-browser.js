import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function waitFor(check, message) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try { if (await check()) return } catch {}
    await pause(50)
  }
  throw new Error(message)
}

/** Optional real Chromium check. No browser package or runtime dependency required. */
export async function checkDashboardBrowser({ base, cookie, accountId, messageId, screenshotDir }) {
  const executable = [
    process.env.DASHBOARD_TEST_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(candidate => candidate && fs.existsSync(candidate))
  if (!executable) return false
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-browser-test-'))
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true })
  let socket, requestId = 0
  const pending = new Map(), errors = [], events = []
  try {
    await waitFor(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'Chromium did not open its debugging interface.')
    const [port, endpoint] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
    socket = new WebSocket('ws://127.0.0.1:' + port + endpoint)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    socket.addEventListener('message', event => {
      const result = JSON.parse(event.data)
      if (result.id) {
        const request = pending.get(result.id)
        if (!request) return
        pending.delete(result.id)
        clearTimeout(request.timer)
        if (result.error) request.reject(new Error(result.error.message))
        else request.resolve(result.result)
      } else {
        events.push(result)
        if (result.method === 'Runtime.exceptionThrown' ||
            (result.method === 'Runtime.consoleAPICalled' && result.params.type === 'error')) errors.push(result.method)
      }
    })
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++requestId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timed out: ' + method)) }, 10000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const command = (method, params) => send(method, params, sessionId)
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error('Browser evaluation failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text).split('\n')[0])
      return result.result.value
    }
    await command('Runtime.enable')
    await command('Network.enable')
    await command('Page.enable')
    const equals = cookie.indexOf('=')
    await command('Network.setCookie', { name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: base, httpOnly: true, secure: false })
    await command('Emulation.setDeviceMetricsOverride', { width: 1365, height: 1000, deviceScaleFactor: 1, mobile: false })
    await command('Page.navigate', { url: base })
    await waitFor(() => evaluate('typeof S !== "undefined" && S && !!S.cfg && S.selectedAccountId === ' + JSON.stringify(accountId)), 'The authenticated dashboard did not load.')
    await evaluate('showView("jobs");document.getElementById("jobMessage").value=' + JSON.stringify(messageId) + ';updateJobSummary()')
    assert.equal(await evaluate('document.getElementById("jobPreview").textContent'), 'hi this is test message')

    for (const [name, groups, status] of [['Browser Groups only', true, false], ['Browser Status only', false, true], ['Browser Groups and Status', true, true]]) {
      await evaluate('(function(){document.getElementById("jobName").value=' + JSON.stringify(name) + ';' +
        'for(const [id,on] of [["jobSendGroups",' + groups + '],["jobToStatus",' + status + ']]){const input=document.getElementById(id);if(input.checked!==on)input.click()}' +
        'const list=document.querySelector(".jobList");if(groupsEnabled()&&!list.checked)list.click();' +
        'function groupsEnabled(){return document.getElementById("jobSendGroups").checked}' +
        'document.getElementById("jobMode").value="at";scheduleMode();' +
        'const date=new Date(Date.now()+3600000);document.getElementById("jobDate").value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);' +
        'document.getElementById("jobDate").dispatchEvent(new Event("change",{bubbles:true}));})()')
      assert.equal(await evaluate('getComputedStyle(document.getElementById("jobGroupPanel")).display !== "none"'), groups)
      assert.equal(await evaluate('getComputedStyle(document.getElementById("jobStatusPanel")).display !== "none"'), status)
      await evaluate('document.getElementById("createJobButton").click()')
      await waitFor(() => evaluate('S.cfg.jobs.some(job=>job.name===' + JSON.stringify(name) + ')&&!document.getElementById("createJobButton").disabled'), 'The browser did not save ' + name)
      assert.equal(await evaluate('document.getElementById("jobFeedback").textContent'), 'Automation scheduled successfully.')
      const saved = await evaluate('S.cfg.jobs.find(job=>job.name===' + JSON.stringify(name) + ')')
      assert.equal(saved.toStatus, status)
      assert.deepEqual(saved.toLists, groups ? ['A list'] : [])
    }
    await evaluate('(function(){document.getElementById("jobName").value="Browser interval Status";' +
      'for(const [id,on] of [["jobSendGroups",false],["jobToStatus",true]]){const input=document.getElementById(id);if(input.checked!==on)input.click()}' +
      'document.getElementById("jobPacing").value="fixed";pacingMode();document.getElementById("jobSendInterval").value="30";' +
      'document.getElementById("jobIntervalUnit").value="60";document.getElementById("jobIntervalUnit").dispatchEvent(new Event("change",{bubbles:true}));' +
      'document.getElementById("jobMode").value="interval";scheduleMode();document.getElementById("jobInterval").value="*/15 * * * *";updateJobSummary();})()')
    assert.equal(await evaluate('document.getElementById("jobSendInterval").value'), '0.5', 'changing seconds to minutes keeps the chosen interval')
    assert.equal(await evaluate('getComputedStyle(document.getElementById("fixedPacing")).display !== "none"'), true)
    await evaluate('document.getElementById("createJobButton").click()')
    await waitFor(() => evaluate('S.cfg.jobs.some(job=>job.name==="Browser interval Status")&&!document.getElementById("createJobButton").disabled'), 'The browser did not save the recurring Status interval')
    const intervalJob = await evaluate('S.cfg.jobs.find(job=>job.name==="Browser interval Status")')
    assert.deepEqual(intervalJob.delaySeconds, [30, 30])
    assert.equal(intervalJob.cron, '*/15 * * * *')
    await command('Page.reload', { ignoreCache: true })
    await waitFor(() => evaluate('typeof S !== "undefined" && S && !!S.cfg && S.cfg.jobs.some(job=>job.name==="Browser Status only")'), 'Browser automation data did not survive refresh.')
    await evaluate('showView("jobs");document.getElementById("jobMessage").value=' + JSON.stringify(messageId) + ';document.getElementById("jobToStatus").click();document.querySelector(".jobList").click();updateJobSummary()')
    assert.equal(await evaluate('document.getElementById("jobSendGroups").checked&&document.getElementById("jobToStatus").checked'), true)
    assert.match(await evaluate('document.getElementById("jobDestinationSummary").textContent'), /1 group list \+ WhatsApp Status/)
    assert(await evaluate('document.getElementById("jobCards").textContent.includes("Browser Status only")'))
    const screenshot = async name => {
      if (!screenshotDir) return
      fs.mkdirSync(screenshotDir, { recursive: true })
      const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(path.join(screenshotDir, name), Buffer.from(data, 'base64'))
    }
    await screenshot('desktop.png')
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'the mobile dashboard has no horizontal page overflow')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".destination-grid")).gridTemplateColumns.split(" ").length'), 1)
    await screenshot('mobile.png')
    assert.deepEqual(errors, [], 'real Chromium reported no script or console errors')
    assert.equal(events.some(event => event.method === 'Network.responseReceived' && event.params.response.url.includes('/jobs') && event.params.response.status >= 400), false)
    await send('Browser.close')
    return true
  } finally {
    if (socket) socket.close()
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser check closed.')) }
    if (child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)])
      if (child.exitCode === null) child.kill()
    }
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
