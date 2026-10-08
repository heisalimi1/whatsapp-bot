import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDestinations, buildDeliveryPlan, sendDelivery } from '../automation-delivery.js'

const viewers = ['12345678901', '12345678902']
const group = { jid: 'test-group@g.us', name: 'Test group' }
const data = { groupLists: { Team: [group.jid], Empty: [] }, recipients: [{ id: 'contact' }], statusRecipients: viewers }

test('Groups, Status and contacts are independent destinations with validated audiences', () => {
  assert.deepEqual(normalizeDestinations(data, { toLists: ['Team'] }).value, { toLists: ['Team'], toRecipients: [], toStatus: false })
  assert.deepEqual(normalizeDestinations(data, { toStatus: true }).value, { toLists: [], toRecipients: [], toStatus: true })
  assert.deepEqual(normalizeDestinations(data, { toLists: ['Team', 'Team'], toStatus: true }).value, { toLists: ['Team'], toRecipients: [], toStatus: true })
  assert.deepEqual(normalizeDestinations(data, { toRecipients: ['contact'] }).value, { toLists: [], toRecipients: ['contact'], toStatus: false })
  assert.match(normalizeDestinations(data, {}).error, /Choose Groups/)
  assert.match(normalizeDestinations({ ...data, statusRecipients: [] }, { toStatus: true }).error, /Add status viewers/)
  for (const body of [{ toLists: 'Team' }, { toRecipients: 'contact' }, { toStatus: 'false' }, { toLists: ['missing'] }, { toLists: ['__proto__'] }, { toLists: ['Empty'] }]) {
    assert.ok(normalizeDestinations(data, body).error)
  }
})

test('actual send dispatch supports groups-only, Status-only and combined delivery including media', async () => {
  for (const [label, targets, job, expected] of [
    ['groups', [group], { toLists: ['Team'], toStatus: false }, [group.jid, group.jid]],
    ['status', [], { toLists: [], toStatus: true }, ['status@broadcast']],
    ['both', [group], { toLists: ['Team'], toStatus: true }, [group.jid, group.jid, 'status@broadcast']]
  ]) {
    const deliveries = buildDeliveryPlan(targets, viewers, job, 2)
    assert.equal(deliveries.length, expected.length, label + ' progress includes all deliveries')
    const calls = [], socket = { async sendMessage(...args) { calls.push(args) } }
    const content = { image: Buffer.from('test-media'), caption: 'hello' }
    for (const delivery of deliveries) await sendDelivery(socket, delivery, content)
    assert.deepEqual(calls.map(args => args[0]), expected, label + ' sends to exactly the chosen destinations')
    for (const [jid, payload, options] of calls) {
      assert.equal(payload, content, 'text/media content is passed unchanged')
      if (jid === 'status@broadcast') assert.deepEqual(options, { statusJidList: viewers.map(number => number + '@s.whatsapp.net') })
      else assert.equal(options, undefined)
    }
    const resumedCalls = []
    for (const delivery of deliveries.slice(1)) await sendDelivery({ async sendMessage(jid) { resumedCalls.push(jid) } }, delivery, { text: 'resumed' })
    assert.deepEqual(resumedCalls, expected.slice(1), 'resume skips previously processed deliveries including Status')
  }
})

test('delivery planning prevents empty audiences, unresolved groups and exceeding safety limit', () => {
  assert.throws(() => buildDeliveryPlan([], [], { toStatus: true }, 1), /Add valid status viewers/)
  assert.throws(() => buildDeliveryPlan([], ['invalid'], { toStatus: true }, 1), /Add valid status viewers/)
  assert.throws(() => buildDeliveryPlan([], viewers, { toLists: ['Team'], toStatus: true }, 1), /No groups or contacts matched/)
  assert.throws(() => buildDeliveryPlan([], viewers, {}, 1), /Choose Groups/)
  assert.throws(() => buildDeliveryPlan([group], viewers, {}, 0), /Repeat count/)
  assert.throws(() => buildDeliveryPlan(Array(100).fill(group), viewers, { toStatus: true }, 100), /10,000/)
  assert.equal(buildDeliveryPlan([], [...viewers, viewers[0]], { toStatus: true }, 1)[0].statusJidList.length, 2)
})

test('send failures propagate to the worker for error accounting', async () => {
  const socket = { async sendMessage() { throw new Error('test-send-failed') } }
  await assert.rejects(() => sendDelivery(socket, { kind: 'status', jid: 'status@broadcast', statusJidList: [] }, { text: 'test' }), /test-send-failed/)
})
