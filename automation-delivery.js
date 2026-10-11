/** Keep existing group/contact destinations and the independent Status choice. */
export function normalizeDestinations(data, body) {
  if ((body.toLists !== undefined && !Array.isArray(body.toLists)) ||
      (body.toRecipients !== undefined && !Array.isArray(body.toRecipients)) ||
      (body.toStatus !== undefined && typeof body.toStatus !== 'boolean')) {
    return { error: 'Choose valid delivery destinations.' }
  }
  const toLists = [...new Set(body.toLists || [])]
  const toRecipients = [...new Set(body.toRecipients || [])]
  const toStatus = body.toStatus === true
  if (toLists.some(name => !Object.hasOwn(data.groupLists || {}, name)) ||
      toRecipients.some(id => !(data.recipients || []).some(recipient => recipient.id === id))) {
    return { error: 'A selected group list or contact is no longer available. Refresh and choose again.' }
  }
  if (toLists.some(name => !(data.groupLists[name] || []).length)) return { error: 'Choose group lists containing at least one group.' }
  if (!toLists.length && !toRecipients.length && !toStatus) return { error: 'Choose Groups, WhatsApp Status, or individual contacts.' }
  return { value: { toLists, toRecipients, toStatus } }
}

/** Status posts once per run, as before; repeats apply to groups and contacts. */
export function buildDeliveryPlan(targets, statusRecipients, job, repeat) {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('Repeat count must be between 1 and 100.')
  if (!targets.length && ((job.toLists || []).length || (job.toRecipients || []).length)) {
    throw new Error('No groups or contacts matched this automation. Refresh your groups and check the selected lists.')
  }
  if (!targets.length && !job.toStatus) throw new Error('Choose Groups, WhatsApp Status, or individual contacts.')
  const audience = [...new Set(statusRecipients.map(value => /^\d{8,15}$/.test(String(value)) ? value + '@s.whatsapp.net' : String(value)))]
  if (job.toStatus && (!audience.length || audience.some(jid => !/^\d{5,20}@(s\.whatsapp\.net|lid)$/.test(jid)))) {
    throw new Error('WhatsApp Status contacts are not synced yet. Sync contacts for this account and try again.')
  }
  if (targets.length * repeat + (job.toStatus ? 1 : 0) > 10000) throw new Error('This job exceeds the 10,000 delivery safety limit.')
  const deliveries = []
  for (let r = 0; r < repeat; r++) for (const target of targets) deliveries.push({ ...target, kind: 'message' })
  if (job.toStatus) deliveries.push({ jid: 'status@broadcast', kind: 'status', statusJidList: audience })
  return deliveries
}

export class AutomationDeliveryError extends Error {}

/** Resolve scheduled hidden mentions before recording a send attempt. */
export async function prepareDeliveryContent(socket, delivery, content) {
  const field = typeof content.text === 'string' ? 'text' : typeof content.caption === 'string' ? 'caption' : null
  if (!field || !/(^|\s)\.tag(?=\s|$)/i.test(content[field])) return content
  const cleaned = content[field].replace(/(?<!\S)\.tag(?=\s|$)[ \t]*/gi, '').trim()
  const prepared = { ...content, [field]: cleaned }
  const hasMedia = ['image', 'video', 'audio', 'document', 'sticker'].some(key => content[key] != null)
  if (!cleaned && !hasMedia) throw new AutomationDeliveryError('Add message text or media alongside .tag before sending this automation.')
  // The same saved message can also go to contacts or Status; never mention
  // group members there or publish the automation directive itself.
  if (delivery.kind !== 'message' || !delivery.jid.endsWith('@g.us')) return prepared
  let metadata, timer
  try {
    metadata = await Promise.race([
      Promise.resolve().then(() => socket.groupMetadata(delivery.jid)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('metadata_timeout')), 15000) })
    ])
  } catch {
    throw new AutomationDeliveryError('Could not load group members for .tag. Check the WhatsApp connection and group access before starting a new run.')
  } finally { clearTimeout(timer) }
  if (metadata?.id !== delivery.jid || !Array.isArray(metadata.participants) || !metadata.participants.length || metadata.participants.length > 5000) {
    throw new AutomationDeliveryError('Could not verify group members for .tag. Refresh your groups before starting a new run.')
  }
  const userJid = value => typeof value === 'string' && /^\d{5,20}(?::\d{1,5})?@(s\.whatsapp\.net|lid)$/.test(value) ? value.replace(/:\d+@/, '@') : ''
  const identities = new Map()
  for (const member of metadata.participants) {
    const jid = userJid(member?.id), canonical = userJid(member?.phoneNumber) || jid
    if (jid && canonical && !identities.has(canonical)) identities.set(canonical, jid)
  }
  if (!identities.size) throw new AutomationDeliveryError('No valid group members are available for .tag. Refresh your groups before starting a new run.')
  prepared.mentions = [...new Set(identities.values())]
  return prepared
}

export async function sendDelivery(socket, delivery, content, options) {
  content = await prepareDeliveryContent(socket, delivery, content)
  if (delivery.kind === 'status') {
    const textStyle = typeof content.text === 'string' ? { backgroundColor: '#008069', font: 1 } : {}
    return socket.sendMessage(delivery.jid, content, { ...textStyle, ...options, statusJidList: delivery.statusJidList })
  }
  return options ? socket.sendMessage(delivery.jid, content, options) : socket.sendMessage(delivery.jid, content)
}
