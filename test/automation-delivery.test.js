import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeDestinations, buildDeliveryPlan, sendDelivery } from '../automation-delivery.js'
import { StatusAudience } from '../status-audience.js'
import { generateWAMessageContent } from '@whiskeysockets/baileys'

const viewers = ['12345678901', '12345678902']
const group = { jid: 'test-group@g.us', name: 'Test group' }
const data = { groupLists: { Team: [group.jid], Empty: [] }, recipients: [{ id: 'contact' }], statusRecipients: viewers }

test('Groups, Status and contacts are independent destinations with validated audiences', () => {
  assert.deepEqual(normalizeDestinations(data, { toLists: ['Team'] }).value, { toLists: ['Team'], toRecipients: [], toStatus: false })
  assert.deepEqual(normalizeDestinations(data, { toStatus: true }).value, { toLists: [], toRecipients: [], toStatus: true })
  assert.deepEqual(normalizeDestinations(data, { toLists: ['Team', 'Team'], toStatus: true }).value, { toLists: ['Team'], toRecipients: [], toStatus: true })
  assert.deepEqual(normalizeDestinations(data, { toRecipients: ['contact'] }).value, { toLists: [], toRecipients: ['contact'], toStatus: false })
  assert.match(normalizeDestinations(data, {}).error, /Choose Groups/)
  assert.deepEqual(normalizeDestinations({ ...data, statusRecipients: [] }, { toStatus: true }).value, { toLists: [], toRecipients: [], toStatus: true }, 'Status needs no manually entered numbers')
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

test('delivery planning prevents empty audiences, unresolved groups and exceeding safety limit', async () => {
  assert.throws(() => buildDeliveryPlan([], [], { toStatus: true }, 1), /not synced yet/)
  assert.throws(() => buildDeliveryPlan([], ['invalid'], { toStatus: true }, 1), /not synced yet/)
  assert.throws(() => buildDeliveryPlan([], viewers, { toLists: ['Team'], toStatus: true }, 1), /No groups or contacts matched/)
  assert.throws(() => buildDeliveryPlan([], viewers, {}, 1), /Choose Groups/)
  assert.throws(() => buildDeliveryPlan([group], viewers, {}, 0), /Repeat count/)
  assert.throws(() => buildDeliveryPlan(Array(100).fill(group), viewers, { toStatus: true }, 100), /10,000/)
  assert.equal(buildDeliveryPlan([], [...viewers, viewers[0]], { toStatus: true }, 1)[0].statusJidList.length, 2)
  assert.deepEqual(buildDeliveryPlan([], ['12345678901@s.whatsapp.net', '123456789012345@lid'], { toStatus: true }, 1)[0].statusJidList, ['12345678901@s.whatsapp.net', '123456789012345@lid'], 'synced PN/LID contacts are accepted')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-audience-test-'))
  const jid = viewers.map(value => value + '@s.whatsapp.net'), lid = '123456789012345@lid'
  let audience = new StatusAudience(dir)
  const socket = {
    async fetchPrivacySettings() { return { status: 'contacts' } },
    async fetchBlocklist() { return [] },
    signalRepository: { lidMapping: { async getPNForLID(value) { return value === lid ? jid[0] : null }, async getLIDForPN(value) { return value === jid[0] ? lid : null } } }
  }
  try {
    audience.sync = async () => {}
    audience.updateContacts([{ id: jid[0], lid, name: 'Saved one' }, { id: jid[1], name: 'Saved two' }, { id: '12345678903@s.whatsapp.net', notify: 'Unknown sender' }])
    assert.deepEqual(await audience.audience(socket), jid, 'automatically uses saved WhatsApp contacts, never unknown message senders')
    audience.updatePrivacy({ mode: 1, userJid: [lid] })
    assert.deepEqual(await audience.audience(socket), [jid[1]], 'phone Status exclusions work across PN/LID aliases')
    audience.flush()
    const persisted = fs.readFileSync(path.join(dir, 'status-audience.json'), 'utf8')
    assert(!persisted.includes('Saved one'), 'contact names are not stored')
    audience = new StatusAudience(dir)
    audience.sync = async () => {}
    assert.deepEqual(await audience.audience(socket), [jid[1]], 'audience and privacy survive restart')
    audience.updatePrivacy({ mode: 0, userJid: [lid] })
    assert.deepEqual(await audience.audience(socket), [jid[0]], 'Only share with privacy is respected')
    socket.fetchBlocklist = async () => [lid]
    await assert.rejects(() => audience.audience(socket), /No eligible/, 'blocked contacts cannot view Status even through another identifier')
    audience.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('send failures propagate to the worker for error accounting', async () => {
  const socket = { async sendMessage() { throw new Error('test-send-failed') } }
  await assert.rejects(() => sendDelivery(socket, { kind: 'status', jid: 'status@broadcast', statusJidList: [] }, { text: 'test' }), /test-send-failed/)
})

test('text Status uses an opaque teal background and native text font in actual Baileys serialization', async () => {
  const calls = [], delivery = { kind: 'status', jid: 'status@broadcast', statusJidList: viewers.map(n => n + '@s.whatsapp.net') }
  const content = { text: 'Status color fixture' }, options = { messageId: 'FIXTURE-MESSAGE-ID' }
  const socket = { async sendMessage(...args) { calls.push(args); return generateWAMessageContent(args[1], args[2]) } }
  const message = await sendDelivery(socket, delivery, content, options)
  assert.equal(message.extendedTextMessage.backgroundArgb, 0xff008069, 'full opacity prevents a transparent/black Status background')
  assert.equal(message.extendedTextMessage.font, 1)
  assert.equal(message.extendedTextMessage.text, content.text)
  assert.deepEqual(calls[0][2], { backgroundColor: '#008069', font: 1, ...options, statusJidList: delivery.statusJidList })
  assert.deepEqual(options, { messageId: 'FIXTURE-MESSAGE-ID' }, 'caller options are preserved')
  const otherCalls = [], capture = { async sendMessage(...args) { otherCalls.push(args) } }
  await sendDelivery(capture, { kind: 'message', jid: group.jid }, content, options)
  await sendDelivery(capture, delivery, { image: Buffer.from('fixture'), caption: 'caption' }, options)
  await sendDelivery(capture, delivery, { video: Buffer.from('fixture'), caption: 'caption' }, options)
  assert.equal(otherCalls[0][2], options)
  for (const [, , sendOptions] of otherCalls) { assert.equal(sendOptions.backgroundColor, undefined); assert.equal(sendOptions.font, undefined) }
})
