import crypto from 'node:crypto'
import cron from 'node-cron'
import { sendDelivery } from './automation-delivery.js'

const units = { minutes: 60000, hours: 3600000, days: 86400000 }
export const recurring = job => !!(job.interval || job.cron)
export function recoverInterruptedJob(job) {
  if (job.status !== 'running') return false
  job.status = recurring(job) ? 'scheduled' : 'paused'
  job.resumeOnRestart = recurring(job)
  job.lastError = 'Restart recovery keeps delivery progress; unconfirmed attempts are not replayed.'
  return true
}
export function intervalMilliseconds(interval) {
  if (!interval || !Object.hasOwn(units, interval.unit) || !Number.isInteger(interval.value) || interval.value < 1) throw new Error('Choose a whole-number repeat interval in minutes, hours or days.')
  const milliseconds = interval.value * units[interval.unit]
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 365 * units.days) throw new Error('Choose a repeat interval of at most 365 days.')
  return milliseconds
}
export function nextIntervalRun(previous, interval, now = Date.now()) {
  const milliseconds = intervalMilliseconds(interval), anchor = Date.parse(previous)
  if (!Number.isFinite(anchor)) return new Date(now + milliseconds).toISOString()
  return new Date(anchor + Math.max(1, Math.floor((now - anchor) / milliseconds) + 1) * milliseconds).toISOString()
}
export function parseSchedule(body, now = Date.now(), allowPast = false) {
  const interval = body.interval ? { value: Number(body.interval.value), unit: body.interval.unit } : null
  const expression = String(body.cron || '').trim()
  if (expression && !cron.validate(expression)) throw new Error('Enter a valid recurring clock schedule.')
  if (interval && expression) throw new Error('Choose an interval or a clock schedule.')
  const first = body.scheduleAt ? new Date(body.scheduleAt) : null
  if (first && (!Number.isFinite(first.getTime()) || (!allowPast && first.getTime() <= now))) throw new Error('Choose a future date and time for the first run.')
  if (first && expression) throw new Error('Choose a date or a recurring clock schedule.')
  const nextRunAt = interval ? first?.toISOString() || new Date(now + intervalMilliseconds(interval)).toISOString() : ''
  if (interval) intervalMilliseconds(interval)
  return { interval, cron: expression, scheduleAt: first?.toISOString() || '', nextRunAt, scheduledAt: interval ? `Every ${interval.value} ${interval.unit}` : first?.toISOString() || expression || 'Now' }
}
export function createDeliveryRun(occurrenceAt, deliveries, message, pickText = () => message.texts?.[0] || '') {
  return { id: crypto.randomUUID(), occurrenceAt, startedAt: new Date().toISOString(), finishedAt: '', entries: deliveries.map(delivery => ({ delivery, messageId: crypto.randomUUID().replace(/-/g, '').toUpperCase(), text: pickText(), media: message.media || '', state: 'pending' })) }
}
export function runMetrics(run) {
  return { progress: run.entries.filter(e => !['pending', 'attempting'].includes(e.state)).length, total: run.entries.length, failedCount: run.entries.filter(e => ['failed', 'uncertain'].includes(e.state)).length, uncertainCount: run.entries.filter(e => e.state === 'uncertain').length }
}
/** Persist intent before dispatch. Unconfirmed attempts are never replayed automatically. */
export async function dispatchDeliveryRun({ run, socket, contentFor, save, shouldStop = () => false, onProgress = () => {}, wait = async () => {} }) {
  for (let index = 0; index < run.entries.length; index++) {
    if (shouldStop()) return { stopped: true }
    const entry = run.entries[index]
    if (entry.state === 'attempting') { entry.state = 'uncertain'; onProgress(); await save() }
    if (entry.state !== 'pending') continue
    let content
    try { content = contentFor(entry) } catch { entry.state = 'failed'; onProgress(); await save(); continue }
    entry.state = 'attempting'
    await save()
    if (shouldStop()) { entry.state = 'pending'; await save(); return { stopped: true } }
    try { await sendDelivery(socket, entry.delivery, content, { messageId: entry.messageId }); entry.state = 'sent' }
    catch { entry.state = 'uncertain' }
    onProgress()
    await save()
    if (index < run.entries.length - 1) await wait()
  }
  return { stopped: shouldStop() }
}
