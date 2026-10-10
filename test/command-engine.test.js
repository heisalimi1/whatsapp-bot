import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { generateWAMessageContent } from '@whiskeysockets/baileys'
import { createCommandStore } from '../commands/store.js'
import { createCommandEngine } from '../commands/engine.js'
import { COMMANDS } from '../commands/catalog.js'
import { matchesPhrase, unauthorizedLink, validateAccountSettings, validateGroupSettings, accountDefaults } from '../commands/settings.js'

const workspace = '11111111-1111-4111-8111-111111111111', accountId = '22222222-2222-4222-8222-222222222222'
const otherWorkspace = '33333333-3333-4333-8333-333333333333', otherAccount = '44444444-4444-4444-8444-444444444444'
const group = '120363000000000001@g.us'
const owner = '15105550101@s.whatsapp.net', member = '15105550102@s.whatsapp.net', administrator = '15105550103@s.whatsapp.net', founder = '15105550104@s.whatsapp.net'
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-command-test-'))
  let clock = Date.parse('2026-10-09T00:00:00Z'), nextId = 0, socket, engine
  const database = path.join(directory, 'test.sqlite'), store = createCommandStore(database, { now: () => clock })
  const calls = [], scheduled = [], broadcasted = []
  const media = { availability: () => ({ tomp3: true }), async process(name, source, limits, consume) { calls.push({ media: name, source, limits }); return consume({ sticker: Buffer.from('test-only') }) } }
  const groups = { id: group, subject: 'Test group', participants: [{ id: owner, admin: 'admin' }, { id: member }, { id: administrator, admin: 'admin' }, { id: founder, admin: 'superadmin' }] }
  const makeSocket = () => ({ user: { id: owner }, async groupMetadata() { return structuredClone(groups) },
    async sendMessage(jid, content, options) { calls.push({ jid, content, options }); return { key: { id: options?.messageId } } },
    async groupParticipantsUpdate(jid, members, action) { calls.push({ action, members, jid }); return [{ status: '200' }] },
    async groupSettingUpdate(jid, setting) { calls.push({ setting, jid }) }
  })
  socket = makeSocket()
  const services = { async schedule(context, args) { scheduled.push({ id: context.account.id, args }); return 'Schedule created.' }, async broadcast(context, args) { broadcasted.push({ id: context.account.id, args }); return 'Broadcast queued.' }, async isAutomationMessage(_, id) { return id === 'automation-echo' } }
  const makeEngine = targetStore => createCommandEngine({ store: targetStore, media, now: () => clock,
    async getAccount(id) { return { id, workspaceId: id === accountId ? workspace : otherWorkspace } }, async getSocket() { return socket }, services })
  engine = makeEngine(store)
  const configure = (mutate, a = accountId, w = workspace) => { const { config, revision } = store.settings(w, a); mutate(config); return store.saveSettings(w, a, config, revision) }
  const enable = (...names) => configure(c => { for (const name of names) c.commands[name].enabled = true })
  function message(text, overrides = {}) {
    return { key: { id: `fixture-${++nextId}`, remoteJid: group, participant: member, fromMe: false, ...overrides.key }, messageTimestamp: Math.floor(clock / 1000), message: { conversation: text }, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'key')) }
  }
  const deliver = msg => engine.onEvent(socket, accountId, 'messages.upsert', { type: 'notify', messages: [msg] })
  const receipt = (id, values = {}, key = {}) => engine.onEvent(socket, accountId, 'message-receipt.update', [{ key: { id, remoteJid: group, fromMe: true, ...key }, receipt: { userJid: member, receiptTimestamp: Math.floor(clock / 1000), ...values } }])
  t.after(async () => { await engine.stop(); store.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }) })
  return { directory, database, store, calls, groups, configure, enable, message, deliver, receipt, services, media, scheduled, broadcasted,
    async send(text, overrides) { return deliver(message(text, overrides)) }, advance(ms = 6000) { clock += ms },
    get socket() { return socket }, get engine() { return engine }, replaceSocket() { socket = makeSocket() }, makeEngine,
    async restart() { await engine.stop(); engine = makeEngine(store) }
  }
}
const ownerKey = { fromMe: true, participant: owner }

async function waitUntil(predicate) {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('A ready command was blocked by unrelated work.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('same-chat waiting actions do not occupy workers needed by another chat', async t => {
  const f = fixture(t); f.enable('tagall')
  const gate = Promise.withResolvers(), original = f.socket.sendMessage.bind(f.socket)
  t.mock.method(f.socket, 'sendMessage', async (jid, content, options) => {
    const result = await original(jid, content, options)
    if (content.text?.startsWith('Holding first')) await gate.promise
    return result
  })
  const tasks = [f.send('.tagall Holding first', { key: ownerKey })]
  try {
    await waitUntil(() => f.calls.length === 1)
    for (let index = 0; index < 3; index++) tasks.push(f.send('.tagall Waiting', { key: ownerKey }))
    tasks.push(f.send('.tagall Other chat', { key: { ...ownerKey, remoteJid: member } }))
    // A private-chat group command still needs to send its usage error promptly.
    await waitUntil(() => f.calls.some(call => call.jid === member))
    assert.equal(f.engine.metrics().active, 1)
  } finally { gate.resolve(); await Promise.all(tasks) }
  assert.deepEqual(f.engine.metrics(), { active: 0, queued: 0 })
})

test('basic replies bypass slow media processing in the same chat', async t => {
  const f = fixture(t); f.enable('sticker')
  const gate = Promise.withResolvers(), started = Promise.withResolvers()
  const original = f.media.process.bind(f.media)
  t.mock.method(f.media, 'process', async (...args) => { started.resolve(); await gate.promise; return original(...args) })
  const slow = f.send('', { key: ownerKey, message: { imageMessage: { caption: '.sticker', url: 'https://mmg.whatsapp.net/test-only' } } })
  let fast
  try {
    await started.promise
    fast = f.send('.ping', { key: ownerKey })
    await waitUntil(() => f.calls.some(call => call.content?.text === 'Pong!'))
    assert.equal(f.calls.some(call => call.media), false)
  } finally { gate.resolve(); await Promise.all([slow, fast]) }
  assert.deepEqual(f.engine.metrics(), { active: 0, queued: 0 })
})

test('buffered tag cleanup cannot delay a new command in the same incoming batch', async t => {
  const f = fixture(t); f.enable('tag')
  await f.send('.tag Delivered announcement', { key: ownerKey })
  const id = f.calls[0].options.messageId, gate = Promise.withResolvers()
  const original = f.socket.sendMessage.bind(f.socket)
  t.mock.method(f.socket, 'sendMessage', async (jid, content, options) => {
    const result = await original(jid, content, options)
    if (content.delete) await gate.promise
    return result
  })
  const work = f.engine.onEvent(f.socket, accountId, 'messages.upsert', { type: 'notify', messages: [
    f.message('Delivered announcement', { key: { ...ownerKey, id }, status: 3 }),
    f.message('.ping', { key: ownerKey })
  ] })
  try {
    await waitUntil(() => f.calls.some(call => call.content?.delete))
    await waitUntil(() => f.calls.some(call => call.content?.text === 'Pong!'))
  } finally { gate.resolve(); await work }
  assert.equal(f.calls.filter(call => call.content?.delete).length, 1)
})
test('catalog has 19 disabled feature commands and four safe owner defaults', t => {
  const f = fixture(t), settings = f.store.settings(workspace, accountId)
  assert.equal(COMMANDS.length, 23)
  assert.equal(COMMANDS.filter(c => c.category !== 'Basic').length, 19)
  assert.equal(COMMANDS.filter(c => c.category === 'Basic').length, 4)
  assert(COMMANDS.filter(c => c.category !== 'Basic').every(c => !settings.config.commands[c.name].enabled))
  assert(COMMANDS.filter(c => c.category === 'Basic').every(c => settings.config.commands[c.name].enabled && settings.config.commands[c.name].permission === 'owner'))
  assert.equal(settings.config.prefix, '.')
})
test('recognition, help, prefix changes, disabled commands and safe defaults', async t => {
  const f = fixture(t)
  await f.send('.kick', { key: ownerKey }); assert.equal(f.calls.length, 0)
  await f.send('.ping', { key: ownerKey }); assert.equal(f.calls[0].content.text, 'Pong!')
  await f.send('.menu', { key: ownerKey }); assert.match(f.calls.at(-1).content.text, /\.help/); assert.doesNotMatch(f.calls.at(-1).content.text, /\.kick/)
  await f.send('.help antiword', { key: ownerKey }); assert.match(f.calls.at(-1).content.text, /Disabled by the account owner/)
  f.configure(c => { c.prefix = '!' }); f.advance()
  const count = f.calls.length; await f.send('.ping', { key: ownerKey }); assert.equal(f.calls.length, count)
  await f.send('!ping', { key: ownerKey }); assert.equal(f.calls.at(-1).content.text, 'Pong!')
  await f.send('!alive', { key: ownerKey }); assert.match(f.calls.at(-1).content.text, /connected/)
})
test('persistent duplicate prevention rejects replay after engine and database reconnection', async t => {
  const f = fixture(t), msg = f.message('.ping', { key: ownerKey })
  await Promise.all([f.deliver(msg), f.deliver(msg)]); assert.equal(f.calls.length, 1)
  await f.restart(); f.advance(); await f.deliver(msg); assert.equal(f.calls.length, 1)
  const secondStore = createCommandStore(f.database), engine = f.makeEngine(secondStore)
  await engine.onEvent(f.socket, accountId, 'messages.upsert', { type: 'notify', messages: [msg] }); assert.equal(f.calls.length, 1)
  await engine.stop(); secondStore.close()
})
test('history, old messages, automation echoes and stale sockets never execute', async t => {
  const f = fixture(t)
  await f.engine.onEvent(f.socket, accountId, 'messages.upsert', { type: 'append', messages: [f.message('.ping', { key: ownerKey })] })
  await f.send('.ping', { key: ownerKey, messageTimestamp: 1 })
  await f.send('.ping', { key: { ...ownerKey, id: 'automation-echo' } })
  const stale = f.socket; f.replaceSocket()
  await f.engine.onEvent(stale, accountId, 'messages.upsert', { type: 'notify', messages: [f.message('.ping', { key: ownerKey })] })
  assert.equal(f.calls.length, 0)
  await f.send('.ping', { key: ownerKey }); assert.equal(f.calls.length, 1)
})
test('owner-only utilities cannot be delegated; nonowners cannot execute owner commands', async t => {
  const f = fixture(t); f.enable('schedule', 'broadcast', 'autoreply')
  await f.send('.schedule list'); assert.equal(f.calls.length, 0); assert.equal(f.scheduled.length, 0)
  await f.send('.broadcast anything'); assert.equal(f.calls.length, 0); assert.equal(f.broadcasted.length, 0)
  assert.throws(() => f.configure(c => { c.commands.broadcast.permission = 'permitted' }), /restricted/)
  await f.send('.schedule list', { key: ownerKey }); assert.equal(f.scheduled[0].id, accountId)
})

test('all commands from other people are silently ignored before replies, moderation or side effects', async t => {
  const f = fixture(t); f.enable(...COMMANDS.map(c => c.name))
  f.configure(c => { c.permittedUsers = [member, administrator]; c.autoreply.enabled = true; c.autoreply.rules = [{ id: 'command-trigger', trigger: '.ping', reply: 'Must not reply' }] })
  f.store.saveGroup(workspace, accountId, group, { antiword: true, words: ['blocked command'], action: 'warn-delete' })
  const originalSettings = f.store.settings.bind(f.store)
  t.mock.method(f.store, 'settings', (...args) => {
    const result = originalSettings(...args)
    for (const setting of Object.values(result.config.commands)) setting.permission = 'permitted'
    return result
  })
  const metadata = t.mock.method(f.socket, 'groupMetadata')
  for (const command of COMMANDS) {
    for (const participant of [member, administrator, owner]) await f.send('.' + command.name + ' blocked command', { key: { participant, fromMe: false } })
    await f.send('.' + command.name, { key: { remoteJid: member, fromMe: false } })
  }
  await f.send('.ping', { key: { participant: owner, fromMe: undefined } })
  await f.send('', { message: { imageMessage: { caption: '.sticker', url: 'https://mmg.whatsapp.net/test-only' } } })
  await f.send('.not-a-command blocked command')
  assert.equal(f.calls.length, 0); assert.equal(f.scheduled.length, 0); assert.equal(f.broadcasted.length, 0)
  assert.equal(metadata.mock.callCount(), 0)
  const connection = new DatabaseSync(f.database)
  try {
    for (const table of ['bot_command_receipts', 'bot_command_statistics', 'bot_warnings']) assert.equal(connection.prepare('SELECT count(*) AS count FROM ' + table).get().count, 0)
  } finally { connection.close() }
  f.advance(); await f.send('.ping', { key: ownerKey })
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].content.text, 'Pong!')
  for (const command of COMMANDS) for (const permission of ['admin', 'permitted']) assert.throws(() => f.configure(c => { c.commands[command.name].permission = permission }), /restricted/)
})
test('group administration checks sender and bot permissions and protects group owner', async t => {
  const f = fixture(t); f.enable('kick', 'mute', 'unmute', 'promote', 'demote')
  await f.send('.kick ' + member); assert.equal(f.calls.length, 0)
  f.advance(); f.groups.participants[0].admin = null
  await f.send('.kick ' + member, { key: ownerKey }); assert.equal(f.calls.some(c => c.action), false); assert.match(f.calls.at(-1).content.text, /administrator/)
  f.groups.participants[0].admin = 'admin'; f.advance()
  await f.send('.kick ' + founder, { key: ownerKey }); assert.match(f.calls.at(-1).content.text, /cannot be targeted/)
  f.advance(); await f.send('.kick ' + member, { key: ownerKey }); assert.deepEqual(f.calls.find(c => c.action).members, [member])
  f.advance(); await f.send('.mute', { key: ownerKey }); assert.equal(f.calls.find(c => c.setting).setting, 'announcement')
  f.advance(); await f.send('.unmute', { key: ownerKey }); assert.equal(f.calls.filter(c => c.setting).at(-1).setting, 'not_announcement')
  f.advance(); await f.send('.promote ' + member, { key: ownerKey }); assert.equal(f.calls.filter(c => c.action).at(-1).action, 'promote')
  f.advance(); await f.send('.demote ' + administrator, { key: ownerKey }); assert.equal(f.calls.filter(c => c.action).at(-1).action, 'demote')
})
test('quoted and mentioned targets use verified LID/PN aliases', async t => {
  const f = fixture(t); f.enable('kick')
  f.groups.participants[1] = { id: '1000000002@lid', phoneNumber: member }
  f.socket.signalRepository = { lidMapping: { async getLIDForPN(pn) { return pn === member ? '1000000002@lid' : null }, async getPNForLID(lid) { return lid === '1000000002@lid' ? member : null } } }
  await f.send('', { key: ownerKey, message: { extendedTextMessage: { text: '.kick', contextInfo: { participant: '1000000002@lid', quotedMessage: { conversation: 'fixture' } } } } })
  assert.deepEqual(f.calls.find(c => c.action).members, ['1000000002@lid'])
  f.advance(); await f.send('', { key: ownerKey, message: { extendedTextMessage: { text: '.kick', contextInfo: { mentionedJid: [member] } } } })
  assert.equal(f.calls.filter(c => c.action).length, 2)
})
test('tagall keeps deduplicated visible member batches without a generated announcement', async t => {
  const f = fixture(t); f.enable('tagall')
  f.groups.participants.push(...Array.from({ length: 205 }, (_, i) => ({ id: `${15105551000 + i}@s.whatsapp.net` })), { id: member })
  await f.send('.tagall Notice', { key: ownerKey })
  assert.equal(f.calls.length, 3); assert(f.calls.every(c => c.content.mentions.length <= 100))
  const mentions = f.calls.flatMap(c => c.content.mentions); assert.equal(mentions.length, new Set(mentions).size)
  f.calls.length = 0; f.advance(); await f.send('.tagall', { key: ownerKey })
  assert.equal(f.calls.length, 3)
  assert(f.calls.every(c => c.content.text.startsWith('@') && !c.content.text.includes('Group announcement')))
})

test('tag sends one hidden-mention message to large groups and rejects replay and echoes', async t => {
  const f = fixture(t); f.enable('tag')
  f.groups.participants.push(...Array.from({ length: 205 }, (_, i) => ({ id: `${15105551000 + i}@s.whatsapp.net` })), { id: member }, { id: '1000000002@lid', phoneNumber: member })
  const msg = f.message('.tag .tag Please read this\nSecond line', { key: ownerKey })
  await Promise.all([f.deliver(msg), f.deliver(msg), f.deliver(msg)])
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].content.text, '.tag Please read this\nSecond line')
  const mentions = f.calls[0].content.mentions
  assert.equal(mentions.length, 209); assert.equal(mentions.length, new Set(mentions).size)
  const outgoingId = f.calls[0].options.messageId
  await f.restart(); f.advance(); f.replaceSocket(); await f.deliver(msg)
  await f.send(f.calls[0].content.text, { key: { ...ownerKey, id: outgoingId } })
  assert.equal(f.calls.length, 1)
  const secondStore = createCommandStore(f.database), secondEngine = f.makeEngine(secondStore)
  try {
    await secondEngine.onEvent(f.socket, accountId, 'messages.upsert', { type: 'notify', messages: [msg] })
    assert.equal(f.calls.length, 1)
  } finally { await secondEngine.stop(); secondStore.close() }
})

test('tag without text returns one usage reply without mentioning members', async t => {
  const f = fixture(t); f.enable('tag')
  const msg = f.message('.tag', { key: ownerKey })
  await Promise.all([f.deliver(msg), f.deliver(msg)])
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].content.text, 'Usage: .tag <message>, or reply to a message with .tag.')
  assert.equal(f.calls[0].content.mentions, undefined)
  f.advance(); await f.send('.tag \n\t ', { key: ownerKey })
  assert.equal(f.calls.length, 2)
  f.configure(c => { c.prefix = '!' }); f.advance(); await f.send('!tag', { key: ownerKey })
  assert.equal(f.calls.at(-1).content.text, 'Usage: !tag <message>, or reply to a message with !tag.')
  assert(f.calls.every(c => !c.content.mentions && !c.content.text.includes('Group announcement')))
})

test('reply tag copies the quoted text once and deletes only the owner command after delivery', async t => {
  const f = fixture(t); f.enable('tag')
  const text = '.tag Original announcement\nPlease read this.', quotedId = 'synthetic-quoted-message'
  const quoted = { extendedTextMessage: { text, contextInfo: { mentionedJid: [member] } } }
  const before = structuredClone(quoted)
  const command = f.message('', { key: ownerKey, message: { extendedTextMessage: { text: '.tag', contextInfo: {
    stanzaId: quotedId, participant: member, quotedMessage: quoted
  } } } })
  await Promise.all([f.deliver(command), f.deliver(command), f.deliver(command)])
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].content.text, text)
  assert.equal(f.calls[0].content.mentions.length, 4)
  assert.deepEqual(quoted, before)
  const outgoing = f.calls[0].options.messageId
  await f.engine.onEvent(f.socket, accountId, 'messages.update', [{ key: { id: outgoing, remoteJid: group, fromMe: true }, update: { status: 2 } }])
  assert.equal(f.calls.length, 1)
  await f.restart()
  await f.send(text, { key: { ...ownerKey, id: outgoing } })
  assert.equal(f.calls.length, 1, 'the quoted tagged output cannot execute itself')
  await Promise.all([f.receipt(outgoing), f.receipt(outgoing)])
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1].content.delete, command.key)
  assert.notEqual(f.calls[1].content.delete.id, quotedId)
  assert.notEqual(f.calls[1].content.delete.id, outgoing)
  await f.deliver(command); assert.equal(f.calls.length, 2)
})

test('reply tag accepts wrapped text, custom prefixes, and explicit text takes precedence', async t => {
  const f = fixture(t); f.enable('tag'); f.configure(c => { c.prefix = '!' })
  const quote = { ephemeralMessage: { message: { conversation: 'Replied-to text' } } }
  await f.send('', { key: ownerKey, message: { extendedTextMessage: { text: '!tag', contextInfo: { quotedMessage: quote } } } })
  assert.equal(f.calls[0].content.text, 'Replied-to text')
  f.advance()
  await f.send('', { key: ownerKey, message: { extendedTextMessage: { text: '!tag Override text', contextInfo: { quotedMessage: quote } } } })
  assert.equal(f.calls[1].content.text, 'Override text')
})

for (const type of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage']) {
  test(`reply tag forwards ${type} with real Baileys hidden mentions and confirmed cleanup`, async t => {
    const f = fixture(t); f.enable('tag')
    const value = { url: 'https://mmg.whatsapp.net/test-only', directPath: '/test-only', mediaKey: Buffer.alloc(32, 1),
      fileSha256: Buffer.alloc(32, 2), fileEncSha256: Buffer.alloc(32, 3), mimetype: 'application/octet-stream',
      contextInfo: { mentionedJid: ['10000000999@s.whatsapp.net'] } }
    if (['imageMessage', 'videoMessage', 'documentMessage'].includes(type)) value.caption = 'Quoted media caption'
    if (type === 'documentMessage') value.fileName = 'test-only.txt'
    if (type === 'audioMessage') value.ptt = true
    const media = { [type]: value }, quoted = type === 'documentMessage' ? { documentWithCaptionMessage: { message: media } } : media
    const command = f.message('', { key: ownerKey, message: { extendedTextMessage: { text: '.tag', contextInfo: {
      stanzaId: 'synthetic-source-media', participant: member, quotedMessage: quoted
    } } } })
    const before = JSON.stringify(quoted)
    await f.deliver(command)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].content.text, undefined, 'no extra caption or announcement is posted')
    assert(f.calls[0].content.forward.message[type])
    assert.equal(f.calls[0].content.mentions.length, 4)
    const encoded = await generateWAMessageContent(f.calls[0].content, {})
    assert.deepEqual(encoded[type].contextInfo.mentionedJid, f.calls[0].content.mentions)
    assert.equal(encoded[type].caption, value.caption)
    assert.deepEqual(Buffer.from(encoded[type].mediaKey), value.mediaKey)
    assert.equal(encoded[type].contextInfo.mentionedJid.includes('10000000999@s.whatsapp.net'), false)
    assert.equal(JSON.stringify(quoted), before, 'forward generation does not mutate the source')
    await Promise.all([f.receipt(f.calls[0].options.messageId), f.receipt(f.calls[0].options.messageId)])
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls[1].content.delete, command.key)
    assert.notEqual(f.calls[1].content.delete.id, 'synthetic-source-media')
  })
}

test('reply tag refuses unavailable, view-once, protocol and cross-chat sources without mentions or deletion', async t => {
  const f = fixture(t); f.enable('tag')
  const cases = [
    { quotedMessage: { conversation: '   ' } },
    { quotedMessage: { protocolMessage: { type: 0 } } },
    { quotedMessage: { editedMessage: { message: { conversation: 'Edited' } } } },
    { quotedMessage: { viewOnceMessageV2: { message: { imageMessage: { url: 'https://mmg.whatsapp.net/test-only' } } } } },
    { quotedMessage: { ephemeralMessage: { message: { imageMessage: { viewOnce: true } } } } },
    { quotedMessage: { documentWithCaptionMessage: { message: { viewOnceMessage: { message: { imageMessage: {} } } } } } },
    { remoteJid: 'status@broadcast', quotedMessage: { conversation: 'Wrong chat' } },
    { quotedMessage: { conversation: 'x'.repeat(12001) } },
    { quotedMessage: { imageMessage: { url: 'https://example.com/not-whatsapp', mediaKey: Buffer.alloc(32, 1) } } },
    { quotedMessage: { videoMessage: { url: 'https://mmg.whatsapp.net/test-only' } } }
  ]
  for (const contextInfo of cases) {
    f.advance(61000)
    await f.send('', { key: ownerKey, message: { extendedTextMessage: { text: '.tag', contextInfo } } })
    assert.equal(f.calls.at(-1).content.mentions, undefined)
    assert.equal(f.calls.at(-1).content.forward, undefined)
    assert.equal(f.calls.at(-1).content.delete, undefined)
  }
  assert.equal(f.calls.length, cases.length)
})

test('reply tag remains owner-only and keeps the command when a forwarded send fails', async t => {
  const f = fixture(t); f.enable('tag')
  const body = { extendedTextMessage: { text: '.tag', contextInfo: { quotedMessage: { imageMessage: {
    url: 'https://mmg.whatsapp.net/test-only', mediaKey: Buffer.alloc(32, 1)
  } } } } }
  await f.send('', { message: body }); assert.equal(f.calls.length, 0)
  const original = f.socket.sendMessage.bind(f.socket)
  t.mock.method(f.socket, 'sendMessage', async (jid, content, options) => {
    const result = await original(jid, content, options)
    if (content.forward) { await f.receipt(options.messageId); throw Error('Synthetic failed forwarded send') }
    return result
  })
  const command = f.message('', { key: ownerKey, message: body })
  await f.deliver(command)
  await f.receipt(f.calls[0].options.messageId)
  await f.deliver(command)
  assert.equal(f.calls.filter(call => call.content.forward).length, 1)
  assert.equal(f.calls.filter(call => call.content.delete).length, 0)
})

test('tag deletes only its original command after a verified group delivery, exactly once', async t => {
  const f = fixture(t); f.enable('tag')
  const msg = f.message('.tag Delivered notice', { key: ownerKey })
  await f.deliver(msg)
  const id = f.calls[0].options.messageId
  assert.equal(f.calls.length, 1)
  await f.engine.onEvent(f.socket, accountId, 'messages.update', [{ key: { id, remoteJid: group, fromMe: true }, update: { status: 2 } }])
  await f.receipt(id, { userJid: owner })
  await f.receipt(id, { userJid: '10000000999@s.whatsapp.net' })
  await f.receipt(id, {}, { fromMe: false })
  await f.receipt(id, {}, { remoteJid: '120363000000009999@g.us' })
  await f.receipt(id, { receiptTimestamp: 0 })
  assert.equal(f.calls.length, 1, 'server ACKs, self/unknown/wrong-chat receipts and empty timestamps do not delete')
  await Promise.all([f.receipt(id), f.receipt(id), f.receipt(id)])
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1].content.delete, msg.key)
  assert.notEqual(f.calls[1].content.delete.id, id, 'the tagged output must remain')
  await f.deliver(msg); await f.receipt(id)
  assert.equal(f.calls.length, 2)
})

test('a delivery receipt arriving before send completion waits for the confirmed send', async t => {
  const f = fixture(t); f.enable('tag')
  const original = f.socket.sendMessage.bind(f.socket)
  t.mock.method(f.socket, 'sendMessage', async (jid, content, options) => {
    const result = await original(jid, content, options)
    if (!content.delete) {
      await f.receipt(options.messageId)
      assert.equal(f.calls.filter(c => c.content.delete).length, 0)
    }
    return result
  })
  await f.send('.tag Early delivery', { key: ownerKey })
  assert.equal(f.calls.length, 2); assert.equal(f.calls.filter(c => c.content.delete).length, 1)
})

test('failed sends preserve the command even when a delivery receipt arrives early', async t => {
  const f = fixture(t); f.enable('tag')
  const original = f.socket.sendMessage.bind(f.socket)
  let first = true
  t.mock.method(f.socket, 'sendMessage', async (jid, content, options) => {
    const result = await original(jid, content, options)
    if (first) { first = false; await f.receipt(options.messageId); throw Error('Synthetic failed send') }
    return result
  })
  await f.send('.tag Keep original', { key: ownerKey })
  await f.receipt(f.calls[0].options.messageId)
  assert.equal(f.calls.filter(c => c.content.delete).length, 0)
})

test('cleanup persists across engine/database restart and competing receipt handlers', async t => {
  const f = fixture(t); f.enable('tag')
  const msg = f.message('.tag Persistent notice', { key: ownerKey }); await f.deliver(msg)
  const id = f.calls[0].options.messageId
  await f.restart()
  const secondStore = createCommandStore(f.database), secondEngine = f.makeEngine(secondStore)
  try {
    await Promise.all([f.receipt(id), secondEngine.onEvent(f.socket, accountId, 'message-receipt.update', [{ key: { id, remoteJid: group, fromMe: true }, receipt: { userJid: member, readTimestamp: 1 } }])])
    assert.equal(f.calls.filter(c => c.content.text === 'Persistent notice').length, 1)
    assert.equal(f.calls.filter(c => c.content.delete).length, 1)
  } finally { await secondEngine.stop(); secondStore.close() }
})

test('reconnection resumes confirmed cleanup and ignores stale socket and cross-account receipts', async t => {
  const f = fixture(t); f.enable('tag'); await f.send('.tag Reconnected notice', { key: ownerKey })
  const id = f.calls[0].options.messageId, old = f.socket
  await f.engine.onEvent(old, otherAccount, 'message-receipt.update', [{ key: { id, remoteJid: group, fromMe: true }, receipt: { userJid: member, receiptTimestamp: 1 } }])
  assert.equal(f.calls.length, 1)
  f.store.confirmTagDelivery(workspace, accountId, id); f.replaceSocket()
  await f.engine.onEvent(old, accountId, 'connection.update', { connection: 'open' }); assert.equal(f.calls.length, 1)
  await f.engine.onEvent(f.socket, accountId, 'connection.update', { connection: 'open' })
  await f.engine.onEvent(f.socket, accountId, 'connection.update', { connection: 'open' })
  assert.equal(f.calls.length, 2); assert.equal(f.calls.filter(c => c.content.delete).length, 1)
})

test('buffered outgoing delivery receipts clean up without executing the tagged text again', async t => {
  const f = fixture(t); f.enable('tag'); await f.send('.tag Buffered notice', { key: ownerKey })
  const id = f.calls[0].options.messageId
  await f.engine.onEvent(f.socket, accountId, 'messages.upsert', { type: 'append', messages: [{ key: { id, remoteJid: group, fromMe: true }, userReceipt: [{ userJid: member, readTimestamp: 1 }] }] })
  assert.equal(f.calls.length, 2); assert.equal(f.calls.filter(c => c.content.delete).length, 1)
})

test('verified PN/LID receipt aliases confirm delivery to the same group recipient', async t => {
  const f = fixture(t); f.enable('tag')
  f.groups.participants[1] = { id: '1000000002@lid' }
  f.socket.signalRepository = { lidMapping: { async getLIDForPN(pn) { return pn === member ? '1000000002@lid' : null }, async getPNForLID(lid) { return lid === '1000000002@lid' ? member : null } } }
  await f.send('.tag Aliased receipt', { key: ownerKey })
  await f.receipt(f.calls[0].options.messageId)
  assert.equal(f.calls.length, 2); assert.equal(f.calls.filter(c => c.content.delete).length, 1)
})

test('deletion failure never resends the tagged message or adds a second group reply', async t => {
  const f = fixture(t); f.enable('tag'); await f.send('.tag Keep tagged output', { key: ownerKey })
  const original = f.socket.sendMessage.bind(f.socket)
  t.mock.method(f.socket, 'sendMessage', async (...args) => { await original(...args); throw Error('Synthetic deletion failure') })
  await f.receipt(f.calls[0].options.messageId); await f.receipt(f.calls[0].options.messageId)
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].content.text, undefined)
})

test('a WhatsApp delivery error preserves the original command and suppresses late cleanup', async t => {
  const f = fixture(t); f.enable('tag'); await f.send('.tag Undelivered notice', { key: ownerKey })
  const id = f.calls[0].options.messageId
  await f.engine.onEvent(f.socket, accountId, 'messages.update', [{ key: { id, remoteJid: group, fromMe: true }, update: { status: 0 } }])
  await f.receipt(id)
  assert.equal(f.calls.length, 1)
})

test('tag cleanup migration is additive and preserves existing customer records and settings', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tag-migration-')), file = path.join(directory, 'synthetic.sqlite')
  const before = new DatabaseSync(file), config = JSON.stringify(accountDefaults())
  before.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES(1,1),(2,2),(3,3); CREATE TABLE synthetic_customers(id TEXT PRIMARY KEY); INSERT INTO synthetic_customers VALUES(\'synthetic-customer\'); CREATE TABLE bot_command_settings(workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,revision INTEGER NOT NULL,config TEXT NOT NULL,PRIMARY KEY(workspace_id,account_id));')
  before.prepare('INSERT INTO bot_command_settings VALUES(?,?,?,?)').run(workspace, accountId, 5, config); before.close()
  const store = createCommandStore(file), db = new DatabaseSync(file)
  t.after(() => { db.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x => x.version), [1, 2, 3, 4])
  assert.equal(db.prepare('SELECT applied_at FROM schema_migrations WHERE version=3').get().applied_at, 3)
  assert.equal(db.prepare('SELECT count(*) AS count FROM synthetic_customers').get().count, 1)
  assert.equal(db.prepare('SELECT config FROM bot_command_settings').get().config, config)
  assert.equal(store.settings(workspace, accountId).revision, 5)
  assert.throws(() => store.prepareTagCleanup(workspace, accountId, 'synthetic-output', { id: 'synthetic-command', remoteJid: group, fromMe: false }, [member]), /Invalid tag cleanup/)
})

test('tag never retries an unconfirmed send when the event is replayed', async t => {
  const f = fixture(t); f.enable('tag')
  const original = f.socket.sendMessage.bind(f.socket)
  let first = true
  t.mock.method(f.socket, 'sendMessage', async (...args) => {
    const result = await original(...args)
    if (first) { first = false; throw Error('Synthetic unconfirmed delivery') }
    return result
  })
  const msg = f.message('.tag One announcement', { key: ownerKey })
  await f.deliver(msg); await f.restart(); f.advance(); await f.deliver(msg)
  assert.equal(f.calls.filter(c => c.content.text === 'One announcement').length, 1)
})

test('tag replaces the old command in catalog, menus, help and execution', async t => {
  const f = fixture(t); f.enable('tag')
  assert.equal(COMMANDS.length, 23)
  assert(COMMANDS.some(c => c.name === 'tag')); assert(!COMMANDS.some(c => c.name === 'hidetag'))
  await f.send('.menu', { key: ownerKey })
  assert.match(f.calls.at(-1).content.text, /\.tag /); assert.doesNotMatch(f.calls.at(-1).content.text, /hidetag/)
  f.advance(); await f.send('.help tag', { key: ownerKey })
  assert.match(f.calls.at(-1).content.text, /Usage: \.tag \[message\].*reply to a message/)
  const count = f.calls.length
  f.advance(); await f.send('.hidetag Old command', { key: ownerKey }); assert.equal(f.calls.length, count)
})

test('existing hidden-tag settings and statistics project to tag without modifying stored data', t => {
  const f = fixture(t), legacy = accountDefaults()
  delete legacy.commands.tag
  legacy.commands.hidetag = { enabled: true, permission: 'permitted' }
  legacy.prefix = '!'
  const connection = new DatabaseSync(f.database)
  try {
    connection.prepare('INSERT INTO bot_command_settings VALUES(?,?,?,?)').run(workspace, accountId, 4, JSON.stringify(legacy))
    f.store.statistic(workspace, accountId, 'hidetag', true)
    f.store.statistic(workspace, accountId, 'hidetag', false)
    f.store.statistic(workspace, accountId, 'tag', true)
    const current = f.store.settings(workspace, accountId)
    assert.equal(current.revision, 4); assert.equal(current.config.prefix, '!')
    assert.deepEqual(current.config.commands.tag, { ...legacy.commands.hidetag, permission: 'owner' })
    assert.equal(current.config.commands.hidetag, undefined)
    assert.equal(Object.keys(current.config.commands).length, 23)
    assert.equal(f.store.settings(otherWorkspace, accountId).config.commands.tag.enabled, false)
    assert.deepEqual(f.store.statistics(workspace, accountId), [{ command: 'tag', successes: 2, failures: 1 }])
    assert.equal(connection.prepare('SELECT config FROM bot_command_settings').get().config, JSON.stringify(legacy))
    const saved = f.store.saveSettings(workspace, accountId, current.config, current.revision)
    assert.deepEqual(saved.config.commands.tag, { ...legacy.commands.hidetag, permission: 'owner' })
    const persisted = JSON.parse(connection.prepare('SELECT config FROM bot_command_settings').get().config)
    assert.equal(persisted.commands.hidetag, undefined)
    assert.deepEqual(persisted.commands.tag, { ...legacy.commands.hidetag, permission: 'owner' })
    legacy.commands.tag = { enabled: false, permission: 'admin' }
    connection.prepare('UPDATE bot_command_settings SET config=?').run(JSON.stringify(legacy))
    assert.deepEqual(f.store.settings(workspace, accountId).config.commands.tag, { ...legacy.commands.tag, permission: 'owner' })
  } finally { connection.close() }
})
test('antiword warns and deletes once; warning escalation and dashboard reset are scoped', async t => {
  const f = fixture(t); f.enable('antiword')
  f.store.saveGroup(workspace, accountId, group, { antiword: true, words: ['bad phrase'], action: 'warn-delete', warningThreshold: 2, escalation: 'kick', moderationCooldownSeconds: 10 })
  const message = f.message('BAD   PHRASE'); await f.deliver(message); await f.deliver(message)
  assert.equal(f.store.warnings(workspace, accountId, group)[0].count, 1)
  assert.equal(f.calls.filter(c => c.content?.delete).length, 1)
  f.advance(11000); await f.send('bad phrase'); assert.equal(f.calls.filter(c => c.action === 'remove').length, 1)
  assert.equal(f.store.warnings(otherWorkspace, otherAccount, group).length, 0)
  f.store.resetWarnings(workspace, accountId, group, member); assert.equal(f.store.warnings(workspace, accountId, group).length, 0)
})
test('antiword CRUD requires confirmation and group rules synchronize through SQLite', async t => {
  const f = fixture(t); f.enable('antiword')
  await f.send('.antiword on', { key: ownerKey }); assert.equal(f.store.group(workspace, accountId, group).antiword, true)
  f.advance(); await f.send('.antiword add rude phrase', { key: ownerKey }); assert.deepEqual(f.store.group(workspace, accountId, group).words, ['rude phrase'])
  f.advance(); await f.send('.antiword list', { key: ownerKey }); assert.equal(f.calls.at(-1).content.text, 'rude phrase')
  f.advance(); await f.send('.antiword clear', { key: ownerKey }); assert.equal(f.store.group(workspace, accountId, group).words.length, 1)
  f.advance(); await f.send('.antiword clear confirm', { key: ownerKey }); assert.equal(f.store.group(workspace, accountId, group).words.length, 0)
  f.advance(); await f.send('.antiword add other', { key: ownerKey }); f.advance(); await f.send('.antiword remove other', { key: ownerKey }); assert.equal(f.store.group(workspace, accountId, group).words.length, 0)
  const reader = createCommandStore(f.database); assert.equal(reader.group(workspace, accountId, group).antiword, true); reader.close()
})
test('antilink allow-list matches exact domains/subdomains and catches prefixed bypasses', async t => {
  const f = fixture(t); f.enable('antilink')
  f.store.saveGroup(workspace, accountId, group, { antilink: true, allowedDomains: ['example.com'] })
  await f.send('https://docs.example.com/page'); assert.equal(f.calls.length, 0)
  await f.send('.disabled https://example.com.evil.test/path'); assert.equal(f.calls.length, 0)
  await f.send('https://example.com.evil.test/path'); assert.equal(f.store.warnings(workspace, accountId, group)[0].count, 1)
})
test('antispam exempts administrators, respects thresholds and cooldowns', async t => {
  const f = fixture(t); f.enable('antispam')
  f.store.saveGroup(workspace, accountId, group, { antispam: true, spamRepeatThreshold: 3, moderationCooldownSeconds: 10 })
  for (const text of ['a normal message', 'a different message', 'hello again']) await f.send(text)
  assert.equal(f.calls.length, 0)
  for (let i = 0; i < 4; i++) await f.send('repeat')
  assert.equal(f.store.warnings(workspace, accountId, group)[0].count, 1)
  for (let i = 0; i < 5; i++) await f.send('repeat', { key: { participant: administrator } })
  assert.equal(f.store.warnings(workspace, accountId, group).length, 1)
})
test('welcome uses placeholders and suppresses duplicate events across restart', async t => {
  const f = fixture(t); f.enable('welcome')
  f.store.saveGroup(workspace, accountId, group, { welcome: true, welcomeTemplate: 'Hello {member}, welcome to {group}.' })
  const update = { id: group, action: 'add', participants: [{ id: member }, { id: member }] }
  await f.engine.onEvent(f.socket, accountId, 'group-participants.update', update)
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].content.text, /Test group/)
  await f.restart(); await f.engine.onEvent(f.socket, accountId, 'group-participants.update', update); assert.equal(f.calls.length, 1)
})
test('autoreply is account-specific, ignores outgoing messages and enforces cooldowns', async t => {
  const f = fixture(t); f.enable('autoreply')
  f.configure(c => { c.autoreply = { enabled: true, cooldownSeconds: 10, rules: [{ id: 'rule', trigger: 'hello', reply: '.ping' }] } })
  await f.send('hello', { key: { remoteJid: member } }); assert.equal(f.calls.length, 1)
  await f.send('hello', { key: { remoteJid: member } }); assert.equal(f.calls.length, 1)
  await f.send('.ping', { key: { ...ownerKey, remoteJid: member, id: f.calls[0].options.messageId } }); assert.equal(f.calls.length, 1)
  f.advance(11000); await f.send('hello', { key: { remoteJid: member } }); assert.equal(f.calls.length, 2)
  await f.engine.onEvent(f.socket, otherAccount, 'messages.upsert', { type: 'notify', messages: [f.message('hello', { key: { remoteJid: member } })] }); assert.equal(f.calls.length, 2)
})
test('autoreply command CRUD and rate limits work without loops', async t => {
  const f = fixture(t); f.enable('autoreply')
  await f.send('.autoreply add hello | Welcome', { key: ownerKey }); f.advance()
  await f.send('.autoreply on', { key: ownerKey }); assert.equal(f.store.settings(workspace, accountId).config.autoreply.enabled, true)
  const rule = f.store.settings(workspace, accountId).config.autoreply.rules[0]
  f.advance(); await f.send('.autoreply remove ' + rule.id, { key: ownerKey }); assert.equal(f.store.settings(workspace, accountId).config.autoreply.rules.length, 0)
  f.advance(); f.configure(c => { c.perChatPerMinute = 1 }); await f.send('.ping', { key: ownerKey }); f.advance(); await f.send('.ping', { key: ownerKey }); assert.match(f.calls.at(-1).content.text, /configured command limit/)
})

test('rejected repeats do not consume account/chat allowance for different commands', async t => {
  const f = fixture(t); f.configure(c => { c.perChatPerMinute = 2; c.perAccountPerMinute = 2 })
  await f.send('.ping', { key: ownerKey })
  for (let index = 0; index < 10; index++) await f.send('.ping', { key: ownerKey })
  await f.send('.alive', { key: ownerKey })
  assert.equal(f.calls.filter(call => call.content?.text === 'Pong!').length, 1)
  assert.match(f.calls.at(-1).content.text, /WhatsApp is connected/)
  await f.send('.menu', { key: ownerKey })
  assert.equal(f.calls.some(call => call.content?.text?.startsWith('Bot commands')), false)
})
test('media and Status commands enforce owner permissions and view-once/consent restrictions', async t => {
  const f = fixture(t); f.enable('sticker', 'statussave')
  const image = { imageMessage: { url: 'https://mmg.whatsapp.net/test-only', caption: '.sticker' } }
  await f.send('', { key: ownerKey, message: image }); assert.equal(f.calls.find(c => c.media).media, 'sticker')
  const previous = f.calls.filter(c => c.media).length
  f.advance(); await f.send('', { key: ownerKey, message: { imageMessage: { ...image.imageMessage, viewOnce: true } } }); assert.equal(f.calls.filter(c => c.media).length, previous)
  await f.send('.statussave', { key: ownerKey }); assert.match(f.calls.at(-1).content.text, /consent/)
  f.configure(c => { c.statusSaveConsent = true }); f.advance()
  await f.send('', { key: ownerKey, message: { extendedTextMessage: { text: '.statussave', contextInfo: { remoteJid: 'status@broadcast', quotedMessage: image } } } }); assert.equal(f.calls.filter(c => c.media).at(-1).media, 'statussave')
})
test('settings enforce tenant isolation, optimistic concurrency and reject unknown commands', t => {
  const f = fixture(t); f.configure(c => { c.prefix = '!' })
  assert.equal(f.store.settings(otherWorkspace, accountId).config.prefix, '.')
  assert.equal(f.store.settings(workspace, otherAccount).config.prefix, '.')
  const snapshot = f.store.settings(workspace, accountId); f.configure(c => { c.cooldownSeconds = 7 })
  assert.throws(() => f.store.saveSettings(workspace, accountId, snapshot.config, snapshot.revision), /another device/)
  assert.throws(() => f.configure(c => { c.commands['not-a-command'] = { enabled: true, permission: 'owner' } }), /Invalid command selection/)
  assert.throws(() => validateAccountSettings({ ...accountDefaults(), prefix: '<script>' }), /prefix/)
})

test('retired commands disappear from stored settings, statistics, menus, help and execution', async t => {
  const f = fixture(t), retired = ['removebg', 'ytmp3', 'ytmp4', 'tiktok', 'instagram', 'facebook']
  assert(retired.every(name => !COMMANDS.some(command => command.name === name)))
  const legacy = accountDefaults(); legacy.prefix = '!'; legacy.cooldownSeconds = 17
  for (const name of retired) legacy.commands[name] = { enabled: true, permission: 'owner' }
  const connection = new DatabaseSync(f.database)
  try {
    connection.prepare('INSERT INTO bot_command_settings VALUES(?,?,?,?)').run(workspace, accountId, 1, JSON.stringify(legacy))
    for (const name of retired) f.store.statistic(workspace, accountId, name, true)
    const current = f.store.settings(workspace, accountId)
    assert.equal(current.revision, 1); assert.equal(current.config.cooldownSeconds, 17); assert.equal(current.config.prefix, '!')
    assert.equal(Object.keys(current.config.commands).length, 23)
    assert.deepEqual(current.config.commands.ping, legacy.commands.ping)
    assert.deepEqual(f.store.statistics(workspace, accountId), [])
    assert.equal(Object.keys(JSON.parse(connection.prepare('SELECT config FROM bot_command_settings').get().config).commands).length, 29, 'reading settings does not alter old database data')
    for (const name of retired) {
      const before = f.calls.length
      await f.send('!' + name, { key: ownerKey }); assert.equal(f.calls.length, before)
      f.advance(18000); await f.send('!help ' + name, { key: ownerKey })
      assert.equal(f.calls.at(-1).content.text, 'That command is not recognized.')
    }
    f.advance(18000); await f.send('!menu', { key: ownerKey })
    assert(retired.every(name => !f.calls.at(-1).content.text.includes(name)))
    f.store.saveSettings(workspace, accountId, current.config, current.revision)
    assert.equal(Object.keys(JSON.parse(connection.prepare('SELECT config FROM bot_command_settings').get().config).commands).length, 23)
  } finally { connection.close() }
})
test('phrase matching uses literal Unicode words instead of substrings or executable patterns', () => {
  assert.equal(matchesPhrase('THIS is fine', 'hi'), false)
  assert.equal(matchesPhrase('HI there', 'hi'), true)
  assert.equal(matchesPhrase('A bad   phrase!', 'bad phrase'), true)
  assert.equal(matchesPhrase('a+b is literal', 'a+b'), true)
  assert.equal(matchesPhrase('ab', 'a+b'), false)
  assert.equal(matchesPhrase('ÖRG is here', 'örg'), true)
  assert.equal(unauthorizedLink('https://example.com.evil.test', ['example.com']), true)
  assert.equal(unauthorizedLink('https://sub.example.com/test', ['example.com']), false)
  assert.equal(unauthorizedLink('Contact support@example.com or first.last@sub.example.com'), false)
  assert.equal(unauthorizedLink('Contact support@example.com and visit evil.test'), true)
  assert.equal(unauthorizedLink('https://user@example.com.evil.test', ['example.com']), true)
})

test('multiline replies and welcomes persist while control characters remain rejected', t => {
  const f = fixture(t), reply = 'Hello!\nHow can we help?', welcome = 'Welcome {member}!\nPlease read the rules for {group}.'
  f.configure(c => { c.autoreply.rules = [{ id: 'multiline', trigger: 'hello', reply }] })
  assert.equal(f.store.settings(workspace, accountId).config.autoreply.rules[0].reply, reply)
  f.store.saveGroup(workspace, accountId, group, { welcomeTemplate: welcome })
  assert.equal(f.store.group(workspace, accountId, group).welcomeTemplate, welcome)
  assert.throws(() => validateGroupSettings({ welcomeTemplate: 'bad\u0000value' }), /valid/)
})

test('manual warnings preserve an optional reason for numeric targets and quoted members', async t => {
  const f = fixture(t); f.enable('warn')
  await f.send('.warn ' + member + ' Please avoid repeated adverts.', { key: ownerKey })
  assert.match(f.calls.at(-1).content.text, /Please avoid repeated adverts\./)
  f.advance()
  await f.send('', { key: ownerKey, message: { extendedTextMessage: { text: '.warn Please follow the topic.', contextInfo: { participant: member, quotedMessage: { conversation: 'synthetic' } } } } })
  assert.match(f.calls.at(-1).content.text, /Please follow the topic\./)
  assert.equal(f.store.warnings(workspace, accountId, group)[0].count, 2)
})
