import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys'
import cron from 'node-cron'
import pino from 'pino'
import express from 'express'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const CONFIG = './messages.json'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function log(...args) {
  const line = `[${new Date().toLocaleString()}] ${args.join(' ')}`
  console.log(line)
  try { fs.appendFileSync('log.txt', line + '\n') } catch {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }
  catch (e) { log('Could not read messages.json:', e.message); return null }
}

let cfg = loadConfig()
if (!cfg) process.exit(1)

let sock = null
let allGroups = []
let lists = {}
let tasks = []
let pairingRequested = false
let selfWrite = 0
const lastText = {}
const testJobName = process.argv[2] === 'send' ? process.argv[3] : null

process.on('unhandledRejection', e => log('Unhandled error:', e?.message || e))

function resolveList(entries) {
  const out = []
  for (const n of entries) {
    const hits = String(n).endsWith('@g.us')
      ? allGroups.filter(g => g.id === n)
      : allGroups.filter(g => g.subject.toLowerCase().includes(String(n).toLowerCase()))
    if (hits.length === 1) out.push(hits[0])
    else log(hits.length
      ? `  "${n}" matches ${hits.length} groups, make it more specific. Skipped.`
      : `  "${n}" not found. Skipped.`)
  }
  return out
}

function buildLists() {
  lists = {}
  for (const [name, entries] of Object.entries(cfg.groupLists || {})) {
    lists[name] = resolveList(entries)
    log(`List "${name}":`, lists[name].map(g => g.subject).join(' | ') || '(empty)')
  }
}

function pickText(job, key) {
  const pool = Array.isArray(job.texts) && job.texts.length ? job.texts : [job.text || '']
  if (pool.length === 1) return pool[0]
  let t
  do { t = pool[Math.floor(Math.random() * pool.length)] } while (t === lastText[key])
  lastText[key] = t
  return t
}

function buildContent(job, text) {
  const file = job.media || job.image
  if (!file) return { text }
  if (!fs.existsSync(file)) { log('Media file not found:', file); return null }
  const buf = fs.readFileSync(file)
  const ext = path.extname(file).toLowerCase()
  if (['.mp4', '.mov', '.mkv', '.3gp'].includes(ext)) return { video: buf, caption: text }
  return { image: buf, caption: text }
}

async function runJob(job, key) {
  if (!sock) { log(`"${key}" skipped: not connected`); return }
  const content = buildContent(job, pickText(job, key))
  if (!content) return

  const targets = new Map()
  for (const l of job.toLists || []) (lists[l] || []).forEach(g => targets.set(g.id, g))
  log(`Running "${key}" -> ${targets.size} groups${job.toStatus ? ' + status' : ''}`)

  const [minD, maxD] = cfg.delaySeconds || [5, 15]
  for (const g of targets.values()) {
    try { await sock.sendMessage(g.id, content); log('  sent to', g.subject) }
    catch (e) { log('  FAILED for', g.subject, '-', e.message) }
    await sleep((minD + Math.random() * (maxD - minD)) * 1000)
  }

  if (job.toStatus) {
    const jids = (cfg.statusRecipients || []).map(n => String(n).includes('@') ? n : `${n}@s.whatsapp.net`)
    if (!jids.length) { log('  status skipped: statusRecipients is empty'); return }
    try {
      const opts = { statusJidList: jids }
      if (content.text) opts.backgroundColor = job.statusColor || '#315575'
      await sock.sendMessage('status@broadcast', content, opts)
      log('  status posted')
    } catch (e) { log('  status FAILED -', e.message) }
  }
}

function scheduleAll() {
  tasks.forEach(t => t.stop()); tasks = []
  if (!sock || !cfg) return
  buildLists()
  const opts = cfg.timezone ? { timezone: cfg.timezone } : {}
  ;(cfg.jobs || []).forEach((job, i) => {
    const key = job.name || `job${i + 1}`
    if (job.enabled === false) { log(`"${key}" is disabled`); return }
    if (!cron.validate(job.cron)) { log(`"${key}" has an invalid cron: ${job.cron}`); return }
    tasks.push(cron.schedule(job.cron, () => runJob(job, key), opts))
    log(`Scheduled "${key}" (${job.cron})`)
  })
}

let reloadTimer
fs.watchFile(CONFIG, { interval: 2000 }, () => {
  if (Date.now() - selfWrite < 4000) return
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    const fresh = loadConfig()
    if (!fresh) return
    cfg = fresh
    log('messages.json changed, reloading')
    scheduleAll()
  }, 1000)
})

/* ---------------- Dashboard ---------------- */

const sha = s => crypto.createHash('sha256').update(String(s)).digest()
const fails = {}

function auth(req, res, next) {
  const ip = req.ip
  let f = fails[ip]
  if (f && Date.now() - f.t > 15 * 60 * 1000) { delete fails[ip]; f = null }
  if (f && f.count >= 10) return res.status(429).send('Too many attempts. Try again in 15 minutes.')
  const raw = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString()
  const i = raw.indexOf(':')
  const pass = i >= 0 ? raw.slice(i + 1) : ''
  if (i >= 0 && crypto.timingSafeEqual(sha(pass), sha(cfg.dashboardPassword))) { delete fails[ip]; return next() }
  if (raw) fails[ip] = { count: (f?.count || 0) + 1, t: Date.now() }
  res.set('WWW-Authenticate', 'Basic realm="WhatsApp Bot"').status(401).send('Login required')
}

function validate(b) {
  if (!b || typeof b !== 'object') return { error: 'Bad data' }

  const gl = {}
  for (const [k, v] of Object.entries(b.groupLists || {})) {
    const name = k.trim()
    if (!name) return { error: 'A list has no name' }
    gl[name] = (Array.isArray(v) ? v : []).map(String)
  }

  let d = Array.isArray(b.delaySeconds) ? b.delaySeconds.map(Number) : [5, 15]
  if (d.length !== 2 || d.some(n => !isFinite(n)) || d[0] < 3 || d[1] < d[0])
    return { error: 'Delay between groups must be two numbers: minimum 3 seconds, second number not smaller than the first' }

  const tz = String(b.timezone || '').trim() || cfg.timezone || 'UTC'
  try { new Intl.DateTimeFormat('en', { timeZone: tz }) } catch { return { error: `Unknown timezone "${tz}"` } }

  const names = new Set()
  const jobs = []
  for (const [i, j] of (Array.isArray(b.jobs) ? b.jobs : []).entries()) {
    const name = String(j.name || '').trim()
    if (!name) return { error: `Message ${i + 1} needs a name` }
    if (names.has(name)) return { error: `Two messages are both named "${name}"` }
    names.add(name)
    const cr = String(j.cron || '').trim()
    if (!cron.validate(cr)) return { error: `"${name}": the schedule "${cr}" is not valid` }
    const texts = (Array.isArray(j.texts) ? j.texts : []).map(t => String(t).trim()).filter(Boolean)
    const media = String(j.media || '').trim()
    if (!texts.length && !media) return { error: `"${name}" has no message and no image/video` }
    jobs.push({
      name, cron: cr, texts, media: media || undefined,
      toLists: (j.toLists || []).filter(l => l in gl),
      toStatus: !!j.toStatus,
      enabled: j.enabled !== false
    })
  }

  return {
    value: {
      timezone: tz,
      delaySeconds: d,
      statusRecipients: (Array.isArray(b.statusRecipients) ? b.statusRecipients : [])
        .map(s => String(s).replace(/[^0-9]/g, '')).filter(Boolean),
      groupLists: gl,
      jobs
    }
  }
}

function startDashboard() {
  const app = express()
  app.disable('x-powered-by')
  app.use(auth)
  app.use(express.json({ limit: '30mb' }))
  app.use((req, res, next) => { res.set('X-Frame-Options', 'DENY'); next() })

  app.get('/', (req, res) => res.type('html').send(PAGE))

  app.get('/api/state', (req, res) => {
    const { dashboardPassword, phone, dashboardPort, ...safe } = cfg
    res.json({
      cfg: safe,
      groups: allGroups.map(g => ({ id: g.id, subject: g.subject })).sort((a, b) => a.subject.localeCompare(b.subject)),
      connected: !!sock
    })
  })

  app.post('/api/config', (req, res) => {
    const r = validate(req.body)
    if (r.error) return res.status(400).json({ error: r.error })
    const next = { ...cfg, ...r.value }
    selfWrite = Date.now()
    fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2))
    cfg = next
    log('Settings saved from dashboard')
    scheduleAll()
    res.json({ ok: true })
  })

  app.post('/api/upload', (req, res) => {
    const name = String(req.body?.name || '').replace(/[^a-zA-Z0-9._-]/g, '_')
    const ext = path.extname(name).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'].includes(ext))
      return res.status(400).json({ error: 'Use jpg, png, webp, mp4 or mov' })
    const buf = Buffer.from(String(req.body?.data || ''), 'base64')
    if (!buf.length || buf.length > 16 * 1024 * 1024) return res.status(400).json({ error: 'File is empty or over 16 MB' })
    fs.mkdirSync('images', { recursive: true })
    const file = `images/${Date.now()}-${name}`
    fs.writeFileSync(file, buf)
    res.json({ path: file })
  })

  app.post('/api/send', (req, res) => {
    const job = (cfg.jobs || [])[req.body?.index]
    if (!job) return res.status(400).json({ error: 'Save first, then send' })
    if (!sock) return res.status(400).json({ error: 'The bot is not connected to WhatsApp right now' })
    runJob(job, job.name || 'job').catch(e => log('Send error:', e.message))
    res.json({ ok: true })
  })

  app.get('/api/log', (req, res) => {
    let t = ''
    try { t = fs.readFileSync('log.txt', 'utf8').trim().split('\n').slice(-60).join('\n') } catch {}
    res.json({ log: t })
  })

  const port = cfg.dashboardPort || 3000
  app.listen(port, '0.0.0.0', () => log('Dashboard running on port', port)).on('error', e => log('Dashboard failed:', e.message))
}

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bot</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1a1a1a}
header{position:sticky;top:0;background:#075e54;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px;z-index:5}
main{max-width:820px;margin:0 auto;padding:12px}
h2{font-size:17px;margin:22px 0 8px}
.card{background:#fff;border-radius:10px;padding:12px;margin-bottom:10px;box-shadow:0 1px 3px #0002}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
input[type=text],input[type=number],input[type=time],select,textarea{width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;font:inherit}
textarea{min-height:90px}
button{padding:8px 12px;border:0;border-radius:6px;background:#128c7e;color:#fff;font:inherit;cursor:pointer}
button.sm{padding:5px 9px;font-size:13px}.danger{background:#c0392b}.gray{background:#667}
.muted{color:#667;font-size:13px;margin-top:6px}
.g{display:block;padding:4px 0}
.gl{max-height:240px;overflow:auto;border:1px solid #ddd;border-radius:6px;padding:6px;margin-top:6px}
pre{background:#111;color:#cfc;padding:10px;border-radius:8px;overflow:auto;max-height:260px;font-size:12px;white-space:pre-wrap}
.on{color:#7fff9f}.off{color:#ffb3a7}
</style></head><body>
<header><b>WhatsApp Bot</b><span id="st"></span><button onclick="saveAll()">Save all</button></header>
<main id="app">Loading...</main>
<script>
var S = null;

function api(path, method, body) {
  return fetch(path, { method: method || 'GET', headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Error'); return j; }); });
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function listNames() { return Object.keys(S.cfg.groupLists); }

function render() {
  document.getElementById('st').innerHTML = S.connected ? '<span class="on">&#9679; Connected</span>' : '<span class="off">&#9679; Offline</span>';
  var names = listNames();
  var h = '<h2>1. Group lists</h2>';

  names.forEach(function (n, i) {
    var ids = S.cfg.groupLists[n];
    h += '<div class="card"><div class="row"><b style="flex:1">' + esc(n) + '</b><span class="muted" id="cnt' + i + '">' + ids.length + ' selected</span><button class="sm danger" onclick="delList(' + i + ')">Delete</button></div>';
    h += '<details><summary>Choose groups</summary><input type="text" placeholder="Search groups..." oninput="filt(this)"><div class="gl">';
    S.groups.forEach(function (g, j) {
      h += '<label class="g" data-s="' + esc(g.subject.toLowerCase()) + '"><input type="checkbox" ' + (ids.indexOf(g.id) >= 0 ? 'checked ' : '') + 'onchange="tog(' + i + ',' + j + ',this.checked)"> ' + esc(g.subject) + '</label>';
    });
    h += '</div></details></div>';
  });
  h += '<div class="row"><input type="text" id="newlist" placeholder="New list name, e.g. list1" style="flex:1"><button onclick="addList()">Add list</button></div>';

  h += '<h2>2. Messages and schedules</h2>';
  S.cfg.jobs.forEach(function (j, i) {
    h += '<div class="card">';
    h += '<div class="row"><input type="text" value="' + esc(j.name) + '" oninput="S.cfg.jobs[' + i + '].name=this.value" style="flex:1"><label><input type="checkbox" ' + (j.enabled !== false ? 'checked ' : '') + 'onchange="S.cfg.jobs[' + i + '].enabled=this.checked"> On</label></div>';
    h += '<div class="muted">Message. To rotate between several, put a line with only --- between them (one is picked at random each time).</div>';
    h += '<textarea oninput="setTexts(' + i + ',this.value)">' + esc((j.texts || []).join('\n---\n')) + '</textarea>';
    h += '<div class="muted">Schedule</div><div class="row"><select onchange="preset(' + i + ',this.value)"><option value="">Quick pick...</option>'
      + '<option value="*/30 * * * *">Every 30 minutes</option><option value="0 * * * *">Every hour</option><option value="0 */2 * * *">Every 2 hours</option>'
      + '<option value="0 */6 * * *">Every 6 hours</option><option value="0 */12 * * *">Every 12 hours</option><option value="0 9 * * *">Daily at 9:00</option>'
      + '<option value="0 9,17 * * *">Daily at 9:00 and 17:00</option></select>'
      + '<span class="muted">or daily at</span><input type="time" onchange="atTime(' + i + ',this.value)" style="width:auto"></div>';
    h += '<input type="text" id="cr' + i + '" value="' + esc(j.cron) + '" oninput="S.cfg.jobs[' + i + '].cron=this.value">';
    h += '<div class="muted">Schedule code: minute hour day month weekday</div>';
    h += '<div class="row"><span class="muted">Image/video: ' + (j.media ? esc(j.media) : 'none') + '</span><input type="file" accept="image/*,video/mp4,video/quicktime" onchange="upload(' + i + ',this)">' + (j.media ? '<button class="sm gray" onclick="rmMedia(' + i + ')">Remove</button>' : '') + '</div>';
    h += '<div class="muted">Send to these lists</div><div class="row">';
    names.forEach(function (n, k) {
      h += '<label><input type="checkbox" ' + ((j.toLists || []).indexOf(n) >= 0 ? 'checked ' : '') + 'onchange="togL(' + i + ',' + k + ',this.checked)"> ' + esc(n) + '</label>';
    });
    if (!names.length) h += '<span class="muted">Create a list first</span>';
    h += '</div><div class="row"><label><input type="checkbox" ' + (j.toStatus ? 'checked ' : '') + 'onchange="S.cfg.jobs[' + i + '].toStatus=this.checked"> Also post to WhatsApp status</label></div>';
    h += '<div class="row"><button class="sm" onclick="sendNow(' + i + ')">Send now</button><button class="sm danger" onclick="delJob(' + i + ')">Delete</button></div></div>';
  });
  h += '<button onclick="addJob()">+ Add message</button>';

  h += '<h2>3. Status viewers</h2><div class="card"><div class="muted">Phone numbers with country code, one per line. Only these contacts will see your status posts.</div>';
  h += '<textarea oninput="setSR(this.value)">' + esc((S.cfg.statusRecipients || []).join('\n')) + '</textarea></div>';

  h += '<h2>4. Settings</h2><div class="card"><div class="muted">Timezone</div><input type="text" value="' + esc(S.cfg.timezone) + '" oninput="S.cfg.timezone=this.value">';
  h += '<div class="muted">Pause between groups (seconds, minimum and maximum)</div><div class="row"><input type="number" value="' + S.cfg.delaySeconds[0] + '" oninput="S.cfg.delaySeconds[0]=Number(this.value)" style="width:90px"><input type="number" value="' + S.cfg.delaySeconds[1] + '" oninput="S.cfg.delaySeconds[1]=Number(this.value)" style="width:90px"></div></div>';

  h += '<h2>Recent activity</h2><pre id="lg"></pre><button class="sm gray" onclick="loadLog()">Refresh</button><div style="height:60px"></div>';
  document.getElementById('app').innerHTML = h;
}

function filt(el) {
  var q = el.value.toLowerCase();
  var labels = el.parentNode.querySelectorAll('label.g');
  for (var k = 0; k < labels.length; k++) labels[k].style.display = labels[k].getAttribute('data-s').indexOf(q) >= 0 ? '' : 'none';
}
function tog(i, j, on) {
  var n = listNames()[i], id = S.groups[j].id, a = S.cfg.groupLists[n], p = a.indexOf(id);
  if (on && p < 0) a.push(id);
  if (!on && p >= 0) a.splice(p, 1);
  document.getElementById('cnt' + i).textContent = a.length + ' selected';
}
function addList() {
  var el = document.getElementById('newlist'), n = el.value.trim();
  if (!n) return;
  if (S.cfg.groupLists[n]) { alert('That list already exists'); return; }
  S.cfg.groupLists[n] = [];
  render();
}
function delList(i) {
  var n = listNames()[i];
  if (!confirm('Delete list "' + n + '"?')) return;
  delete S.cfg.groupLists[n];
  S.cfg.jobs.forEach(function (j) { j.toLists = (j.toLists || []).filter(function (x) { return x !== n; }); });
  render();
}
function addJob() {
  S.cfg.jobs.push({ name: 'message' + (S.cfg.jobs.length + 1), cron: '0 9 * * *', texts: [''], toLists: [], toStatus: false, enabled: true });
  render();
}
function delJob(i) {
  if (!confirm('Delete "' + S.cfg.jobs[i].name + '"?')) return;
  S.cfg.jobs.splice(i, 1);
  render();
}
function setTexts(i, v) { S.cfg.jobs[i].texts = v.split(/\n\s*---\s*\n/).map(function (t) { return t.trim(); }).filter(Boolean); }
function setSR(v) { S.cfg.statusRecipients = v.split(/[\s,]+/).filter(Boolean); }
function preset(i, v) { if (!v) return; S.cfg.jobs[i].cron = v; document.getElementById('cr' + i).value = v; }
function atTime(i, v) {
  if (!v) return;
  var p = v.split(':'), c = parseInt(p[1], 10) + ' ' + parseInt(p[0], 10) + ' * * *';
  S.cfg.jobs[i].cron = c; document.getElementById('cr' + i).value = c;
}
function togL(i, k, on) {
  var n = listNames()[k], a = S.cfg.jobs[i].toLists = S.cfg.jobs[i].toLists || [], p = a.indexOf(n);
  if (on && p < 0) a.push(n);
  if (!on && p >= 0) a.splice(p, 1);
}
function rmMedia(i) { S.cfg.jobs[i].media = ''; render(); }
function upload(i, el) {
  var f = el.files[0];
  if (!f) return;
  if (f.size > 16 * 1024 * 1024) { alert('File too large (max 16 MB)'); return; }
  var r = new FileReader();
  r.onload = function () {
    api('/api/upload', 'POST', { name: f.name, data: r.result.split(',')[1] })
      .then(function (d) { S.cfg.jobs[i].media = d.path; render(); })
      .catch(function (e) { alert(e.message); });
  };
  r.readAsDataURL(f);
}
function refresh() {
  return api('/api/state').then(function (d) { S = d; render(); loadLog(); });
}
function saveAll() {
  return api('/api/config', 'POST', S.cfg)
    .then(function () { alert('Saved'); return refresh(); })
    .catch(function (e) { alert('Not saved: ' + e.message); });
}
function sendNow(i) {
  var j = S.cfg.jobs[i];
  if (!confirm('Save and send "' + j.name + '" now to its lists?')) return;
  api('/api/config', 'POST', S.cfg)
    .then(function () { return api('/api/send', 'POST', { index: i }); })
    .then(function () { alert('Sending started. Refresh the activity log in a minute.'); setTimeout(loadLog, 5000); })
    .catch(function (e) { alert(e.message); });
}
function loadLog() {
  api('/api/log').then(function (d) {
    var el = document.getElementById('lg');
    if (el) { el.textContent = d.log || '(nothing yet)'; el.scrollTop = el.scrollHeight; }
  });
}
refresh();
</script></body></html>`

/* ---------------- WhatsApp connection ---------------- */

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    logger: pino({ level: 'silent' })
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !state.creds.registered && !pairingRequested) {
      pairingRequested = true
      try {
        log('PAIRING CODE:', await sock.requestPairingCode(cfg.phone))
      } catch (e) {
        pairingRequested = false
        log('Pairing failed:', e.message)
      }
    }

    if (connection === 'open') {
      log('Connected')
      allGroups = Object.values(await sock.groupFetchAllParticipating())
      fs.writeFileSync('groups.txt', allGroups.map(g => `${g.subject} => ${g.id}`).join('\n'))
      log(`Saved ${allGroups.length} groups to groups.txt`)

      if (testJobName) {
        buildLists()
        const idx = (cfg.jobs || []).findIndex((j, i) => (j.name || `job${i + 1}`) === testJobName)
        if (idx === -1) { log('No job named', testJobName); process.exit(1) }
        await runJob(cfg.jobs[idx], testJobName)
        log('Test finished')
        await sleep(3000)
        process.exit(0)
      }
      scheduleAll()
    }

    if (connection === 'close') {
      tasks.forEach(t => t.stop()); tasks = []
      sock = null
      const code = lastDisconnect?.error?.output?.statusCode
      log('Connection closed, reason code:', code)
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000)
      else log('Logged out. Delete the auth folder and restart.')
    }
  })
}

if (!testJobName) {
  if (!cfg.dashboardPassword || String(cfg.dashboardPassword).length < 8)
    log('Dashboard is OFF: set "dashboardPassword" (8+ characters) in messages.json')
  else startDashboard()
}
start()