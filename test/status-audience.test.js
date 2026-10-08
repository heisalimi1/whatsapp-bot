import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StatusAudience } from '../status-audience.js'
import { buildDeliveryPlan, sendDelivery } from '../automation-delivery.js'

const pn = n => `12345678${n}@s.whatsapp.net`
const lid = n => `12345678901${n}@lid`
function fixture(t, contacts, privacy = { mode: 2, userJid: [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-alias-test-'))
  const audience = new StatusAudience(dir)
  audience.sync = async () => {}
  audience.updateContacts(contacts); audience.updatePrivacy(privacy)
  const socket = { async fetchPrivacySettings() { return { status: privacy.mode === 1 ? 'contact_blacklist' : privacy.mode === 0 ? 'contacts_whitelist' : 'contacts' } }, async fetchBlocklist() { return [] }, signalRepository: { lidMapping: { async getPNForLID() { return null }, async getLIDForPN() { return null } } } }
  t.after(() => { clearTimeout(audience.writeTimer); fs.rmSync(dir, { recursive: true, force: true }) })
  return { audience, socket, dir }
}

test('an unrelated blocked LID without a reverse mapping does not prevent Status posting', async t => {
  const { audience, socket } = fixture(t, [{ id: pn(1), lid: lid(1), name: 'fixture' }, { id: pn(2), name: 'ambiguous' }])
  socket.fetchBlocklist = async () => [lid(9)]
  const viewers = await audience.audience(socket)
  assert.deepEqual(viewers, [pn(1)], 'verified contacts remain eligible; a PN-only contact is withheld against an unknown blocked LID')
  assert.equal(audience.summary().eligibleCount, 1); assert.equal(audience.summary().unmappedCount, 1)
  const calls = []
  socket.sendMessage = async (...args) => { calls.push(args) }
  for (const content of [{ text: 'fixture' }, { image: Buffer.from('fixture') }, { video: Buffer.from('fixture') }]) {
    for (const delivery of buildDeliveryPlan([], viewers, { toStatus: true }, 1)) await sendDelivery(socket, delivery, content)
  }
  assert.equal(calls.length, 3)
  assert(calls.every(([jid, , options]) => jid === 'status@broadcast' && options.statusJidList.length === 1 && options.statusJidList[0] === pn(1)))
})

test('snapshot PN/LID pairs enforce exclusions even when SDK mapping lookups fail', async t => {
  const { audience, socket } = fixture(t, [{ id: pn(1), lid: lid(1), name: 'excluded' }, { id: pn(2), lid: lid(2), name: 'eligible' }], { mode: 1, userJid: [lid(1)] })
  let lookups = 0
  socket.signalRepository.lidMapping = { async getPNForLID() { lookups++; throw Error('fixture missing reverse cache') }, async getLIDForPN() { lookups++; throw Error('fixture cache failed') } }
  assert.deepEqual(await audience.audience(socket), [pn(2)])
  assert.equal(lookups, 0, 'already verified local pairs do not require reverse lookups')
  audience.updatePrivacy({ mode: 0, userJid: [lid(1)] }); socket.fetchPrivacySettings = async () => ({ status: 'contacts_whitelist' })
  assert.deepEqual(await audience.audience(socket), [pn(1)], 'only-share-with remains restrictive')
  socket.fetchBlocklist = async () => [pn(1)]
  await assert.rejects(() => audience.audience(socket), /No eligible/)
})

test('forward batch USync repairs a missing reverse mapping and deduplicates contact identities', async t => {
  const { audience, socket, dir } = fixture(t, [{ id: pn(1), name: 'saved' }, { id: lid(1), name: 'same person' }, { id: pn(2), name: 'blocked' }], { mode: 1, userJid: [lid(2)] })
  let forwardCalls = 0, reverseReady = false
  socket.signalRepository.lidMapping = {
    async getPNsForLIDs(values) { return reverseReady ? values.map(value => ({ lid: value, pn: value === lid(1) ? pn(1) : pn(2) })) : null },
    async getLIDsForPNs(values) { forwardCalls++; reverseReady = true; return values.map(value => ({ pn: value, lid: value === pn(1) ? lid(1) : lid(2) })) }
  }
  assert.deepEqual(await audience.audience(socket), [pn(1)])
  assert.equal(forwardCalls, 1, 'missing PN mappings are fetched in one batch')
  audience.flush()
  const restored = new StatusAudience(dir); restored.sync = async () => {}
  assert(restored.contacts.get(pn(1)).lid === lid(1))
  clearTimeout(restored.writeTimer)
})

test('missing PN exclusions withhold ambiguous LID-only contacts without blocking verified viewers', async t => {
  const { audience, socket } = fixture(t, [{ id: lid(1), name: 'ambiguous' }, { id: pn(2), lid: lid(2), name: 'eligible' }])
  socket.fetchBlocklist = async () => [pn(9)]
  socket.signalRepository.lidMapping.getLIDForPN = async () => { throw Error('fixture missing mapping') }
  assert.deepEqual(await audience.audience(socket), [pn(2)])
  assert.equal(audience.summary().unmappedCount, 1)
})

test('unknown allow-list aliases, contradictory mappings and invalid blocklists never broaden privacy', async t => {
  const { audience, socket } = fixture(t, [{ id: pn(1), name: 'unverified' }], { mode: 0, userJid: [lid(9)] })
  await assert.rejects(() => audience.audience(socket), /No eligible/)
  audience.updatePrivacy({ mode: 2, userJid: [] }); socket.fetchPrivacySettings = async () => ({ status: 'contacts' })
  socket.fetchBlocklist = async () => ['invalid-identifier']
  await assert.rejects(() => audience.audience(socket), /could not be verified/)
  socket.fetchBlocklist = async () => []
  audience.updateContacts([{ id: pn(1), lid: lid(1), name: 'fixture' }, { id: pn(2), lid: lid(1), name: 'conflict' }])
  await assert.rejects(() => audience.audience(socket), /No eligible/)
})

test('contact events during mapping preparation wait for the next verified audience snapshot', async t => {
  const { audience, socket } = fixture(t, [{ id: pn(1), name: 'initial' }])
  socket.signalRepository.lidMapping.getLIDForPN = async () => {
    audience.updateContacts([{ id: pn(2), name: 'new arrival' }])
    return lid(1)
  }
  assert.deepEqual(await audience.audience(socket), [pn(1)])
  assert.equal(audience.summary().eligibleCount, 1)
})
