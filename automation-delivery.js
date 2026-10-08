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

export function sendDelivery(socket, delivery, content) {
  if (delivery.kind === 'status') return socket.sendMessage(delivery.jid, content, { statusJidList: delivery.statusJidList })
  return socket.sendMessage(delivery.jid, content)
}
