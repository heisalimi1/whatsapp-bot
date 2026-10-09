import { CommandError } from './engine.js'
import { parseSchedule } from '../recurring-schedules.js'
import crypto from 'node:crypto'

export function createCommandUtilities({ store, dataFor, createJob, cancelJob, now = Date.now }) {
  const listJobs = data => data.jobs.slice().reverse().slice(0, 20).map(j => `${j.id} — ${j.name} (${j.status}; ${j.scheduledAt || 'now'})`).join('\n') || 'No schedules exist for this account.'
  function destination(data, raw) {
    if (raw.startsWith('list:')) { const name = raw.slice(5).trim(); if (!Object.hasOwn(data.groupLists, name) || !data.groupLists[name].length) throw new CommandError('Choose a saved, nonempty group list for this account.'); return { toLists: [name], toRecipients: [], toStatus: false } }
    if (raw.startsWith('contact:')) { const id = raw.slice(8).trim(); if (!data.recipients.some(r => r.id === id)) throw new CommandError('Choose a saved recipient ID for this account.'); return { toLists: [], toRecipients: [id], toStatus: false } }
    if (raw === 'status') return { toLists: [], toRecipients: [], toStatus: true }
    throw new CommandError('Use list:<group list>, contact:<recipient ID> or status as the destination.')
  }
  async function schedule(context, argument) {
    const data = await dataFor(context.account.id)
    if (argument === 'list') return listJobs(data) + `\nAccount timezone: ${data.timezone}. Use an ISO date with its explicit UTC offset.`
    if (argument.startsWith('cancel ')) {
      const id = argument.slice(7).trim()
      if (!data.jobs.some(j => j.id === id)) throw new CommandError('Schedule not found for this account.')
      await cancelJob(context.account.id, id); return 'Schedule cancelled. Its saved message and delivery history are preserved.'
    }
    const parts = argument.split('|').map(x => x.trim())
    if (parts.length !== 3 || !data.messages.some(m => m.id === parts[1])) throw new CommandError('Use schedule at <ISO date> | <saved message ID> | <destination>, or schedule every <count> <minutes|hours|days> | <message ID> | <destination>.')
    let timing
    if (parts[0].startsWith('at ')) {
      const date = parts[0].slice(3).trim()
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(date)) throw new CommandError('Include the date’s time zone, for example 2030-01-01T09:00:00+01:00.')
      const [year, month, day] = date.slice(0, 10).split('-').map(Number)
      const calendarDate = new Date(Date.UTC(year, month - 1, day))
      if (calendarDate.toISOString().slice(0, 10) !== date.slice(0, 10)) throw new CommandError('Choose a valid calendar date.')
      timing = { scheduleAt: date }
    } else {
      const match = /^every (\d+) (minutes|hours|days)$/.exec(parts[0])
      if (!match) throw new CommandError('Choose at <ISO date with offset> or every <count> <minutes|hours|days>.')
      timing = { interval: { value: Number(match[1]), unit: match[2] } }
    }
    try { parseSchedule(timing, now()) } catch (e) { throw new CommandError(e.message) }
    const job = await createJob(context.account.id, { name: 'WhatsApp command schedule', messageId: parts[1], ...destination(data, parts[2]), ...timing, delaySeconds: data.delaySeconds, repeatCount: 1 }, context.message.key.id, 'schedule')
    return `Schedule created: ${job.id}. Manage it in Automations or use ${context.config.prefix}schedule cancel ${job.id}.`
  }
  async function broadcast(context, argument) {
    const { config } = store.settings(context.account.workspaceId, context.account.id), data = await dataFor(context.account.id)
    if (!config.broadcast.confirmedConsent) throw new CommandError('Confirm recipient authorization and configure a broadcast list in the dashboard first.')
    let messageId, listName, approved
    if (argument.startsWith('confirm ')) {
      try { approved = store.consumeBroadcast(context.account.workspaceId, context.account.id, context.chat, argument.slice(8).trim()) }
      catch (e) { throw new CommandError(e.message) }
      ;({ messageId, listName } = approved)
    } else {
      const parts = argument.split('|').map(x => x.trim())
      if (parts.length !== 2) throw new CommandError('Use broadcast <saved message ID> | <authorized recipient list>.')
      ;[messageId, listName] = parts
    }
    const recipients = config.broadcast.lists[listName]
    if (!Array.isArray(recipients) || !recipients.length || recipients.some(id => !data.recipients.some(r => r.id === id))) throw new CommandError('Choose a current authorized recipient list from the dashboard.')
    const savedMessage = data.messages.find(m => m.id === messageId)
    if (!savedMessage) throw new CommandError('Choose a saved message for this account.')
    if (data.jobs.some(j => j.commandKind === 'broadcast' && ['running', 'scheduled'].includes(j.status))) throw new CommandError('This account already has a broadcast in progress. Manage it in Automations before starting another.')
    if (approved && JSON.stringify(recipients) !== JSON.stringify(approved.recipients)) throw new CommandError('The recipient list changed. Request a new broadcast confirmation.')
    const contentHash = crypto.createHash('sha256').update(JSON.stringify({ message: savedMessage, recipients: recipients.map(id => data.recipients.find(r => r.id === id)), delay: config.broadcast.delaySeconds })).digest('hex')
    if (approved && contentHash !== approved.contentHash) throw new CommandError('The message or delivery settings changed. Request a new broadcast confirmation.')
    if (!approved && recipients.length >= config.broadcast.confirmationThreshold) {
      const token = store.prepareBroadcast(context.account.workspaceId, context.account.id, context.chat, { messageId, listName, recipients, contentHash })
      return `Confirm sending to ${recipients.length} authorized recipients: ${context.config.prefix}broadcast confirm ${token}\nThe confirmation expires in two minutes and works once in this chat.`
    }
    const job = await createJob(context.account.id, { name: `Broadcast: ${listName}`, messageId, toRecipients: recipients, toLists: [], toStatus: false, repeatCount: 1, delaySeconds: [config.broadcast.delaySeconds, config.broadcast.delaySeconds] }, context.message.key.id, 'broadcast')
    return `Broadcast queued: ${job.id}. Delivery uses the existing automation worker at ${config.broadcast.delaySeconds} seconds per recipient.`
  }
  return { schedule, broadcast,
    async isAutomationMessage(accountId, id) { const data = await dataFor(accountId); return data.jobs.some(job => job.activeRun?.entries?.some(entry => entry.messageId === id)) }
  }
}
