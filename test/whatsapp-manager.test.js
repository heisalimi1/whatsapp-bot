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
    socketFactory({ auth: state }) {
      const socket = { ev: new EventEmitter(), state, pairingCalls: 0,
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
