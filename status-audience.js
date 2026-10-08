import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ALL_WA_PATCH_NAMES, decodeSyncdSnapshot, extractSyncdPatches } from '@whiskeysockets/baileys'

// Only identifiers and saved-contact flags are stored; contact names are not needed.
export function statusJid(value) {
  const match = /^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(String(value || ''))
  return match ? `${match[1]}@${match[2]}` : ''
}

export class StatusAudience {
  constructor(directory) {
    this.file = path.join(directory, 'status-audience.json')
    this.contacts = new Map()
    this.privacy = null
    this.syncedAt = null
    this.syncing = null
    this.writeTimer = null
    if (fs.existsSync(this.file)) {
      if (fs.lstatSync(this.file).isSymbolicLink()) throw new Error('Invalid contact storage file.')
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const contact of saved.contacts || []) if (statusJid(contact.id)) this.contacts.set(contact.id, contact)
      this.privacy = saved.privacy || null
      this.syncedAt = saved.syncedAt || null
    }
  }

  updateContacts(contacts = []) {
    for (const contact of contacts) {
      const id = statusJid(contact.id)
      if (!id) continue
      const previous = this.contacts.get(id) || { id, saved: false }
      const pn = statusJid(contact.phoneNumber) || (id.endsWith('@s.whatsapp.net') ? id : previous.pn)
      const lid = statusJid(contact.lid) || (id.endsWith('@lid') ? id : previous.lid)
      const saved = Object.hasOwn(contact, 'name') ? !!contact.name : previous.saved
      this.contacts.set(id, { id, pn, lid, saved })
    }
    this.queueWrite()
  }

  updatePrivacy(value) {
    if (!value || ![0, 1, 2, 3].includes(value.mode)) return
    this.privacy = { mode: value.mode, jids: [...new Set((value.userJid || []).map(statusJid).filter(Boolean))] }
    this.queueWrite()
  }

  queueWrite() {
    clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => { try { this.flush() } catch { this.storageError = true } }, 250)
    this.writeTimer.unref()
  }

  flush() {
    clearTimeout(this.writeTimer)
    if (fs.lstatSync(path.dirname(this.file)).isSymbolicLink() ||
        (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink())) throw new Error('Invalid contact storage path.')
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ contacts: [...this.contacts.values()], privacy: this.privacy, syncedAt: this.syncedAt }), { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, this.file)
    this.storageError = false
  }

  summary() {
    return { contactCount: new Set([...this.contacts.values()].filter(c => c.saved).map(c => c.pn || c.lid || c.id)).size, syncedAt: this.syncedAt, syncing: !!this.syncing }
  }

  async sync(socket) {
    if (this.syncing) return this.syncing
    // Read complete snapshots so existing sessions need no reset/re-pair to discover contacts.
    // This deliberately never writes app-state versions or authentication keys.
    this.syncing = (async () => {
      const response = await socket.query({ tag: 'iq', attrs: { xmlns: 'w:sync:app:state', to: 's.whatsapp.net', type: 'set' }, content: [{ tag: 'sync', attrs: {}, content: ALL_WA_PATCH_NAMES.map(name => ({ tag: 'collection', attrs: { name, version: '0', return_snapshot: 'true' } })) }] })
      const collections = await extractSyncdPatches(response, {})
      const getKey = async id => (await socket.authState.keys.get('app-state-sync-key', [id]))[id]
      const mutations = []
      for (const [name, collection] of Object.entries(collections)) {
        if (!collection.snapshot) continue
        const decoded = await decodeSyncdSnapshot(name, collection.snapshot, getKey, undefined, true)
        mutations.push(...Object.values(decoded.mutationMap))
      }
      if (!collections.critical_unblock_low?.snapshot) throw new Error('WhatsApp contacts are still syncing. Please try again shortly.')
      const contacts = []
      for (const { syncAction, index } of mutations) {
        const action = syncAction.value
        const contact = action?.contactAction || action?.lidContactAction
        if (contact) contacts.push({ id: index[1], name: contact.fullName || contact.firstName || contact.username || '', phoneNumber: contact.pnJid, lid: contact.lidJid })
        if (action?.statusPrivacy) this.updatePrivacy(action.statusPrivacy)
      }
      this.contacts.clear()
      this.updateContacts(contacts)
      this.syncedAt = new Date().toISOString()
      this.flush()
      return this.summary()
    })().catch(() => { throw new Error('WhatsApp contacts and Status privacy are still syncing. Please try again shortly.') }).finally(() => { this.syncing = null })
    return this.syncing
  }

  async audience(socket) {
    await this.sync(socket)
    let settings, blocked
    try { [settings, blocked] = await Promise.all([socket.fetchPrivacySettings(true), socket.fetchBlocklist()]) }
    catch { throw new Error('WhatsApp could not load Status privacy. Please try again shortly.') }
    if (settings.status === 'none') throw new Error('Your WhatsApp Status privacy does not allow any viewers.')
    // Custom allow/exclude lists must be synced; never widen an unknown audience.
    let privacy = this.privacy
    if (!privacy && ['contacts', 'all'].includes(settings.status)) privacy = { mode: 2, jids: [] }
    if (!privacy) throw new Error('WhatsApp Status privacy is still syncing. Open Status privacy on your phone, then sync contacts again.')
    if (settings.status === 'contact_blacklist' && privacy.mode !== 1) throw new Error('WhatsApp Status exclusions are still syncing. Please try again shortly.')
    if (['whitelist', 'contacts_whitelist'].includes(settings.status) && ![0, 3].includes(privacy.mode)) throw new Error('WhatsApp Status sharing preferences are still syncing. Please try again shortly.')
    const expand = async values => {
      const result = new Set(values.map(statusJid).filter(Boolean))
      for (const jid of [...result]) {
        const mapping = socket.signalRepository?.lidMapping
        let alias
        try { alias = jid.endsWith('@lid') ? await mapping?.getPNForLID(jid) : await mapping?.getLIDForPN(jid) }
        catch { throw new Error('WhatsApp Status privacy contact mappings are still syncing. Please try again shortly.') }
        if (statusJid(alias)) result.add(statusJid(alias))
        else if (jid.endsWith('@lid') && ![...this.contacts.values()].some(contact => contact.id === jid || contact.lid === jid)) throw new Error('WhatsApp Status privacy contact mappings are still syncing. Please try again shortly.')
      }
      return result
    }
    const excluded = await expand([...blocked, ...(privacy.mode === 1 ? privacy.jids : [])])
    const selected = [0, 3].includes(privacy.mode) ? await expand(privacy.jids) : null
    const audience = new Set()
    for (const contact of this.contacts.values()) {
      const aliases = [contact.id, contact.pn, contact.lid].filter(Boolean)
      if (aliases.some(jid => excluded.has(jid))) continue
      if (selected ? !aliases.some(jid => selected.has(jid)) : !contact.saved) continue
      audience.add(contact.pn || contact.lid || contact.id)
    }
    if (!audience.size) throw new Error('No eligible WhatsApp Status contacts are synced yet. Sync contacts and check Status privacy on your phone.')
    const ownJid = statusJid(socket.user?.id)
    if (ownJid) audience.add(ownJid)
    return [...audience]
  }
}
