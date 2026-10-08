import cron from 'node-cron'
import express from 'express'
import crypto from 'crypto'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { listAccounts, getAccountSocket, getAccountStatusAudience, syncAccountContacts, createAccount, getAccount, ownsAccount, claimLegacyAccounts, reconnectAccount, disconnectAccount, removeAccount, closeAllAccounts, onAccountConnected } from './whatsapp-manager.js'
import { loadAutomation, saveAutomation, loadGroupSnapshot, saveGroupSnapshot, makeId } from './automation-store.js'
import { normalizeDestinations, buildDeliveryPlan } from './automation-delivery.js'
import { recurring, recoverInterruptedJob, validSendingDelays, intervalMilliseconds, nextIntervalRun, parseSchedule, createDeliveryRun, dispatchDeliveryRun, runMetrics } from './recurring-schedules.js'
import { allowRate, tokensMatch } from './dashboard-security.js'
import { cleanupExpiredAuthRecords, closeAuthStore, consumePasswordReset, createPasswordReset, createSession, createUser, destroySession, findUser, normalizeEmail, sessionForRequest, verifyUserPassword } from './auth-store.js'
import { sendPasswordResetEmail } from './password-reset-mailer.js'
import { FORGOT_PASSWORD_PAGE, LOGIN_PAGE as AUTH_LOGIN_PAGE, RESET_PASSWORD_PAGE, SIGNUP_PAGE } from './auth-pages.js'
import { workspaceContext, selectWorkspace, workspaceMembers, createWorkspaceInvite, acceptWorkspaceInvite, removeWorkspaceMember, renameWorkspace, closeWorkspaceStore } from './workspace-store.js'

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  try { process.loadEnvFile(path.resolve('.env')) }
  catch { console.error('Could not load the private environment file.') }
}

const CONFIG = path.resolve('messages.local.json')
const DEFAULT_CONFIG = path.resolve('messages.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const logBuffer = []
const MAX_LOG_LINES = 500

function log(...args) {
  const safe = args.map(value => String(value ?? '').replace(/[\r\n\t]+/g, ' '))
  const line = `[${new Date().toLocaleString()}] ${redactLogText(safe.join(' '))}`
  console.log(line)
  logBuffer.push(line)
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES)
}

function redactLogText(value) {
  return String(value || '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key redacted]')
    .replace(/\b(password|passwd|token|secret|authorization|cookie|pairing code|api[_-]?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]')
    .replace(/\bpair(?:ing)? code(?:\s+is|\s*[:=])?\s+[A-Z0-9-]{4,}/ig, 'pairing code [redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/ig, '[authorization redacted]')
    .replace(/(?:[A-Za-z]:\\|\/(?:home|var|tmp|root|Users)\/)[^\r\n]*/g, '[path redacted]')
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, x => `${'•'.repeat(Math.max(0, x.replace(/\D/g, '').length - 4))}${x.replace(/\D/g, '').slice(-4)}`)
}

function loadConfig() {
  for (const source of [CONFIG, DEFAULT_CONFIG]) {
    if (!fs.existsSync(source)) continue
    try {
      const data = JSON.parse(fs.readFileSync(source, 'utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid configuration shape')
      delete data.dashboardPassword
      delete data.dashboardPasswordHash
      return data
    } catch {
      if (source === CONFIG) log('Ignoring invalid messages.local.json; using messages.json defaults.')
      else log('Could not read the default messages.json configuration.')
    }
  }
  return null
}

let cfg = loadConfig()
if (!cfg) process.exit(1)

cleanupExpiredAuthRecords()

const accountGroups = new Map()
const accountData = new Map()
const accountDataLoads = new Map()
const cronTasks = new Map()
const oneShotTimers = new Map()
const runningJobs = new Set()
const activeJobPromises = new Map()
const queuedJobs = new Map()
const stopRequests = new Map()
const MAX_CONCURRENT_JOBS = 2
const MAX_JOBS_PER_ACCOUNT = 500
const SHUTDOWN_TIMEOUT_MS = 25000
let shuttingDown = false
let shutdownPromise
let dashboardServer
let schedulerStarted = false
let processCpuSample = { at: Date.now(), usage: process.cpuUsage() }
let selfWrite = 0
const testJobName = process.argv[2] === 'send' ? process.argv[3] : null

process.on('unhandledRejection', () => log('Unhandled asynchronous operation failed.'))

async function dataFor(accountId) {
  if (accountData.has(accountId)) return accountData.get(accountId)
  if (accountDataLoads.has(accountId)) return accountDataLoads.get(accountId)
  const loading = (async () => {
  const account = await getAccount(accountId)
  if (!account) throw new Error('Account not found.')
  const accounts = await listAccounts()
  const legacy = accounts[0]?.id === accountId ? {
    timezone: cfg.timezone, delaySeconds: cfg.delaySeconds, statusRecipients: cfg.statusRecipients,
    groupLists: cfg.groupLists, jobs: cfg.jobs
  } : {}
  const data = loadAutomation(accountId, legacy)
  if (!accountGroups.has(accountId)) {
    try { const snapshot = loadGroupSnapshot(accountId); accountGroups.set(accountId, snapshot.groups); groupSyncTimes.set(accountId, snapshot.syncedAt) } catch { log('Saved group snapshot could not be loaded for account', accountId) }
  }
  accountData.set(accountId, data)
  return data
  })()
  accountDataLoads.set(accountId, loading)
  try { return await loading } finally { accountDataLoads.delete(accountId) }
}

function saveAccountData(accountId, data) { accountData.set(accountId, data); saveAutomation(accountId, data) }

function publicAutomation(data) {
  return {
    revision: data.revision || 0, timezone: data.timezone, delaySeconds: data.delaySeconds, statusRecipients: data.statusRecipients,
    groupLists: data.groupLists,
    recipients: (data.recipients || []).map(({ id, name, phone }) => ({ id, name, phone })),
    messages: (data.messages || []).map(({ id, name, texts, media, createdAt, updatedAt }) => ({ id, name, texts, media, createdAt, updatedAt })),
    jobs: (data.jobs || []).map(job => ({
      id: job.id, name: job.name, messageId: job.messageId, toLists: job.toLists, toRecipients: job.toRecipients,
      repeatCount: job.repeatCount, delaySeconds: job.delaySeconds, cron: job.cron, scheduleAt: job.scheduleAt,
      interval: job.interval || null, nextRunAt: job.nextRunAt || '', lastRunAt: job.lastRunAt || '', uncertainCount: job.uncertainCount || 0,
      nextDeliveryAt: job.activeRun && !job.activeRun.finishedAt ? job.activeRun.nextDeliveryAt || '' : '',
      canRetry: job.status === 'failed' && !job.activeRun && !job.progress && !job.total,
      toStatus: !!job.toStatus, status: job.status, progress: job.progress, total: job.total,
      createdAt: job.createdAt, scheduledAt: job.scheduledAt, startedAt: job.startedAt,
      completedAt: job.completedAt, failedCount: job.failedCount, lastError: job.lastError
    }))
  }
}

function normalizeGroupLists(accountId, data, groups) {
  let changed = false
  for (const [name, values] of Object.entries(data.groupLists || {})) {
    data.groupLists[name] = (values || []).map(value => {
      if (groups.some(g => g.id === value)) return value
      const hits = groups.filter(g => g.subject.toLowerCase().includes(String(value).toLowerCase()))
      if (hits.length === 1) { changed = true; return hits[0].id }
      return value
    })
  }
  if (changed) saveAccountData(accountId, data)
}

const groupSyncs = new Map(), groupSyncTimes = new Map()
async function refreshAccountGroups(accountId) {
  if (groupSyncs.has(accountId)) return groupSyncs.get(accountId)
  const operation = (async () => {
    const socket = await getAccountSocket(accountId)
    if (!socket) throw new Error('Connect this WhatsApp account to refresh its groups.')
    const groups = Object.values(await socket.groupFetchAllParticipating()).map(g => ({ id: g.id, subject: g.subject })).sort((a,b) => a.subject.localeCompare(b.subject))
    // Ignore a response from a socket replaced while this fetch was in progress.
    if (await getAccountSocket(accountId) !== socket) throw new Error('WhatsApp connection changed. Please refresh groups again.')
    const snapshot = saveGroupSnapshot(accountId, groups)
    accountGroups.set(accountId, groups); groupSyncTimes.set(accountId, snapshot.syncedAt)
    normalizeGroupLists(accountId, await dataFor(accountId), groups)
    return groups
  })()
  groupSyncs.set(accountId, operation)
  try { return await operation } finally { if (groupSyncs.get(accountId) === operation) groupSyncs.delete(accountId) }
}

function pickText(message, key) {
  const pool = Array.isArray(message?.texts) && message.texts.length ? message.texts : [message?.text || '']
  return pool[Math.floor(Math.random() * pool.length)]
}

function mediaFileFor(accountId, media) {
  const file = path.resolve(String(media || ''))
  const accountRoot = path.resolve('accounts'), accountDir = path.resolve(accountRoot, accountId)
  const roots = [
    { path: path.join(accountDir, 'media'), ancestors: [accountRoot, accountDir, path.join(accountDir, 'media')] },
    { path: path.resolve('images'), ancestors: [path.resolve('images')] }
  ]
  for (const candidate of roots) {
    try {
      if (candidate.ancestors.some(dir => fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())) continue
      const root = candidate.path
      const realRoot = fs.realpathSync(root), realFile = fs.realpathSync(file)
      if (realFile.startsWith(realRoot + path.sep) && fs.statSync(realFile).isFile()) return realFile
    } catch {}
  }
  throw new Error('Media must be an existing file in an allowed media directory.')
}

function validateMessageInput(body, id = makeId()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Enter a valid message.' }
  const name = String(body.name || '').trim()
  const texts = (Array.isArray(body.texts) ? body.texts : []).map(text => String(text).trim().slice(0, 10000)).filter(Boolean).slice(0, 50)
  const media = String(body.media || '').trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || (!texts.length && !media)) return { error: 'Enter a message name and text or uploaded media.' }
  return { value: { id, name, texts, media } }
}
function buildContent(job, text, accountId) {
  const file = job.media || job.image
  if (!file) return { text }
  const safeFile = mediaFileFor(accountId, file)
  const buf = fs.readFileSync(safeFile)
  const ext = path.extname(safeFile).toLowerCase()
  if (['.mp4', '.mov', '.mkv', '.3gp'].includes(ext)) return { video: buf, caption: text }
  return { image: buf, caption: text }
}

async function targetsFor(accountId, data, job) {
  const targets = new Map()
  const groups = accountGroups.get(accountId) || []
  for (const listName of job.toLists || []) {
    for (const entry of data.groupLists[listName] || []) {
      const hits = String(entry).endsWith('@g.us') ? groups.filter(g => g.id === entry) : groups.filter(g => g.subject.toLowerCase().includes(String(entry).toLowerCase()))
      if (hits.length === 1) targets.set(hits[0].id, { jid: hits[0].id, name: hits[0].subject })
    }
  }
  for (const id of job.toRecipients || []) {
    const r = data.recipients.find(x => x.id === id)
    if (r) { const jid = `${r.phone.replace(/\D/g, '')}@s.whatsapp.net`; targets.set(jid, { jid, name: r.name || r.phone }) }
  }
  return [...targets.values()]
}

function scheduleAccount(accountId, data) {
  for (const task of cronTasks.get(accountId)?.values() || []) task.destroy()
  for (const timer of oneShotTimers.get(accountId)?.values() || []) clearTimeout(timer)
  const schedules = new Map(), timers = new Map()
  cronTasks.set(accountId, schedules); oneShotTimers.set(accountId, timers)
  if (shuttingDown) return
  const opts = { ...(data.timezone ? { timezone: data.timezone } : {}), noOverlap: true }
  for (const job of data.jobs || []) {
    if (['paused', 'cancelled', 'completed', 'failed', 'running'].includes(job.status)) continue
    const unfinished = job.activeRun && !job.activeRun.finishedAt
    if (job.interval || unfinished) {
      if (job.interval && !job.nextRunAt) { job.nextRunAt = new Date(Date.now() + intervalMilliseconds(job.interval)).toISOString(); saveAccountData(accountId, data) }
      const tick = async () => {
        if (shuttingDown || job.status !== 'scheduled') return
        const due = Math.max(unfinished ? Date.now() : Date.parse(job.nextRunAt), Date.parse(job.retryAt || '') || 0)
        if (due > Date.now()) { timers.set(job.id, setTimeout(tick, Math.min(due - Date.now(), 2147480000))); return }
        try { await runJob(accountId, job.id, { oneShot: !recurring(job), resumeProgress: !!unfinished, occurrenceAt: unfinished ? job.activeRun.occurrenceAt : job.nextRunAt }) }
        catch { log('Scheduled run could not finish for job', job.id) }

      }
      timers.set(job.id, setTimeout(tick, Math.max(0, Math.min(Math.max(unfinished ? Date.now() : Date.parse(job.nextRunAt), Date.parse(job.retryAt || '') || 0) - Date.now(), 2147480000))))
    } else if (job.scheduleAt) {
      const runAt = Date.parse(job.scheduleAt)
      if (!Number.isFinite(runAt)) continue
      const tick = () => {
        const left = runAt - Date.now()
        if (left <= 0) { runJob(accountId, job.id, { oneShot: true, occurrenceAt: job.scheduleAt }).catch(e => log('Job failed:', e.message)); return }
        timers.set(job.id, setTimeout(tick, Math.min(left, 2147480000)))
      }
      tick()
    } else if (job.cron && cron.validate(job.cron)) {
      schedules.set(job.id, cron.schedule(job.cron, ctx => runJob(accountId, job.id, { occurrenceAt: ctx.date.toISOString() }).catch(e => log('Job failed:', e.message)), opts))
    } else if (accountGroups.has(accountId) && job.status === 'scheduled') {
      runJob(accountId, job.id, { oneShot: true, resumeProgress: job.progress > 0 }).catch(e => log('Recovered job failed:', e.message))
    }
  }
}

function startJob(accountId, jobId, options = {}) {
  const key = `${accountId}:${jobId}`
  runningJobs.add(key)
  stopRequests.delete(key)
  const execution = executeJob(accountId, jobId, options)
  const settled = execution.finally(() => {
    runningJobs.delete(key)
    activeJobPromises.delete(key)
    stopRequests.delete(key)
    drainJobQueue()
    dataFor(accountId).then(data => scheduleAccount(accountId, data)).catch(() => {})
  })
  activeJobPromises.set(key, settled)
  return settled
}

function runJob(accountId, jobId, options = {}) {
  const key = `${accountId}:${jobId}`
  if (shuttingDown) return Promise.resolve({ stopping: true })
  if (runningJobs.has(key) || queuedJobs.has(key)) return Promise.resolve({ alreadyRunning: true })
  if (runningJobs.size >= MAX_CONCURRENT_JOBS) {
    queuedJobs.set(key, { accountId, jobId, options })
    log(`Job ${jobId} queued because the worker limit is reached`)
    return Promise.resolve({ queued: true })
  }
  return startJob(accountId, jobId, options)
}

function drainJobQueue() {
  while (!shuttingDown && runningJobs.size < MAX_CONCURRENT_JOBS && queuedJobs.size) {
    const [key, item] = queuedJobs.entries().next().value
    queuedJobs.delete(key)
    if (stopRequests.has(key)) continue
    startJob(item.accountId, item.jobId, item.options).catch(e => log('Queued job failed:', e.message))
  }
}

function removeQueuedJob(key) {
  const removed = queuedJobs.delete(key)
  if (removed && !runningJobs.has(key)) stopRequests.delete(key)
}

function cpuPercent() {
  const now = Date.now(), usage = process.cpuUsage()
  const elapsed = Math.max(1, now - processCpuSample.at)
  const micros = (usage.user - processCpuSample.usage.user) + (usage.system - processCpuSample.usage.system)
  processCpuSample = { at: now, usage }
  return Math.round((micros / (elapsed * 1000)) * 1000) / 10
}

async function executeJob(accountId, jobId, { oneShot = false, resumeProgress = false, occurrenceAt } = {}) {
  const key = `${accountId}:${jobId}`
  const data = await dataFor(accountId), job = data.jobs.find(j => j.id === jobId)
  if (!job || ['paused', 'cancelled', 'completed'].includes(job.status)) return
  const pendingRun = job.activeRun && !job.activeRun.finishedAt
  if (!pendingRun && occurrenceAt && job.lastOccurrenceAt && Date.parse(occurrenceAt) <= Date.parse(job.lastOccurrenceAt)) return
  const sock = await getAccountSocket(accountId)
  if (!sock) { job.status = recurring(job) ? 'scheduled' : 'failed'; job.lastError = 'Waiting for WhatsApp to connect.'; job.retryAt = new Date(Date.now() + 30000).toISOString(); saveAccountData(accountId, data); return }
  const delays = (job.delaySeconds || data.delaySeconds).map(Number)
  if (!validSendingDelays(delays)) { job.status = 'failed'; job.lastError = 'Invalid sending interval.'; saveAccountData(accountId, data); return }
  if (!pendingRun) {
    try {
      const message = data.messages.find(m => m.id === job.messageId) || { texts: job.texts || [job.text || ''], media: job.media || '' }
      const deliveries = buildDeliveryPlan(await targetsFor(accountId, data, job), job.toStatus ? await getAccountStatusAudience(accountId) : [], job, Number(job.repeatCount))
      job.activeRun = createDeliveryRun(occurrenceAt || new Date().toISOString(), deliveries, message, () => pickText(message, key))
      job.activeRun.delaySeconds = delays
      if (resumeProgress) for (const entry of job.activeRun.entries.slice(0, job.progress || 0)) entry.state = 'sent'
      job.lastOccurrenceAt = job.activeRun.occurrenceAt
    } catch (e) { job.status = recurring(job) ? 'scheduled' : 'failed'; job.lastError = e.message; job.retryAt = new Date(Date.now() + 30000).toISOString(); saveAccountData(accountId, data); return }
  }
  job.status = 'running'; job.startedAt = job.activeRun.startedAt; job.lastRunAt = new Date().toISOString(); job.lastError = ''; job.retryAt = ''; job.resumeOnRestart = false
  Object.assign(job, runMetrics(job.activeRun)); saveAccountData(accountId, data)
  const [minD, maxD] = job.activeRun.delaySeconds || delays
  const stopped = () => shuttingDown || stopRequests.has(key) || !data.jobs.includes(job) || ['paused', 'cancelled'].includes(job.status)
  try {
    const result = await dispatchDeliveryRun({
      run: job.activeRun, socket: sock,
      contentFor: entry => buildContent({ media: entry.media }, entry.text, accountId),
      save: () => saveAccountData(accountId, data), shouldStop: stopped,
      onProgress: () => { Object.assign(job, runMetrics(job.activeRun)); if (job.uncertainCount) job.lastError = 'A delivery was not confirmed. It is not retried automatically, to prevent duplicate posts.' },
      nextDelay: () => (minD + Math.random() * (maxD - minD)) * 1000, now: () => Date.now()
    })
    if (result.stopped) return
    if (result.deferredUntil) { job.status = 'scheduled'; job.retryAt = result.deferredUntil; saveAccountData(accountId, data); return }
    job.activeRun.finishedAt = new Date().toISOString(); job.completedAt = job.activeRun.finishedAt
    job.status = recurring(job) ? 'scheduled' : job.failedCount ? 'failed' : 'completed'
    if (job.interval && (!job.nextRunAt || Date.parse(job.nextRunAt) <= Date.now())) job.nextRunAt = nextIntervalRun(job.nextRunAt || job.activeRun.occurrenceAt, job.interval, Date.now())
    saveAccountData(accountId, data)
  } catch {
    job.status = 'failed'; job.lastError = 'Delivery progress could not be saved. Review this run before resuming.'; saveAccountData(accountId, data)
  }
}

let reloadTimer
fs.watchFile(CONFIG, { interval: 2000 }, () => {
  if (Date.now() - selfWrite < 4000) return
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    const fresh = loadConfig()
    if (!fresh) return
    cfg = fresh
    log('Local settings changed, reloading')
  }, 1000)
})

/* ---------------- Dashboard ---------------- */

function auth(req, res, next) {
  const session = sessionForRequest(req)
  if (!session) return res.status(401).json({ error: 'Your session expired. Sign in again.' })
  req.dashboardSession = session
  req.user = session.user
  const context = workspaceContext(req.user.id)
  req.workspace = context.workspace
  req.workspaces = context.workspaces
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin')
    const expectedOrigin = `${req.protocol}://${req.get('host')}`
    if (!origin || origin !== expectedOrigin) {
      log(`Request verification rejected: origin mismatch (protocol=${req.protocol}; secure=${req.secure}; hostMatched=${origin?.endsWith(req.get('host')) || false})`)
      return res.status(403).json({ error: 'Request verification failed. Reload the dashboard and try again.' })
    }
    if (!tokensMatch(session.csrfToken, req.get('x-csrf-token'))) {
      log('Request verification rejected: CSRF token mismatch')
      return res.status(403).json({ error: 'Request verification failed. Reload the dashboard and try again.' })
    }
  }
  next()
}

function validateData(b) {
  if (!b || typeof b !== 'object') return { error: 'Invalid account settings.' }
  for (const key of ['recipients', 'messages', 'jobs', 'statusRecipients']) if (b[key] !== undefined && !Array.isArray(b[key])) return { error: `Invalid ${key} value.` }
  if (b.groupLists !== undefined && (!b.groupLists || typeof b.groupLists !== 'object' || Array.isArray(b.groupLists))) return { error: 'Invalid group lists.' }
  const groupLists = Object.create(null)
  if (Object.keys(b.groupLists || {}).length > 100) return { error: 'Too many group lists.' }
  for (const [key, values] of Object.entries(b.groupLists || {})) {
    const name = String(key).trim()
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return { error: 'Group list names must be 1 to 80 printable characters.' }
    if (!Array.isArray(values) || values.length > 1000 || values.some(v => typeof v !== 'string' || v.length > 160 || /[\u0000-\u001f\u007f]/.test(v))) return { error: 'A group list contains invalid group selections.' }
    groupLists[name] = [...new Set(values)]
  }
  if ((b.recipients || []).length > 5000 || (b.messages || []).length > 500 || (b.jobs || []).length > 500) return { error: 'This account has reached a saved data limit.' }
  const recipients = (Array.isArray(b.recipients) ? b.recipients : []).map(r => ({
    id: String(r.id || makeId()), name: String(r.name || '').trim().slice(0, 80), phone: String(r.phone || '').replace(/\D/g, '')
  }))
  if (recipients.some(r => !/^\d{8,15}$/.test(r.phone) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(r.id) || /[\u0000-\u001f\u007f]/.test(r.name)) || new Set(recipients.map(r => r.id)).size !== recipients.length || new Set(recipients.map(r => r.phone)).size !== recipients.length) return { error: 'Enter unique, valid recipient details.' }
  const messages = (Array.isArray(b.messages) ? b.messages : []).map(m => ({
    id: String(m.id || makeId()), name: String(m.name || '').trim().slice(0, 80),
    texts: (Array.isArray(m.texts) ? m.texts : []).map(t => String(t).slice(0, 10000)).filter(Boolean).slice(0, 50),
    media: String(m.media || '').trim(), createdAt: m.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
  }))
  if (messages.some(m => !m.name || /[\u0000-\u001f\u007f]/.test(m.name) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(m.id) || (!m.texts.length && !m.media)) || new Set(messages.map(m => m.id)).size !== messages.length) return { error: 'Each message needs a unique name and text or media.' }
  const d = Array.isArray(b.delaySeconds) ? b.delaySeconds.map(Number) : [5, 15]
  if (d.length !== 2 || d.some(n => !Number.isFinite(n)) || d[0] < 0 || d[1] < d[0] || d[1] > 600) return { error: 'Delay must be between 0 and 600 seconds, with maximum at least minimum.' }
  const timezone = String(b.timezone || 'Africa/Lagos').trim()
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { return { error: `Unknown timezone "${timezone}".` } }
  const jobs = (Array.isArray(b.jobs) ? b.jobs : []).map(j => ({
    id: String(j.id || makeId()), name: String(j.name || '').trim().slice(0, 100), messageId: String(j.messageId || ''),
    toLists: (Array.isArray(j.toLists) ? j.toLists : []).filter(n => n in groupLists),
    toRecipients: (Array.isArray(j.toRecipients) ? j.toRecipients : []).filter(id => recipients.some(r => r.id === id)),
    repeatCount: Number(j.repeatCount ?? 1),
    delaySeconds: Array.isArray(j.delaySeconds) ? j.delaySeconds.map(Number) : d,
    interval: j.interval ? { value: Number(j.interval.value), unit: j.interval.unit } : null, nextRunAt: String(j.nextRunAt || ''), cron: String(j.cron || '').slice(0, 100), scheduleAt: String(j.scheduleAt || '').slice(0, 40), toStatus: !!j.toStatus,
    status: ['scheduled', 'running', 'paused', 'cancelled', 'completed', 'failed'].includes(j.status) ? j.status : 'scheduled',
    progress: Math.max(0, Math.floor(Number(j.progress) || 0)), total: Math.max(0, Math.floor(Number(j.total) || 0)),
    createdAt: String(j.createdAt || new Date().toISOString()).slice(0, 40), scheduledAt: String(j.scheduledAt || '').slice(0, 100),
    startedAt: String(j.startedAt || '').slice(0, 40), completedAt: String(j.completedAt || '').slice(0, 40),
    failedCount: Math.max(0, Math.floor(Number(j.failedCount) || 0)), lastError: String(j.lastError || '').slice(0, 300)
  }))
  if (jobs.some(j => !j.name || /[\u0000-\u001f\u007f]/.test(j.name) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(j.id) || !messages.some(m => m.id === j.messageId) || !Number.isInteger(j.repeatCount) || j.repeatCount < 1 || j.repeatCount > 100) || new Set(jobs.map(j => j.id)).size !== jobs.length) return { error: 'Each job needs a unique valid name, saved message and repeat count from 1 to 100.' }
  if (jobs.some(j => !validSendingDelays(j.delaySeconds))) return { error: 'A job has an invalid delivery delay.' }
  try { for (const job of jobs) if (job.interval) { intervalMilliseconds(job.interval); if (job.cron) throw new Error('Choose an interval or a clock schedule.'); } } catch (e) { return { error: e.message } }
  if (jobs.some(j => j.cron && !cron.validate(j.cron))) return { error: 'A job has an invalid recurring schedule.' }
  if (jobs.some(j => j.repeatCount * Math.max(1, j.toRecipients.length + j.toLists.reduce((n, name) => n + (groupLists[name]?.length || 0), 0)) > 10000)) return { error: 'A job exceeds the 10,000 delivery safety limit.' }
  if ((b.statusRecipients || []).length > 5000) return { error: 'Too many status recipients.' }
  const statusRecipients = (b.statusRecipients || []).map(x => String(x).replace(/\D/g, ''))
  if (statusRecipients.some(x => !/^\d{8,15}$/.test(x))) return { error: 'Enter valid status recipient numbers.' }
  return { value: { timezone, delaySeconds: d, groupLists, recipients, messages, jobs, statusRecipients } }
}

async function shutdown(reason, exitCode = 0) {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  process.exitCode = exitCode
  shutdownPromise = (async () => {
    log('Graceful shutdown started:', reason)
    clearTimeout(reloadTimer)
    fs.unwatchFile(CONFIG)
    for (const tasks of cronTasks.values()) for (const task of tasks.values()) task.stop()
    for (const timers of oneShotTimers.values()) for (const timer of timers.values()) clearTimeout(timer)
    queuedJobs.clear()
    let serverClosed = Promise.resolve()
    if (dashboardServer) {
      const server = dashboardServer
      serverClosed = new Promise(resolve => server.close(() => resolve()))
      server.closeIdleConnections?.()
    }

    const stopAt = Date.now() + SHUTDOWN_TIMEOUT_MS
    for (const key of runningJobs) {
      stopRequests.set(key, 'paused')
      const split = key.indexOf(':')
      const accountId = key.slice(0, split), jobId = key.slice(split + 1)
      try {
        const data = await dataFor(accountId)
        const job = data.jobs.find(item => item.id === jobId)
        if (job?.status === 'running') {
          recoverInterruptedJob(job)
          saveAccountData(accountId, data)
        }
      } catch (e) { log('Could not save a job during shutdown:', e.message) }
    }

    await Promise.race([serverClosed, sleep(Math.max(0, stopAt - Date.now()))])
    await Promise.race([Promise.allSettled([...activeJobPromises.values()]), sleep(Math.max(0, stopAt - Date.now()))])
    if (dashboardServer?.listening) dashboardServer.closeAllConnections?.()
    try { await closeAllAccounts() } catch (e) { log('Could not close all WhatsApp sockets cleanly:', e.message); process.exitCode = 1 }
    try { closeWorkspaceStore(); closeAuthStore() } catch (e) { log('Could not close the authentication database cleanly:', e.message); process.exitCode = 1 }
    log('Graceful shutdown complete')
    process.exit(process.exitCode || 0)
  })()
  return shutdownPromise
}

process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)) })
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
process.on('uncaughtException', error => {
  log('Uncaught exception:', error?.message || 'unknown error')
  shutdown('uncaughtException', 1).catch(() => process.exit(1))
})

function startDashboard() {
  const app = express()
  const host = process.env.DASHBOARD_HOST || '127.0.0.1'
  const remoteBind = !['127.0.0.1', '::1', 'localhost'].includes(host)
  app.disable('x-powered-by')
  if (process.env.DASHBOARD_TRUST_PROXY === 'loopback') app.set('trust proxy', 'loopback')
  app.use(express.json({ limit: '24mb' }))
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      'Cache-Control': 'no-store'
    })
    if (remoteBind || req.secure) res.set('Strict-Transport-Security', 'max-age=31536000')
    next()
  })
  app.param('id', (req, res, next, id) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ? next() : res.status(400).json({ error: 'Invalid account ID.' }))

  app.get('/login', (req, res) => sessionForRequest(req) ? res.redirect('/') : res.type('html').send(AUTH_LOGIN_PAGE))
  app.get('/signup', (req, res) => sessionForRequest(req) ? res.redirect('/') : res.type('html').send(SIGNUP_PAGE))
  app.get('/forgot-password', (req, res) => res.type('html').send(FORGOT_PASSWORD_PAGE))
  app.get('/reset-password', (req, res) => res.type('html').send(RESET_PASSWORD_PAGE))
  app.get('/', (req, res) => {
    if (!sessionForRequest(req)) return res.redirect('/login')
    res.set('Cache-Control', 'no-store')
    res.type('html').send(STAGE3_PAGE)
  })
  const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  const validPassword = value => typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 72
  const sameOrigin = req => !!req.get('origin') && req.get('origin') === `${req.protocol}://${req.get('host')}`
  const setSessionCookie = (res, req, session) => {
    const maxAge = session.remember ? 30 * 24 * 60 * 60 : 12 * 60 * 60
    res.set('Set-Cookie', `wa_dashboard_session=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${(remoteBind || req.secure) ? '; Secure' : ''}`)
  }
  app.post('/api/signup', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Please refresh the page and try again.' })
    const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim().replace(/\s+/g, ' ') : ''
    const email = req.body?.email
    const password = req.body?.password
    if (fullName.length < 2 || fullName.length > 100 || /[\u0000-\u001f\u007f]/.test(fullName)) return res.status(400).json({ error: 'Enter your full name.' })
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
    if (!validPassword(password)) return res.status(400).json({ error: 'Use a password with at least 12 characters and no more than 72 UTF-8 bytes.' })
    if (password !== req.body?.confirmPassword) return res.status(400).json({ error: 'The passwords do not match.' })
    try {
      const { user, firstUser } = await createUser({ fullName, email: normalizeEmail(email), password })
      if (firstUser) {
        try { await claimLegacyAccounts(user.id) }
        catch { log('Existing WhatsApp accounts could not be linked to the first workspace.') }
      }
      const session = createSession(user.id)
      setSessionCookie(res, req, session)
      res.status(201).json({ ok: true })
    } catch (error) {
      if (error?.code === 'EMAIL_EXISTS' || String(error?.code || '').startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(error?.message || '')) return res.status(409).json({ error: 'An account with this email already exists.' })
      log('Account creation could not be completed.')
      res.status(500).json({ error: 'We could not create your account. Please try again.' })
    }
  })
  app.post('/api/login', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Please refresh the page and try again.' })
    const email = req.body?.email, password = req.body?.password
    if (!validEmail(email) || typeof password !== 'string' || password.length > 128) return res.status(401).json({ error: 'Email or password is incorrect.' })
    try {
      const user = findUser(email)
      if (!user || !(await verifyUserPassword(password, user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' })
      const session = createSession(user.id, req.body?.remember === true)
      setSessionCookie(res, req, session)
      res.json({ ok: true })
    } catch {
      log('Sign-in could not be completed.')
      res.status(500).json({ error: 'We could not sign you in. Please try again.' })
    }
  })
  app.post('/api/forgot-password', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    if (!allowRate(ip, 'forgot-password', 4, 60 * 60 * 1000)) return res.status(429).json({ error: 'Please wait before requesting another reset link.' })
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Please refresh the page and try again.' })
    const generic = 'If an account matches that email, we will send password reset instructions.'
    if (!validEmail(req.body?.email)) return res.json({ ok: true, message: generic })
    if (!allowRate(`email:${normalizeEmail(req.body.email)}`, 'forgot-password-email', 3, 60 * 60 * 1000)) return res.json({ ok: true, message: generic })
    try {
      const reset = createPasswordReset(req.body.email)
      if (reset) {
        try {
          const sent = await sendPasswordResetEmail(reset)
          if (!sent) log('Password reset email delivery is not configured.')
        } catch { log('Password reset email could not be delivered.') }
      }
    } catch { log('Password reset could not be prepared.') }
    res.json({ ok: true, message: generic })
  })
  app.post('/api/reset-password', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    if (!allowRate(ip, 'reset-password', 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many reset attempts. Please try again later.' })
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Please refresh the page and try again.' })
    const password = req.body?.password
    if (!validPassword(password)) return res.status(400).json({ error: 'Use a password with at least 12 characters and no more than 72 UTF-8 bytes.' })
    if (password !== req.body?.confirmPassword) return res.status(400).json({ error: 'The passwords do not match.' })
    try {
      if (!await consumePasswordReset(req.body?.token, password)) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' })
      res.json({ ok: true })
    } catch {
      log('Password reset could not be completed.')
      res.status(500).json({ error: 'We could not reset your password. Please request a new link.' })
    }
  })

  app.use(auth)
  app.use('/api', (req, res, next) => {
    // Connecting an account has no timed attempt quota. The manager coalesces
    // concurrent requests and reuses the existing account/socket instead.
    if (req.method === 'POST' && (req.path === '/accounts' || /^\/accounts\/[^/]+\/reconnect$/.test(req.path))) return next()
    // Independent dashboard sessions do not consume a shared network/IP quota.
    return allowRate(req.dashboardSession.tokenHash, 'api', 300, 60 * 1000) ? next() : res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' })
  })
  app.use('/api/accounts/:id', async (req, res, next) => {
    try {
      if (!await ownsAccount(req.params.id, req.workspace.id)) return res.status(404).json({ error: 'WhatsApp account not found in this business workspace.' })
      next()
    } catch { res.status(500).json({ error: 'We could not load this WhatsApp account.' }) }
  })
  app.get('/api/session', (req, res) => res.json({ csrfToken: req.dashboardSession.csrfToken, expiresAt: req.dashboardSession.expiresAt, user: req.user, workspace: req.workspace, workspaces: req.workspaces }))
  app.post('/api/workspaces/select', (req, res) => {
    try { res.json({ ok: true, workspace: selectWorkspace(req.user.id, req.body?.workspaceId) }) }
    catch { res.status(404).json({ error: 'Business workspace not found.' }) }
  })
  app.get('/api/workspace/members', (req, res) => {
    try { res.json({ members: workspaceMembers(req.user.id, req.workspace.id) }) }
    catch { res.status(403).json({ error: 'Only the business owner can manage members.' }) }
  })
  app.post('/api/workspace/invites', (req, res) => {
    if (req.workspace.role !== 'owner') return res.status(403).json({ error: 'Only the business owner can invite members.' })
    if (!allowRate(req.user.id, 'workspace-invites', 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'Please wait before creating more invitations.' })
    try { res.status(201).json({ ok: true, ...createWorkspaceInvite(req.user.id, req.workspace.id, req.body?.email) }) }
    catch { res.status(400).json({ error: 'Enter a valid email for the member you want to invite.' }) }
  })
  app.post('/api/workspace/join', (req, res) => {
    if (!allowRate(req.user.id, 'workspace-join', 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'Please wait before trying another invitation.' })
    try { res.json({ ok: true, ...acceptWorkspaceInvite(req.user.id, req.body?.code) }) }
    catch { res.status(400).json({ error: 'The invitation is invalid, expired, already used, or belongs to another email.' }) }
  })
  app.delete('/api/workspace/members/:memberId', (req, res) => {
    if (req.workspace.role !== 'owner') return res.status(403).json({ error: 'Only the business owner can manage members.' })
    try { removeWorkspaceMember(req.user.id, req.workspace.id, req.params.memberId); res.json({ ok: true }) }
    catch { res.status(400).json({ error: 'Only existing non-owner members can be removed.' }) }
  })
  app.put('/api/workspace', (req, res) => {
    if (req.workspace.role !== 'owner') return res.status(403).json({ error: 'Only the business owner can rename it.' })
    try { renameWorkspace(req.user.id, req.workspace.id, req.body?.name); res.json({ ok: true }) }
    catch { res.status(400).json({ error: 'Use a business name from 1 to 80 printable characters.' }) }
  })
  app.post('/api/logout', (req, res) => {
    destroySession(req)
    res.set('Set-Cookie', `wa_dashboard_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${(remoteBind || req.secure) ? '; Secure' : ''}`)
    res.json({ ok: true })
  })

  app.get('/health', async (req, res) => {
    const accounts = await listAccounts(req.workspace.id)
    const connections = { connected: 0, connecting: 0, reconnecting: 0, disconnected: 0, other: 0 }
    for (const account of accounts) {
      if (account.status in connections) connections[account.status]++
      else connections.other++
    }
    const jobs = await Promise.all(accounts.map(async account => (await dataFor(account.id)).jobs || []))
    res.json({
      status: 'ok', scheduler: schedulerStarted && !shuttingDown ? 'running' : 'stopped',
      uptimeSeconds: Math.floor(process.uptime()), memoryBytes: process.memoryUsage().rss,
      cpuPercent: cpuPercent(), configuredAccounts: accounts.length, connections,
      activeJobs: runningJobs.size, queuedJobs: queuedJobs.size,
      failedJobs: jobs.filter(job => job.status === 'failed').length
    })
  })

  app.get('/api/state', async (req, res) => {
    const accounts = await listAccounts(req.workspace.id)
    const selectedAccountId = String(req.query.accountId || accounts[0]?.id || '')
    const account = accounts.find(a => a.id === selectedAccountId)
    if (selectedAccountId && !account) return res.status(404).json({ error: 'Account not found.' })
    const data = account ? await dataFor(account.id) : { timezone: cfg.timezone, delaySeconds: cfg.delaySeconds, statusRecipients: [], recipients: [], groupLists: {}, messages: [], jobs: [] }
    const overviewJobs = []
    for (const a of accounts) {
      try { for (const j of (await dataFor(a.id)).jobs) overviewJobs.push({ id: j.id, name: j.name, status: j.status, createdAt: j.createdAt, scheduledAt: j.scheduledAt, accountName: a.name, accountId: a.id }) } catch {}
    }
    if (account?.status === 'connected' && (!groupSyncTimes.get(account.id) || Date.now() - Date.parse(groupSyncTimes.get(account.id)) > 60000)) refreshAccountGroups(account.id).catch(() => {})
    res.json({ workspace: req.workspace, workspaces: req.workspaces, accounts, account, selectedAccountId, cfg: publicAutomation(data), groups: accountGroups.get(selectedAccountId) || [], groupsSyncedAt: groupSyncTimes.get(selectedAccountId) || null, jobs: overviewJobs, connected: accounts.some(a => a.status === 'connected') })
  })

  app.get('/api/accounts', async (req, res) => res.json({ accounts: await listAccounts(req.workspace.id) }))
  app.get('/api/accounts/:id', async (req, res) => {
    const account = await getAccount(req.params.id)
    if (!account) return res.status(404).json({ error: 'Account not found.' })
    res.json({ account })
  })
  app.post('/api/accounts', async (req, res) => {
    try {
      const phone = String(req.body?.phone || '').trim()
      if (!/^[+()\d\s.-]+$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number with country code.' })
      const result = await createAccount({ userId: req.user.id, workspaceId: req.workspace.id, name: req.body?.name, phone })
      res.status(201).json(result)
    } catch (e) { log('Could not create WhatsApp account:', e?.message || 'unknown error'); res.status(400).json({ error: 'Could not create WhatsApp account. Check the phone number and try again.' }) }
  })
  app.post('/api/accounts/:id/reconnect', async (req, res) => {
    try {
      res.json(await reconnectAccount(req.params.id, { pair: !!req.body?.pair }))
    }
    catch (e) { log('Could not reconnect WhatsApp account:', e?.message || 'unknown error'); res.status(400).json({ error: 'Could not reconnect this WhatsApp account. Try again.' }) }
  })
  app.post('/api/accounts/:id/disconnect', async (req, res) => {
    try { res.json({ account: await disconnectAccount(req.params.id) }) }
    catch (e) { log('Could not disconnect WhatsApp account:', e?.message || 'unknown error'); res.status(400).json({ error: 'Could not disconnect this WhatsApp account.' }) }
  })
  app.delete('/api/accounts/:id', async (req, res) => {
    if (req.workspace.role !== 'owner') return res.status(403).json({ error: 'Only the business owner can remove a WhatsApp account.' })
    try {
      const id = req.params.id
      if ([...runningJobs].some(key => key.startsWith(`${id}:`))) return res.status(409).json({ error: 'Pause or cancel this account’s running jobs before removing it.' })
      const result = await removeAccount(id)
      for (const task of cronTasks.get(id)?.values() || []) task.stop()
      for (const timer of oneShotTimers.get(id)?.values() || []) clearTimeout(timer)
      cronTasks.delete(id); oneShotTimers.delete(id); accountGroups.delete(id); groupSyncTimes.delete(id); accountData.delete(id)
      res.json(result)
    }
    catch (e) { log('Could not remove WhatsApp account:', e?.message || 'unknown error'); res.status(400).json({ error: 'Could not remove this WhatsApp account.' }) }
  })

  app.get('/api/accounts/:id/groups', async (req, res) => {
    const sock = await getAccountSocket(req.params.id)
    if (!sock) return res.status(409).json({ error: 'Connect this WhatsApp account to load its groups.' })
    try {
      const groups = await refreshAccountGroups(req.params.id)
      res.json({ groups })
    } catch { res.status(502).json({ error: 'Unable to load groups from WhatsApp. Please retry.' }) }
  })
  app.post('/api/accounts/:id/contacts/sync', async (req, res) => {
    if (!await getAccountSocket(req.params.id)) return res.status(409).json({ error: 'Connect this WhatsApp account before syncing contacts.' })
    if (!allowRate(req.user.id, `contacts-sync:${req.params.id}`, 4, 60 * 1000)) return res.status(429).json({ error: 'Contacts are syncing. Please wait a moment before trying again.' })
    try { res.json({ ok: true, audience: await syncAccountContacts(req.params.id), message: 'WhatsApp contacts synced. Status uses your phone\'s privacy settings.' }) }
    catch { res.status(502).json({ error: 'WhatsApp contacts could not be synced yet. Please wait a moment and retry.' }) }
  })
  app.get('/api/accounts/:id/status/preview', async (req, res) => {
    try {
      if (!await getAccountSocket(req.params.id)) return res.status(409).json({ error: 'Connect this WhatsApp account before checking Status privacy.' })
      await getAccountStatusAudience(req.params.id)
      const audience = (await getAccount(req.params.id)).statusAudience
      res.json({ ok: true, audience, message: audience.eligibleCount + ' contacts can receive your Status.' + (audience.unmappedCount ? ' Contacts with unverified privacy mappings are withheld automatically.' : '') })
    } catch (e) { res.status(409).json({ error: e.message || 'WhatsApp Status privacy could not be verified.' }) }
  })
  app.put('/api/accounts/:id/group-lists/:name', async (req, res) => {
    try {
      const name = String(req.params.name || '').trim(), body = req.body || {}
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return res.status(400).json({ error: 'Group list names must be 1 to 80 printable characters.' })
      if (!Array.isArray(body.groups) || body.groups.length > 1000 || body.groups.some(id => typeof id !== 'string' || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id))) return res.status(400).json({ error: 'Choose valid WhatsApp groups for this list.' })
      const data = await dataFor(req.params.id), exists = Object.hasOwn(data.groupLists, name)
      if (body.create === true && exists) return res.status(409).json({ error: 'A list with that name already exists. Choose a different name.' })
      if (body.create !== true && !exists) return res.status(404).json({ error: 'This group list no longer exists. Refresh and try again.' })
      if (!exists && Object.keys(data.groupLists).length >= 100) return res.status(409).json({ error: 'This account has reached its 100-group-list limit.' })
      const groups = [...new Set(body.groups)]
      if (!exists && !groups.length) return res.status(400).json({ error: 'Tick at least one group before saving a new list.' })
      const allowed = new Set([...(accountGroups.get(req.params.id) || []).map(group => group.id), ...(exists ? data.groupLists[name] : [])])
      if (groups.some(id => !allowed.has(id))) return res.status(400).json({ error: 'Refresh WhatsApp groups and choose groups belonging to this account.' })
      const previousLists = data.groupLists
      data.groupLists = { ...data.groupLists, [name]: groups }
      try { saveAccountData(req.params.id, data) }
      catch (e) { data.groupLists = previousLists; throw e }
      res.json({ ok: true, groupList: { name, groups }, message: exists ? 'Group selection saved.' : 'Group list created with your selected groups.' })
    } catch (e) {
      log('Unable to save group list:', e?.message || 'unknown error')
      res.status(500).json({ error: 'The group list could not be saved. Your selection is still available to retry.' })
    }
  })
  app.post('/api/accounts/:id/recipients', async (req, res) => {
    try {
      const data = await dataFor(req.params.id), phone = String(req.body?.phone || '').replace(/\D/g, '')
      if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number with country code.' })
      if (data.recipients.some(r => r.phone === phone)) return res.status(409).json({ error: 'That number is already saved.' })
      const recipient = { id: makeId(), name: String(req.body?.name || '').trim().slice(0, 80), phone }
      data.recipients.push(recipient); saveAccountData(req.params.id, data); res.status(201).json({ recipient })
    } catch (e) { log('Unable to add recipient:', e?.message || 'unknown error'); res.status(400).json({ error: 'Unable to add this recipient.' }) }
  })
  app.delete('/api/accounts/:id/recipients/:recipientId', async (req, res) => {
    try {
      const data = await dataFor(req.params.id), i = data.recipients.findIndex(r => r.id === req.params.recipientId)
      if (i < 0) return res.status(404).json({ error: 'Recipient not found.' })
      data.recipients.splice(i, 1)
      for (const job of data.jobs) job.toRecipients = (job.toRecipients || []).filter(id => id !== req.params.recipientId)
      saveAccountData(req.params.id, data); scheduleAccount(req.params.id, data); res.json({ ok: true })
    } catch (e) { log('Unable to remove recipient:', e?.message || 'unknown error'); res.status(400).json({ error: 'Unable to remove this recipient.' }) }
  })
  app.post('/api/accounts/:id/messages', async (req, res) => {
    try {
      const data = await dataFor(req.params.id)
      if (data.messages.length >= 500) return res.status(409).json({ error: 'This account has reached its saved message limit.' })
      const checked = validateMessageInput(req.body)
      if (checked.error) return res.status(400).json({ error: checked.error })
      if (checked.value.media) {
        try { mediaFileFor(req.params.id, checked.value.media) }
        catch { return res.status(400).json({ error: 'Choose media uploaded for this account.' }) }
      }
      const now = new Date().toISOString()
      const message = { ...checked.value, createdAt: now, updatedAt: now }
      data.messages.push(message)
      saveAccountData(req.params.id, data)
      res.status(201).json({ ok: true, message: 'Message saved successfully.', savedMessage: message })
    } catch (e) {
      log('Unable to create account message:', e?.message || 'unknown error')
      res.status(500).json({ error: 'Unable to save this message. Please try again.' })
    }
  })
  app.put('/api/accounts/:id/messages/:messageId', async (req, res) => {
    try {
      const data = await dataFor(req.params.id)
      const index = data.messages.findIndex(message => message.id === req.params.messageId)
      if (index < 0) return res.status(404).json({ error: 'Message not found for this account.' })
      const checked = validateMessageInput(req.body, req.params.messageId)
      if (checked.error) return res.status(400).json({ error: checked.error })
      if (checked.value.media) {
        try { mediaFileFor(req.params.id, checked.value.media) }
        catch { return res.status(400).json({ error: 'Choose media uploaded for this account.' }) }
      }
      const message = { ...checked.value, createdAt: data.messages[index].createdAt, updatedAt: new Date().toISOString() }
      data.messages[index] = message
      saveAccountData(req.params.id, data)
      res.json({ ok: true, message: 'Message saved successfully.', savedMessage: message })
    } catch (e) {
      log('Unable to update account message:', e?.message || 'unknown error')
      res.status(500).json({ error: 'Unable to save this message. Please try again.' })
    }
  })
  app.put('/api/accounts/:id/data', async (req, res) => {
    try {
      const previous = await dataFor(req.params.id)
      if (req.body?.revision !== undefined && req.body.revision !== (previous.revision || 0)) return res.status(409).json({ error: 'This account changed on another device. Latest data has been loaded; review your changes and save again.' })
      const checked = validateData({ ...previous, ...req.body })
      if (checked.error) return res.status(400).json({ error: checked.error })
      const mediaRoots = [path.resolve('accounts', req.params.id, 'media'), path.resolve('images')]
      for (const message of checked.value.messages) if (message.media) {
        const mediaPath = path.resolve(message.media)
        if (!mediaRoots.some(root => mediaPath.startsWith(root + path.sep))) return res.status(400).json({ error: 'Media must be uploaded for this account.' })
        try { mediaFileFor(req.params.id, message.media) } catch { return res.status(400).json({ error: 'Media must be an existing file in an allowed media directory.' }) }
      }
      const priorJobs = new Map(previous.jobs.map(j => [j.id, j]))
      const nextJobs = checked.value.jobs.map(j => {
        const prior = priorJobs.get(j.id)
        if (!prior) return j
        for (const key of ['status', 'progress', 'total', 'createdAt', 'scheduledAt', 'startedAt', 'completedAt', 'failedCount', 'lastError', 'activeRun', 'lastOccurrenceAt', 'lastRunAt', 'nextRunAt', 'retryAt', 'resumeOnRestart', 'uncertainCount']) if (prior[key] !== undefined) j[key] = prior[key]
        return j
      })
      Object.assign(previous, checked.value, { jobs: nextJobs })
      saveAccountData(req.params.id, previous)
      scheduleAccount(req.params.id, previous)
      res.json({ ok: true, message: 'Changes saved successfully.' })
    } catch (e) { log('Unable to save account data:', e?.message || 'unknown error'); res.status(400).json({ error: 'Unable to save account data. Check the submitted values and try again.' }) }
  })

  app.post('/api/upload', async (req, res) => {
    const accountId = String(req.body?.accountId || '')
    if (!await ownsAccount(accountId, req.workspace.id)) return res.status(404).json({ error: 'Choose a WhatsApp account in this business workspace.' })
    if (!allowRate(req.ip || 'unknown', `upload:${accountId}`, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'Upload limit reached. Try again later.' })
    const name = path.basename(String(req.body?.name || '')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)
    const ext = path.extname(name).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'].includes(ext))
      return res.status(400).json({ error: 'Use jpg, png, webp, mp4 or mov' })
    const encoded = String(req.body?.data || '')
    if (encoded.length > 22 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return res.status(400).json({ error: 'Invalid media upload.' })
    const buf = Buffer.from(encoded, 'base64')
    if (!buf.length || buf.length > 16 * 1024 * 1024) return res.status(400).json({ error: 'File is empty or over 16 MB' })
    const signatures = { '.jpg': buf.subarray(0, 3).toString('hex') === 'ffd8ff', '.jpeg': buf.subarray(0, 3).toString('hex') === 'ffd8ff', '.png': buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', '.webp': buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP', '.mp4': buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp', '.mov': buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' }
    if (!signatures[ext]) return res.status(400).json({ error: 'File content does not match the selected media type.' })
    const root = path.resolve('accounts')
    const accountDir = path.resolve(root, accountId)
    if (!accountDir.startsWith(root + path.sep)) return res.status(400).json({ error: 'Invalid account storage path.' })
    if ((fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) || (fs.existsSync(accountDir) && fs.lstatSync(accountDir).isSymbolicLink())) return res.status(400).json({ error: 'Invalid account storage directory.' })
    const dir = path.join(accountDir, 'media')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(dir).isSymbolicLink()) return res.status(400).json({ error: 'Invalid media storage directory.' })
    const file = path.join(dir, `${crypto.randomUUID()}${ext}`)
    fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o600 })
    res.json({ path: path.relative(process.cwd(), file) })
  })

  const jobConfiguration = (data, body) => {
    if (!String(body.name || '').trim() || /[\u0000-\u001f\u007f]/.test(String(body.name))) throw new Error('Enter an automation name.')
    if (!data.messages.some(m => m.id === body.messageId)) throw new Error('Choose a saved message.')
    const destination = normalizeDestinations(data, body)
    if (destination.error) throw new Error(destination.error)
    const repeatCount = Number(body.repeatCount ?? 1), delaySeconds = Array.isArray(body.delaySeconds) ? body.delaySeconds.map(Number) : data.delaySeconds
    if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100) throw new Error('Repeat count must be between 1 and 100.')
    if (!validSendingDelays(delaySeconds)) throw new Error('Choose a fixed wait between sends from 0 to 365 days, or a random range from 0 to 600 seconds.')
    const message = data.messages.find(m => m.id === body.messageId)
    if (destination.value.toStatus && message.media && !['.png','.jpg','.jpeg','.webp','.mp4','.mov','.mkv','.3gp'].includes(path.extname(message.media).toLowerCase())) throw new Error('Choose text, an image or a video for WhatsApp Status.')
    return { name: String(body.name).trim().slice(0, 100), messageId: body.messageId, ...destination.value, repeatCount, delaySeconds, ...parseSchedule(body) }
  }
  app.post('/api/accounts/:id/jobs', async (req, res) => {
    try {
      const data = await dataFor(req.params.id)
      if (data.jobs.length >= MAX_JOBS_PER_ACCOUNT) return res.status(409).json({ error: 'Remove an old schedule before adding another.' })
      const config = jobConfiguration(data, req.body || {})
      if (!config.interval && !config.cron && !config.scheduleAt && !await getAccountSocket(req.params.id)) return res.status(409).json({ error: 'Connect WhatsApp before sending now, or choose a future schedule.' })
      const job = { id: makeId(), ...config, status: 'scheduled', progress: 0, total: 0, createdAt: new Date().toISOString(), completedAt: '' }
      data.jobs.push(job); saveAccountData(req.params.id, data); scheduleAccount(req.params.id, data)
      if (!recurring(job) && !job.scheduleAt) runJob(req.params.id, job.id, { oneShot: true }).catch(() => {})
      res.status(201).json({ ok: true, job: publicAutomation(data).jobs.find(j => j.id === job.id), message: recurring(job) || job.scheduleAt ? 'Automation scheduled successfully.' : 'Automation started successfully.' })
    } catch (e) { res.status(400).json({ error: e.message || 'Unable to create this schedule.' }) }
  })
  app.put('/api/accounts/:id/jobs/:jobId', async (req, res) => {
    try {
      const data = await dataFor(req.params.id), job = data.jobs.find(j => j.id === req.params.jobId)
      if (!job) return res.status(404).json({ error: 'Schedule not found.' })
      const key = `${req.params.id}:${job.id}`
      if (runningJobs.has(key) || queuedJobs.has(key)) return res.status(409).json({ error: 'Pause this run and wait for its current send to finish before editing.' })
      const config = jobConfiguration(data, req.body || {})
      if (!config.interval && !config.cron && !config.scheduleAt) return res.status(400).json({ error: 'Choose a future or recurring schedule when editing.' })
      Object.assign(job, config, { updatedAt: new Date().toISOString(), retryAt: '' })
      if (['completed','cancelled','failed'].includes(job.status)) job.status = 'paused'
      saveAccountData(req.params.id, data); scheduleAccount(req.params.id, data)
      res.json({ ok: true, job: publicAutomation(data).jobs.find(j => j.id === job.id), message: 'Schedule updated successfully.' })
    } catch (e) { res.status(400).json({ error: e.message || 'Unable to edit this schedule.' }) }
  })
  app.post('/api/accounts/:id/jobs/:jobId/:action', async (req, res) => {
    try {
      const data = await dataFor(req.params.id), job = data.jobs.find(j => j.id === req.params.jobId)
      if (!job) return res.status(404).json({ error: 'Job not found.' })
      const key = `${req.params.id}:${job.id}`, action = req.params.action
      if (action === 'start') {
        if (runningJobs.has(key)) return res.status(409).json({ error: 'This job is already running.' })
        if (!recurring(job)) job.scheduleAt = ''; job.scheduledAt = job.interval ? 'Every '+job.interval.value+' '+job.interval.unit : job.cron || 'Now'; job.status = 'scheduled'; job.lastError = ''; saveAccountData(req.params.id, data)
        runJob(req.params.id, job.id, { oneShot: true }).catch(e => log('Job failed:', e.message))
      } else if (action === 'pause') {
        if (!['running', 'scheduled'].includes(job.status)) return res.status(400).json({ error: 'Only scheduled or running jobs can be paused.' })
        job.status = 'paused'; stopRequests.set(key, 'paused'); removeQueuedJob(key); saveAccountData(req.params.id, data)
      }
      else if (action === 'resume') {
        if (job.status !== 'paused') return res.status(400).json({ error: 'Only paused jobs can be resumed.' })
        job.status = 'scheduled'; stopRequests.delete(key); saveAccountData(req.params.id, data)
        const hasProgress = (job.activeRun && !job.activeRun.finishedAt) || (job.progress > 0 && job.progress < job.total)
        const expiredOneShot = !recurring(job) && job.scheduleAt && Date.parse(job.scheduleAt) <= Date.now()
        if (hasProgress || expiredOneShot || (!job.scheduleAt && !recurring(job))) runJob(req.params.id, job.id, { oneShot: true, resumeProgress: true }).catch(e => log('Job failed:', e.message))
        else scheduleAccount(req.params.id, data)
      } else if (action === 'cancel') {
        if (['completed', 'cancelled'].includes(job.status)) return res.status(400).json({ error: `A ${job.status} job cannot be cancelled.` })
        job.status = 'cancelled'; stopRequests.set(key, 'cancelled'); removeQueuedJob(key); saveAccountData(req.params.id, data)
      }
      else return res.status(404).json({ error: 'Unknown job action.' })
      scheduleAccount(req.params.id, data)
      res.json({ ok: true, job: publicAutomation(data).jobs.find(j => j.id === job.id) })
    } catch (e) { log('Unable to update automation:', e?.message || 'unknown error'); res.status(400).json({ error: 'Unable to update this automation.' }) }
  })
  app.delete('/api/accounts/:id/jobs/:jobId', async (req, res) => {
    try {
      const data = await dataFor(req.params.id), i = data.jobs.findIndex(j => j.id === req.params.jobId)
      if (i < 0) return res.status(404).json({ error: 'Job not found.' })
      const key = `${req.params.id}:${req.params.jobId}`
      stopRequests.set(key, 'cancelled'); removeQueuedJob(key); data.jobs.splice(i, 1)
      saveAccountData(req.params.id, data); scheduleAccount(req.params.id, data); res.json({ ok: true })
    } catch (e) { log('Unable to delete automation:', e?.message || 'unknown error'); res.status(400).json({ error: 'Unable to delete this automation.' }) }
  })

  app.get('/api/log', async (req, res) => {
    const ownedIds = (await listAccounts(req.workspace.id)).map(account => account.id)
    res.json({ log: redactLogText(logBuffer.filter(line => ownedIds.some(id => line.includes(id))).slice(-60).join('\n')) })
  })

  app.use((err, req, res, next) => {
    log('API request failed:', req.method, req.path, err?.type || 'internal_error')
    res.status(500).json({ error: 'The request could not be completed.' })
  })

  const port = Number(process.env.DASHBOARD_PORT || cfg.dashboardPort || 3000)
  try {
    if (remoteBind) {
      if (!process.env.DASHBOARD_TLS_KEY || !process.env.DASHBOARD_TLS_CERT) {
        log('Dashboard not started: remote access requires DASHBOARD_TLS_KEY and DASHBOARD_TLS_CERT')
        return
      }
      dashboardServer = https.createServer({ key: fs.readFileSync(process.env.DASHBOARD_TLS_KEY), cert: fs.readFileSync(process.env.DASHBOARD_TLS_CERT) }, app)
        .listen(port, host, () => log('HTTPS dashboard running on port', port))
        .on('error', e => log('Dashboard failed:', e.message))
    } else dashboardServer = app.listen(port, host, () => log('Dashboard running on localhost port', port)).on('error', e => log('Dashboard failed:', e.message))
  } catch (e) { log('Dashboard failed to load its TLS certificate:', e.message) }
}


const STAGE3_PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Business WhatsApp</title>
<style>
:root{--green:#087f6e;--ink:#172522;--muted:#667570;--line:#e1e9e6;--bg:#f4f7f6;--card:#fff}*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,Segoe UI,sans-serif;color:var(--ink);background:var(--bg)}header{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid var(--line);padding:12px max(16px,calc((100vw - 1180px)/2));display:flex;align-items:center;gap:14px;box-shadow:0 2px 10px #1725220a}header b{font-size:18px}header select{margin-left:auto;max-width:230px}main{max-width:1180px;margin:auto;padding:20px}.nav{display:flex;gap:8px;overflow:auto;padding:4px 0 14px}.nav button{background:#e5eeeb;color:#23443d;white-space:nowrap}.nav button.sel{background:var(--green);color:#fff}.view{display:none}.view.sel{display:block}h1{font-size:25px;margin:8px 0 16px}h2{font-size:18px;margin:18px 0 10px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:0 2px 8px #17252208;margin:10px 0}.card h3{margin:0 0 8px;font-size:16px}.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:8px 0}.row>*{min-width:0}.grow{flex:1}input,select,textarea{font:inherit;padding:9px 10px;border:1px solid #cbd8d3;border-radius:8px;background:#fff;color:var(--ink)}input[type=text],input[type=tel],input[type=number],input[type=datetime-local],select,textarea{width:100%}textarea{min-height:95px;resize:vertical}button{border:0;border-radius:8px;background:var(--green);color:white;font:inherit;font-weight:600;padding:9px 13px;cursor:pointer}button.secondary{background:#e7efec;color:#23443d}button.danger{background:#a93a36}button:disabled{opacity:.5;cursor:not-allowed}.muted,small{color:var(--muted)}.pill{display:inline-block;padding:3px 9px;border-radius:999px;background:#e8efed;color:#37564d;font-size:13px}.pill.connected,.pill.running,.pill.completed{background:#dcf5e7;color:#126039}.pill.failed,.pill.cancelled,.pill.logged_out{background:#fde4e2;color:#8a2522}.pill.scheduled{background:#e7efff;color:#294c97}.pill.paused,.pill.disconnected{background:#f0eee6;color:#625b38}.stat{font-size:28px;font-weight:700}.groupbox{max-height:260px;overflow:auto;border:1px solid var(--line);padding:8px;border-radius:8px}.groupbox label{display:block;padding:5px}.message-preview{white-space:pre-wrap;color:#42534d}.toast{position:fixed;right:16px;bottom:16px;z-index:10;padding:12px 16px;color:#fff;background:#245b48;border-radius:8px;box-shadow:0 4px 18px #0002;display:none}.toast.err{background:#a93a36}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid var(--line)}.wrap{overflow:auto}.actions{display:flex;gap:6px;flex-wrap:wrap}.hidden{display:none!important}@media(max-width:600px){main{padding:13px}header{padding:10px 13px;gap:8px}header select{max-width:48%}.row>*{flex:1}.row button{flex:0 0 auto}.stat{font-size:23px}td,th{padding:7px;font-size:13px}}
/* Dashboard workspace and independent delivery destinations. */
body{background:radial-gradient(ellipse at top right,#e5f3ed 0,transparent 45%),#f5f7fa}
header{background:#ffffffed;backdrop-filter:blur(14px)}header b{letter-spacing:-.5px}
main{padding-top:26px}.nav{gap:6px;margin-bottom:10px}.nav button{background:transparent;color:var(--muted);border-radius:10px}.nav button.sel{background:#e0f1eb;color:#076c59}
.card{padding:22px;border-radius:16px;box-shadow:0 4px 18px #17252205}h1{letter-spacing:-.8px;font-size:30px}h2{letter-spacing:-.3px}
button{transition:background .15s,box-shadow .15s}button:hover:not(:disabled){filter:brightness(.96)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #96d6c5;outline-offset:3px}
input[type=checkbox]{accent-color:var(--green);width:18px;height:18px;flex-shrink:0}label{line-height:1.6}label>input:not([type=checkbox]),label>select{display:block;margin-top:5px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.account-connect-form{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;width:100%;max-width:680px;margin-top:16px}.account-connect-form label{min-width:0}.account-connect-form input{width:100%;min-width:0;font-size:16px;min-height:48px}.account-connect-form #newAccountPhone{font-size:18px;font-variant-numeric:tabular-nums;letter-spacing:.025em;padding:12px;direction:ltr}.account-connect-form button{justify-self:start;min-height:46px;padding:12px 18px}@media(max-width:600px){.account-connect-form button{width:100%}}
.page-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}.page-heading h1{margin:0 0 4px}.page-heading p{margin:0}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:var(--green);font-weight:700}
.automation-layout{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr);gap:20px;align-items:start}.automation-layout>.card{margin:0}.automation-layout>*,.field-grid>*{min-width:0}.form-step{padding:0 0 24px;margin-bottom:24px;border-bottom:1px solid var(--line)}.form-step h2{margin:0 0 6px}.step-number{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:#e4f2ed;color:var(--green);font-size:13px;margin-right:8px}.help{font-size:13px;margin:0 0 16px;color:var(--muted)}
.destination-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.destination-choice{display:flex;align-items:flex-start;gap:12px;border:1px solid var(--line);padding:16px;border-radius:12px;cursor:pointer;background:#fafcfb}.destination-choice.selected{border-color:var(--green);background:#eff9f4;box-shadow:0 0 0 1px var(--green)}.destination-choice input{margin-top:4px}.destination-choice strong,.destination-choice small{display:block}.destination-panel{padding:14px 0 0}.target-options{display:flex;flex-direction:column;gap:8px;max-height:240px;overflow:auto}.target-option{display:flex;align-items:center;gap:9px;border:1px solid var(--line);border-radius:9px;padding:9px 12px}.target-option small{margin-left:auto}.status-help{border-radius:10px;background:#eef4ff;padding:14px;margin:0}.status-help button{margin-top:10px}
.contacts-option{display:flex;align-items:center;gap:9px;margin-top:18px}.preview-panel{position:sticky;top:88px}.preview-panel h2{margin-top:0}.preview-text{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f4f8f6;border-radius:10px;max-height:250px;overflow:auto;font-size:14px}.summary-line{display:flex;justify-content:space-between;gap:12px;margin:16px 0;font-size:14px}.summary-line span{color:var(--muted)}.summary-line strong{text-align:right}.submit-row{display:flex;justify-content:space-between;align-items:center;gap:12px}.submit-row button{padding:12px 20px}.form-feedback{margin-top:12px;font-size:14px;color:var(--green)}.form-feedback.err{color:#a93a36}.advanced{margin-top:16px}.advanced summary{cursor:pointer;color:var(--muted);font-size:14px}.advanced .field-grid{margin-top:12px}.job-destinations{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.empty-state{padding:24px;text-align:center;border:1px dashed #cadbd3;border-radius:12px;color:var(--muted)}
@media(max-width:850px){.automation-layout{grid-template-columns:1fr}.preview-panel{position:static}}@media(max-width:600px){header{flex-wrap:wrap}header b{flex:1 1 220px;white-space:nowrap}header select{order:3;max-width:none;margin:0;flex:1 1 calc(100% - 100px)}header>button{order:4}.field-grid,.destination-grid{grid-template-columns:1fr}.card{padding:16px}.page-heading{align-items:flex-start}.submit-row{align-items:flex-start;flex-direction:column}.submit-row button{width:100%}h1{font-size:26px}}
/* Keep entry pages, activity lines, and dynamic content within the viewport. */
body{overflow-wrap:anywhere}main{width:100%;min-width:0}header>*{min-width:0;max-width:100%}.card{min-width:0;max-width:100%}.grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))}input,select,textarea{min-width:0;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}.toast{max-width:calc(100% - 32px)}
</style></head><body>
<header><b>Business WhatsApp</b><select id="workspaceSelect" aria-label="Business workspace" onchange="switchWorkspace(this.value)"></select><span id="topStatus" class="pill">Loading</span><span id="syncState" class="muted" role="status" aria-live="polite">Checking server</span><select id="accountSelect" aria-label="WhatsApp account" onchange="selectAccount(this.value)"></select><button class="secondary" onclick="logout()">Logout</button></header>
<main><nav class="nav"><button data-view="overview" onclick="showView('overview')">Overview</button><button data-view="accounts" onclick="showView('accounts')">Accounts</button><button data-view="messages" onclick="showView('messages')">Messages</button><button data-view="groups" onclick="showView('groups')">Recipients &amp; Groups</button><button data-view="jobs" onclick="showView('jobs')">Automations</button><button data-view="settings" onclick="showView('settings')">Settings</button></nav>
<section id="overview" class="view"><h1>Dashboard</h1><div class="grid"><div class="card"><small>WhatsApp accounts</small><div class="stat" id="accountCount">0</div><button onclick="showView('accounts')">Manage accounts</button></div><div class="card"><small>Active jobs</small><div class="stat" id="activeCount">0</div><button onclick="showView('jobs')">View automations</button></div><div class="card"><small>Scheduled jobs</small><div class="stat" id="scheduledCount">0</div><button onclick="showView('jobs')">View schedule</button></div></div><div class="card"><h2>WhatsApp Accounts</h2><div id="overviewAccounts"></div><button onclick="showView('accounts')">＋ Connect WhatsApp</button></div><div class="card"><h2>Active Automations</h2><div id="overviewJobs"></div></div><div class="card"><h2>Recent Activity</h2><pre id="overviewLog"></pre></div><div class="card"><h2>Quick actions</h2><div class="actions"><button onclick="showView('accounts')">Connect WhatsApp</button><button onclick="newMessage();showView('messages')">Create Message</button><button onclick="showView('groups')">Manage Groups</button><button onclick="showView('jobs')">Create Automation</button></div></div></section>
<section id="accounts" class="view"><h1>WhatsApp Accounts</h1><div class="card"><h2>＋ Connect WhatsApp</h2><div class="muted">Enter the phone number with country code. We’ll show a pairing code here.</div><div class="account-connect-form"><label for="newAccountName">Business or account name (optional)<input id="newAccountName" type="text" placeholder="Business or account name" autocomplete="organization"></label><label for="newAccountPhone">WhatsApp phone number<input id="newAccountPhone" type="tel" inputmode="tel" autocomplete="tel" spellcheck="false" dir="ltr" aria-describedby="accountPhoneHelp" placeholder="Country code + phone number"></label><p id="accountPhoneHelp" class="help">Include your country code, such as +1 or +234. Check the full number before connecting.</p><button id="connectAccountButton" onclick="connectAccount()">Connect WhatsApp</button></div><p id="accountFeedback" class="form-feedback" role="status" aria-live="polite"></p><div id="pairCode"></div></div><div id="accountCards" class="grid"></div></section>
<section id="messages" class="view"><h1>Messages</h1><div class="card"><h2 id="messageFormTitle">Create message</h2><input id="messageName" type="text" placeholder="Message name"><textarea id="messageText" placeholder="Message text. Separate rotating versions with a line containing ---"></textarea><div class="row"><input id="messageFile" type="file" accept="image/*,video/mp4,video/quicktime"><button class="secondary" onclick="uploadMessageMedia()">Upload media</button><span id="mediaLabel" class="muted"></span></div><div class="actions"><button onclick="saveMessage()">Save message</button><button class="secondary" onclick="previewMessage()">Preview</button><button class="secondary" onclick="newMessage()">Clear</button></div></div><div id="messageCards" class="grid"></div></section>
<section id="groups" class="view"><h1>Recipients &amp; Groups</h1><div class="card"><h2>Individual numbers</h2><div class="row"><input id="recipientName" type="text" placeholder="Contact name (optional)"><input id="recipientPhone" type="tel" placeholder="Number with country code"><button onclick="addRecipient()">Add number</button></div><div id="recipientCards"></div></div><div class="card"><h2>Group Lists</h2><p class="help">Create a draft list, tick the groups you want, and click Save selected groups.</p><div class="row"><input id="newListName" type="text" placeholder="New group list name"><button onclick="addList()">Create Group List</button><button class="secondary" onclick="loadGroups()">Refresh WhatsApp groups</button></div><div id="listCards"></div></div></section>
<section id="jobs" class="view">
<div class="page-heading"><div><span class="eyebrow">Campaign workspace</span><h1>Automations</h1><p class="muted">Send the right message to the right place, on your schedule.</p></div></div>
<div class="automation-layout"><div class="card">
<div class="form-step"><h2><span class="step-number">1</span>Choose your message</h2><p class="help">Select a saved message, including any attached photo or video.</p>
<div class="field-grid"><label>WhatsApp account<select id="jobAccount"></select></label><label>Automation name<input id="jobName" type="text" maxlength="100" placeholder="e.g. Weekend promotion"></label></div>
<label>Saved message<select id="jobMessage" onchange="updateJobSummary()"></select></label></div>
<div class="form-step"><h2><span class="step-number">2</span>Where should it go?</h2><p class="help">Choose Groups, WhatsApp Status, or select both to send to both places.</p>
<div class="destination-grid">
<label id="groupChoice" class="destination-choice selected"><input id="jobSendGroups" type="checkbox" checked onchange="destinationMode()"><span><strong>Send to groups</strong><small>Deliver to the group lists you choose.</small></span></label>
<label id="statusChoice" class="destination-choice"><input id="jobToStatus" type="checkbox" onchange="destinationMode()"><span><strong>Post to WhatsApp Status</strong><small>Use your WhatsApp contacts. No numbers to enter.</small></span></label>
</div>
<div id="jobGroupPanel" class="destination-panel"><div id="jobTargets" class="target-options"></div><button class="secondary" onclick="showView('groups')">Manage group lists</button></div>
<div id="jobStatusPanel" class="destination-panel hidden"><div class="status-help"><strong>Your WhatsApp Status audience</strong><p id="jobStatusAudience" class="help"></p><small>Your phone's Status privacy and blocked contacts are respected. Status is posted once per automation run.</small><br><button id="syncStatusContacts" class="secondary" onclick="syncStatusContacts()">Sync WhatsApp contacts</button></div></div>
<label class="contacts-option"><input id="jobSendContacts" type="checkbox" onchange="destinationMode()">Send to individual contacts</label>
<div id="jobContactPanel" class="destination-panel hidden"><div id="jobContactTargets" class="target-options"></div><button class="secondary" onclick="showView('groups')">Manage contacts</button></div></div>
<div class="form-step"><h2><span class="step-number">3</span>Choose when to send</h2><p id="jobTimezone" class="help"></p>
<div class="field-grid"><label>Delivery schedule<select id="jobMode" onchange="scheduleMode()"><option value="now">Send now</option><option value="at">Schedule for later</option><option value="interval">Repeat at custom intervals</option><option value="preset">Repeat at clock times</option><option value="cron">Custom recurring schedule</option></select></label>
<label id="dateWrap" class="hidden">Date and time<input id="jobDate" type="datetime-local"></label><label id="cronWrap" class="hidden">Cron expression<input id="jobCron" type="text" placeholder="0 9 * * *"><small>For example: 0 9 * * * runs daily at 9 AM.</small></label></div>
<div id="intervalWrap" class="hidden"><div class="field-grid"><label>Repeat every<input id="jobEvery" type="number" min="1" step="1" value="15" oninput="updateJobSummary()"></label><label>Unit<select id="jobEveryUnit" onchange="updateJobSummary()"><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label></div><label>First run (optional)<input id="jobFirstRun" type="datetime-local"></label><p class="help">Leave blank to run after the chosen interval. Runs continue while this page is closed. Missed intervals are combined into one run after downtime.</p></div><label id="presetWrap" class="hidden">Repeat schedule<select id="jobInterval" onchange="updateJobSummary()"><option value="* * * * *">Every minute</option><option value="*/5 * * * *">Every 5 minutes</option><option value="*/15 * * * *">Every 15 minutes</option><option value="*/30 * * * *">Every 30 minutes</option><option value="0 * * * *" selected>Every hour, on the hour</option><option value="0 */2 * * *">Every 2 hours</option><option value="0 */6 * * *">Every 6 hours</option><option value="0 9 * * *">Daily at 9 AM</option></select><small>Runs at clock times in your account timezone. Each run posts a new Status if selected.</small></label></div>
<div class="form-step"><h2><span class="step-number">4</span>Set the interval between groups</h2><p class="help">Send to the first group, wait this interval, then send to the next group. The same spacing applies to contacts and repeats within a run. For example, 5 minutes means Group 1 now, Group 2 after 5 minutes, Group 3 after 10 minutes. This is separate from how often the full campaign repeats. Status posts once per run.</p>
<div class="field-grid"><label>Interval style<select id="jobPacing" onchange="pacingMode()"><option value="fixed">Fixed interval</option><option value="random" selected>Random interval range</option></select></label><label>Group/contact repeats per run<input id="jobRepeat" type="number" min="1" max="100" value="1" onchange="updateJobSummary()"></label></div>
<div id="fixedPacing" class="field-grid hidden"><label>Wait before the next group/contact<input id="jobSendInterval" type="number" min="0" max="31536000" value="10" step="0.1" oninput="updateJobSummary()"></label><label>Unit<select id="jobIntervalUnit" onchange="pacingMode()"><option value="1">Seconds</option><option value="60">Minutes</option><option value="3600">Hours</option><option value="86400">Days</option></select></label></div>
<div id="randomPacing" class="field-grid"><label>Minimum wait (seconds)<input id="jobMinDelay" type="number" min="0" max="600" value="5" step="0.1" oninput="updateJobSummary()"></label><label>Maximum wait (seconds)<input id="jobMaxDelay" type="number" min="0" max="600" value="15" step="0.1" oninput="updateJobSummary()"></label></div><p class="help">Up to 10 minutes between sends. A Status-only run posts once; use Repeat at intervals for regular Status updates.</p></div>
<div class="submit-row"><span class="muted">Review your campaign summary before sending.</span><button id="cancelJobEdit" class="secondary hidden" onclick="cancelJobEdit()">Cancel edit</button><button id="createJobButton" onclick="createJob()">Send now</button></div><div id="jobFeedback" class="form-feedback" role="status" aria-live="polite"></div>
</div>
<aside class="card preview-panel"><span class="eyebrow">Your campaign</span><h2>Ready to send?</h2><div id="jobPreview" class="preview-text">Choose a saved message to preview it here.</div><p id="jobMediaHint" class="help"></p><div class="summary-line"><span>Destinations</span><strong id="jobDestinationSummary">Choose a destination</strong></div><div class="summary-line"><span>Schedule</span><strong id="jobScheduleSummary">Send now</strong></div><div class="summary-line"><span>Sending interval</span><strong id="jobPacingSummary"></strong></div><div class="summary-line"><span>Account</span><strong id="jobConnectionSummary"></strong></div><small>Your messages and audience stay separate for each WhatsApp account.</small></aside>
</div><div class="page-heading" style="margin-top:28px"><div><h2>Your automations</h2><p class="muted">Track deliveries and manage upcoming campaigns.</p></div></div><div id="jobCards"></div></section>
<section id="settings" class="view"><h1>Settings</h1><div class="card"><label>Timezone<input id="timezone" type="text" placeholder="Africa/Lagos"></label><div class="row"><label>Default minimum wait (seconds)<input id="defaultMin" type="number" min="0" max="600"></label><label>Default maximum wait (seconds)<input id="defaultMax" type="number" min="0" max="600"></label></div><p class="help">Use the same minimum and maximum for a fixed sending interval.</p><button onclick="saveSettings()">Save settings</button><h2>WhatsApp Status audience</h2><p class="help">Contacts sync from your WhatsApp account automatically. Manage who can see your Status in WhatsApp on your phone. You do not need to enter viewer numbers here.</p><button class="secondary" onclick="syncStatusContacts()">Sync WhatsApp contacts</button></div><div class="card"><h2>Business &amp; team</h2><p id="workspaceNameSummary" class="help"></p><div id="workspaceOwnerPanel"><label>Business name<input id="workspaceName" maxlength="80"></label><button class="secondary" onclick="saveWorkspaceName()">Save business name</button><h3>Invite a team member</h3><p class="help">Invite their dashboard email. Share the one-use code directly with them; it expires after 24 hours.</p><label>Member email<input id="workspaceInviteEmail" type="email" autocomplete="off"></label><button onclick="inviteWorkspaceMember()">Generate invitation</button><label>Invitation code<textarea id="workspaceInviteCode" readonly autocomplete="off"></textarea></label><button class="secondary" onclick="copyWorkspaceInvite()">Copy code</button><h3>Members</h3><button class="secondary" onclick="loadWorkspaceMembers()">Refresh members</button><div id="workspaceMembers"></div></div><h3>Join a business</h3><p class="help">Sign in with the email your business owner invited, then paste their invitation code.</p><label>Invitation code<input id="workspaceJoinCode" autocomplete="off"></label><button onclick="joinWorkspace()">Join business</button></div></section>
</main><div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
var S=null, accountId='', activeView='overview', editMessageId='', mediaPath='', pairCode='', pairAccountId='', toastTimer=null, csrfToken='';
var groupListDrafts=new Map(),groupListOpenPanels=new Map(),renderedGroupAccountId='';
var jobTimingAccount='',lastIntervalUnit=1,stateGeneration=0,pollInFlight=false,membersLoadedFor='',editJobId='';
function esc(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function api(url,method,body){method=method||'GET';var headers={'Content-Type':'application/json'};if(method!=='GET'&&method!=='HEAD')headers['X-CSRF-Token']=csrfToken;return fetch(url,{method:method,headers:headers,body:body===undefined?undefined:JSON.stringify(body)}).then(async function(r){if(r.status===401){location.assign('/login');throw new Error('Sign in again.')}var d=await r.json();if(!r.ok){var e=new Error(d.error||'Request failed.');e.status=r.status;throw e}return d})}
function logout(){api('/api/logout','POST',{}).then(function(){location.assign('/login')}).catch(function(e){toast(e.message,true)})}
function toast(msg,bad){var el=document.getElementById('toast');el.textContent=msg;el.className='toast'+(bad?' err':'');el.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.style.display='none'},3500)}
function selectedAccount(){return (S.accounts||[]).find(function(a){return a.id===accountId})}
function showView(name){activeView=name;document.querySelectorAll('.view').forEach(function(x){x.classList.toggle('sel',x.id===name)});document.querySelectorAll('.nav button').forEach(function(x){x.classList.toggle('sel',x.dataset.view===name)})}
function selectAccount(id){accountId=id;pairCode='';document.querySelectorAll('.jobList,.jobRecipient').forEach(function(x){x.checked=false});document.getElementById('jobMessage').value='';document.getElementById('jobFeedback').textContent='';return loadState().then(function(){toast('Account selected.')}).catch(function(e){toast(e.message,true)})}
function switchJobAccount(id){if(id&&id!==accountId)selectAccount(id)}
function loadState(options){
  var generation=++stateGeneration,oldAccount=accountId,oldWorkspace=S?.workspace?.id,url='/api/state'+(accountId?'?accountId='+encodeURIComponent(accountId):'');
  return api(url).catch(function(e){if(e.status===404&&oldAccount)return api('/api/state');throw e}).then(function(d){
    if(generation!==stateGeneration)return d;
    S=d;accountId=d.selectedAccountId||'';var changed=oldAccount!==accountId||oldWorkspace!==S.workspace?.id;
    if(changed){pairCode='';pairAccountId='';jobTimingAccount='';cancelJobEdit();document.getElementById('workspaceInviteCode').value='';}
    if(selectedAccount()?.status==='connected')pairCode='';
    document.getElementById('syncState').textContent='Live from server';
    if(options?.background&&!changed&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||''))renderLiveStatus();else render();
    return d
  })
}
function renderLiveStatus(){var a=selectedAccount();document.getElementById('topStatus').textContent=a?a.status.replace(/_/g,' '):'No WhatsApp account';renderAccounts();}
function pollState(){if(pollInFlight||document.hidden)return;pollInFlight=true;return loadState({background:true}).catch(function(){document.getElementById('syncState').textContent='Server temporarily unavailable; retrying'}).finally(function(){pollInFlight=false})}
function switchWorkspace(id){return api('/api/workspaces/select','POST',{workspaceId:id}).then(function(){accountId='';pairCode='';groupListDrafts.clear();return loadState()}).catch(function(e){toast(e.message,true)})}
function renderWorkspace(){
  var context=S.workspace||{},selector=document.getElementById('workspaceSelect');
  if(document.activeElement?.id!=='workspaceSelect'){selector.innerHTML=(S.workspaces||[]).map(function(w){return '<option value="'+esc(w.id)+'">'+esc(w.name)+'</option>'}).join('');selector.value=context.id||''}
  document.getElementById('workspaceNameSummary').textContent=(context.name||'Business workspace')+' · '+(context.role||'member')+'. WhatsApp accounts and saved data are shared with authorized members.';
  document.getElementById('workspaceOwnerPanel').classList.toggle('hidden',context.role!=='owner');
  if(document.activeElement?.id!=='workspaceName')document.getElementById('workspaceName').value=context.name||'';
  if(context.role==='owner'&&membersLoadedFor!==context.id){membersLoadedFor=context.id;loadWorkspaceMembers().catch(function(){})}
}
function loadWorkspaceMembers(){var workspaceId=S.workspace?.id;return api('/api/workspace/members').then(function(d){if(S.workspace?.id!==workspaceId)return;document.getElementById('workspaceMembers').innerHTML=d.members.map(function(m){return '<div class="row"><span class="grow">'+esc(m.fullName)+' · '+esc(m.email)+'</span><span class="pill">'+esc(m.role)+'</span>'+(m.role==='owner'?'':'<button class="danger" onclick="removeWorkspaceMember(\''+esc(m.id)+'\')">Remove member</button>')+'</div>'}).join('')})}
function saveWorkspaceName(){return api('/api/workspace','PUT',{name:document.getElementById('workspaceName').value}).then(function(){toast('Business name saved.');return loadState()}).catch(function(e){toast(e.message,true)})}
function inviteWorkspaceMember(){return api('/api/workspace/invites','POST',{email:document.getElementById('workspaceInviteEmail').value}).then(function(d){document.getElementById('workspaceInviteCode').value=d.code;toast('Invitation ready. Share it directly with the invited member.')}).catch(function(e){toast(e.message,true)})}
function copyWorkspaceInvite(){var code=document.getElementById('workspaceInviteCode').value;if(!code){toast('Generate an invitation first.',true);return}if(navigator.clipboard)return navigator.clipboard.writeText(code).then(function(){toast('Invitation copied.')}).catch(function(){toast('Select the invitation code and copy it.',true)});document.getElementById('workspaceInviteCode').select();toast('Select the invitation code and copy it.')}
function joinWorkspace(){return api('/api/workspace/join','POST',{code:document.getElementById('workspaceJoinCode').value.trim()}).then(function(){document.getElementById('workspaceJoinCode').value='';accountId='';return loadState()}).then(function(){toast('You joined the business. Its WhatsApp accounts are available here.')}).catch(function(e){toast(e.message,true)})}
function removeWorkspaceMember(id){if(!confirm('Remove this member\'s access to this business?'))return;return api('/api/workspace/members/'+encodeURIComponent(id),'DELETE').then(function(){toast('Member access removed.');return loadWorkspaceMembers()}).catch(function(e){toast(e.message,true)})}
function refresh(){var draft={name:document.getElementById('newAccountName')?.value||'',phone:document.getElementById('newAccountPhone')?.value||''};return loadState().then(function(){var a=document.getElementById('newAccountName'),p=document.getElementById('newAccountPhone');if(a)a.value=draft.name;if(p)p.value=draft.phone})}
function render(){if(!S)return;var acc=selectedAccount(),sel=document.getElementById('accountSelect');sel.innerHTML=(S.accounts||[]).map(function(a){return '<option value="'+esc(a.id)+'" '+(a.id===accountId?'selected':'')+'>'+esc(a.name)+' · '+esc(a.phone)+'</option>'}).join('')||'<option value="">No accounts</option>';document.getElementById('topStatus').textContent=acc?acc.status.replace('_',' '):'No WhatsApp account';document.getElementById('accountCount').textContent=(S.accounts||[]).length;document.getElementById('activeCount').textContent=(S.jobs||[]).filter(function(j){return j.status==='running'}).length;document.getElementById('scheduledCount').textContent=(S.jobs||[]).filter(function(j){return j.status==='scheduled'}).length;renderOverview();renderAccounts();renderMessages();renderGroups();renderJobs();renderSettings();showView(activeView)}
function statusPill(status){return '<span class="pill '+esc(status)+'">'+esc(String(status||'unknown').replace('_',' '))+'</span>'}
function renderOverview(){document.getElementById('overviewAccounts').innerHTML=(S.accounts||[]).map(function(a){return '<div class="row"><b class="grow">'+esc(a.name)+'</b>'+esc(a.phone)+' '+statusPill(a.status)+' <button class="secondary" onclick="selectAccount(\''+esc(a.id)+'\').then(function(){showView(\'accounts\')})">Manage</button></div>'}).join('')||'<p class="muted">Connect a WhatsApp account to get started.</p>';document.getElementById('overviewJobs').innerHTML=(S.jobs||[]).slice(0,8).map(function(j){return '<div class="row"><b class="grow">'+esc(j.name)+'</b><span>'+esc(j.accountName)+'</span>'+statusPill(j.status)+'</div>'}).join('')||'<p class="muted">No automation jobs yet.</p>';api('/api/log').then(function(x){document.getElementById('overviewLog').textContent=x.log||'No recent activity.'}).catch(function(){})}
function accountFeedback(message,bad){var el=document.getElementById('accountFeedback');el.textContent=message;el.className='form-feedback'+(bad?' err':'');}
function connectAccount(){
  var button=document.getElementById('connectAccountButton');if(button.disabled)return;
  var name=document.getElementById('newAccountName').value.trim(),phone=document.getElementById('newAccountPhone').value.trim(),digits=phone.replace(/\D/g,'');
  if(!/^[+()\d\s.-]+$/.test(phone)||digits.length<8||digits.length>15){accountFeedback('Enter your WhatsApp number with its country code (8 to 15 digits).',true);document.getElementById('newAccountPhone').focus();return;}
  button.disabled=true;button.textContent='Connecting?';accountFeedback('Preparing your WhatsApp connection?');
  return api('/api/accounts','POST',{name:name,phone:phone}).then(async function(d){
    accountId=d.account.id;pairAccountId=accountId;pairCode=d.pairingCode||'';
    await loadState();
    accountFeedback(pairCode?'Pairing code ready. Open WhatsApp ? Linked Devices ? Link with phone number and enter the code.':d.account.status==='connected'?'WhatsApp is already connected. Your existing account is ready to use.':'Connecting your saved account. The status updates automatically.');
  }).catch(async function(e){accountFeedback(e.message,true);try{await refresh()}catch{}}).finally(function(){button.disabled=false;button.textContent='Connect WhatsApp';});
}
function pairAgain(id){accountId=id;api('/api/accounts/'+encodeURIComponent(id)+'/reconnect','POST',{pair:true}).then(function(d){pairCode=d.pairingCode||'';pairAccountId=id;return loadState()}).then(function(){toast(pairCode?'Pairing code generated.':'Reconnecting.')}).catch(function(e){toast(e.message,true)})}
function accountAction(id,action){if(action==='disconnect'&&!confirm('Disconnect this WhatsApp account for everyone in this business?'))return;return api('/api/accounts/'+encodeURIComponent(id)+'/'+action,'POST',{}).then(function(d){toast(action==='disconnect'?'Account disconnected.':d.reused?'This account is already connected.':'Reconnection started.');return loadState()}).catch(function(e){toast(e.message,true)})}
function removeAccount(id){if(!confirm('Remove this account and its session data?'))return;api('/api/accounts/'+encodeURIComponent(id),'DELETE').then(function(){if(accountId===id)accountId='';pairCode='';toast('Account removed.');return loadState()}).catch(function(e){toast(e.message,true)})}
function newMessage(){editMessageId='';mediaPath='';document.getElementById('messageFormTitle').textContent='Create message';document.getElementById('messageName').value='';document.getElementById('messageText').value='';document.getElementById('mediaLabel').textContent=''}
function renderMessages(){if(!S.cfg)return;document.getElementById('messageCards').innerHTML=(S.cfg.messages||[]).map(function(m){var text=(m.texts||[]).join('\n---\n');return '<article class="card"><h3>'+esc(m.name)+'</h3><p class="message-preview">'+esc(text.slice(0,220))+(text.length>220?'…':'')+'</p><small>'+esc(m.media?'Media attached':'Text only')+'</small><div class="actions"><button class="secondary" onclick="editMessage(\''+esc(m.id)+'\')">Edit</button><button class="secondary" onclick="previewMessage(\''+esc(m.id)+'\')">Preview</button><button class="danger" onclick="deleteMessage(\''+esc(m.id)+'\')">Delete</button></div></article>'}).join('')||'<p class="muted">No messages saved for this account.</p>';if(!editMessageId)document.getElementById('mediaLabel').textContent=mediaPath?'Media ready: '+mediaPath:''}
function saveData(success){if(!accountId){toast('Connect or select a WhatsApp account first.',true);return Promise.reject(new Error('No account selected.'))}return api('/api/accounts/'+encodeURIComponent(accountId)+'/data','PUT',S.cfg).then(function(){if(success)toast(success);return loadState()}).catch(async function(e){if(e.status===409)await loadState();toast(e.message,true);throw e})}
function saveMessage(){var name=document.getElementById('messageName').value.trim(),raw=document.getElementById('messageText').value,texts=raw.split(/\n\s*---\s*\n/).map(function(x){return x.trim()}).filter(Boolean);if(!name||(!texts.length&&!mediaPath)){toast('Enter a message name and text or media.',true);return}if(!accountId){toast('Select a WhatsApp account first.',true);return}var button=document.querySelector('#messages .actions button');if(button.disabled)return;var target='/api/accounts/'+encodeURIComponent(accountId)+'/messages',method='POST';if(editMessageId){target+='/'+encodeURIComponent(editMessageId);method='PUT'}button.disabled=true;api(target,method,{name:name,texts:texts,media:mediaPath}).then(function(d){newMessage();toast(d.message||'Message saved successfully.');return loadState()}).catch(function(e){toast(e.message,true)}).finally(function(){button.disabled=false})}
function editMessage(id){var m=S.cfg.messages.find(function(x){return x.id===id});if(!m)return;editMessageId=id;mediaPath=m.media||'';document.getElementById('messageFormTitle').textContent='Edit message';document.getElementById('messageName').value=m.name;document.getElementById('messageText').value=(m.texts||[]).join('\n---\n');document.getElementById('mediaLabel').textContent=mediaPath||'';showView('messages');window.scrollTo(0,0)}
function previewMessage(id){var m=id?S.cfg.messages.find(function(x){return x.id===id}):{name:document.getElementById('messageName').value,texts:document.getElementById('messageText').value.split(/\n\s*---\s*\n/),media:mediaPath};alert((m?.name||'Message')+'\n\n'+(m?.texts||[]).join('\n\n---\n\n')+(m?.media?'\n\nMedia: '+m.media:''))}
function deleteMessage(id){if(S.cfg.jobs.some(function(j){return j.messageId===id})){toast('This message is used by a job. Delete or edit that job first.',true);return}if(!confirm('Delete this message?'))return;S.cfg.messages=S.cfg.messages.filter(function(m){return m.id!==id});saveData('Message deleted.').catch(function(){})}
function uploadMessageMedia(){var f=document.getElementById('messageFile').files[0];if(!f||!accountId){toast('Choose a file and account first.',true);return}if(f.size>16*1024*1024){toast('File too large (max 16 MB).',true);return}var reader=new FileReader();reader.onload=function(){api('/api/upload','POST',{accountId:accountId,name:f.name,data:reader.result.split(',')[1]}).then(function(d){mediaPath=d.path;document.getElementById('mediaLabel').textContent='Media ready: '+mediaPath;toast('Media uploaded.')}).catch(function(e){toast(e.message,true)})};reader.readAsDataURL(f)}
function listDrafts(){if(!groupListDrafts.has(accountId))groupListDrafts.set(accountId,new Map());return groupListDrafts.get(accountId)}
function listOpenPanels(){if(!groupListOpenPanels.has(accountId))groupListOpenPanels.set(accountId,new Set());return groupListOpenPanels.get(accountId)}
function groupListNames(){return [...new Set([...Object.keys(S.cfg.groupLists||{}),...listDrafts().keys()])]}
function savedGroupsForList(name){return Object.hasOwn(S.cfg.groupLists,name)?S.cfg.groupLists[name]:[]}
function listSelectionDirty(name,draft){if(!draft)return false;var saved=savedGroupsForList(name);return draft.isNew||saved.length!==draft.groups.length||saved.some(function(id){return !draft.groups.includes(id)})}
function validListName(name){return name.length>0&&name.length<=80&&!/[\u0000-\u001f\u007f]/.test(name)}
function addList(){
  if(!accountId){toast('Select a WhatsApp account first.',true);return}
  var name=document.getElementById('newListName').value.trim(),drafts=listDrafts();
  if(!validListName(name)){toast('Enter a group list name with 1 to 80 printable characters.',true);return}
  if(Object.hasOwn(S.cfg.groupLists,name)||drafts.has(name)){toast('A list with that name already exists.',true);return}
  drafts.set(name,{groups:[],isNew:true,saving:false,error:''});listOpenPanels().add(name);
  document.getElementById('newListName').value='';renderGroups();toast('Tick your groups, then click Save selected groups to create the list.')
}
function renameList(i){
  var old=groupListNames()[i],drafts=listDrafts(),draft=drafts.get(old);
  if(draft?.saving)return;
  if(draft&&!draft.isNew&&listSelectionDirty(old,draft)){toast('Save or discard your group selection before renaming this list.',true);return}
  var name=prompt('Rename group list',old);if(name===null)return;name=name.trim();
  if(!validListName(name)||(name!==old&&(Object.hasOwn(S.cfg.groupLists,name)||drafts.has(name)))){toast('Enter an unused list name with 1 to 80 printable characters.',true);return}
  if(name===old)return;
  if(draft?.isNew){drafts.delete(old);drafts.set(name,draft);listOpenPanels().delete(old);listOpenPanels().add(name);renderGroups();return}
  S.cfg.groupLists[name]=S.cfg.groupLists[old];delete S.cfg.groupLists[old];S.cfg.jobs.forEach(function(j){j.toLists=(j.toLists||[]).map(function(n){return n===old?name:n})});
  saveData('Group list renamed.').then(function(){drafts.delete(old);listOpenPanels().delete(old);listOpenPanels().add(name);renderGroups()}).catch(function(){})
}
function deleteList(i){
  var name=groupListNames()[i],drafts=listDrafts(),draft=drafts.get(name);if(draft?.saving)return;
  if(draft?.isNew){discardGroupSelection(i);return}
  if(!confirm('Delete group list "'+name+'"?'))return;
  delete S.cfg.groupLists[name];S.cfg.jobs.forEach(function(j){j.toLists=(j.toLists||[]).filter(function(n){return n!==name})});
  saveData('Group list deleted.').then(function(){drafts.delete(name);listOpenPanels().delete(name);renderGroups()}).catch(function(){})
}
function toggleGroup(listIndex,groupIndex,on){
  var name=groupListNames()[listIndex],group=(S.groups||[])[groupIndex];if(!group||name===undefined)return;
  var drafts=listDrafts(),draft=drafts.get(name);
  if(!draft){draft={groups:savedGroupsForList(name).slice(),isNew:false,saving:false,error:''};drafts.set(name,draft)}
  if(draft.saving)return;
  var index=draft.groups.indexOf(group.id);if(on&&index<0)draft.groups.push(group.id);if(!on&&index>=0)draft.groups.splice(index,1);
  draft.error='';updateGroupSelectionUI(listIndex)
}
function updateGroupSelectionUI(i){
  var name=groupListNames()[i],draft=listDrafts().get(name),selected=draft?draft.groups:savedGroupsForList(name),dirty=listSelectionDirty(name,draft);
  document.getElementById('groupSelectionCount'+i).textContent=selected.length+' selected';
  document.getElementById('groupSelectionState'+i).textContent=draft?.saving?'Saving...':draft?.isNew?'Not saved yet':dirty?'Unsaved changes':'All changes saved';
  var button=document.getElementById('saveGroupList'+i);button.disabled=!!draft?.saving||!dirty||(!!draft?.isNew&&!selected.length);button.textContent=draft?.saving?'Saving...':'Save selected groups';
  document.getElementById('discardGroupList'+i).disabled=!!draft?.saving||!draft;
  document.getElementById('groupSelectionError'+i).textContent=draft?.error||''
}
function discardGroupSelection(i){
  var name=groupListNames()[i],draft=listDrafts().get(name);if(draft?.saving)return;
  listDrafts().delete(name);if(draft?.isNew)listOpenPanels().delete(name);
  renderGroups();toast(draft?.isNew?'Draft list discarded.':'Unsaved selections discarded.')
}
function saveGroupSelection(i){
  var name=groupListNames()[i],drafts=listDrafts(),draft=drafts.get(name),targetId=accountId;
  if(!draft||draft.saving||!listSelectionDirty(name,draft))return;
  if(draft.isNew&&!draft.groups.length){toast('Tick at least one group before saving the list.',true);return}
  draft.saving=true;draft.error='';renderGroups();
  return api('/api/accounts/'+encodeURIComponent(targetId)+'/group-lists/'+encodeURIComponent(name),'PUT',{groups:draft.groups.slice(),create:draft.isNew}).then(function(result){
    drafts.delete(name);toast(result.message);
    if(accountId===targetId){
      S.cfg.groupLists=Object.assign(Object.create(null),S.cfg.groupLists,{[name]:result.groupList.groups});renderGroups();renderJobs();
      return loadState().catch(function(){toast('Group list saved. Refresh the page to reload account data.',true)})
    }
  }).catch(function(e){draft.error=e.message;toast(e.message,true)}).finally(function(){draft.saving=false;if(accountId===targetId)renderGroups()})
}
function loadGroups(){
  if(!accountId)return toast('Select an account first.',true);
  var targetId=accountId;return api('/api/accounts/'+encodeURIComponent(targetId)+'/groups').then(function(d){if(accountId===targetId){S.groups=d.groups;renderGroups();toast('WhatsApp groups refreshed.')}}).catch(function(e){toast(e.message,true)})
}
function renderGroups(){
  var drafts=listDrafts(),openPanels=listOpenPanels(),names=groupListNames();
  if(renderedGroupAccountId===accountId)document.querySelectorAll('#listCards details[data-list-name]').forEach(function(panel){if(panel.open)openPanels.add(panel.dataset.listName);else openPanels.delete(panel.dataset.listName)});
  renderedGroupAccountId=accountId;
  document.getElementById('listCards').innerHTML=names.map(function(n,i){
    var draft=drafts.get(n),selected=draft?draft.groups:savedGroupsForList(n),saved=savedGroupsForList(n),busy=!!draft?.saving;
    return '<article class="card"><div class="row"><h3 class="grow">'+esc(n)+'</h3><span class="pill">'+(draft?.isNew?'New draft':saved.length+' saved')+'</span><button class="secondary" '+(busy?'disabled ':'')+'onclick="renameList('+i+')">Rename</button><button class="danger" '+(busy?'disabled ':'')+'onclick="deleteList('+i+')">'+(draft?.isNew?'Discard draft':'Delete')+'</button></div><details data-list-name="'+esc(n)+'" '+(openPanels.has(n)?'open':'')+'><summary>Choose groups</summary><p class="help">Tick or untick groups, then click Save selected groups. Checkbox changes are not saved automatically.</p><div class="groupbox">'+((S.groups||[]).map(function(g,j){return '<label><input type="checkbox" '+(selected.includes(g.id)?'checked ':'')+(busy?'disabled ':'')+'onchange="toggleGroup('+i+','+j+',this.checked)"> '+esc(g.subject)+'</label>'}).join('')||'<p class="muted">Connect this account and refresh WhatsApp groups to choose groups.</p>')+'</div><div class="row"><span id="groupSelectionCount'+i+'" class="pill">'+selected.length+' selected</span><span id="groupSelectionState'+i+'" class="muted"></span></div><div class="actions"><button id="saveGroupList'+i+'" onclick="saveGroupSelection('+i+')">Save selected groups</button><button id="discardGroupList'+i+'" class="secondary" onclick="discardGroupSelection('+i+')">Discard changes</button></div><p id="groupSelectionError'+i+'" class="form-feedback err" role="status" aria-live="polite"></p></details></article>'
  }).join('')||'<p class="muted">Name a list, choose your groups, then save it.</p>';
  names.forEach(function(name,i){updateGroupSelectionUI(i)});
  document.getElementById('recipientCards').innerHTML=(S.cfg.recipients||[]).map(function(r,i){return '<div class="row"><b class="grow">'+esc(r.name||('Recipient '+(i+1)))+'</b><span>'+esc(r.phone.replace(/\d(?=\d{4})/g,'&bull;'))+'</span><button class="danger" onclick="removeRecipient(\''+esc(r.id)+'\')">Remove</button></div>'}).join('')||'<p class="muted">No individual numbers saved.</p>'
}
function addRecipient(){var phone=document.getElementById('recipientPhone').value.trim(),name=document.getElementById('recipientName').value.trim();if(!/^[+()\d\s.-]+$/.test(phone)||phone.replace(/\D/g,'').length<8||phone.replace(/\D/g,'').length>15){toast('Enter a valid number with country code.',true);return}api('/api/accounts/'+encodeURIComponent(accountId)+'/recipients','POST',{phone:phone,name:name}).then(function(){document.getElementById('recipientPhone').value='';document.getElementById('recipientName').value='';toast('Recipient added.');return loadState()}).catch(function(e){toast(e.message,true)})}
function removeRecipient(id){api('/api/accounts/'+encodeURIComponent(accountId)+'/recipients/'+encodeURIComponent(id),'DELETE').then(function(){toast('Recipient removed.');return loadState()}).catch(function(e){toast(e.message,true)})}
function jobFeedback(message,bad){var el=document.getElementById('jobFeedback');el.textContent=message;el.className='form-feedback'+(bad?' err':'');toast(message,bad)}
function syncStatusContacts(){
  if(!accountId){toast('Choose a WhatsApp account first.',true);return}
  var button=document.getElementById('syncStatusContacts');if(button.disabled)return;button.disabled=true;button.textContent='Syncing...';
  return api('/api/accounts/'+encodeURIComponent(accountId)+'/status/preview').then(function(d){toast(d.message);return loadState()}).catch(function(e){toast(e.message,true)}).finally(function(){button.disabled=false;button.textContent='Sync WhatsApp contacts'})
}
function jobDelaySeconds(){
  if(document.getElementById('jobPacing').value==='fixed'){
    var field=document.getElementById('jobSendInterval'),seconds=field.value.trim()===''?NaN:Number(field.value)*Number(document.getElementById('jobIntervalUnit').value);
    return [seconds,seconds]
  }
  return ['jobMinDelay','jobMaxDelay'].map(function(id){var value=document.getElementById(id).value;return value.trim()===''?NaN:Number(value)})
}
function pacingMode(){
  var fixed=document.getElementById('jobPacing').value==='fixed',unit=Number(document.getElementById('jobIntervalUnit').value)||1,field=document.getElementById('jobSendInterval');
  if(unit!==lastIntervalUnit){field.value=String(Number(field.value)*lastIntervalUnit/unit);lastIntervalUnit=unit}
  field.max=String(31536000/unit);document.getElementById('fixedPacing').classList.toggle('hidden',!fixed);document.getElementById('randomPacing').classList.toggle('hidden',fixed);updateJobSummary()
}
function destinationMode(){
  [['jobSendGroups','jobGroupPanel','groupChoice'],['jobToStatus','jobStatusPanel','statusChoice'],['jobSendContacts','jobContactPanel','']].forEach(function(item){
    var on=document.getElementById(item[0]).checked;document.getElementById(item[1]).classList.toggle('hidden',!on);if(item[2])document.getElementById(item[2]).classList.toggle('selected',on)
  });updateJobSummary()
}
function updateJobSummary(){
  if(!S||!S.cfg)return;
  var destinations=[],lists=[...document.querySelectorAll('.jobList:checked')],contacts=[...document.querySelectorAll('.jobRecipient:checked')];
  if(document.getElementById('jobSendGroups').checked)destinations.push(lists.length+' group list'+(lists.length===1?'':'s'));
  if(document.getElementById('jobToStatus').checked)destinations.push('WhatsApp Status');
  if(document.getElementById('jobSendContacts').checked)destinations.push(contacts.length+' contact'+(contacts.length===1?'':'s'));
  document.getElementById('jobDestinationSummary').textContent=destinations.join(' + ')||'Choose a destination';
  var mode=document.getElementById('jobMode').value;
  var intervalSelect=document.getElementById('jobInterval');
  document.getElementById('jobScheduleSummary').textContent=mode==='at'?(document.getElementById('jobDate').value.replace('T',' ')||'Choose a date and time'):mode==='interval'?('Every '+document.getElementById('jobEvery').value+' '+document.getElementById('jobEveryUnit').value):mode==='preset'?(intervalSelect.options?.[intervalSelect.selectedIndex]?.text||'Repeat at intervals'):mode==='cron'?(document.getElementById('jobCron').value||'Set a recurring schedule'):'Send now';
  var delays=jobDelaySeconds(),unitNames={1:'seconds',60:'minutes',3600:'hours',86400:'days'},unit=document.getElementById('jobIntervalUnit').value;document.getElementById('jobPacingSummary').textContent=delays.some(function(n){return !Number.isFinite(n)})?'Choose an interval':delays[0]===delays[1]?'Wait '+Number((delays[0]/Number(unit)).toFixed(4))+' '+unitNames[unit]+' between sends':'Wait '+delays[0]+' to '+delays[1]+' seconds between sends';
  var message=(S.cfg.messages||[]).find(function(m){return m.id===document.getElementById('jobMessage').value});
  document.getElementById('jobPreview').textContent=message?(message.texts||[])[0]||'Media-only message':'Choose a saved message to preview it here.';
  document.getElementById('jobMediaHint').textContent=message&&message.media?'Photo or video attached.':'';
  var account=selectedAccount();document.getElementById('jobConnectionSummary').textContent=account?account.name+' ('+account.status.replace(/_/g,' ')+')':'Select an account';
}
function scheduleMode(){var m=document.getElementById('jobMode').value;document.getElementById('dateWrap').classList.toggle('hidden',m!=='at');document.getElementById('cronWrap').classList.toggle('hidden',m!=='cron');document.getElementById('intervalWrap').classList.toggle('hidden',m!=='interval');document.getElementById('presetWrap').classList.toggle('hidden',m!=='preset');document.getElementById('createJobButton').textContent=editJobId?'Save schedule':m==='now'?'Send now':'Schedule automation';updateJobSummary()}
function newestJobs(jobs){return (jobs||[]).slice().reverse().sort(function(a,b){return (Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)})}
function renderJobs(){
  var d=document.getElementById('jobAccount'),accountChoice=accountId,messageSelect=document.getElementById('jobMessage'),messageChoice=messageSelect.value;
  d.innerHTML=(S.accounts||[]).map(function(a){return '<option value="'+esc(a.id)+'" '+(a.id===accountId?'selected':'')+'>'+esc(a.name)+'</option>'}).join('');d.value=accountChoice;
  messageSelect.innerHTML=(S.cfg.messages||[]).map(function(m){return '<option value="'+esc(m.id)+'">'+esc(m.name)+'</option>'}).join('')||'<option value="">Create a message first</option>';
  if((S.cfg.messages||[]).some(function(m){return m.id===messageChoice}))messageSelect.value=messageChoice;
  var selectedLists=[...document.querySelectorAll('.jobList:checked')].map(function(x){return x.value}),selectedRecipients=[...document.querySelectorAll('.jobRecipient:checked')].map(function(x){return x.value});
  document.getElementById('jobTargets').innerHTML=Object.keys(S.cfg.groupLists||{}).map(function(n){return '<label class="target-option"><input type="checkbox" class="jobList" onchange="updateJobSummary()" value="'+esc(n)+'" '+(selectedLists.includes(n)?'checked':'')+'> '+esc(n)+'<small>'+S.cfg.groupLists[n].length+(S.cfg.groupLists[n].length===1?' group':' groups')+'</small></label>'}).join('')||'<p class="help">No group lists yet. Create a list in Recipients &amp; Groups.</p>';
  document.getElementById('jobContactTargets').innerHTML=(S.cfg.recipients||[]).map(function(r){return '<label class="target-option"><input type="checkbox" class="jobRecipient" onchange="updateJobSummary()" value="'+esc(r.id)+'" '+(selectedRecipients.includes(r.id)?'checked':'')+'> '+esc(r.name||'Saved contact')+'</label>'}).join('')||'<p class="help">Add contacts in Recipients &amp; Groups.</p>';
  var audience=selectedAccount()?.statusAudience||{},viewers=audience.contactCount||0;document.getElementById('jobStatusAudience').textContent=audience.syncing?'WhatsApp contacts are syncing...':Number.isInteger(audience.eligibleCount)?audience.eligibleCount+' contacts can receive your Status.'+(audience.unmappedCount?' '+audience.unmappedCount+' contacts are withheld until their privacy mappings can be verified.':''):viewers?viewers+' WhatsApp contacts synced. Status uses your phone\'s privacy settings.':'Contacts sync automatically after connecting. No viewer numbers to add.';
  if(jobTimingAccount!==accountId){var delays=S.cfg.delaySeconds||[5,15];jobTimingAccount=accountId;lastIntervalUnit=1;document.getElementById('jobIntervalUnit').value='1';document.getElementById('jobPacing').value=delays[0]===delays[1]?'fixed':'random';document.getElementById('jobSendInterval').value=String(delays[0]===delays[1]?delays[0]:10);document.getElementById('jobMinDelay').value=String(delays[0]);document.getElementById('jobMaxDelay').value=String(delays[1]);pacingMode()}
  document.getElementById('jobTimezone').textContent='Clock schedules use '+(S.cfg.timezone||'Africa/Lagos')+'. Repeat intervals use elapsed time; one day is 24 hours.';
  document.getElementById('jobCards').innerHTML=newestJobs(S.cfg.jobs).map(function(j){
    var m=S.cfg.messages.find(function(x){return x.id===j.messageId}),prog=j.total?j.progress+'/'+j.total:'Waiting',destinations=[];
    if((j.toLists||[]).length)destinations.push('Groups: '+j.toLists.join(', '));if(j.toStatus)destinations.push('WhatsApp Status');if((j.toRecipients||[]).length)destinations.push(j.toRecipients.length+' contacts');
    var buttons='';if(j.canRetry)buttons+='<button onclick="jobAction(\''+esc(j.id)+'\',\'start\')">Retry</button>';if(j.status==='running')buttons+='<button class="secondary" onclick="jobAction(\''+esc(j.id)+'\',\'pause\')">Pause</button>';if(j.status==='paused')buttons+='<button onclick="jobAction(\''+esc(j.id)+'\',\'resume\')">Resume</button>';if(j.status==='scheduled')buttons+='<button class="secondary" onclick="jobAction(\''+esc(j.id)+'\',\'pause\')">Pause</button>';if(j.status==='scheduled')buttons+='<button onclick="jobAction(\''+esc(j.id)+'\',\'start\')">Start now</button>';if(!['completed','cancelled','failed'].includes(j.status))buttons+='<button class="secondary" onclick="jobAction(\''+esc(j.id)+'\',\'cancel\')">Cancel</button>';if(j.status!=='running')buttons+='<button class="secondary" onclick="editJob(\''+esc(j.id)+'\')">Edit</button>';buttons+='<button class="danger" onclick="deleteJob(\''+esc(j.id)+'\')">Delete</button>';
    return '<article class="card"><div class="row"><h3 class="grow">'+esc(j.name)+'</h3>'+statusPill(j.status)+'</div><div class="muted">'+esc(m?.name||'Missing message')+' &middot; '+esc(prog)+' deliveries processed'+(j.failedCount?' &middot; '+j.failedCount+' failed':'')+'</div><div class="job-destinations">'+destinations.map(function(n){return '<span class="pill">'+esc(n)+'</span>'}).join('')+'</div><p class="muted">Scheduled: '+esc(j.interval?'Every '+j.interval.value+' '+j.interval.unit:j.scheduleAt?new Date(j.scheduleAt).toLocaleString():j.cron||'Now')+(j.interval&&j.nextRunAt?' &middot; Next campaign: '+esc(new Date(j.nextRunAt).toLocaleString()):'')+(j.nextDeliveryAt?' &middot; Next message: '+esc(new Date(j.nextDeliveryAt).toLocaleString()):'')+(j.completedAt?' &middot; Finished: '+esc(new Date(j.completedAt).toLocaleString()):'')+'</p>'+(j.lastError?'<p class="form-feedback err">'+esc(j.lastError)+'</p>':'')+'<div class="actions">'+buttons+'</div></article>'
  }).join('')||'<div class="empty-state"><strong>Your first campaign starts here.</strong><p>Choose a message, pick its destinations, and send or schedule it above.</p></div>';
  destinationMode();scheduleMode()
}
document.addEventListener('change',function(e){if(e.target&&e.target.id==='jobAccount')switchJobAccount(e.target.value);if(e.target&&['jobDate','jobCron'].includes(e.target.id))updateJobSummary()})
function renderAccounts(){
  var card=document.getElementById('accountCards')
  card.innerHTML=(S.accounts||[]).map(function(a){
    var action=a.status==='connected'
      ? '<button class="secondary" onclick="accountAction(\''+esc(a.id)+'\',\'disconnect\')">Disconnect</button>'
      : (a.requiresPairing && !['connecting','reconnecting'].includes(a.status)
        ? '<button onclick="pairAgain(\''+esc(a.id)+'\')">Connect / get code</button>'
        : (['disconnected','temporarily_unavailable','authentication_failure'].includes(a.status) ? '<button onclick="accountAction(\''+esc(a.id)+'\',\'reconnect\')">Reconnect saved session</button>' : '<button disabled>Connecting…</button>'))
    return '<article class="card"><h3>'+esc(a.name)+'</h3><div>'+esc(a.phone)+' '+statusPill(a.status)+'</div><p class="muted">Last connected: '+esc(a.lastConnectedAt?new Date(a.lastConnectedAt).toLocaleString():'Never')+'</p>'+(a.error?'<p class="muted">'+esc(a.error)+'</p>':'')+'<div class="actions">'+action+(S.workspace?.role==='owner'?'<button class="danger" onclick="removeAccount(\''+esc(a.id)+'\')">Remove</button>':'')+'</div></article>'
  }).join('')
  if(pairCode&&pairAccountId===accountId)document.getElementById('pairCode').innerHTML='<div class="card"><h3>Pairing code for '+esc(selectedAccount()?.name)+'</h3><div class="stat">'+esc(pairCode)+'</div><p>On your phone open WhatsApp → Linked Devices → Link a device → Link with phone number, then enter this code.</p></div>'
  else document.getElementById('pairCode').innerHTML=''
}
function createJob(){
  var button=document.getElementById('createJobButton');if(button.disabled)return;
  var targetId=document.getElementById('jobAccount').value;if(targetId!==accountId){selectAccount(targetId).then(function(){jobFeedback('Account changed. Review its message and destinations before sending.');}).catch(function(e){jobFeedback(e.message,true)});return}
  if(!accountId){jobFeedback('Select a WhatsApp account first.',true);return}
  var sendGroups=document.getElementById('jobSendGroups').checked,sendContacts=document.getElementById('jobSendContacts').checked,toStatus=document.getElementById('jobToStatus').checked;
  var lists=sendGroups?[...document.querySelectorAll('.jobList:checked')].map(function(x){return x.value}):[],recipients=sendContacts?[...document.querySelectorAll('.jobRecipient:checked')].map(function(x){return x.value}):[];
  if(!sendGroups&&!sendContacts&&!toStatus){jobFeedback('Choose Groups, WhatsApp Status, or individual contacts.',true);return}
  if(sendGroups&&!lists.length){jobFeedback('Choose at least one group list, or turn off Send to groups.',true);return}
  if(sendContacts&&!recipients.length){jobFeedback('Choose at least one contact, or turn off individual contacts.',true);return}
  var mode=document.getElementById('jobMode').value,body={name:document.getElementById('jobName').value.trim(),messageId:document.getElementById('jobMessage').value,toLists:lists,toRecipients:recipients,toStatus:toStatus,repeatCount:Number(document.getElementById('jobRepeat').value),delaySeconds:jobDelaySeconds()};
  if(body.delaySeconds.some(function(n){return !Number.isFinite(n)})||body.delaySeconds[0]<0||body.delaySeconds[1]<body.delaySeconds[0]||body.delaySeconds[1]>(body.delaySeconds[0]===body.delaySeconds[1]?31536000:600)){jobFeedback('Choose a sending interval from 0 to 365 days for a fixed wait, or 0 to 600 seconds for a random range.',true);return}
  if(!body.name||!body.messageId){jobFeedback('Enter an automation name and choose a saved message.',true);return}
  if(mode==='at'){var date=new Date(document.getElementById('jobDate').value);if(!Number.isFinite(date.getTime())||date.getTime()<=Date.now()){jobFeedback('Choose a future date and time.',true);return}body.scheduleAt=date.toISOString()}
  if(mode==='cron'){body.cron=document.getElementById('jobCron').value.trim();if(!body.cron){jobFeedback('Enter a recurring schedule.',true);return}}
  if(mode==='preset')body.cron=document.getElementById('jobInterval').value;
  if(mode==='interval'){body.interval={value:Number(document.getElementById('jobEvery').value),unit:document.getElementById('jobEveryUnit').value};var factors={minutes:60000,hours:3600000,days:86400000};if(!Number.isInteger(body.interval.value)||body.interval.value<1||body.interval.value*factors[body.interval.unit]>31536000000){jobFeedback('Choose a whole-number repeat interval from 1 minute to 365 days.',true);return}var first=document.getElementById('jobFirstRun').value;if(first){var firstDate=new Date(first);if(!Number.isFinite(firstDate.getTime())||firstDate.getTime()<=Date.now()){jobFeedback('Choose a future first run.',true);return}body.scheduleAt=firstDate.toISOString()}}
  button.disabled=true;button.textContent='Saving...';document.getElementById('jobFeedback').textContent='';
  return api('/api/accounts/'+encodeURIComponent(accountId)+'/jobs'+(editJobId?'/'+encodeURIComponent(editJobId):''),editJobId?'PUT':'POST',body).then(function(d){document.getElementById('jobName').value='';cancelJobEdit();jobFeedback(d.message);return loadState()}).catch(function(e){jobFeedback(e.message,true)}).finally(function(){button.disabled=false;scheduleMode()})
}
function cancelJobEdit(){editJobId='';document.getElementById('cancelJobEdit')?.classList.add('hidden');if(S?.cfg)scheduleMode()}
function editJob(id){
  var job=S.cfg.jobs.find(function(j){return j.id===id});if(!job)return;
  editJobId=id;showView('jobs');document.getElementById('cancelJobEdit').classList.remove('hidden');
  document.getElementById('jobName').value=job.name;document.getElementById('jobMessage').value=job.messageId;document.getElementById('jobRepeat').value=job.repeatCount;
  document.getElementById('jobSendGroups').checked=!!job.toLists?.length;document.getElementById('jobSendContacts').checked=!!job.toRecipients?.length;document.getElementById('jobToStatus').checked=!!job.toStatus;
  document.querySelectorAll('.jobList').forEach(function(el){el.checked=(job.toLists||[]).includes(el.value)});document.querySelectorAll('.jobRecipient').forEach(function(el){el.checked=(job.toRecipients||[]).includes(el.value)});
  var date=job.scheduleAt&&Date.parse(job.scheduleAt)>Date.now()?new Date(job.scheduleAt):null;var local=date?new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  document.getElementById('jobMode').value=job.interval?'interval':job.cron?'cron':'at';document.getElementById('jobCron').value=job.cron||'';document.getElementById('jobDate').value=local;document.getElementById('jobFirstRun').value=local;
  document.getElementById('jobEvery').value=job.interval?.value||15;document.getElementById('jobEveryUnit').value=job.interval?.unit||'minutes';
  var seconds=job.delaySeconds[0],unit=seconds>=86400&&seconds%86400===0?86400:seconds>=3600&&seconds%3600===0?3600:seconds>=60&&seconds%60===0?60:1;
  document.getElementById('jobPacing').value=job.delaySeconds[0]===job.delaySeconds[1]?'fixed':'random';document.getElementById('jobIntervalUnit').value=String(unit);lastIntervalUnit=unit;document.getElementById('jobSendInterval').value=seconds/unit;document.getElementById('jobMinDelay').value=Math.min(seconds,600);document.getElementById('jobMaxDelay').value=Math.min(job.delaySeconds[1],600);
  destinationMode();pacingMode();scheduleMode();jobFeedback('Edit this schedule. Changes apply to future runs; saved progress is preserved.');window.scrollTo(0,0);
}
function jobAction(id,action){var words={start:'started',pause:'paused',resume:'resumed',cancel:'cancelled'};return api('/api/accounts/'+encodeURIComponent(accountId)+'/jobs/'+encodeURIComponent(id)+'/'+action,'POST',{}).then(function(){toast('Job '+(words[action]||action)+'.');return loadState()}).catch(function(e){toast(e.message,true)})}
function deleteJob(id){if(!confirm('Delete this automation?'))return;api('/api/accounts/'+encodeURIComponent(accountId)+'/jobs/'+encodeURIComponent(id),'DELETE').then(function(){toast('Job deleted.');return loadState()}).catch(function(e){toast(e.message,true)})}
function renderSettings(){renderWorkspace();if(['timezone','defaultMin','defaultMax'].includes(document.activeElement?.id))return;document.getElementById('timezone').value=S.cfg.timezone||'Africa/Lagos';document.getElementById('defaultMin').value=(S.cfg.delaySeconds||[5,15])[0];document.getElementById('defaultMax').value=(S.cfg.delaySeconds||[5,15])[1]}
function saveSettings(){S.cfg.timezone=document.getElementById('timezone').value;S.cfg.delaySeconds=[Number(document.getElementById('defaultMin').value),Number(document.getElementById('defaultMax').value)];jobTimingAccount='';saveData('Settings saved.').catch(function(){})}
fetch('/api/session').then(function(r){if(!r.ok){location.assign('/login');throw new Error('Sign in again.')}return r.json()}).then(function(x){csrfToken=x.csrfToken;return loadState()}).then(function(){showView('overview')}).catch(function(e){if(e.message!=='Sign in again.')toast(e.message,true)});setInterval(pollState,3000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)pollState()});
document.addEventListener('focusout',function(){setTimeout(function(){if(S&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||''))render()},0)});
window.addEventListener?.('online',pollState);window.addEventListener?.('focus',pollState);
</script></body></html>`

onAccountConnected(async (waSocket, accountId) => {
  log('WhatsApp account connected:', accountId)
  try {
    const groups = await refreshAccountGroups(accountId)
    log(`Loaded ${groups.length} groups for account ${accountId}`)
    const data = await dataFor(accountId)
    if (testJobName) {
      const job = data.jobs.find(j => j.name === testJobName)
      if (!job) { log('No job named', testJobName); process.exit(1) }
      await runJob(accountId, job.id, { oneShot: true })
      log('Test finished')
      await sleep(3000)
      process.exit(0)
    }
    scheduleAccount(accountId, data)
  } catch (e) { log('Could not load WhatsApp groups:', e.message); scheduleAccount(accountId, await dataFor(accountId)) }
})

if (!testJobName) startDashboard()
listAccounts().then(async accounts => {
  for (const account of accounts) {
    try {
      const data = await dataFor(account.id)
      let recovered = false
      for (const job of data.jobs) if (job.status === 'running') {
        recovered = recoverInterruptedJob(job) || recovered
      }
      if (recovered) saveAccountData(account.id, data)
      scheduleAccount(account.id, data)
    }
    catch (e) { log('Could not load account automation:', e.message) }
  }
  schedulerStarted = true
}).catch(() => log('Account restore failed. Check local account storage permissions and metadata.'))
