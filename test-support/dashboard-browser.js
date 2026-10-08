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
export async function checkDashboardBrowser({ base, cookie, secondCookie = cookie, accountId, messageId, screenshotDir }) {
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
    await evaluate('showView("accounts");document.getElementById("newAccountPhone").value="+123 456 789 012 345"')
    for (const width of [320, 360, 390, 768, 1365]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
      const field = await evaluate('(function(){const input=document.getElementById("newAccountPhone"),style=getComputedStyle(input),form=document.querySelector(".account-connect-form"),canvas=document.createElement("canvas"),context=canvas.getContext("2d");context.font=style.font;return {width:input.getBoundingClientRect().width,formWidth:form.getBoundingClientRect().width,available:input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),textWidth:context.measureText(input.value).width+input.value.length*parseFloat(style.letterSpacing||0),fontSize:parseFloat(style.fontSize),type:input.type,inputMode:input.inputMode,direction:style.direction,value:input.value}})()')
      assert(Math.abs(field.width-field.formWidth)<2, 'the phone field fills the connection form at '+width+'px')
      assert(field.textWidth<field.available, 'the complete formatted 15-digit number is visible at '+width+'px')
      assert(field.fontSize>=16);assert.equal(field.type,'tel');assert.equal(field.inputMode,'tel');assert.equal(field.direction,'ltr')
      assert.equal(field.value,'+123 456 789 012 345','viewport changes preserve the typed number')
    }
    await command('Emulation.setDeviceMetricsOverride', { width: 1365, height: 1000, deviceScaleFactor: 1, mobile: false })
    await evaluate('document.getElementById("newAccountPhone").focus();document.getElementById("newAccountPhone").setSelectionRange(4,4);loadState()')
    assert.equal(await evaluate('document.getElementById("newAccountPhone").value'), '+123 456 789 012 345', 'live polling preserves the phone draft')
    assert.equal(await evaluate('document.getElementById("newAccountPhone").selectionStart'),4,'polling preserves the editing caret')
    await evaluate('document.getElementById("newAccountPhone").blur()')
    await evaluate('showView("accounts");document.getElementById("newAccountPhone").value="12";document.getElementById("connectAccountButton").click()')
    assert.match(await evaluate('document.getElementById("accountFeedback").textContent'), /country code/)
    assert.equal(await evaluate('document.getElementById("connectAccountButton").disabled'), false)
    await evaluate('window.connectionTestFetch=window.fetch;window.connectionTestCount=0;window.fetch=function(url,options){if(url==="/api/accounts"&&options?.method==="POST"){window.connectionTestCount++;return new Promise(resolve=>{window.connectionTestResolve=()=>resolve(new Response(JSON.stringify({account:{id:S.selectedAccountId,status:"connecting"},pairingCode:"FIXTURE-CODE",reused:true}),{status:201,headers:{"Content-Type":"application/json"}}))})}return window.connectionTestFetch(url,options)};document.getElementById("newAccountPhone").value="12345678901";document.getElementById("connectAccountButton").click();document.getElementById("connectAccountButton").click()')
    assert.equal(await evaluate('window.connectionTestCount'), 1, 'a double click submits only one connection request')
    assert.equal(await evaluate('document.getElementById("connectAccountButton").disabled'), true)
    await evaluate('window.connectionTestResolve()')
    await waitFor(() => evaluate('!document.getElementById("connectAccountButton").disabled&&document.getElementById("accountFeedback").textContent.includes("Pairing code ready")'), 'Connection progress did not finish with clear pairing instructions.')
    await evaluate('window.fetch=window.connectionTestFetch;pairCode="";document.getElementById("newAccountPhone").value="";renderAccounts()')
    const { browserContextId } = await send('Target.createBrowserContext')
    const secondTarget = await send('Target.createTarget', { url: 'about:blank', browserContextId })
    const secondSession = await send('Target.attachToTarget', { targetId: secondTarget.targetId, flatten: true })
    const mobileCommand = (method, params) => send(method, params, secondSession.sessionId)
    const mobileEvaluate = async expression => {
      const result = await mobileCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error('Second browser evaluation failed: ' + result.exceptionDetails.text)
      return result.result.value
    }
    await mobileCommand('Runtime.enable')
    await mobileCommand('Network.enable')
    await mobileCommand('Page.enable')
    const secondEquals = secondCookie.indexOf('=')
    await mobileCommand('Network.setCookie', { name: secondCookie.slice(0, secondEquals), value: secondCookie.slice(secondEquals + 1), url: base, httpOnly: true, secure: false })
    await mobileCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await mobileCommand('Page.navigate', { url: base })
    await waitFor(() => mobileEvaluate('typeof S!=="undefined"&&!!S?.cfg&&S.selectedAccountId===' + JSON.stringify(accountId)), 'The independent mobile dashboard did not load.')
    assert.equal(await mobileEvaluate('S.account.status'), await evaluate('S.account.status'), 'both devices show the same backend connection state')
    await mobileEvaluate('showView("messages");document.getElementById("messageName").value="Unsaved mobile draft";document.getElementById("messageName").focus()')
    await evaluate('showView("groups");document.getElementById("newListName").value="Browser shared list";addList()')
    assert.equal(await evaluate('Object.hasOwn(S.cfg.groupLists,"Browser shared list")'), false, 'creating a draft does not persist a group list')
    await evaluate('(async function(){const names=groupListNames();const i=names.indexOf("Browser shared list");toggleGroup(i,0,true);await saveGroupSelection(i)})()')
    await waitFor(() => mobileEvaluate('S.cfg.groupLists["Browser shared list"]?.[0]==="test-group@g.us"'), 'Focused mobile polling did not receive the group list saved by the desktop.')
    assert.equal(await mobileEvaluate('document.getElementById("messageName").value'), 'Unsaved mobile draft', 'live polling preserves the focused form draft')
    await mobileEvaluate('document.getElementById("messageName").blur();showView("groups")')
    await waitFor(() => mobileEvaluate('document.getElementById("listCards").textContent.includes("Browser shared list")'), 'The mobile saved list did not render after blur.')
    await mobileCommand('Page.reload', { ignoreCache: true })
    await waitFor(() => mobileEvaluate('typeof S!=="undefined"&&S?.cfg?.groupLists["Browser shared list"]?.[0]==="test-group@g.us"'), 'The saved list did not survive the independent browser refresh.')
    assert.deepEqual(await mobileEvaluate('S.groups'), await evaluate('S.groups'))
    await evaluate('(async function(){delete S.cfg.groupLists["Browser shared list"];await saveData()})()')
    await evaluate('showView("jobs");document.getElementById("jobMessage").value=' + JSON.stringify(messageId) + ';updateJobSummary()')
    assert.equal(await evaluate('document.getElementById("jobPreview").textContent'), 'hi this is test message')
    await evaluate('window.statusPreviewFetch=window.fetch;window.statusPreviewRequests=0;window.fetch=function(url,options){if(url.endsWith("/status/preview")){window.statusPreviewRequests++;return new Promise(resolve=>{window.resolveStatusPreview=()=>resolve(new Response(JSON.stringify({ok:true,audience:{eligibleCount:12,unmappedCount:1},message:"12 contacts can receive your Status."}),{status:200,headers:{"Content-Type":"application/json"}}))})}return window.statusPreviewFetch(url,options)};syncStatusContacts();syncStatusContacts()')
    assert.equal(await evaluate('window.statusPreviewRequests'), 1, 'parallel audience checks coalesce in the dashboard')
    assert.equal(await evaluate('document.getElementById("syncStatusContacts").disabled'), true)
    await evaluate('window.resolveStatusPreview()')
    await waitFor(() => evaluate('!document.getElementById("syncStatusContacts").disabled'), 'Status eligibility check did not finish.')
    assert.equal(await evaluate('document.getElementById("toast").textContent'), '12 contacts can receive your Status.')
    await evaluate('window.fetch=window.statusPreviewFetch')

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
      'document.getElementById("jobMode").value="interval";scheduleMode();document.getElementById("jobEvery").value="17";document.getElementById("jobEveryUnit").value="minutes";updateJobSummary();})()')
    assert.equal(await evaluate('document.getElementById("jobSendInterval").value'), '0.5', 'changing seconds to minutes keeps the chosen interval')
    assert.equal(await evaluate('getComputedStyle(document.getElementById("fixedPacing")).display !== "none"'), true)
    await evaluate('document.getElementById("createJobButton").click()')
    await waitFor(() => evaluate('S.cfg.jobs.some(job=>job.name==="Browser interval Status")&&!document.getElementById("createJobButton").disabled'), 'The browser did not save the recurring Status interval')
    const intervalJob = await evaluate('S.cfg.jobs.find(job=>job.name==="Browser interval Status")')
    assert.deepEqual(intervalJob.delaySeconds, [30, 30])
    assert.deepEqual(intervalJob.interval, { value: 17, unit: 'minutes' });assert.equal(intervalJob.cron,'')
    const clickJobControl = (id, label) => '(function(){const button=[...document.querySelectorAll("#jobCards button")].find(b=>b.textContent===' + JSON.stringify(label) + '&&b.getAttribute("onclick").includes(' + JSON.stringify(id) + '));if(!button)throw Error("Missing schedule control");button.click()})()'
    await evaluate(clickJobControl(intervalJob.id, 'Pause'))
    await waitFor(() => evaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').status==="paused"'), 'Pause did not persist.')
    await evaluate(clickJobControl(intervalJob.id, 'Edit'))
    assert.equal(await evaluate('document.getElementById("jobEvery").value'), '17')
    await evaluate('document.getElementById("jobEvery").value="2";document.getElementById("jobEveryUnit").value="hours";document.getElementById("jobIntervalUnit").value="3600";pacingMode();document.getElementById("jobSendInterval").value="2";document.getElementById("createJobButton").click()')
    await waitFor(() => evaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').interval.unit==="hours"&&!document.getElementById("createJobButton").disabled'), 'Editing the schedule did not save.')
    assert.equal(await evaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').status'), 'paused')
    assert.deepEqual(await evaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').delaySeconds'), [7200,7200])
    await evaluate(clickJobControl(intervalJob.id, 'Resume'))
    await waitFor(() => evaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').status==="scheduled"'), 'Resume did not persist.')
    await mobileCommand('Page.reload', { ignoreCache: true })
    await waitFor(() => mobileEvaluate('typeof S!=="undefined"&&S?.cfg?.jobs.some(j=>j.id===' + JSON.stringify(intervalJob.id) + '&&j.interval.unit==="hours")'), 'The edited schedule did not survive mobile refresh.')
    await mobileEvaluate('showView("jobs")')
    await mobileEvaluate(clickJobControl(intervalJob.id, 'Edit'))
    assert.equal(await mobileEvaluate('document.getElementById("jobIntervalUnit").value'), '3600', 'editing restores readable hour units')
    await mobileEvaluate('document.getElementById("jobEvery").value="3";document.getElementById("jobEveryUnit").value="days";document.getElementById("jobIntervalUnit").value="86400";pacingMode();document.getElementById("jobSendInterval").value="1";document.getElementById("createJobButton").click()')
    await waitFor(() => mobileEvaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').interval.unit==="days"&&!document.getElementById("createJobButton").disabled'), 'The mobile day interval did not save.')
    assert(await mobileEvaluate('document.documentElement.scrollWidth<=window.innerWidth'), 'the mobile schedule editor has no horizontal overflow')
    assert.deepEqual(await mobileEvaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').delaySeconds'), [86400,86400])
    await mobileEvaluate(clickJobControl(intervalJob.id, 'Pause'))
    await waitFor(() => mobileEvaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').status==="paused"'), 'Mobile pause did not save.')
    await mobileEvaluate(clickJobControl(intervalJob.id, 'Resume'))
    await waitFor(() => mobileEvaluate('S.cfg.jobs.find(j=>j.id===' + JSON.stringify(intervalJob.id) + ').status==="scheduled"'), 'Mobile resume did not save.')
    await mobileEvaluate('window.confirm=()=>true;' + clickJobControl(intervalJob.id, 'Delete'))
    await waitFor(() => mobileEvaluate('!S.cfg.jobs.some(j=>j.id===' + JSON.stringify(intervalJob.id) + ')'), 'Mobile delete did not remove the schedule.')
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
