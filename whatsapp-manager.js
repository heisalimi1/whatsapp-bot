import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys'
import pino from 'pino'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { StatusAudience } from './status-audience.js'

export function createWhatsAppManager({ root = process.cwd(), socketFactory = makeWASocket, authStateFactory = useMultiFileAuthState, versionProvider = fetchLatestBaileysVersion, retryDelay = 3000, connectionTimeout = 25000 } = {}) {
const DATA_FILE = path.resolve(root, 'accounts.json')
const DATA_DIR = path.resolve(root, 'accounts')
const CODE_TIMEOUT_MS = connectionTimeout
const MAX_RETRIES = 8

process.umask(0o077)

const entries = new Map()
let initPromise
let connectionListener = () => {}
let stopping = false

function now() { return new Date().toISOString() }
function safePhone(phone) { return String(phone || '').replace(/\D/g, '') }
function publicAccount(entry) {
  const { id, name, phone, status, createdAt, updatedAt, lastConnectedAt, everConnected, lastError } = entry
  return { id, workspaceId: entry.workspaceId, name, phone: phone ? `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}` : '', status, requiresPairing: !!entry.requiresPairing, createdAt, updatedAt, lastConnectedAt: lastConnectedAt || null, everConnected: !!everConnected, statusAudience: entry.audience?.summary() || { contactCount: 0, syncedAt: null, syncing: false }, ...(lastError ? { error: lastError } : {}) }
}
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  if (fs.existsSync(DATA_FILE) && fs.lstatSync(DATA_FILE).isSymbolicLink()) throw makeError('Account metadata cannot be a symbolic link.')
  const tmp = `${DATA_FILE}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify([...entries.values()].map(({ id, ownerId, workspaceId, authGeneration, autoConnect, name, phone, createdAt, updatedAt, lastConnectedAt, everConnected, status, requiresPairing }) => ({ id, ownerId, workspaceId, authGeneration, autoConnect, name, phone, createdAt, updatedAt, lastConnectedAt, everConnected, status, requiresPairing })), null, 2), { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, DATA_FILE)
}
function setStatus(entry, status, error) {
  entry.status = status
  entry.updatedAt = now()
  entry.lastError = error || ''
  persist()
}
function makeError(message) { return new Error(message) }
function statusCode(err) { return err?.output?.statusCode ?? err?.statusCode }
function setPrivateMode(file, mode) { if (process.platform !== 'win32') fs.chmodSync(file, mode) }
function secureAuthDirectory(dir) {
  const accountDir = path.dirname(dir)
  if (fs.lstatSync(accountDir).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) throw makeError('Invalid WhatsApp session storage directory.')
  setPrivateMode(accountDir, 0o700)
  setPrivateMode(dir, 0o700)
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name)
    if (item.isSymbolicLink()) throw makeError('Symbolic links are not allowed in WhatsApp session storage.')
    if (item.isDirectory()) secureAuthDirectory(file)
    else if (item.isFile()) setPrivateMode(file, 0o600)
  }
}

async function endSocket(entry, { logout = false } = {}) {
  clearTimeout(entry.connectTimer)
  entry.cancelPair?.(makeError('WhatsApp connection was stopped. Your session files are preserved.'))
  entry.cancelPair = null
  const socket = entry.sock
  entry.sock = null
  entry.pairCode = ''
  if (socket) {
    if (logout) { try { await socket.logout() } catch {} }
    try { await socket.end(undefined) } catch {}
  }
}
function retryEntry(entry) {
  if (stopping || !entry.wantConnection) return
  if (++entry.retries > MAX_RETRIES) {
    entry.wantConnection = false
    setStatus(entry, 'temporarily_unavailable', 'WhatsApp is temporarily unavailable. Your saved session is preserved; try Reconnect.')
    return
  }
  setStatus(entry, 'reconnecting')
  clearTimeout(entry.retryTimer)
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null
    startEntry(entry).catch(() => {})
  }, Math.min(retryDelay * 2 ** (entry.retries - 1), 60000))
}
async function pairingCode(entry, socket) {
  if (entry.pairCode && Date.now() - entry.pairCodeAt < 120000) return entry.pairCode
  if (entry.pairRequest) return entry.pairRequest
  entry.pairRequest = socket.requestPairingCode(entry.phone).then(code => {
    if (entry.sock !== socket) throw makeError('Connection changed while pairing. Try again.')
    entry.pairCode = code
    entry.pairCodeAt = Date.now()
    return code
  }).finally(() => { entry.pairRequest = null })
  return entry.pairRequest
}
async function startEntry(entry, { pairing = false } = {}) {
  if (stopping || !entry.wantConnection) throw makeError('WhatsApp connection manager is not starting this account.')
  if (entry.starting) return entry.starting
  if (entry.sock) return pairing && !entry.authState?.creds.registered ? pairingCode(entry, entry.sock) : null
  const operation = (async () => {
    await entry.savePromise
    const root = path.resolve(DATA_DIR), accountDir = path.dirname(entry.authDir), relative = path.relative(root, accountDir)
    if ((fs.existsSync(DATA_DIR) && fs.lstatSync(DATA_DIR).isSymbolicLink()) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw makeError('Invalid WhatsApp session storage directory.')
    let current = root
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part)
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw makeError('Invalid WhatsApp session storage directory.')
    }
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(entry.authDir, { recursive: true, mode: 0o700 })
    secureAuthDirectory(entry.authDir)
    try { entry.audience ||= new StatusAudience(entry.storageDir) } catch { entry.audience = null }
    const { state, saveCreds } = await authStateFactory(entry.authDir)
    entry.authState = state
    if (!state.creds.registered && !pairing) {
      entry.requiresPairing = true
      entry.wantConnection = false
      entry.autoConnect = false
      setStatus(entry, 'logged_out', 'This WhatsApp session needs authentication. Request a pairing code.')
      throw makeError('This WhatsApp session needs authentication.')
    }
    const { version } = await versionProvider()
    if (stopping || !entry.wantConnection) throw makeError('WhatsApp connection manager is shutting down.')
    const socket = socketFactory({ version, auth: state, browser: Browsers.macOS('Chrome'), logger: pino({ level: 'silent' }) })
    entry.sock = socket
    entry.requiresPairing = !state.creds.registered
    setStatus(entry, entry.retries ? 'reconnecting' : 'connecting')
    let resolvePair, rejectPair
    const pairReady = pairing && !state.creds.registered ? new Promise((resolve, reject) => { resolvePair = resolve; rejectPair = reject }) : null
    entry.cancelPair = rejectPair
    // A readiness promise is distinct from the live socket guard: registered sockets
    // are reused even after the HTTP response has returned.
    const updateContacts = contacts => { if (entry.sock === socket) { try { entry.audience?.updateContacts(contacts) } catch {} } }
    socket.ev.on('contacts.upsert', updateContacts)
    socket.ev.on('contacts.update', updateContacts)
    socket.ev.on('messaging-history.set', ({ contacts }) => updateContacts(contacts))
    socket.ev.on('settings.update', ({ setting, value }) => { if (entry.sock === socket && setting === 'statusPrivacy') { try { entry.audience?.updatePrivacy(value) } catch {} } })
    socket.ev.on('lid-mapping.update', ({ lid, pn }) => updateContacts([{ id: lid, phoneNumber: pn }, { id: pn, lid }]))
    socket.ev.on('creds.update', () => {
      if (entry.sock !== socket) return
      entry.savePromise = (entry.savePromise || Promise.resolve()).then(async () => {
        await saveCreds()
        entry.updatedAt = now()
        persist()
      }).catch(() => { if (entry.sock === socket) setStatus(entry, 'temporarily_unavailable', 'Could not save WhatsApp session data. Your existing session files are preserved.') })
    })
    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (entry.sock !== socket || stopping) return
      if (qr && pairReady) {
        try { resolvePair(await pairingCode(entry, socket)) }
        catch { rejectPair(makeError('WhatsApp could not create a pairing code. Please retry.')) }
      }
      if (connection === 'connecting') setStatus(entry, entry.retries ? 'reconnecting' : 'connecting')
      if (connection === 'open') {
        clearTimeout(entry.connectTimer)
        entry.retries = 0
        entry.requiresPairing = false
        entry.autoConnect = true
        entry.lastConnectedAt = now()
        entry.everConnected = true
        entry.pairCode = ''
        setStatus(entry, 'connected')
        entry.audience?.sync(socket).catch(() => {})
        Promise.resolve(connectionListener(socket, entry.id)).catch(() => {})
        resolvePair?.(null)
      }
      if (connection === 'close') {
        clearTimeout(entry.connectTimer)
        entry.sock = null
        entry.pairCode = ''
        const code = statusCode(lastDisconnect?.error)
        if (code === DisconnectReason.loggedOut) {
          entry.wantConnection = false
          entry.autoConnect = false
          entry.requiresPairing = true
          setStatus(entry, 'logged_out', 'WhatsApp logged this account out. Request a new pairing code to connect it again.')
          rejectPair?.(makeError('WhatsApp logged this account out.'))
        } else if (entry.wantConnection) {
          rejectPair?.(makeError('WhatsApp connection changed during pairing. Retry to request its current code.'))
          retryEntry(entry)
        } else setStatus(entry, 'disconnected')
      }
    })
    entry.connectTimer = setTimeout(async () => {
      if (entry.sock !== socket || entry.status === 'connected') return
      rejectPair?.(makeError('WhatsApp connection timed out. Your session data is preserved; please retry.'))
      await endSocket(entry)
      retryEntry(entry)
    }, CODE_TIMEOUT_MS)
    entry.connectTimer.unref?.()
    return pairReady ? await pairReady : null
  })()
  entry.starting = operation
  try { return await operation }
  catch (error) {
    if (entry.wantConnection && !stopping && !entry.sock && entry.status !== 'logged_out' && !entry.retryTimer) retryEntry(entry)
    throw error
  } finally { if (entry.starting === operation) entry.starting = null }
}

async function loadAccounts() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(DATA_DIR).isSymbolicLink()) throw makeError('Account storage root cannot be a symbolic link.')
    setPrivateMode(DATA_DIR, 0o700)
    if (!fs.existsSync(DATA_FILE)) return
    setPrivateMode(DATA_FILE, 0o600)
    let data
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }
    catch { throw makeError('Account metadata is corrupt. Back up and repair accounts.json before starting.') }
    for (const item of data) {
      if (!item?.id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.id) || !/^\d{8,15}$/.test(item.phone)) continue
      const ownerId = /^[a-f0-9-]{36}$/i.test(item.ownerId || '') ? item.ownerId : ''
      const workspaceId = /^[a-f0-9-]{36}$/i.test(item.workspaceId || '') ? item.workspaceId : ownerId
      const storageDir = ownerId ? path.join(DATA_DIR, ownerId, item.id) : path.join(DATA_DIR, item.id)
      const authGeneration = /^[a-f0-9-]{36}$/i.test(item.authGeneration || '') ? item.authGeneration : ''
      const authDir = authGeneration ? path.join(storageDir, 'sessions', authGeneration, 'auth') : path.join(storageDir, 'auth')
      const requiresPairing = item.requiresPairing === true || item.status === 'logged_out' || item.everConnected === false
      const autoConnect = item.autoConnect !== false && !!workspaceId && !requiresPairing
      const entry = { ...item, ownerId, workspaceId, storageDir, authGeneration, requiresPairing, autoConnect, everConnected: item.everConnected !== false, status: requiresPairing ? 'logged_out' : 'disconnected', updatedAt: item.updatedAt || now(), authDir, sock: null, retries: 0, wantConnection: autoConnect }
      entries.set(entry.id, entry)
    }
    for (const entry of entries.values()) {
      if (!entry.ownerId) setStatus(entry, 'disconnected', 'Sign in to finish setting up this WhatsApp account.')
      else if (entry.autoConnect) startEntry(entry).catch(() => {})
      else if (entry.requiresPairing) setStatus(entry, 'logged_out', 'This WhatsApp session needs authentication. Request a pairing code.')
      else setStatus(entry, 'disconnected')
    }
  })()
  return initPromise
}

async function listAccounts(workspaceId) { await loadAccounts(); return [...entries.values()].filter(e => !workspaceId || e.workspaceId === workspaceId).map(publicAccount) }
async function getAccount(id) { await loadAccounts(); const e = entries.get(id); return e ? publicAccount(e) : null }
async function ownsAccount(id, workspaceId) { await loadAccounts(); return !!workspaceId && entries.get(id)?.workspaceId === workspaceId }
async function getAccountSocket(id) { await loadAccounts(); return entries.get(id)?.status === 'connected' ? entries.get(id).sock : null }
async function syncAccountContacts(id) {
  const sock = await getAccountSocket(id), entry = entries.get(id)
  if (!sock) throw makeError('Connect this WhatsApp account before syncing its contacts.')
  if (!entry.audience) throw makeError('Could not load this account\'s contact storage. Reconnect WhatsApp and try again.')
  return entry.audience.sync(sock)
}
async function getAccountStatusAudience(id) {
  const sock = await getAccountSocket(id), entry = entries.get(id)
  if (!sock) throw makeError('Connect this WhatsApp account before posting to Status.')
  if (!entry.audience) throw makeError('Could not load this account\'s contact storage. Reconnect WhatsApp and try again.')
  return entry.audience.audience(sock)
}
async function getPrimarySocket() {
  await loadAccounts()
  // Stage 2 keeps the existing global automation bound to the first account; Stage 3 can add per-account job ownership.
  const primary = entries.values().next().value
  return primary?.status === 'connected' ? primary.sock : null
}

async function createAccount({ userId, workspaceId = userId, name, phone }) {
  await loadAccounts()
  if (!/^[a-f0-9-]{36}$/i.test(String(userId || ''))) throw makeError('Sign in again before connecting WhatsApp.')
  if (!/^[a-f0-9-]{36}$/i.test(String(workspaceId || ''))) throw makeError('Choose a valid business workspace.')
  const digits = safePhone(phone)
  if (!/^\d{8,15}$/.test(digits)) throw makeError('Enter a valid phone number with country code (8 to 15 digits).')
  const existing = [...entries.values()].find(e => e.phone === digits)
  if (existing) {
    if (existing.workspaceId !== workspaceId) throw makeError('This number is already configured. Use its existing account instead of pairing it twice.')
    return { ...await reconnectAccount(existing.id, { pair: existing.requiresPairing }), reused: true }
  }
  const id = crypto.randomUUID()
  const safeName = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  const storageDir = path.join(DATA_DIR, userId, id)
  const entry = { id, ownerId: userId, workspaceId, storageDir, name: safeName || `WhatsApp ${digits.slice(-4)}`, phone: digits, status: 'connecting', requiresPairing: true, autoConnect: true, everConnected: false, createdAt: now(), updatedAt: now(), authDir: path.join(storageDir, 'auth'), sock: null, retries: 0, wantConnection: true }
  entries.set(id, entry)
  try { persist(); const code = await startEntry(entry, { pairing: true }); return { account: publicAccount(entry), pairingCode: code || undefined } }
  catch (e) { entry.wantConnection = false; entry.autoConnect = false; clearTimeout(entry.retryTimer); await endSocket(entry); setStatus(entry, 'temporarily_unavailable', 'WhatsApp could not connect. Existing authentication files are preserved.'); throw e }
}

async function reconnectAccount(id, { pair = false } = {}) {
  await loadAccounts()
  const entry = entries.get(id)
  if (!entry) throw makeError('Account not found.')
  if (entry.reconnectPromise) return entry.reconnectPromise
  if (entry.requiresPairing && !pair) throw makeError('This session needs authentication. Request a pairing code.')
  const operation = (async () => {
    if (entry.status === 'connected' && entry.sock) return { account: publicAccount(entry), reused: true }
    clearTimeout(entry.retryTimer)
    entry.retries = 0
    // Only a genuine logout with registered old credentials gets a new generation.
    // The previous auth directory is kept in place, including every session file.
    if (pair && entry.requiresPairing && !entry.sock) {
      let registered = false
      const creds = path.join(entry.authDir, 'creds.json')
      if (fs.existsSync(creds)) {
        if (fs.lstatSync(creds).isSymbolicLink()) throw makeError('Invalid WhatsApp session storage file.')
        try { registered = JSON.parse(fs.readFileSync(creds, 'utf8')).registered === true } catch { throw makeError('Session credentials could not be read. Existing files are preserved.') }
      }
      if (registered) {
        entry.authGeneration = crypto.randomUUID()
        entry.authDir = path.join(entry.storageDir, 'sessions', entry.authGeneration, 'auth')
        entry.audience = null
      }
    }
    entry.wantConnection = true
    entry.autoConnect = true
    persist()
    const result = await startEntry(entry, { pairing: pair && entry.requiresPairing })
    return { account: publicAccount(entry), pairingCode: result || undefined }
  })()
  entry.reconnectPromise = operation
  try { return await operation } finally { if (entry.reconnectPromise === operation) entry.reconnectPromise = null }
}

async function disconnectAccount(id) {
  await loadAccounts()
  const entry = entries.get(id)
  if (!entry) throw makeError('Account not found.')
  entry.wantConnection = false
  entry.autoConnect = false
  clearTimeout(entry.retryTimer)
  await endSocket(entry)
  setStatus(entry, 'disconnected')
  return publicAccount(entry)
}

async function removeAccount(id) {
  await loadAccounts()
  const entry = entries.get(id)
  if (!entry) throw makeError('Account not found.')
  entry.wantConnection = false
  clearTimeout(entry.retryTimer)
  await endSocket(entry, { logout: true })
  await entry.savePromise
  const dataDir = path.resolve(DATA_DIR, entry.id)
  const authDir = path.resolve(entry.storageDir)
  if (!dataDir.startsWith(`${DATA_DIR}${path.sep}`) || !authDir.startsWith(`${DATA_DIR}${path.sep}`)) throw makeError('Invalid account storage path.')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(authDir, { recursive: true, force: true })
  const userDir = path.dirname(authDir)
  if (userDir !== path.resolve(DATA_DIR) && fs.existsSync(userDir) && fs.readdirSync(userDir).length === 0) fs.rmdirSync(userDir)
  entries.delete(id)
  persist()
  return { ok: true }
}

async function closeAllAccounts() {
  stopping = true
  for (const entry of entries.values()) {
    entry.wantConnection = false
    clearTimeout(entry.retryTimer)
    clearTimeout(entry.connectTimer)
    try { entry.audience?.flush() } catch {}
    await entry.savePromise
    await endSocket(entry)
    if (entry.status !== 'logged_out') setStatus(entry, 'disconnected')
  }
}

function onAccountConnected(listener) { connectionListener = listener }

async function claimLegacyAccounts(ownerId) {
  await loadAccounts()
  if (!/^[a-f0-9-]{36}$/i.test(String(ownerId || ''))) throw makeError('Invalid account owner.')
  if (fs.existsSync(DATA_DIR) && fs.lstatSync(DATA_DIR).isSymbolicLink()) throw makeError('Account storage root cannot be a symbolic link.')
  let claimed = 0
  for (const entry of entries.values()) {
    if (entry.ownerId) continue
    const oldDir = path.join(DATA_DIR, entry.id)
    const ownerDir = path.join(DATA_DIR, ownerId), nextDir = path.join(ownerDir, entry.id)
    const oldAuth = path.join(oldDir, 'auth'), nextAuth = path.join(nextDir, 'auth')
    for (const directory of [oldDir, oldAuth, ownerDir, nextDir, nextAuth]) {
      if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw makeError('Invalid WhatsApp session storage directory.')
    }
    fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(nextDir, { recursive: true, mode: 0o700 })
    if (fs.existsSync(oldAuth) && !fs.existsSync(nextAuth)) fs.renameSync(oldAuth, nextAuth)
    entry.ownerId = ownerId
    entry.workspaceId = ownerId
    entry.storageDir = nextDir
    entry.authDir = nextAuth
    entry.wantConnection = true
    entry.status = 'disconnected'
    entry.lastError = ''
    claimed++
  }
  if (claimed) persist()
  for (const entry of entries.values()) if (entry.ownerId === ownerId && entry.everConnected) startEntry(entry).catch(() => {})
  return claimed
}

return { listAccounts, getAccount, ownsAccount, getAccountSocket, syncAccountContacts, getAccountStatusAudience, getPrimarySocket, createAccount, reconnectAccount, disconnectAccount, removeAccount, closeAllAccounts, onAccountConnected, claimLegacyAccounts };
}
const manager = createWhatsAppManager();
export const { listAccounts, getAccount, ownsAccount, getAccountSocket, syncAccountContacts, getAccountStatusAudience, getPrimarySocket, createAccount, reconnectAccount, disconnectAccount, removeAccount, closeAllAccounts, onAccountConnected, claimLegacyAccounts } = manager;
