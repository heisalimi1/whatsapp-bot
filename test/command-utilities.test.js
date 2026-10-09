import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { createCommandStore } from '../commands/store.js'
import { createCommandUtilities } from '../commands/utilities.js'
import { accountDefaults } from '../commands/settings.js'
import { normalizeDestinations } from '../automation-delivery.js'
import { parseSchedule, validSendingDelays, recurring } from '../recurring-schedules.js'

const workspace = '11111111-1111-4111-8111-111111111111', account = '22222222-2222-4222-8222-222222222222', other = '33333333-3333-4333-8333-333333333333'
const messageId = '44444444-4444-4444-8444-444444444444', recipient = '55555555-5555-4555-8555-555555555555', second = '66666666-6666-4666-8666-666666666666'
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-command-utilities-test-'))
  const store = createCommandStore(path.join(directory, 'test.sqlite'))
  t.after(() => { store.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }) })
  const data = { timezone: 'Africa/Lagos', delaySeconds: [5, 15], messages: [{ id: messageId, name: 'Test saved message', texts: ['fixture text'] }], groupLists: { 'Test groups': ['120363000000000001@g.us'] }, recipients: [{ id: recipient }, { id: second }], jobs: [] }
  const calls = [], saved = []
  const context = vm.createContext({ normalizeDestinations, parseSchedule, validSendingDelays, recurring,
    MAX_JOBS_PER_ACCOUNT: 500, makeId: () => crypto.randomUUID(), async dataFor(id) { assert.equal(id, account); return data },
    saveAccountData(id, value) { saved.push({ id, jobs: JSON.parse(JSON.stringify(value.jobs)) }) }, scheduleAccount(id) { calls.push({ id, scheduler: true }) },
    runJob(id, job, options) { calls.push({ id, job, options }); return Promise.resolve() },
    stopRequests: new Map(), removeQueuedJob(key) { calls.push({ removed: key }) }
  })
  const source = fs.readFileSync(new URL('../bot.js', import.meta.url), 'utf8')
  vm.runInContext(source.slice(source.indexOf('function jobConfiguration('), source.indexOf('function publicAutomation(')), context)
  const services = createCommandUtilities({ store, dataFor: context.dataFor, createJob: context.createCommandJob, cancelJob: context.cancelAccountJob })
  const commandContext = id => ({ account: { id: account, workspaceId: workspace }, chat: '15105550101@s.whatsapp.net', message: { key: { id } }, config: store.settings(workspace, account).config })
  return { store, data, calls, saved, services, commandContext }
}
test('WhatsApp schedule commands reuse production validators, persistence and existing timers', async t => {
  const f = fixture(t), date = new Date(Date.now() + 3600000).toISOString()
  const input = `at ${date} | ${messageId} | list:Test groups`
  await f.services.schedule(f.commandContext('first'), input)
  assert.equal(f.data.jobs.length, 1); assert.equal(f.data.jobs[0].scheduleAt, date)
  assert.deepEqual([...f.data.jobs[0].toLists], ['Test groups']); assert.equal(f.saved[0].id, account)
  assert.equal(f.calls.filter(c => c.scheduler).length, 1); assert.equal(f.calls.some(c => c.options), false)
  await f.services.schedule(f.commandContext('first'), input); assert.equal(f.data.jobs.length, 1, 'a repeated command does not create another job')
  await f.services.schedule(f.commandContext('second'), `every 2 hours | ${messageId} | contact:${recipient}`)
  assert.equal(f.data.jobs[1].interval.unit, 'hours'); assert.equal(f.data.jobs[1].interval.value, 2)
  assert.match(await f.services.schedule(f.commandContext('view'), 'list'), /Africa\/Lagos/)
  await f.services.schedule(f.commandContext('cancel'), 'cancel ' + f.data.jobs[0].id)
  assert.equal(f.data.jobs[0].status, 'cancelled'); assert(f.calls.some(c => c.removed))
  assert.equal(f.data.messages.length, 1)
})
test('schedule validation rejects invalid dates, recipients, messages and competing schedule modes', async t => {
  const f = fixture(t)
  for (const command of [`at 2030-01-01T09:00 | ${messageId} | status`, `at invalid | ${messageId} | status`, `every 0 minutes | ${messageId} | status`, `every 1 hours | other-message | status`, `every 1 days | ${messageId} | contact:${other}`, `every 1 days | ${messageId} | list:Unknown`]) await assert.rejects(f.services.schedule(f.commandContext(command), command))
  assert.equal(f.data.jobs.length, 0)
})
test('broadcast authorization and one-time confirmations create paced jobs through the existing worker', async t => {
  const f = fixture(t)
  await assert.rejects(f.services.broadcast(f.commandContext('unauthorized'), messageId + ' | Customers'), /authorization/)
  const current = f.store.settings(workspace, account), config = accountDefaults()
  config.broadcast = { lists: { Customers: [recipient, second] }, confirmedConsent: true, confirmationThreshold: 2, delaySeconds: 10 }
  f.store.saveSettings(workspace, account, config, current.revision)
  const confirmation = await f.services.broadcast(f.commandContext('prepare'), messageId + ' | Customers')
  assert.equal(f.data.jobs.length, 0); const token = /confirm ([a-f0-9]{24})/.exec(confirmation)[1]
  const otherChat = { ...f.commandContext('other-chat'), chat: '15105550102@s.whatsapp.net' }
  await assert.rejects(f.services.broadcast(otherChat, 'confirm ' + token), /expired/)
  await f.services.broadcast(f.commandContext('confirm'), 'confirm ' + token)
  assert.equal(f.data.jobs.length, 1); assert.deepEqual([...f.data.jobs[0].delaySeconds], [10, 10]); assert.equal(f.data.jobs[0].commandKind, 'broadcast')
  assert.equal(f.calls.filter(c => c.options).length, 1, 'the existing send worker is called once')
  await assert.rejects(f.services.broadcast(f.commandContext('replay'), 'confirm ' + token), /expired/)
})
test('broadcast confirmation cannot survive a changed recipient list or cross tenant use', async t => {
  const f = fixture(t), initial = f.store.settings(workspace, account)
  initial.config.broadcast = { lists: { Customers: [recipient, second] }, confirmedConsent: true, confirmationThreshold: 2, delaySeconds: 10 }
  f.store.saveSettings(workspace, account, initial.config, initial.revision)
  const confirmation = await f.services.broadcast(f.commandContext('prepare'), messageId + ' | Customers'), token = /confirm ([a-f0-9]{24})/.exec(confirmation)[1]
  assert.throws(() => f.store.consumeBroadcast(other, account, f.commandContext('x').chat, token), /expired/)
  const latest = f.store.settings(workspace, account); latest.config.broadcast.lists.Customers = [recipient]; f.store.saveSettings(workspace, account, latest.config, latest.revision)
  await assert.rejects(f.services.broadcast(f.commandContext('confirm'), 'confirm ' + token), /changed/)
  assert.equal(f.data.jobs.length, 0)
})

test('broadcast confirmation rejects changed message content, contact details and pacing', async t => {
  const f = fixture(t), initial = f.store.settings(workspace, account)
  initial.config.broadcast = { lists: { Customers: [recipient, second] }, confirmedConsent: true, confirmationThreshold: 2, delaySeconds: 10 }
  f.store.saveSettings(workspace, account, initial.config, initial.revision)
  const prepare = async id => /confirm ([a-f0-9]{24})/.exec(await f.services.broadcast(f.commandContext(id), messageId + ' | Customers'))[1]
  let token = await prepare('message-prepare')
  f.data.messages[0].texts = ['Changed synthetic content']
  await assert.rejects(f.services.broadcast(f.commandContext('message-confirm'), 'confirm ' + token), /changed/)
  token = await prepare('contact-prepare'); f.data.recipients[0].phone = '15105550101'
  await assert.rejects(f.services.broadcast(f.commandContext('contact-confirm'), 'confirm ' + token), /changed/)
  token = await prepare('delay-prepare')
  const latest = f.store.settings(workspace, account); latest.config.broadcast.delaySeconds = 20
  f.store.saveSettings(workspace, account, latest.config, latest.revision)
  await assert.rejects(f.services.broadcast(f.commandContext('delay-confirm'), 'confirm ' + token), /changed/)
  assert.equal(f.data.jobs.length, 0)
})
