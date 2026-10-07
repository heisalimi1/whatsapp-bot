import cron from 'node-cron'
import express from 'express'
import crypto from 'crypto'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { listAccounts, getAccountSocket, createAccount, getAccount, ownsAccount, claimLegacyAccounts, reconnectAccount, disconnectAccount, removeAccount, closeAllAccounts, onAccountConnected } from './whatsapp-manager.js'
import { loadAutomation, saveAutomation, makeId } from './automation-store.js'
import { allowRate, tokensMatch } from './dashboard-security.js'
import { cleanupExpiredAuthRecords, closeAuthStore, consumePasswordReset, createPasswordReset, createSession, createUser, destroySession, findUser, normalizeEmail, sessionForRequest, verifyUserPassword } from './auth-store.js'
import { sendPasswordResetEmail } from './password-reset-mailer.js'
import { FORGOT_PASSWORD_PAGE, LOGIN_PAGE as AUTH_LOGIN_PAGE, RESET_PASSWORD_PAGE, SIGNUP_PAGE } from './auth-pages.js'

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
  accountData.set(accountId, data)
  return data
  })()
  accountDataLoads.set(accountId, loading)
  try { return await loading } finally { accountDataLoads.delete(accountId) }
}

function saveAccountData(accountId, data) { accountData.set(accountId, data); saveAutomation(accountId, data) }

function publicAutomation(data) {
  return {
    timezone: data.timezone, delaySeconds: data.delaySeconds, statusRecipients: data.statusRecipients,
    groupLists: data.groupLists,
    recipients: (data.recipients || []).map(({ id, name, phone }) => ({ id, name, phone })),
    messages: (data.messages || []).map(({ id, name, texts, media, createdAt, updatedAt }) => ({ id, name, texts, media, createdAt, updatedAt })),
    jobs: (data.jobs || []).map(job => ({
      id: job.id, name: job.name, messageId: job.messageId, toLists: job.toLists, toRecipients: job.toRecipients,
      repeatCount: job.repeatCount, delaySeconds: job.delaySeconds, cron: job.cron, scheduleAt: job.scheduleAt,
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

function pickText(message, key) {
  const pool = Array.isArray(message?.texts) && message.texts.length ? message.texts : [message?.text || '']
  return pool[Math.floor(Math.random() * pool.length)]
}

async function waitBetweenSends(key, duration) {
  let remaining = duration
  while (remaining > 0 && !stopRequests.has(key)) {
    const interval = Math.min(remaining, 250)
    await sleep(interval)
    remaining -= interval
  }
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
  for (const task of cronTasks.get(accountId)?.values() || []) task.stop()
  for (const timer of oneShotTimers.get(accountId)?.values() || []) clearTimeout(timer)
  const schedules = new Map(), timers = new Map()
  cronTasks.set(accountId, schedules); oneShotTimers.set(accountId, timers)
  if (shuttingDown) return
  const opts = data.timezone ? { timezone: data.timezone } : {}
  for (const job of data.jobs || []) {
    if (['paused', 'cancelled', 'completed', 'failed'].includes(job.status)) continue
    if (job.scheduleAt) {
      const runAt = Date.parse(job.scheduleAt)
      if (!Number.isFinite(runAt)) continue
      const tick = () => {
        const left = runAt - Date.now()
        if (left <= 0) { runJob(accountId, job.id, { oneShot: true }).catch(e => log('Job failed:', e.message)); return }
        timers.set(job.id, setTimeout(tick, Math.min(left, 2147480000)))
      }
      tick()
    } else if (job.cron && cron.validate(job.cron)) {
      schedules.set(job.id, cron.schedule(job.cron, () => runJob(accountId, job.id).catch(e => log('Job failed:', e.message)), opts))
    } else if (!job.cron && accountGroups.has(accountId) && job.status === 'scheduled') {
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

async function executeJob(accountId, jobId, { oneShot = false, resumeProgress = false } = {}) {
  const key = `${accountId}:${jobId}`
  const data = await dataFor(accountId)
  const job = data.jobs.find(j => j.id === jobId)
  if (!job) throw new Error('Job not found.')
  if (['paused', 'cancelled'].includes(job.status)) throw new Error(`This job is ${job.status}.`)
  const sock = await getAccountSocket(accountId)
  if (!sock) { job.status = oneShot ? 'failed' : 'scheduled'; job.lastError = 'WhatsApp account is not connected.'; saveAccountData(accountId, data); return }
  const message = data.messages.find(m => m.id === job.messageId) || { texts: job.texts || [job.text || ''], media: job.media || '' }
  const targets = await targetsFor(accountId, data, job)
  if (!targets.length) { job.status = 'failed'; job.lastError = 'Choose at least one group or individual recipient.'; saveAccountData(accountId, data); return }
  const rawRepeat = Number(job.repeatCount)
  const repeat = Number.isInteger(rawRepeat) && rawRepeat >= 1 && rawRepeat <= 100 ? rawRepeat : 0
  const delays = Array.isArray(job.delaySeconds) ? job.delaySeconds : data.delaySeconds
  if (!repeat || !Array.isArray(delays) || delays.length !== 2 || delays.some(n => !Number.isFinite(Number(n))) || Number(delays[0]) < 0 || Number(delays[1]) < Number(delays[0]) || Number(delays[1]) > 600) {
    job.status = 'failed'; job.lastError = 'Job repeat count or delivery delay is invalid.'; saveAccountData(accountId, data); return
  }
  if (targets.length * repeat > 10000) { job.status = 'failed'; job.lastError = 'This job exceeds the 10,000 delivery safety limit.'; saveAccountData(accountId, data); return }
  const [minD, maxD] = delays.map(Number)
  const previousProgress = Math.max(0, Math.min(job.progress || 0, targets.length * repeat))
  job.status = 'running'; job.startedAt = new Date().toISOString(); job.progress = resumeProgress ? previousProgress : 0; job.total = targets.length * repeat
  if (!resumeProgress) job.failedCount = 0
  job.lastError = ''
  saveAccountData(accountId, data)
  log(`Job ${job.id} started for account ${accountId}; ${job.total} deliveries queued`)
  try {
    let deliveryIndex = 0
    for (let r = 0; r < repeat; r++) {
      for (const target of targets) {
        if (deliveryIndex++ < (resumeProgress ? previousProgress : 0)) continue
        const current = await dataFor(accountId)
        const liveJob = current.jobs.find(j => j.id === jobId)
        if (!liveJob || stopRequests.has(key) || liveJob.status === 'paused' || liveJob.status === 'cancelled') break
        const text = pickText(message, key)
        const content = buildContent({ media: message.media }, text, accountId)
        if (!content) throw new Error(`Media file for "${message.name || job.name}" is missing.`)
        try { await sock.sendMessage(target.jid, content); log(`Job ${job.id} sent one delivery for account ${accountId}`) }
        catch (e) { log(`Job ${job.id} delivery failed for account ${accountId}:`, e.message); job.failedCount = (job.failedCount || 0) + 1; job.lastError = 'One or more recipients could not be reached.' }
        job.progress++
        saveAccountData(accountId, data)
        if (job.progress < job.total && maxD > 0) await waitBetweenSends(key, (minD + Math.random() * (maxD - minD)) * 1000)
      }
      if (stopRequests.has(key)) break
    }
    if (job.toStatus && !stopRequests.has(key)) {
      const jids = (data.statusRecipients || []).map(n => String(n).includes('@') ? n : `${n}@s.whatsapp.net`)
      if (jids.length) {
        try { const content = buildContent({ media: message.media }, pickText(message, key), accountId); if (content) await sock.sendMessage('status@broadcast', content, { statusJidList: jids }) }
        catch (e) { job.failedCount++; job.lastError = 'Status post failed.'; log(`Status delivery failed for job ${job.id}:`, e.message) }
      }
    }
    if (job.status === 'paused' || job.status === 'cancelled') return
    job.completedAt = new Date().toISOString()
    job.status = job.failedCount ? 'failed' : (job.cron && !job.scheduleAt ? 'scheduled' : 'completed')
    if (job.status === 'completed') job.completedAt = new Date().toISOString()
    saveAccountData(accountId, data)
    scheduleAccount(accountId, data)
  } catch (e) {
    job.status = 'failed'; job.lastError = 'Job failed. Check the server log and WhatsApp connection.'; job.completedAt = new Date().toISOString(); saveAccountData(accountId, data)
    log('Job execution failed:', e?.message || 'unknown error')
    scheduleAccount(accountId, data)
    throw e
  } finally {}
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
    cron: String(j.cron || '').slice(0, 100), scheduleAt: String(j.scheduleAt || '').slice(0, 40), toStatus: !!j.toStatus,
    status: ['scheduled', 'running', 'paused', 'cancelled', 'completed', 'failed'].includes(j.status) ? j.status : 'scheduled',
    progress: Math.max(0, Math.floor(Number(j.progress) || 0)), total: Math.max(0, Math.floor(Number(j.total) || 0)),
    createdAt: String(j.createdAt || new Date().toISOString()).slice(0, 40), scheduledAt: String(j.scheduledAt || '').slice(0, 100),
    startedAt: String(j.startedAt || '').slice(0, 40), completedAt: String(j.completedAt || '').slice(0, 40),
    failedCount: Math.max(0, Math.floor(Number(j.failedCount) || 0)), lastError: String(j.lastError || '').slice(0, 300)
  }))
  if (jobs.some(j => !j.name || /[\u0000-\u001f\u007f]/.test(j.name) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(j.id) || !messages.some(m => m.id === j.messageId) || !Number.isInteger(j.repeatCount) || j.repeatCount < 1 || j.repeatCount > 100) || new Set(jobs.map(j => j.id)).size !== jobs.length) return { error: 'Each job needs a unique valid name, saved message and repeat count from 1 to 100.' }
  if (jobs.some(j => j.delaySeconds.length !== 2 || j.delaySeconds.some(n => !Number.isFinite(n)) || j.delaySeconds[0] < 0 || j.delaySeconds[1] < j.delaySeconds[0] || j.delaySeconds[1] > 600)) return { error: 'A job has an invalid delivery delay.' }
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
          job.status = 'paused'
          job.lastError = 'Paused during graceful shutdown; delivery progress is saved.'
          saveAccountData(accountId, data)
        }
      } catch (e) { log('Could not save a job during shutdown:', e.message) }
    }

    await Promise.race([serverClosed, sleep(Math.max(0, stopAt - Date.now()))])
    await Promise.race([Promise.allSettled([...activeJobPromises.values()]), sleep(Math.max(0, stopAt - Date.now()))])
    if (dashboardServer?.listening) dashboardServer.closeAllConnections?.()
    try { await closeAllAccounts() } catch (e) { log('Could not close all WhatsApp sockets cleanly:', e.message); process.exitCode = 1 }
    try { closeAuthStore() } catch (e) { log('Could not close the authentication database cleanly:', e.message); process.exitCode = 1 }
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
  app.use('/api/login', (req, res, next) => allowRate(req.ip || req.socket.remoteAddress || 'unknown', 'login-traffic', 30, 15 * 60 * 1000) ? next() : res.status(429).json({ error: 'Too many sign-in requests. Try again later.' }))
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
  app.get('/', (req, res) => sessionForRequest(req) ? res.type('html').send(STAGE3_PAGE) : res.redirect('/login'))
  const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  const validPassword = value => typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 72
  const sameOrigin = req => !!req.get('origin') && req.get('origin') === `${req.protocol}://${req.get('host')}`
  const setSessionCookie = (res, req, session) => {
    const maxAge = session.remember ? 30 * 24 * 60 * 60 : 12 * 60 * 60
    res.set('Set-Cookie', `wa_dashboard_session=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${(remoteBind || req.secure) ? '; Secure' : ''}`)
  }
  app.post('/api/signup', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    if (!allowRate(ip, 'signup', 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many account requests. Please try again later.' })
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
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    if (!allowRate(ip, 'login', 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many sign-in attempts. Please try again later.' })
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
  app.use('/api', (req, res, next) => allowRate(req.ip || 'unknown', 'api', 300, 60 * 1000) ? next() : res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' }))
  app.use('/api/accounts/:id', async (req, res, next) => {
    try {
      if (!await ownsAccount(req.params.id, req.user.id)) return res.status(404).json({ error: 'WhatsApp account not found.' })
      next()
    } catch { res.status(500).json({ error: 'We could not load this WhatsApp account.' }) }
  })
  app.get('/api/session', (req, res) => res.json({ csrfToken: req.dashboardSession.csrfToken, expiresAt: req.dashboardSession.expiresAt, user: req.user }))
  app.post('/api/logout', (req, res) => {
    destroySession(req)
    res.set('Set-Cookie', `wa_dashboard_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${(remoteBind || req.secure) ? '; Secure' : ''}`)
    res.json({ ok: true })
  })

  app.get('/health', async (req, res) => {
    const accounts = await listAccounts(req.user.id)
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
    const accounts = await listAccounts(req.user.id)
    const selectedAccountId = String(req.query.accountId || accounts[0]?.id || '')
    const account = accounts.find(a => a.id === selectedAccountId)
    if (selectedAccountId && !account) return res.status(404).json({ error: 'Account not found.' })
    const data = account ? await dataFor(account.id) : { timezone: cfg.timezone, delaySeconds: cfg.delaySeconds, statusRecipients: [], recipients: [], groupLists: {}, messages: [], jobs: [] }
    const overviewJobs = []
    for (const a of accounts) {
      try { for (const j of (await dataFor(a.id)).jobs) overviewJobs.push({ id: j.id, name: j.name, status: j.status, createdAt: j.createdAt, scheduledAt: j.scheduledAt, accountName: a.name, accountId: a.id }) } catch {}
    }
    res.json({ accounts, account, selectedAccountId, cfg: publicAutomation(data), groups: accountGroups.get(selectedAccountId) || [], jobs: overviewJobs, connected: accounts.some(a => a.status === 'connected') })
  })

  app.get('/api/accounts', async (req, res) => res.json({ accounts: await listAccounts(req.user.id) }))
  app.get('/api/accounts/:id', async (req, res) => {
    const account = await getAccount(req.params.id)
    if (!account) return res.status(404).json({ error: 'Account not found.' })
    res.json({ account })
  })
  app.post('/api/accounts', async (req, res) => {
    try {
      if (!allowRate(req.ip || 'unknown', 'create-account', 3, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many account creation requests. Try again later.' })
      const phone = String(req.body?.phone || '').trim()
      if (!/^[+()\d\s.-]+$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number with country code.' })
      const result = await createAccount({ userId: req.user.id, name: req.body?.name, phone })
      res.status(201).json(result)
    } catch (e) { log('Could not create WhatsApp account:', e?.message || 'unknown error'); res.status(400).json({ error: 'Could not create WhatsApp account. Check the phone number and try again.' }) }
  })
  app.post('/api/accounts/:id/reconnect', async (req, res) => {
    try {
      if (!allowRate(req.ip || 'unknown', `reconnect:${req.params.id}`, 6, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many reconnect attempts for this account. Try again later.' })
      res.json(await reconnectAccount(req.params.id, { pair: !!req.body?.pair }))
    }
    catch (e) { log('Could not reconnect WhatsApp account:', e?.message || 'unknown error'); res.status(400).json({ error: 'Could not reconnect this WhatsApp account. Try again.' }) }
  })
  app.post('/api/accounts/:id/disconnect', async (req, res) => {
    try { res.json({ account: await disconnectAccount(req.params.id) }) }
    catch (e) { log('Could not disconnect WhatsApp account:', e?.message || 'unknown error'); res.status(400).json({ error: 'Could not disconnect this WhatsApp account.' }) }
  })
  app.delete('/api/accounts/:id', async (req, res) => {
    try {
      const id = req.params.id
      if ([...runningJobs].some(key => key.startsWith(`${id}:`))) return res.status(409).json({ error: 'Pause or cancel this account’s running jobs before removing it.' })
      const result = await removeAccount(id)
      for (const task of cronTasks.get(id)?.values() || []) task.stop()
      for (const timer of oneShotTimers.get(id)?.values() || []) clearTimeout(timer)
      cronTasks.delete(id); oneShotTimers.delete(id); accountGroups.delete(id); accountData.delete(id)
      res.json(result)
    }
    catch (e) { log('Could not remove WhatsApp account:', e?.message || 'unknown error'); res.status(400).json({ error: 'Could not remove this WhatsApp account.' }) }
  })

  app.get('/api/accounts/:id/groups', async (req, res) => {
    const sock = await getAccountSocket(req.params.id)
    if (!sock) return res.status(409).json({ error: 'Connect this WhatsApp account to load its groups.' })
    try {
      const groups = Object.values(await sock.groupFetchAllParticipating()).map(g => ({ id: g.id, subject: g.subject })).sort((a, b) => a.subject.localeCompare(b.subject))
      accountGroups.set(req.params.id, groups)
      normalizeGroupLists(req.params.id, await dataFor(req.params.id), groups)
      res.json({ groups })
    } catch { res.status(502).json({ error: 'Unable to load groups from WhatsApp. Please retry.' }) }
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
  app.put('/api/accounts/:id/data', async (req, res) => {
    try {
      const previous = await dataFor(req.params.id)
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
        for (const key of ['status', 'progress', 'total', 'createdAt', 'scheduledAt', 'startedAt', 'completedAt', 'failedCount', 'lastError']) if (prior[key] !== undefined) j[key] = prior[key]
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
    if (!await ownsAccount(accountId, req.user.id)) return res.status(404).json({ error: 'Choose a WhatsApp account first.' })
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

  app.post('/api/accounts/:id/jobs', async (req, res) => {
    try {
      const data = await dataFor(req.params.id), body = req.body || {}
      if (data.jobs.length >= MAX_JOBS_PER_ACCOUNT) return res.status(409).json({ error: `This account has reached its ${MAX_JOBS_PER_ACCOUNT}-job storage limit. Remove old jobs before adding more.` })
      if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Enter a job name.' })
      if (!data.messages.some(m => m.id === body.messageId)) return res.status(400).json({ error: 'Choose a saved message.' })
      if (!(body.toLists || []).length && !(body.toRecipients || []).length) return res.status(400).json({ error: 'Choose at least one recipient or group list.' })
      const repeatCount = Number(body.repeatCount)
      const delaySeconds = Array.isArray(body.delaySeconds) ? body.delaySeconds.map(Number) : data.delaySeconds
      if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100) return res.status(400).json({ error: 'Repeat count must be between 1 and 100.' })
      if (delaySeconds.length !== 2 || delaySeconds.some(n => !Number.isFinite(n)) || delaySeconds[0] < 0 || delaySeconds[1] < delaySeconds[0] || delaySeconds[1] > 600) return res.status(400).json({ error: 'Enter a valid delay range from 0 to 600 seconds.' })
      if (body.cron && !cron.validate(body.cron)) return res.status(400).json({ error: 'Enter a valid recurring schedule.' })
      const scheduleAt = body.scheduleAt ? new Date(body.scheduleAt) : null
      if (scheduleAt && (!Number.isFinite(scheduleAt.getTime()) || scheduleAt.getTime() <= Date.now())) return res.status(400).json({ error: 'Choose a future schedule time.' })
      if (!scheduleAt && !body.cron && !await getAccountSocket(req.params.id)) return res.status(409).json({ error: 'Connect this WhatsApp account before starting an automation now.' })
      const job = { id: makeId(), name: String(body.name).trim().slice(0, 100), messageId: body.messageId, toLists: (body.toLists || []).filter(n => n in data.groupLists), toRecipients: (body.toRecipients || []).filter(id => data.recipients.some(r => r.id === id)), repeatCount, delaySeconds, cron: body.cron || '', scheduleAt: scheduleAt?.toISOString() || '', status: 'scheduled', progress: 0, total: 0, createdAt: new Date().toISOString(), scheduledAt: scheduleAt?.toISOString() || body.cron || 'Now', completedAt: '' }
      if (!job.toLists.length && !job.toRecipients.length) return res.status(400).json({ error: 'Choose valid recipients.' })
      data.jobs.push(job); saveAccountData(req.params.id, data); scheduleAccount(req.params.id, data)
      if (!scheduleAt && !job.cron) runJob(req.params.id, job.id, { oneShot: true }).catch(e => log('Job failed:', e.message))
      res.status(201).json({ ok: true, job, message: scheduleAt || job.cron ? 'Automation scheduled successfully.' : 'Automation started successfully.' })
    } catch (e) { log('Unable to create automation:', e?.message || 'unknown error'); res.status(400).json({ error: 'Unable to create automation. Check its settings and try again.' }) }
  })
  app.post('/api/accounts/:id/jobs/:jobId/:action', async (req, res) => {
    try {
      const data = await dataFor(req.params.id), job = data.jobs.find(j => j.id === req.params.jobId)
      if (!job) return res.status(404).json({ error: 'Job not found.' })
      const key = `${req.params.id}:${job.id}`, action = req.params.action
      if (action === 'start') {
        if (runningJobs.has(key)) return res.status(409).json({ error: 'This job is already running.' })
        job.scheduleAt = ''; job.scheduledAt = job.cron ? job.cron : 'Now'; job.status = 'scheduled'; job.lastError = ''; saveAccountData(req.params.id, data)
        runJob(req.params.id, job.id, { oneShot: true }).catch(e => log('Job failed:', e.message))
      } else if (action === 'pause') {
        if (!['running', 'scheduled'].includes(job.status)) return res.status(400).json({ error: 'Only scheduled or running jobs can be paused.' })
        job.status = 'paused'; stopRequests.set(key, 'paused'); removeQueuedJob(key); saveAccountData(req.params.id, data)
      }
      else if (action === 'resume') {
        if (job.status !== 'paused') return res.status(400).json({ error: 'Only paused jobs can be resumed.' })
        job.status = 'scheduled'; stopRequests.delete(key); saveAccountData(req.params.id, data)
        const hasProgress = job.progress > 0 && job.progress < job.total
        const expiredOneShot = job.scheduleAt && Date.parse(job.scheduleAt) <= Date.now()
        if (hasProgress || expiredOneShot || (!job.scheduleAt && !job.cron)) runJob(req.params.id, job.id, { oneShot: true, resumeProgress: true }).catch(e => log('Job failed:', e.message))
        else scheduleAccount(req.params.id, data)
      } else if (action === 'cancel') {
        if (['completed', 'cancelled'].includes(job.status)) return res.status(400).json({ error: `A ${job.status} job cannot be cancelled.` })
        job.status = 'cancelled'; stopRequests.set(key, 'cancelled'); removeQueuedJob(key); saveAccountData(req.params.id, data)
      }
      else return res.status(404).json({ error: 'Unknown job action.' })
      scheduleAccount(req.params.id, data)
      res.json({ ok: true, job })
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
    const ownedIds = (await listAccounts(req.user.id)).map(account => account.id)
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
</style></head><body>
<header><b>Business WhatsApp</b><span id="topStatus" class="pill">Loading</span><select id="accountSelect" onchange="selectAccount(this.value)"></select><button class="secondary" onclick="logout()">Logout</button></header>
<main><nav class="nav"><button data-view="overview" onclick="showView('overview')">Overview</button><button data-view="accounts" onclick="showView('accounts')">Accounts</button><button data-view="messages" onclick="showView('messages')">Messages</button><button data-view="groups" onclick="showView('groups')">Recipients &amp; Groups</button><button data-view="jobs" onclick="showView('jobs')">Automations</button><button data-view="settings" onclick="showView('settings')">Settings</button></nav>
<section id="overview" class="view"><h1>Dashboard</h1><div class="grid"><div class="card"><small>WhatsApp accounts</small><div class="stat" id="accountCount">0</div><button onclick="showView('accounts')">Manage accounts</button></div><div class="card"><small>Active jobs</small><div class="stat" id="activeCount">0</div><button onclick="showView('jobs')">View automations</button></div><div class="card"><small>Scheduled jobs</small><div class="stat" id="scheduledCount">0</div><button onclick="showView('jobs')">View schedule</button></div></div><div class="card"><h2>WhatsApp Accounts</h2><div id="overviewAccounts"></div><button onclick="showView('accounts')">＋ Connect WhatsApp</button></div><div class="card"><h2>Active Automations</h2><div id="overviewJobs"></div></div><div class="card"><h2>Recent Activity</h2><pre id="overviewLog"></pre></div><div class="card"><h2>Quick actions</h2><div class="actions"><button onclick="showView('accounts')">Connect WhatsApp</button><button onclick="newMessage();showView('messages')">Create Message</button><button onclick="showView('groups')">Manage Groups</button><button onclick="showView('jobs')">Create Automation</button></div></div></section>
<section id="accounts" class="view"><h1>WhatsApp Accounts</h1><div class="card"><h2>＋ Connect WhatsApp</h2><div class="muted">Enter the phone number with country code. We’ll show a pairing code here.</div><div class="row"><input id="newAccountName" type="text" placeholder="Business or account name"><input id="newAccountPhone" type="tel" placeholder="+234 801 234 5678"><button onclick="connectAccount()">Connect WhatsApp</button></div><div id="pairCode"></div></div><div id="accountCards" class="grid"></div></section>
<section id="messages" class="view"><h1>Messages</h1><div class="card"><h2 id="messageFormTitle">Create message</h2><input id="messageName" type="text" placeholder="Message name"><textarea id="messageText" placeholder="Message text. Separate rotating versions with a line containing ---"></textarea><div class="row"><input id="messageFile" type="file" accept="image/*,video/mp4,video/quicktime"><button class="secondary" onclick="uploadMessageMedia()">Upload media</button><span id="mediaLabel" class="muted"></span></div><div class="actions"><button onclick="saveMessage()">Save message</button><button class="secondary" onclick="previewMessage()">Preview</button><button class="secondary" onclick="newMessage()">Clear</button></div></div><div id="messageCards" class="grid"></div></section>
<section id="groups" class="view"><h1>Recipients &amp; Groups</h1><div class="card"><h2>Individual numbers</h2><div class="row"><input id="recipientName" type="text" placeholder="Contact name (optional)"><input id="recipientPhone" type="tel" placeholder="Number with country code"><button onclick="addRecipient()">Add number</button></div><div id="recipientCards"></div></div><div class="card"><h2>Group Lists</h2><div class="row"><input id="newListName" type="text" placeholder="New group list name"><button onclick="addList()">Create Group List</button><button class="secondary" onclick="loadGroups()">Refresh WhatsApp groups</button></div><div id="listCards"></div></div></section>
<section id="jobs" class="view"><h1>Automations</h1><div class="card"><h2>Create Automation</h2><div class="row"><label class="grow">WhatsApp account<select id="jobAccount"></select></label><label class="grow">Job name<input id="jobName" type="text" placeholder="Weekend Promotion"></label></div><div class="row"><label class="grow">Message<select id="jobMessage"></select></label><label>Repeat count<input id="jobRepeat" type="number" min="1" max="100" value="1"></label></div><div class="row"><label>Minimum delay (seconds)<input id="jobMinDelay" type="number" min="0" max="600" value="5"></label><label>Maximum delay (seconds)<input id="jobMaxDelay" type="number" min="0" max="600" value="15"></label></div><div><b>Recipients / lists</b><div id="jobTargets" class="row"></div></div><div class="row"><label>Schedule<select id="jobMode" onchange="scheduleMode()"><option value="now">Now</option><option value="at">Schedule once</option><option value="cron">Recurring schedule</option></select></label><label id="dateWrap" class="hidden">Run at<input id="jobDate" type="datetime-local"></label><label id="cronWrap" class="hidden grow">Cron schedule<input id="jobCron" type="text" placeholder="0 9 * * *"></label><label><input id="jobToStatus" type="checkbox"> Also post to status</label></div><button onclick="createJob()">Create Job</button></div><div id="jobCards"></div></section>
<section id="settings" class="view"><h1>Settings</h1><div class="card"><label>Timezone<input id="timezone" type="text" placeholder="Africa/Lagos"></label><div class="row"><label>Default minimum delay<input id="defaultMin" type="number" min="0" max="600"></label><label>Default maximum delay<input id="defaultMax" type="number" min="0" max="600"></label></div><label>Status viewers, one phone number per line<textarea id="statusRecipients"></textarea></label><button onclick="saveSettings()">Save settings</button></div></section>
</main><div id="toast" class="toast"></div>
<script>
var S=null, accountId='', activeView='overview', editMessageId='', mediaPath='', pairCode='', pairAccountId='', toastTimer=null, csrfToken='';
function esc(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function api(url,method,body){method=method||'GET';var headers={'Content-Type':'application/json'};if(method!=='GET'&&method!=='HEAD')headers['X-CSRF-Token']=csrfToken;return fetch(url,{method:method,headers:headers,body:body===undefined?undefined:JSON.stringify(body)}).then(async function(r){if(r.status===401){location.assign('/login');throw new Error('Sign in again.')}var d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed.');return d})}
function logout(){api('/api/logout','POST',{}).then(function(){location.assign('/login')}).catch(function(e){toast(e.message,true)})}
function toast(msg,bad){var el=document.getElementById('toast');el.textContent=msg;el.className='toast'+(bad?' err':'');el.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.style.display='none'},3500)}
function selectedAccount(){return (S.accounts||[]).find(function(a){return a.id===accountId})}
function showView(name){activeView=name;document.querySelectorAll('.view').forEach(function(x){x.classList.toggle('sel',x.id===name)});document.querySelectorAll('.nav button').forEach(function(x){x.classList.toggle('sel',x.dataset.view===name)})}
function selectAccount(id){accountId=id;pairCode='';loadState().then(function(){toast('Account selected.')}).catch(function(e){toast(e.message,true)})}
function switchJobAccount(id){if(id&&id!==accountId)selectAccount(id)}
function loadState(){var url='/api/state'+(accountId?'?accountId='+encodeURIComponent(accountId):'');return api(url).then(function(d){S=d;accountId=d.selectedAccountId||'';render();return d})}
function refresh(){var draft={name:document.getElementById('newAccountName')?.value||'',phone:document.getElementById('newAccountPhone')?.value||''};return loadState().then(function(){var a=document.getElementById('newAccountName'),p=document.getElementById('newAccountPhone');if(a)a.value=draft.name;if(p)p.value=draft.phone})}
function render(){if(!S)return;var acc=selectedAccount(),sel=document.getElementById('accountSelect');sel.innerHTML=(S.accounts||[]).map(function(a){return '<option value="'+esc(a.id)+'" '+(a.id===accountId?'selected':'')+'>'+esc(a.name)+' · '+esc(a.phone)+'</option>'}).join('')||'<option value="">No accounts</option>';document.getElementById('topStatus').textContent=acc?acc.status.replace('_',' '):'No WhatsApp account';document.getElementById('accountCount').textContent=(S.accounts||[]).length;document.getElementById('activeCount').textContent=(S.jobs||[]).filter(function(j){return j.status==='running'}).length;document.getElementById('scheduledCount').textContent=(S.jobs||[]).filter(function(j){return j.status==='scheduled'}).length;renderOverview();renderAccounts();renderMessages();renderGroups();renderJobs();renderSettings();showView(activeView)}
function statusPill(status){return '<span class="pill '+esc(status)+'">'+esc(String(status||'unknown').replace('_',' '))+'</span>'}
function renderOverview(){document.getElementById('overviewAccounts').innerHTML=(S.accounts||[]).map(function(a){return '<div class="row"><b class="grow">'+esc(a.name)+'</b>'+esc(a.phone)+' '+statusPill(a.status)+' <button class="secondary" onclick="selectAccount(\''+esc(a.id)+'\').then(function(){showView(\'accounts\')})">Manage</button></div>'}).join('')||'<p class="muted">Connect a WhatsApp account to get started.</p>';document.getElementById('overviewJobs').innerHTML=(S.jobs||[]).slice(0,8).map(function(j){return '<div class="row"><b class="grow">'+esc(j.name)+'</b><span>'+esc(j.accountName)+'</span>'+statusPill(j.status)+'</div>'}).join('')||'<p class="muted">No automation jobs yet.</p>';api('/api/log').then(function(x){document.getElementById('overviewLog').textContent=x.log||'No recent activity.'}).catch(function(){})}
function renderAccounts(){var card=document.getElementById('accountCards');card.innerHTML=(S.accounts||[]).map(function(a){var action=a.status==='connected'?'<button class="secondary" onclick="accountAction(\''+esc(a.id)+'\',\'disconnect\')">Disconnect</button>':(a.status==='logged_out'||a.status==='authentication_failure'?'<button onclick="pairAgain(\''+esc(a.id)+'\')">Connect</button>':'<button onclick="accountAction(\''+esc(a.id)+'\',\'reconnect\')">Reconnect</button>');return '<article class="card"><h3>'+esc(a.name)+'</h3><div>'+esc(a.phone)+' '+statusPill(a.status)+'</div><p class="muted">Last connected: '+esc(a.lastConnectedAt?new Date(a.lastConnectedAt).toLocaleString():'Never')+'</p>'+(a.error?'<p class="muted">'+esc(a.error)+'</p>':'')+'<div class="actions">'+action+'<button class="danger" onclick="removeAccount(\''+esc(a.id)+'\')">Remove</button></div></article>'}).join('');if(pairCode&&pairAccountId===accountId)document.getElementById('pairCode').innerHTML='<div class="card"><h3>Pairing code · '+esc(selectedAccount()?.name)+'</h3><div class="stat">'+esc(pairCode)+'</div><p>On your phone open WhatsApp → Linked Devices → Link a device → Link with phone number, then enter this code.</p></div>';else document.getElementById('pairCode').innerHTML=''}
function connectAccount(){var name=document.getElementById('newAccountName').value,phone=document.getElementById('newAccountPhone').value;if(!/^[+()\d\s.-]+$/.test(phone)){toast('Enter a valid WhatsApp phone number.',true);return}api('/api/accounts','POST',{name:name,phone:phone}).then(function(d){accountId=d.account.id;pairAccountId=accountId;pairCode=d.pairingCode||'';return loadState()}).then(function(){toast(pairCode?'Pairing code generated.':'Connection starting.')}).catch(function(e){toast(e.message,true);refresh()})}
function pairAgain(id){accountId=id;api('/api/accounts/'+encodeURIComponent(id)+'/reconnect','POST',{pair:true}).then(function(d){pairCode=d.pairingCode||'';pairAccountId=id;return loadState()}).then(function(){toast(pairCode?'Pairing code generated.':'Reconnecting.')}).catch(function(e){toast(e.message,true)})}
function accountAction(id,action){api('/api/accounts/'+encodeURIComponent(id)+'/'+action,'POST',{}).then(function(){toast(action==='disconnect'?'Account disconnected.':'Reconnection started.');return loadState()}).catch(function(e){toast(e.message,true)})}
function removeAccount(id){if(!confirm('Remove this account and its session data?'))return;api('/api/accounts/'+encodeURIComponent(id),'DELETE').then(function(){if(accountId===id)accountId='';pairCode='';toast('Account removed.');return loadState()}).catch(function(e){toast(e.message,true)})}
function newMessage(){editMessageId='';mediaPath='';document.getElementById('messageFormTitle').textContent='Create message';document.getElementById('messageName').value='';document.getElementById('messageText').value='';document.getElementById('mediaLabel').textContent=''}
function renderMessages(){if(!S.cfg)return;document.getElementById('messageCards').innerHTML=(S.cfg.messages||[]).map(function(m){var text=(m.texts||[]).join('\n---\n');return '<article class="card"><h3>'+esc(m.name)+'</h3><p class="message-preview">'+esc(text.slice(0,220))+(text.length>220?'…':'')+'</p><small>'+esc(m.media?'Media attached':'Text only')+'</small><div class="actions"><button class="secondary" onclick="editMessage(\''+esc(m.id)+'\')">Edit</button><button class="secondary" onclick="previewMessage(\''+esc(m.id)+'\')">Preview</button><button class="danger" onclick="deleteMessage(\''+esc(m.id)+'\')">Delete</button></div></article>'}).join('')||'<p class="muted">No messages saved for this account.</p>';if(!editMessageId)document.getElementById('mediaLabel').textContent=mediaPath?'Media ready: '+mediaPath:''}
function saveData(success){if(!accountId){toast('Connect or select a WhatsApp account first.',true);return Promise.reject(new Error('No account selected.'))}return api('/api/accounts/'+encodeURIComponent(accountId)+'/data','PUT',S.cfg).then(function(){if(success)toast(success);return loadState()}).catch(function(e){toast(e.message,true);throw e})}
function saveMessage(){var name=document.getElementById('messageName').value.trim(),raw=document.getElementById('messageText').value,texts=raw.split(/\n\s*---\s*\n/).map(function(x){return x.trim()}).filter(Boolean);if(!name||(!texts.length&&!mediaPath)){toast('Enter a message name and text or media.',true);return}var msg={id:editMessageId||crypto.randomUUID(),name:name,texts:texts,media:mediaPath,createdAt:new Date().toISOString()};var i=(S.cfg.messages||[]).findIndex(function(m){return m.id===editMessageId});if(i<0)S.cfg.messages.push(msg);else S.cfg.messages[i]={...S.cfg.messages[i],...msg};saveData('Message saved.').then(newMessage).catch(function(){})}
function editMessage(id){var m=S.cfg.messages.find(function(x){return x.id===id});if(!m)return;editMessageId=id;mediaPath=m.media||'';document.getElementById('messageFormTitle').textContent='Edit message';document.getElementById('messageName').value=m.name;document.getElementById('messageText').value=(m.texts||[]).join('\n---\n');document.getElementById('mediaLabel').textContent=mediaPath||'';showView('messages');window.scrollTo(0,0)}
function previewMessage(id){var m=id?S.cfg.messages.find(function(x){return x.id===id}):{name:document.getElementById('messageName').value,texts:document.getElementById('messageText').value.split(/\n\s*---\s*\n/),media:mediaPath};alert((m?.name||'Message')+'\n\n'+(m?.texts||[]).join('\n\n---\n\n')+(m?.media?'\n\nMedia: '+m.media:''))}
function deleteMessage(id){if(S.cfg.jobs.some(function(j){return j.messageId===id})){toast('This message is used by a job. Delete or edit that job first.',true);return}if(!confirm('Delete this message?'))return;S.cfg.messages=S.cfg.messages.filter(function(m){return m.id!==id});saveData('Message deleted.').catch(function(){})}
function uploadMessageMedia(){var f=document.getElementById('messageFile').files[0];if(!f||!accountId){toast('Choose a file and account first.',true);return}if(f.size>16*1024*1024){toast('File too large (max 16 MB).',true);return}var reader=new FileReader();reader.onload=function(){api('/api/upload','POST',{accountId:accountId,name:f.name,data:reader.result.split(',')[1]}).then(function(d){mediaPath=d.path;document.getElementById('mediaLabel').textContent='Media ready: '+mediaPath;toast('Media uploaded.')}).catch(function(e){toast(e.message,true)})};reader.readAsDataURL(f)}
function addList(){var name=document.getElementById('newListName').value.trim();if(!name){toast('Enter a group list name.',true);return}if(S.cfg.groupLists[name]){toast('A list with that name already exists.',true);return}S.cfg.groupLists[name]=[];saveData('Group list created.').then(function(){document.getElementById('newListName').value=''}).catch(function(){})}
function renameList(i){var names=Object.keys(S.cfg.groupLists),old=names[i],name=prompt('Rename group list',old);if(name===null)return;name=name.trim();if(!name|| (name!==old&&S.cfg.groupLists[name])){toast('Enter an unused list name.',true);return}S.cfg.groupLists[name]=S.cfg.groupLists[old];delete S.cfg.groupLists[old];S.cfg.jobs.forEach(function(j){j.toLists=(j.toLists||[]).map(function(n){return n===old?name:n})});saveData('Group list renamed.').catch(function(){})}
function deleteList(i){var names=Object.keys(S.cfg.groupLists),name=names[i];if(!confirm('Delete group list “'+name+'”?'))return;delete S.cfg.groupLists[name];S.cfg.jobs.forEach(function(j){j.toLists=(j.toLists||[]).filter(function(n){return n!==name})});saveData('Group list deleted.').catch(function(){})}
function toggleGroup(listIndex,groupIndex,on){var name=Object.keys(S.cfg.groupLists)[listIndex],id=S.groups[groupIndex].id,arr=S.cfg.groupLists[name],i=arr.indexOf(id);if(on&&i<0)arr.push(id);if(!on&&i>=0)arr.splice(i,1);clearTimeout(window.groupSaveTimer);window.groupSaveTimer=setTimeout(function(){saveData('Group selection saved.').catch(function(){})},700)}
function loadGroups(){if(!accountId)return toast('Select an account first.',true);api('/api/accounts/'+encodeURIComponent(accountId)+'/groups').then(function(d){S.groups=d.groups;renderGroups();toast('WhatsApp groups refreshed.')}).catch(function(e){toast(e.message,true)})}
function renderGroups(){var names=Object.keys(S.cfg.groupLists||{});document.getElementById('listCards').innerHTML=names.map(function(n,i){var selected=S.cfg.groupLists[n]||[];return '<article class="card"><div class="row"><h3 class="grow">'+esc(n)+'</h3><span class="pill">'+selected.length+' groups</span><button class="secondary" onclick="renameList('+i+')">Rename</button><button class="danger" onclick="deleteList('+i+')">Delete</button></div><details><summary>Choose groups</summary><div class="groupbox">'+(S.groups||[]).map(function(g,j){return '<label><input type="checkbox" '+(selected.includes(g.id)?'checked ':'')+'onchange="toggleGroup('+i+','+j+',this.checked)"> '+esc(g.subject)+'</label>'}).join('')+'</div></details></article>'}).join('')||'<p class="muted">Create a group list to organize recipients.</p>';document.getElementById('recipientCards').innerHTML=(S.cfg.recipients||[]).map(function(r,i){return '<div class="row"><b class="grow">'+esc(r.name||('Recipient '+(i+1)))+'</b><span>'+esc(r.phone.replace(/\d(?=\d{4})/g,'•'))+'</span><button class="danger" onclick="removeRecipient(\''+esc(r.id)+'\')">Remove</button></div>'}).join('')||'<p class="muted">No individual numbers saved.</p>'}
function addRecipient(){var phone=document.getElementById('recipientPhone').value.trim(),name=document.getElementById('recipientName').value.trim();if(!/^[+()\d\s.-]+$/.test(phone)||phone.replace(/\D/g,'').length<8||phone.replace(/\D/g,'').length>15){toast('Enter a valid number with country code.',true);return}api('/api/accounts/'+encodeURIComponent(accountId)+'/recipients','POST',{phone:phone,name:name}).then(function(){document.getElementById('recipientPhone').value='';document.getElementById('recipientName').value='';toast('Recipient added.');return loadState()}).catch(function(e){toast(e.message,true)})}
function removeRecipient(id){api('/api/accounts/'+encodeURIComponent(accountId)+'/recipients/'+encodeURIComponent(id),'DELETE').then(function(){toast('Recipient removed.');return loadState()}).catch(function(e){toast(e.message,true)})}
function scheduleMode(){var m=document.getElementById('jobMode').value;document.getElementById('dateWrap').classList.toggle('hidden',m!=='at');document.getElementById('cronWrap').classList.toggle('hidden',m!=='cron')}
function renderJobs(){var d=document.getElementById('jobAccount'),accountChoice=d.value||accountId,messageSelect=document.getElementById('jobMessage'),messageChoice=messageSelect.value;d.innerHTML=(S.accounts||[]).map(function(a){return '<option value="'+esc(a.id)+'" '+(a.id===accountId?'selected':'')+'>'+esc(a.name)+'</option>'}).join('');if((S.accounts||[]).some(function(a){return a.id===accountChoice}))d.value=accountChoice;messageSelect.innerHTML=(S.cfg.messages||[]).map(function(m){return '<option value="'+esc(m.id)+'">'+esc(m.name)+'</option>'}).join('')||'<option value="">Create a message first</option>';if((S.cfg.messages||[]).some(function(m){return m.id===messageChoice}))messageSelect.value=messageChoice;var selectedLists=[...document.querySelectorAll('.jobList:checked')].map(function(x){return x.value}),selectedRecipients=[...document.querySelectorAll('.jobRecipient:checked')].map(function(x){return x.value}),targets=[];Object.keys(S.cfg.groupLists||{}).forEach(function(n){targets.push('<label><input type="checkbox" class="jobList" value="'+esc(n)+'" '+(selectedLists.includes(n)?'checked':'')+'> '+esc(n)+'</label>')});(S.cfg.recipients||[]).forEach(function(r){targets.push('<label><input type="checkbox" class="jobRecipient" value="'+esc(r.id)+'" '+(selectedRecipients.includes(r.id)?'checked':'')+'> '+esc(r.name||r.phone)+'</label>')});document.getElementById('jobTargets').innerHTML=targets.join(' ')||'<span class="muted">Add recipients or group lists first.</span>';document.getElementById('jobCards').innerHTML=(S.cfg.jobs||[]).map(function(j){var m=S.cfg.messages.find(function(x){return x.id===j.messageId}),prog=j.total?j.progress+'/'+j.total:'—',recipientNames=(j.toRecipients||[]).map(function(id){var r=S.cfg.recipients.find(function(x){return x.id===id});return r?.name||r?.phone||''});var buttons='';if(j.status==='running')buttons+='<button class="secondary" onclick="jobAction(\''+esc(j.id)+'\',\'pause\')">Pause</button>';if(j.status==='paused')buttons+='<button onclick="jobAction(\''+esc(j.id)+'\',\'resume\')">Resume</button>';if(j.status==='scheduled')buttons+='<button onclick="jobAction(\''+esc(j.id)+'\',\'start\')">Start</button>';if(!['completed','cancelled','failed'].includes(j.status))buttons+='<button class="secondary" onclick="jobAction(\''+esc(j.id)+'\',\'cancel\')">Cancel</button>';buttons+='<button class="danger" onclick="deleteJob(\''+esc(j.id)+'\')">Delete</button>';return '<article class="card"><div class="row"><h3 class="grow">'+esc(j.name)+'</h3>'+statusPill(j.status)+'</div><div>Account: '+esc(selectedAccount()?.name)+' · Message: '+esc(m?.name||'Missing')+' · Progress: '+esc(prog)+'</div><div class="muted">Recipients: '+esc([...(j.toLists||[]),...recipientNames].join(', '))+' · Created: '+esc(j.createdAt?new Date(j.createdAt).toLocaleString():'—')+' · Scheduled: '+esc(j.scheduledAt||'Now')+(j.completedAt?' · Completed: '+esc(new Date(j.completedAt).toLocaleString()):'')+'</div>'+(j.lastError?'<div class="muted">'+esc(j.lastError)+'</div>':'')+'<div class="actions">'+buttons+'</div></article>'}).join('')||'<p class="muted">No automations for this account yet.</p>'}
document.addEventListener('change',function(e){if(e.target&&e.target.id==='jobAccount')switchJobAccount(e.target.value)})
function renderAccounts(){
  var card=document.getElementById('accountCards')
  card.innerHTML=(S.accounts||[]).map(function(a){
    var action=a.status==='connected'
      ? '<button class="secondary" onclick="accountAction(\''+esc(a.id)+'\',\'disconnect\')">Disconnect</button>'
      : (!a.everConnected||a.status==='logged_out'||a.status==='authentication_failure'
        ? '<button onclick="pairAgain(\''+esc(a.id)+'\')">Connect / get code</button>'
        : (a.status==='disconnected' ? '<button onclick="accountAction(\''+esc(a.id)+'\',\'reconnect\')">Reconnect</button>' : '<button disabled>Connecting…</button>'))
    return '<article class="card"><h3>'+esc(a.name)+'</h3><div>'+esc(a.phone)+' '+statusPill(a.status)+'</div><p class="muted">Last connected: '+esc(a.lastConnectedAt?new Date(a.lastConnectedAt).toLocaleString():'Never')+'</p>'+(a.error?'<p class="muted">'+esc(a.error)+'</p>':'')+'<div class="actions">'+action+'<button class="danger" onclick="removeAccount(\''+esc(a.id)+'\')">Remove</button></div></article>'
  }).join('')
  if(pairCode&&pairAccountId===accountId)document.getElementById('pairCode').innerHTML='<div class="card"><h3>Pairing code for '+esc(selectedAccount()?.name)+'</h3><div class="stat">'+esc(pairCode)+'</div><p>On your phone open WhatsApp → Linked Devices → Link a device → Link with phone number, then enter this code.</p></div>'
  else document.getElementById('pairCode').innerHTML=''
}
function createJob(){var targetId=document.getElementById('jobAccount').value;if(targetId!==accountId){accountId=targetId;loadState().then(function(){document.querySelectorAll('.jobList,.jobRecipient').forEach(function(x){x.checked=false});toast('Account changed. Select this account’s recipients.');});return}if(!accountId){toast('Connect a WhatsApp account first.',true);return}var lists=[...document.querySelectorAll('.jobList:checked')].map(function(x){return x.value}),recipients=[...document.querySelectorAll('.jobRecipient:checked')].map(function(x){return x.value}),mode=document.getElementById('jobMode').value,body={name:document.getElementById('jobName').value,messageId:document.getElementById('jobMessage').value,toLists:lists,toRecipients:recipients,repeatCount:Number(document.getElementById('jobRepeat').value),delaySeconds:[Number(document.getElementById('jobMinDelay').value),Number(document.getElementById('jobMaxDelay').value)],toStatus:document.getElementById('jobToStatus').checked};if(mode==='at'){var date=document.getElementById('jobDate').value;if(!date){toast('Choose a scheduled date and time.',true);return}body.scheduleAt=new Date(date).toISOString()}if(mode==='cron')body.cron=document.getElementById('jobCron').value.trim();api('/api/accounts/'+encodeURIComponent(accountId)+'/jobs','POST',body).then(function(d){toast(d.message);document.getElementById('jobName').value='';return loadState()}).catch(function(e){toast(e.message,true)})}
function jobAction(id,action){var words={start:'started',pause:'paused',resume:'resumed',cancel:'cancelled'};api('/api/accounts/'+encodeURIComponent(accountId)+'/jobs/'+encodeURIComponent(id)+'/'+action,'POST',{}).then(function(){toast('Job '+(words[action]||action)+'.');return loadState()}).catch(function(e){toast(e.message,true)})}
function deleteJob(id){if(!confirm('Delete this automation?'))return;api('/api/accounts/'+encodeURIComponent(accountId)+'/jobs/'+encodeURIComponent(id),'DELETE').then(function(){toast('Job deleted.');return loadState()}).catch(function(e){toast(e.message,true)})}
function renderSettings(){if(['timezone','defaultMin','defaultMax','statusRecipients'].includes(document.activeElement?.id))return;document.getElementById('timezone').value=S.cfg.timezone||'Africa/Lagos';document.getElementById('defaultMin').value=(S.cfg.delaySeconds||[5,15])[0];document.getElementById('defaultMax').value=(S.cfg.delaySeconds||[5,15])[1];document.getElementById('statusRecipients').value=(S.cfg.statusRecipients||[]).join('\n')}
function saveSettings(){S.cfg.timezone=document.getElementById('timezone').value;S.cfg.delaySeconds=[Number(document.getElementById('defaultMin').value),Number(document.getElementById('defaultMax').value)];S.cfg.statusRecipients=document.getElementById('statusRecipients').value.split(/[\s,]+/).filter(Boolean);saveData('Settings saved.').catch(function(){})}
fetch('/api/session').then(function(r){if(!r.ok){location.assign('/login');throw new Error('Sign in again.')}return r.json()}).then(function(x){csrfToken=x.csrfToken;return loadState()}).then(function(){showView('overview')}).catch(function(e){if(e.message!=='Sign in again.')toast(e.message,true)});setInterval(function(){if(!document.hidden&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||''))refresh().catch(function(){})},5000);
</script></body></html>`

onAccountConnected(async (waSocket, accountId) => {
  log('WhatsApp account connected:', accountId)
  try {
    const groups = Object.values(await waSocket.groupFetchAllParticipating()).map(g => ({ id: g.id, subject: g.subject }))
    accountGroups.set(accountId, groups)
    normalizeGroupLists(accountId, await dataFor(accountId), groups)
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
  } catch (e) { log('Could not load WhatsApp groups:', e.message) }
})

if (!testJobName) startDashboard()
listAccounts().then(async accounts => {
  for (const account of accounts) {
    try {
      const data = await dataFor(account.id)
      let recovered = false
      for (const job of data.jobs) if (job.status === 'running') {
        job.status = 'paused'; job.lastError = 'The bot restarted while this job was running. Resume continues after the last saved delivery.'; recovered = true
      }
      if (recovered) saveAccountData(account.id, data)
      scheduleAccount(account.id, data)
    }
    catch (e) { log('Could not load account automation:', e.message) }
  }
  schedulerStarted = true
}).catch(() => log('Account restore failed. Check local account storage permissions and metadata.'))
