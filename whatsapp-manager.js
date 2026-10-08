import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys'
import pino from 'pino'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { StatusAudience } from './status-audience.js'

const DATA_FILE = path.resolve('accounts.json')
const DATA_DIR = path.resolve('accounts')
const CODE_TIMEOUT_MS = 25000
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
  return { id, name, phone: phone ? `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}` : '', status, createdAt, updatedAt, lastConnectedAt: lastConnectedAt || null, everConnected: !!everConnected, statusAudience: entry.audience?.summary() || { contactCount: 0, syncedAt: null, syncing: false }, ...(lastError ? { error: lastError } : {}) }
}
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  if (fs.existsSync(DATA_FILE) && fs.lstatSync(DATA_FILE).isSymbolicLink()) throw makeError('Account metadata cannot be a symbolic link.')
  const tmp = `${DATA_FILE}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify([...entries.values()].map(({ id, ownerId, name, phone, createdAt, updatedAt, lastConnectedAt, everConnected, status }) => ({ id, ownerId, name, phone, createdAt, updatedAt, lastConnectedAt, everConnected, status })), null, 2), { mode: 0o600, flag: 'wx' })
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

async function startEntry(entry, { pairing = false } = {}) {
  if (stopping || !entry.wantConnection) throw makeError('WhatsApp connection manager is shutting down.')
  if (entry.starting) return entry.starting
  entry.wantConnection = true
  entry.starting = new Promise(async (resolve, reject) => {
    let settled = false
    const finish = (err, code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      err ? reject(err) : resolve(code)
    }
    const timer = pairing ? setTimeout(() => finish(makeError('Pairing code request timed out. Try again.'), null), CODE_TIMEOUT_MS) : null
    try {
      const root = path.resolve(DATA_DIR), accountDir = path.dirname(entry.authDir), relative = path.relative(root, accountDir)
      if ((fs.existsSync(DATA_DIR) && fs.lstatSync(DATA_DIR).isSymbolicLink()) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw makeError('Invalid WhatsApp session storage directory.')
      let current = root
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part)
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw makeError('Invalid WhatsApp session storage directory.')
      }
      fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 })
      current = root
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part)
        if (fs.lstatSync(current).isSymbolicLink()) throw makeError('Invalid WhatsApp session storage directory.')
      }
      fs.mkdirSync(entry.authDir, { recursive: true, mode: 0o700 })
      secureAuthDirectory(entry.authDir)
      try { entry.audience ||= new StatusAudience(accountDir) } catch { entry.audience = null }
      const { state, saveCreds } = await useMultiFileAuthState(entry.authDir)
      const { version } = await fetchLatestBaileysVersion()
      if (stopping || !entry.wantConnection) { finish(makeError('WhatsApp connection manager is shutting down.'), null); return }
      const sock = makeWASocket({ version, auth: state, browser: Browsers.macOS('Chrome'), logger: pino({ level: 'silent' }) })
      entry.sock = sock
      entry.saveCreds = saveCreds
      entry.pairRequested = false
      const updateContacts = contacts => { try { entry.audience?.updateContacts(contacts) } catch {} }
      sock.ev.on('contacts.upsert', updateContacts)
      sock.ev.on('contacts.update', updateContacts)
      sock.ev.on('messaging-history.set', ({ contacts }) => updateContacts(contacts))
      sock.ev.on('settings.update', ({ setting, value }) => { if (setting === 'statusPrivacy') { try { entry.audience?.updatePrivacy(value) } catch {} } })
      sock.ev.on('lid-mapping.update', ({ lid, pn }) => updateContacts([{ id: lid, phoneNumber: pn }, { id: pn, lid }]))
      sock.ev.on('creds.update', async () => {
        try { await saveCreds(); entry.updatedAt = now(); persist() }
        catch (e) { setStatus(entry, 'authentication_failure', 'Could not save WhatsApp session data') }
      })
      sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr && !state.creds.registered && !entry.pairRequested) {
          entry.pairRequested = true
          try { const code = await sock.requestPairingCode(entry.phone); finish(null, code) }
          catch (e) { entry.pairRequested = false; setStatus(entry, 'authentication_failure', 'WhatsApp could not create a pairing code'); finish(makeError('WhatsApp could not create a pairing code. Please retry.'), null) }
        }
        if (connection === 'connecting') setStatus(entry, entry.retries ? 'reconnecting' : 'connecting')
        if (connection === 'open') {
          entry.retries = 0
          entry.sock = sock
          entry.lastConnectedAt = now()
          entry.everConnected = true
          setStatus(entry, 'connected')
          entry.audience?.sync(sock).catch(() => {})
          Promise.resolve(connectionListener(sock, entry.id)).catch(() => {})
          finish(null, null)
        }
        if (connection === 'close') {
          entry.sock = null
          const code = statusCode(lastDisconnect?.error)
          if (code === DisconnectReason.loggedOut) {
            entry.wantConnection = false
            setStatus(entry, 'logged_out', 'WhatsApp logged this account out. Pair it again to reconnect.')
            finish(makeError('WhatsApp logged this account out. Retry pairing to connect again.'), null)
          } else if (entry.wantConnection && entry.retries < MAX_RETRIES) {
            entry.retries++
            setStatus(entry, 'reconnecting')
            const delay = Math.min(3000 * (2 ** (entry.retries - 1)), 60000)
            clearTimeout(entry.retryTimer)
            entry.retryTimer = setTimeout(() => { entry.starting = null; startEntry(entry).catch(() => {}) }, delay)
            finish(pairing ? makeError('WhatsApp connection closed before pairing completed. Retry to request a new code.') : null, null)
          } else if (!entry.wantConnection) {
            setStatus(entry, 'disconnected')
            finish(null, null)
          } else {
            entry.wantConnection = false
            setStatus(entry, 'disconnected', 'Connection stopped after repeated failures. Reconnect to try again.')
            finish(pairing ? makeError('WhatsApp connection failed before pairing completed.') : null, null)
          }
        }
      })
      if (state.creds.registered) finish(null, null)
    } catch (e) {
      entry.sock = null
      if (stopping || !entry.wantConnection) { finish(makeError('WhatsApp connection manager is shutting down.'), null); return }
      setStatus(entry, 'authentication_failure', 'Could not initialize this WhatsApp session')
      finish(makeError('Could not initialize the WhatsApp session. Check server connectivity and try again.'), null)
    }
  })
  try { return await entry.starting }
  finally { entry.starting = null }
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
      const authDir = ownerId ? path.join(DATA_DIR, ownerId, item.id, 'auth') : path.join(DATA_DIR, item.id, 'auth')
      const entry = { ...item, ownerId, everConnected: item.everConnected !== false, status: 'disconnected', updatedAt: item.updatedAt || now(), authDir, sock: null, retries: 0, wantConnection: !!ownerId }
      entries.set(entry.id, entry)
    }
    for (const entry of entries.values()) {
      if (!entry.ownerId) setStatus(entry, 'disconnected', 'Sign in to finish setting up this WhatsApp account.')
      else if (entry.everConnected) startEntry(entry).catch(() => {})
      else setStatus(entry, 'disconnected', 'Pair this account to connect it to WhatsApp.')
    }
  })()
  return initPromise
}

export async function listAccounts(ownerId) { await loadAccounts(); return [...entries.values()].filter(e => !ownerId || e.ownerId === ownerId).map(publicAccount) }
export async function getAccount(id) { await loadAccounts(); const e = entries.get(id); return e ? publicAccount(e) : null }
export async function ownsAccount(id, ownerId) { await loadAccounts(); return entries.get(id)?.ownerId === ownerId }
export async function getAccountSocket(id) { await loadAccounts(); return entries.get(id)?.status === 'connected' ? entries.get(id).sock : null }
export async function syncAccountContacts(id) {
  const sock = await getAccountSocket(id), entry = entries.get(id)
  if (!sock) throw makeError('Connect this WhatsApp account before syncing its contacts.')
  if (!entry.audience) throw makeError('Could not load this account\'s contact storage. Reconnect WhatsApp and try again.')
  return entry.audience.sync(sock)
}
export async function getAccountStatusAudience(id) {
  const sock = await getAccountSocket(id), entry = entries.get(id)
  if (!sock) throw makeError('Connect this WhatsApp account before posting to Status.')
  if (!entry.audience) throw makeError('Could not load this account\'s contact storage. Reconnect WhatsApp and try again.')
  return entry.audience.audience(sock)
}
export async function getPrimarySocket() {
  await loadAccounts()
  // Stage 2 keeps the existing global automation bound to the first account; Stage 3 can add per-account job ownership.
  const primary = entries.values().next().value
  return primary?.status === 'connected' ? primary.sock : null
}

export async function createAccount({ userId, name, phone }) {
  await loadAccounts()
  if (!/^[a-f0-9-]{36}$/i.test(String(userId || ''))) throw makeError('Sign in again before connecting WhatsApp.')
  const digits = safePhone(phone)
  if (!/^\d{8,15}$/.test(digits)) throw makeError('Enter a valid phone number with country code (8 to 15 digits).')
  if ([...entries.values()].some(e => e.ownerId === userId && e.phone === digits)) throw makeError('An account with this phone number already exists.')
  const id = crypto.randomUUID()
  const safeName = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  const entry = { id, ownerId: userId, name: safeName || `WhatsApp ${digits.slice(-4)}`, phone: digits, status: 'connecting', everConnected: false, createdAt: now(), updatedAt: now(), authDir: path.join(DATA_DIR, userId, id, 'auth'), sock: null, retries: 0, wantConnection: true }
  entries.set(id, entry)
  try { persist(); const code = await startEntry(entry, { pairing: true }); return { account: publicAccount(entry), pairingCode: code || undefined } }
  catch (e) { entry.wantConnection = false; clearTimeout(entry.retryTimer); if (entry.sock) await entry.sock.end(undefined).catch(() => {}); entry.sock = null; setStatus(entry, 'authentication_failure', e.message); throw e }
}

export async function reconnectAccount(id, { pair = false } = {}) {
  await loadAccounts()
  const entry = entries.get(id)
  if (!entry) throw makeError('Account not found.')
  if (entry.status === 'logged_out' && !pair) throw makeError('This account is logged out. Start a new pairing to connect it again.')
  clearTimeout(entry.retryTimer)
  entry.retries = 0
  if (pair && (!entry.everConnected || entry.status === 'logged_out' || entry.status === 'authentication_failure')) {
    entry.wantConnection = false
    clearTimeout(entry.retryTimer)
    if (entry.sock) await entry.sock.end(undefined).catch(() => {})
    entry.sock = null
    const accountDir = path.dirname(entry.authDir)
    fs.rmSync(accountDir, { recursive: true, force: true })
    entry.authDir = path.join(accountDir, 'auth')
    entry.status = 'disconnected'
  }
  const result = await startEntry(entry, { pairing: pair })
  return { account: publicAccount(entry), pairingCode: result || undefined }
}

export async function disconnectAccount(id) {
  await loadAccounts()
  const entry = entries.get(id)
  if (!entry) throw makeError('Account not found.')
  entry.wantConnection = false
  clearTimeout(entry.retryTimer)
  const sock = entry.sock
  entry.sock = null
  if (sock) await sock.end(undefined).catch(() => {})
  setStatus(entry, 'disconnected')
  return publicAccount(entry)
}

export async function removeAccount(id) {
  await loadAccounts()
  const entry = entries.get(id)
  if (!entry) throw makeError('Account not found.')
  entry.wantConnection = false
  clearTimeout(entry.retryTimer)
  if (entry.sock) await entry.sock.logout().catch(() => {})
  const dataDir = path.resolve(DATA_DIR, entry.id)
  const authDir = path.resolve(path.dirname(entry.authDir))
  if (!dataDir.startsWith(`${DATA_DIR}${path.sep}`) || !authDir.startsWith(`${DATA_DIR}${path.sep}`)) throw makeError('Invalid account storage path.')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(authDir, { recursive: true, force: true })
  const userDir = path.dirname(authDir)
  if (userDir !== path.resolve(DATA_DIR) && fs.existsSync(userDir) && fs.readdirSync(userDir).length === 0) fs.rmdirSync(userDir)
  entries.delete(id)
  persist()
  return { ok: true }
}

export async function closeAllAccounts() {
  stopping = true
  for (const entry of entries.values()) {
    entry.wantConnection = false
    clearTimeout(entry.retryTimer)
    try { entry.audience?.flush() } catch {}
    const sock = entry.sock
    entry.sock = null
    if (sock) await sock.end(undefined).catch(() => {})
    if (entry.status !== 'logged_out') setStatus(entry, 'disconnected')
  }
}

export function onAccountConnected(listener) { connectionListener = listener }

export async function claimLegacyAccounts(ownerId) {
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
