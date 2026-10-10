import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createWhatsAppManager } from '../whatsapp-manager.js'

const owner = '11111111-1111-4111-8111-111111111111'
const accountId = '22222222-2222-4222-8222-222222222222'
const other = '33333333-3333-4333-8333-333333333333'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate) { for(let i=0;i<600;i++){if(await predicate())return;await delay(5)}throw new Error('Fixture lifecycle did not settle') }
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-manager-test-'))
  const auth = path.join(root, 'accounts', owner, accountId, 'auth')
  fs.mkdirSync(auth, { recursive: true })
  fs.writeFileSync(path.join(auth, 'creds.json'), JSON.stringify({ registered: true }))
  fs.writeFileSync(path.join(auth, 'session-marker'), 'original-session-fixture')
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify([{ id: accountId, ownerId: owner, phone: '12345678901', name: 'Fixture business', everConnected: true, status: 'connected' }]))
  const sockets = [], authPaths = []
  const dependencies = {
    root, connectionTimeout: 1000, retryDelay: 5,
    async versionProvider() { return { version: [1, 2, 3] } },
    async authStateFactory(dir) {
      authPaths.push(dir)
      const file = path.join(dir, 'creds.json')
      const state = { creds: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { registered: false }, keys: {} }
      return { state, async saveCreds() { fs.writeFileSync(file, JSON.stringify(state.creds)) } }
    },
    socketFactory(options) {
      const { auth: state } = options
      const socket = { ev: new EventEmitter(), state, options, pairingCalls: 0, metadataRequests: 0,
        async groupMetadata(jid) { socket.metadataRequests++; return { id: jid, participants: [] } },
        async groupParticipantsUpdate() { return [{ status: '200' }] },
        async groupSettingUpdate() {},
        async requestPairingCode() { socket.pairingCalls++; return 'TEST-CODE' },
        async end() { socket.ev.emit('connection.update', { connection: 'close' }) },
        async logout() { socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { statusCode: 401 } } }) }
      }
      sockets.push(socket)
      if (!state.creds.registered) setImmediate(() => socket.ev.emit('connection.update', { qr: 'fixture-only' }))
      return socket
    }, ...overrides
  }
  const managers = []
  const make = () => { const manager = createWhatsAppManager(dependencies); managers.push(manager); return manager }
  t.after(async () => { for(const manager of managers)await manager.closeAllAccounts();fs.rmSync(root,{recursive:true,force:true}) })
  return { root, auth, sockets, authPaths, make }
}

test('send metadata is reused while explicit permission queries stay fresh and events invalidate it', async t => {
  const f = fixture(t), manager = f.make(), jid = '120363000000000001@g.us'
  await manager.listAccounts(owner); await until(() => f.sockets.length === 1)
  const socket = f.sockets[0]; socket.ev.emit('connection.update', { connection: 'open' })
  const cached = socket.options.cachedGroupMetadata
  const first = await socket.groupMetadata(jid)
  assert.equal(await cached(jid), first); assert.equal(socket.metadataRequests, 1)
  await socket.groupMetadata(jid)
  assert.equal(socket.metadataRequests, 2, 'administration cannot rely on old cached permissions')
  await Promise.all([cached(jid), cached(jid), cached(jid)])
  assert.equal(socket.metadataRequests, 2)
  for (const event of ['group-participants.update', 'groups.update', 'groups.upsert']) {
    const before = socket.metadataRequests
    socket.ev.emit(event, event === 'group-participants.update' ? { id: jid, action: 'remove', participants: [] } : [{ id: jid }])
    await cached(jid); assert.equal(socket.metadataRequests, before + 1)
  }
  for (const method of ['groupParticipantsUpdate', 'groupSettingUpdate']) {
    const before = socket.metadataRequests
    await socket[method](jid, [], 'remove')
    await cached(jid); assert.equal(socket.metadataRequests, before + 1)
  }
  assert.equal(await cached('status@broadcast'), undefined)
  await manager.disconnectAccount(accountId)
  assert.equal(socket.ev.listenerCount('groups.update'), 0)
  assert.equal(socket.ev.listenerCount('groups.upsert'), 0)
  assert.equal(await cached(jid), undefined, 'closed sockets never reuse metadata or start queries')
})

test('send metadata expires, stays bounded, and concurrent misses share a single query', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock)
  const f = fixture(t), manager = f.make(), jid = '120363000000000001@g.us'
  await manager.listAccounts(owner); await until(() => f.sockets.length === 1)
  const socket = f.sockets[0], cached = socket.options.cachedGroupMetadata
  await Promise.all(Array.from({ length: 10 }, () => cached(jid)))
  assert.equal(socket.metadataRequests, 1)
  clock += 30001; await cached(jid); assert.equal(socket.metadataRequests, 2)
  for (let index = 0; index < 256; index++) await cached(`${120363000001000000n + BigInt(index)}@g.us`)
  const before = socket.metadataRequests
  await cached(jid); assert.equal(socket.metadataRequests, before + 1, 'the oldest group is evicted')
})

test('metadata changed during a query cannot enter the send cache, which is isolated per socket', async t => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers(), sockets = []
  const f = fixture(t, { socketFactory(options) {
    const socket = { ev: new EventEmitter(), options, metadataRequests: 0,
      async groupMetadata(jid) {
        socket.metadataRequests++
        if (sockets.length === 1 && socket.metadataRequests === 1) { started.resolve(); await gate.promise }
        return { id: jid, participants: [] }
      },
      async end() { socket.ev.emit('connection.update', { connection: 'close' }) }
    }
    sockets.push(socket); return socket
  } }), manager = f.make(), jid = '120363000000000001@g.us'
  await manager.listAccounts(owner); await until(() => sockets.length === 1)
  const first = sockets[0]
  const pending = first.options.cachedGroupMetadata(jid)
  await started.promise
  first.ev.emit('groups.update', [{ id: jid }])
  gate.resolve(); assert.equal(await pending, undefined)
  await first.options.cachedGroupMetadata(jid); assert.equal(first.metadataRequests, 2)
  await manager.disconnectAccount(accountId); await manager.reconnectAccount(accountId)
  const second = sockets[1]
  await second.options.cachedGroupMetadata(jid); assert.equal(second.metadataRequests, 1)
  assert.equal(await first.options.cachedGroupMetadata(jid), undefined)
})

test('command event listeners attach once, detach on disconnect, and ignore replaced sockets', async t => {
  const f = fixture(t), manager = f.make(), events = []
  manager.onAccountEvent((socket, id, name, update) => events.push({ socket, id, name, update }))
  await manager.listAccounts(owner); await until(() => f.sockets.length === 1)
  const first = f.sockets[0]
  first.ev.emit('messages.upsert', { type: 'notify', messages: [] })
  await delay(5); assert.equal(events.length, 0, 'Unconnected sockets do not route commands')
  first.ev.emit('connection.update', { connection: 'open' })
  first.ev.emit('connection.update', { connection: 'open' })
  await until(() => events.filter(event => event.name === 'connection.update').length === 2)
  assert.equal(first.ev.listenerCount('messages.upsert'), 1)
  assert.equal(first.ev.listenerCount('group-participants.update'), 1)
  assert.equal(first.ev.listenerCount('messages.update'), 1)
  assert.equal(first.ev.listenerCount('message-receipt.update'), 1)
  first.ev.emit('messages.upsert', { type: 'notify', messages: [] })
  first.ev.emit('group-participants.update', { action: 'add', participants: [] })
  first.ev.emit('messages.update', [])
  first.ev.emit('message-receipt.update', [])
  await until(() => events.filter(event => event.name !== 'connection.update').length === 4)
  assert(events.every(event => event.socket === first && event.id === accountId))
  await manager.disconnectAccount(accountId)
  assert.equal(first.ev.listenerCount('messages.upsert'), 0)
  assert.equal(first.ev.listenerCount('group-participants.update'), 0)
  assert.equal(first.ev.listenerCount('messages.update'), 0)
  assert.equal(first.ev.listenerCount('message-receipt.update'), 0)
  await manager.reconnectAccount(accountId)
  const second = f.sockets[1]; second.ev.emit('connection.update', { connection: 'open' })
  first.ev.emit('messages.upsert', { type: 'notify', messages: [] })
  second.ev.emit('messages.upsert', { type: 'notify', messages: [] })
  await until(() => events.filter(event => event.name !== 'connection.update').length === 5)
  assert.equal(events.filter(event => event.name !== 'connection.update')[4].socket, second)
  assert.equal(second.ev.listenerCount('messages.upsert'), 1)
  assert.equal(second.ev.listenerCount('messages.update'), 1)
  assert.equal(second.ev.listenerCount('message-receipt.update'), 1)
  assert.equal(fs.readFileSync(path.join(f.auth, 'session-marker'), 'utf8'), 'original-session-fixture')
})

test('all devices reuse one registered socket; stale socket events cannot disconnect its replacement', async t => {
  const f=fixture(t),manager=f.make()
  await manager.listAccounts(owner)
  await until(()=>f.sockets.length===1)
  await Promise.all(Array.from({length:20},()=>manager.reconnectAccount(accountId)))
  assert.equal(f.sockets.length,1,'concurrent browser reconnect requests create no duplicate socket')
  f.sockets[0].ev.emit('connection.update',{connection:'open'})
  const laptop=await manager.listAccounts(owner),phone=await manager.listAccounts(owner)
  assert.equal(laptop[0].status,'connected');assert.deepEqual(phone,laptop)
  assert.equal(await manager.ownsAccount(accountId,owner),true)
  assert.equal(await manager.ownsAccount(accountId,other),false)
  assert.deepEqual(await manager.listAccounts(other),[])
  const reused=await manager.reconnectAccount(accountId,{pair:true})
  assert.equal(reused.reused,true);assert.equal(f.sockets.length,1)
  assert.equal(f.sockets[0].pairingCalls,0,'connected accounts never request another pairing code')
  const repeatedCreates=await Promise.all(Array.from({length:20},()=>manager.createAccount({userId:other,workspaceId:owner,name:'Retry',phone:'12345678901'})))
  for(const result of repeatedCreates){assert.equal(result.account.id,accountId);assert.equal(result.reused,true)}
  assert.equal(f.sockets.length,1,'repeated connect form submissions select the shared existing account without duplicate sockets')
  assert.equal((await manager.listAccounts(owner)).length,1)
  await assert.rejects(()=>manager.createAccount({userId:other,workspaceId:other,name:'Duplicate',phone:'12345678901'}),/already configured/)
  await manager.disconnectAccount(accountId)
  await manager.reconnectAccount(accountId)
  assert.equal(f.sockets.length,2)
  f.sockets[1].ev.emit('connection.update',{connection:'open'})
  f.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{statusCode:401}}})
  assert.equal((await manager.getAccount(accountId)).status,'connected','late old close cannot log the new socket out')
  assert.equal(fs.readFileSync(path.join(f.auth,'session-marker'),'utf8'),'original-session-fixture')
})

test('genuine logout pairs once in a new generation, preserves every old auth file, and survives restart', async t => {
  const f=fixture(t),manager=f.make()
  await manager.listAccounts(owner);await until(()=>f.sockets.length===1)
  f.sockets[0].ev.emit('connection.update',{connection:'open'})
  f.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{statusCode:401}}})
  assert.equal((await manager.getAccount(accountId)).requiresPairing,true)
  await assert.rejects(()=>manager.reconnectAccount(accountId),/needs authentication/)
  const results=await Promise.all([manager.reconnectAccount(accountId,{pair:true}),manager.reconnectAccount(accountId,{pair:true}),manager.createAccount({userId:owner,workspaceId:owner,name:'Retry',phone:'12345678901'})])
  assert.equal(results[0].pairingCode,'TEST-CODE');assert.equal(results[1].pairingCode,'TEST-CODE')
  assert.equal(results[2].pairingCode,'TEST-CODE');assert.equal(results[2].account.id,accountId)
  assert.equal(f.sockets.length,2);assert.equal(f.sockets[1].pairingCalls,1)
  assert.notEqual(f.authPaths[1],f.auth)
  assert.equal(fs.readFileSync(path.join(f.auth,'session-marker'),'utf8'),'original-session-fixture')
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.auth,'creds.json'),'utf8')).registered,true)
  f.sockets[1].state.creds.registered=true
  f.sockets[1].ev.emit('creds.update',{})
  f.sockets[1].ev.emit('connection.update',{connection:'open'})
  await manager.closeAllAccounts()
  const restarted=f.make();await restarted.listAccounts(owner);await until(()=>f.sockets.length===3)
  assert.equal(f.authPaths[2],f.authPaths[1],'restart loads the same newly registered auth generation')
  f.sockets[2].ev.emit('connection.update',{connection:'open'})
  assert.equal((await restarted.getAccount(accountId)).status,'connected')
  assert.equal(f.sockets[2].pairingCalls,0)
})

test('transient connection and initialization failures preserve auth and never ask for pairing', async t => {
  const f=fixture(t),manager=f.make()
  await manager.listAccounts(owner);await until(()=>f.sockets.length===1)
  f.sockets[0].ev.emit('connection.update',{connection:'open'})
  f.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{statusCode:408}}})
  await until(()=>f.sockets.length===2)
  f.sockets[1].ev.emit('connection.update',{connection:'open'})
  assert.equal((await manager.getAccount(accountId)).requiresPairing,false)
  assert.equal(f.authPaths[0],f.authPaths[1])
  await manager.closeAllAccounts()
  const failed=fixture(t,{async versionProvider(){throw new Error('fixture-network-unavailable')}})
  const failing=failed.make();await failing.listAccounts(owner)
  await until(async()=> (await failing.getAccount(accountId)).status==='temporarily_unavailable')
  assert.equal((await failing.getAccount(accountId)).requiresPairing,false)
  assert(fs.existsSync(path.join(failed.auth,'session-marker')))
})

test('disconnect during startup cancels socket creation and stays disconnected after restart', async t => {
  let releaseVersion, waiting = false
  const gate = new Promise(resolve => { releaseVersion = resolve })
  const f = fixture(t, { async versionProvider() { waiting = true; await gate; return { version: [1, 2, 3] } } })
  const manager = f.make()
  await manager.listAccounts(owner)
  await until(() => waiting)
  await manager.disconnectAccount(accountId)
  releaseVersion()
  await delay(20)
  assert.equal((await manager.getAccount(accountId)).status, 'disconnected')
  assert.equal(f.sockets.length, 0)
  await manager.closeAllAccounts()
  const restarted = f.make()
  await restarted.listAccounts(owner)
  await delay(20)
  assert.equal(f.sockets.length, 0, 'an intentional disconnect does not reconnect on restart')
  assert(fs.existsSync(path.join(f.auth, 'session-marker')))
})
