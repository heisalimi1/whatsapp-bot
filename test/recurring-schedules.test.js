import test from 'node:test'
import assert from 'node:assert/strict'
import { validSendingDelays, recoverInterruptedJob, parseSchedule, intervalMilliseconds, nextIntervalRun, createDeliveryRun, dispatchDeliveryRun, runMetrics } from '../recurring-schedules.js'

test('restart recovery resumes recurring work and preserves explicitly paused schedules', () => {
  for (const cadence of [{ interval: { value: 2, unit: 'hours' } }, { cron: '* * * * *' }]) {
    const job = { ...cadence, status: 'running', progress: 3, activeRun: { entries: [{ state: 'attempting' }] } }
    assert.equal(recoverInterruptedJob(job), true)
    assert.equal(job.status, 'scheduled'); assert.equal(job.progress, 3)
    assert.equal(job.activeRun.entries[0].state, 'attempting')
    job.status = 'paused'; assert.equal(recoverInterruptedJob(job), false); assert.equal(job.status, 'paused')
  }
  const once = { status: 'running', progress: 2 }
  recoverInterruptedJob(once); assert.equal(once.status, 'paused'); assert.equal(once.progress, 2)
})

test('custom minutes/hours/days stay anchored and coalesce missed intervals', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  for (const seconds of [0,300,7200,172800,365*86400]) assert(validSendingDelays([seconds,seconds]))
  for (const delays of [[-1,-1],[0,601],[600,0],[Infinity,Infinity],[NaN,NaN],[366*86400,366*86400]]) assert.equal(validSendingDelays(delays),false)
  for (const [unit, value, ms] of [['minutes',17,1020000],['hours',3,10800000],['days',2,172800000]]) {
    const config = parseSchedule({ interval: { value, unit } }, now)
    assert.equal(Date.parse(config.nextRunAt), now + ms)
    assert.equal(intervalMilliseconds(config.interval), ms)
    assert.equal(Date.parse(nextIntervalRun(config.nextRunAt, config.interval, now + 5 * ms + 1000)), now + 6 * ms)
  }
  assert.throws(() => parseSchedule({ interval: { value: 0, unit: 'minutes' } }, now))
  assert.throws(() => parseSchedule({ interval: { value: 1.5, unit: 'days' } }, now))
  assert.throws(() => parseSchedule({ interval: { value: 1, unit: 'weeks' } }, now))
  assert.throws(() => parseSchedule({ interval: { value: 366, unit: 'days' } }, now))
  assert.throws(() => parseSchedule({ interval: { value: 2, unit: 'hours' }, cron: '* * * * *' }, now))
  assert.equal(parseSchedule({ interval: { value: 2, unit: 'hours' }, scheduleAt: '2026-10-09T12:00:00Z' }, now).nextRunAt, '2026-10-09T12:00:00.000Z')
})

test('text/image/video Status and message runs persist intent and never replay after an ACK/save crash', async () => {
  for (const content of [{ text: 'fixture' }, { image: Buffer.from('fixture'), caption: 'image' }, { video: Buffer.from('fixture'), caption: 'video' }]) {
    const deliveries = [{ jid: 'fixture@g.us', kind: 'message' }, { jid: 'status@broadcast', kind: 'status', statusJidList: ['1234567890@s.whatsapp.net'] }]
    let run = createDeliveryRun('2026-10-08T12:00:00Z', deliveries, { texts: ['fixture'] }), persisted, saves = 0
    const calls = [], socket = { async sendMessage(jid, body, options) { calls.push({ jid, body, options }); return { key: { id: options.messageId } } } }
    await assert.rejects(() => dispatchDeliveryRun({ run, socket, contentFor: () => content, save() { saves++; if (saves === 2) throw new Error('fixture-crash-after-ack'); persisted = structuredClone(run) } }))
    assert.equal(persisted.entries[0].state, 'attempting')
    run = structuredClone(persisted)
    await dispatchDeliveryRun({ run, socket, contentFor: () => content, save() { persisted = structuredClone(run) } })
    assert.deepEqual(calls.map(c => c.jid), ['fixture@g.us','status@broadcast'], 'the unconfirmed first delivery is skipped and the unsent Status continues')
    assert.equal(run.entries[0].state, 'uncertain')
    assert.deepEqual(runMetrics(run), { progress: 2, total: 2, failedCount: 1, uncertainCount: 1 })
    assert.deepEqual(calls[1].options.statusJidList, deliveries[1].statusJidList)
    assert(calls.every(c => /^[A-F0-9]{32}$/.test(c.options.messageId)))
    await dispatchDeliveryRun({ run: structuredClone(persisted), socket, contentFor: () => content, save() {} })
    assert.equal(calls.length, 2, 'refresh/restart/repeated callbacks cannot replay processed entries')
  }
})

test('pause/resume, failed sends and cancellation preserve remaining deliveries', async () => {
  const run = createDeliveryRun('fixture-run', [{jid:'a@g.us',kind:'message'},{jid:'b@g.us',kind:'message'}],{texts:['fixture']})
  let paused = false, calls = []
  const socket = { async sendMessage(jid) { calls.push(jid); paused = true } }
  assert.equal((await dispatchDeliveryRun({run,socket,contentFor:e=>({text:e.text}),save(){},shouldStop:()=>paused})).stopped,true)
  paused = false
  await dispatchDeliveryRun({run,socket,contentFor:e=>({text:e.text}),save(){},shouldStop:()=>false})
  assert.deepEqual(calls,['a@g.us','b@g.us'])
  const failed = createDeliveryRun('fixture-failure',[{jid:'status@broadcast',kind:'status',statusJidList:['1234567890@s.whatsapp.net']}],{texts:['fixture']})
  let attempts=0
  const dispatch=()=>dispatchDeliveryRun({run:failed,socket:{async sendMessage(){attempts++;throw Error('fixture-uncertain')}},contentFor:e=>({text:e.text}),save(){}})
  await dispatch();await dispatch();assert.equal(attempts,1)
  const cancelled=createDeliveryRun('fixture-cancel',[{jid:'a@g.us',kind:'message'}],{texts:['fixture']})
  await dispatchDeliveryRun({run:cancelled,socket,contentFor:e=>({text:e.text}),save(){},shouldStop:()=>true})
  assert.equal(cancelled.entries[0].state,'pending')
})
