import { COMMANDS, COMMAND_BY_NAME, ownerOnly } from './catalog.js'

export const userJid = value => {
  const match = /^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(String(value || ''))
  return match ? `${match[1]}@${match[2]}` : ''
}
export const groupJid = value => /^[0-9-]{5,80}@g\.us$/.test(String(value || ''))
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${label} must be a whole number from ${min} to ${max}.`)
  return value
}
const text = (value, max, label, multiline = false) => {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/
  if (typeof value !== 'string' || !value.trim() || value.length > max || controls.test(value)) throw Error(`Enter a valid ${label}.`)
  return value.trim()
}
export function accountDefaults() {
  return { prefix: '.', commands: Object.fromEntries(COMMANDS.map(c => [c.name, { enabled: c.category === 'Basic', permission: c.permission }])),
    permittedUsers: [], cooldownSeconds: 5, perChatPerMinute: 12, perAccountPerMinute: 60,
    media: { maxBytes: 8 * 1024 * 1024, maxVideoSeconds: 10, timeoutSeconds: 25 },
    autoreply: { enabled: false, cooldownSeconds: 60, rules: [] },
    broadcast: { lists: {}, confirmedConsent: false, confirmationThreshold: 20, delaySeconds: 10 }, statusSaveConsent: false }
}
export function groupDefaults() {
  return { antilink: false, allowedDomains: [], antiword: false, words: [], antispam: false,
    spamWindowSeconds: 15, spamMaxMessages: 8, spamRepeatThreshold: 4, moderationCooldownSeconds: 60,
    exemptAdmins: true, action: 'warn', warningThreshold: 3, escalation: 'none',
    welcome: false, welcomeTemplate: 'Welcome {member} to {group}! Please read the group rules.' }
}
function bool(value, label) { if (typeof value !== 'boolean') throw Error(`Invalid ${label} switch.`); return value }
function array(value, max, label) { if (!Array.isArray(value) || value.length > max) throw Error(`Invalid ${label} list.`); return value }
export function validateAccountSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid command settings.')
  const d = accountDefaults(), value = { ...d, ...input }
  value.prefix = text(value.prefix, 4, 'command prefix')
  if (!/^[.!#/$?+~_-]{1,4}$/.test(value.prefix)) throw Error('Use one to four punctuation characters for the prefix.')
  if (!value.commands || typeof value.commands !== 'object' || Array.isArray(value.commands) || Object.keys(value.commands).some(name => !COMMAND_BY_NAME.has(name))) throw Error('Invalid command selection.')
  value.commands = Object.fromEntries(COMMANDS.map(c => {
    const setting = value.commands[c.name] || d.commands[c.name]
    bool(setting.enabled, 'command')
    if (!['owner', 'admin', 'permitted'].includes(setting.permission)) throw Error('Choose owner, group administrator or permitted users.')
    if (ownerOnly.has(c.name) && setting.permission !== 'owner') throw Error(`${c.name} is restricted to the connected account owner.`)
    return [c.name, { enabled: setting.enabled, permission: setting.permission }]
  }))
  value.permittedUsers = [...new Set(array(value.permittedUsers, 200, 'permitted users').map(v => { const jid = userJid(v); if (!jid) throw Error('Enter valid permitted-user identifiers.'); return jid }))]
  value.cooldownSeconds = integer(value.cooldownSeconds, 1, 3600, 'Command cooldown')
  value.perChatPerMinute = integer(value.perChatPerMinute, 1, 120, 'Chat command limit')
  value.perAccountPerMinute = integer(value.perAccountPerMinute, 1, 300, 'Account command limit')
  const m = { ...d.media, ...value.media }
  value.media = { maxBytes: integer(m.maxBytes, 1024, 16 * 1024 * 1024, 'Media bytes'), maxVideoSeconds: integer(m.maxVideoSeconds, 1, 30, 'Video duration'), timeoutSeconds: integer(m.timeoutSeconds, 5, 60, 'Processing timeout') }
  const a = { ...d.autoreply, ...value.autoreply }
  value.autoreply = { enabled: bool(a.enabled, 'automatic reply'), cooldownSeconds: integer(a.cooldownSeconds, 10, 86400, 'Reply cooldown'),
    rules: array(a.rules, 50, 'reply rules').map(r => ({ id: text(r.id, 40, 'rule ID'), trigger: text(r.trigger, 100, 'trigger'), reply: text(r.reply, 2000, 'reply', true) })) }
  if (new Set(value.autoreply.rules.map(r => r.id)).size !== value.autoreply.rules.length) throw Error('Reply rule IDs must be unique.')
  const b = { ...d.broadcast, ...value.broadcast }, lists = {}
  if (!b.lists || typeof b.lists !== 'object' || Array.isArray(b.lists) || Object.keys(b.lists).length > 50) throw Error('Invalid broadcast recipient lists.')
  for (const [name, ids] of Object.entries(b.lists)) {
    const label = text(name, 80, 'recipient list name')
    if (['__proto__', 'constructor', 'prototype'].includes(label)) throw Error('Choose another list name.')
    lists[label] = [...new Set(array(ids, 500, 'recipients').map(id => text(id, 36, 'recipient ID')))]
  }
  value.broadcast = { lists, confirmedConsent: bool(b.confirmedConsent, 'recipient authorization'), confirmationThreshold: integer(b.confirmationThreshold, 1, 100, 'Broadcast confirmation threshold'), delaySeconds: integer(b.delaySeconds, 5, 3600, 'Broadcast delivery interval') }
  value.statusSaveConsent = bool(value.statusSaveConsent, 'Status permission')
  // Only validated fields are persisted; do not retain arbitrary nested properties.
  return Object.fromEntries(Object.keys(d).map(key => [key, value[key]]))
}
export function validateGroupSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid group command settings.')
  const d = groupDefaults(), v = { ...d, ...input }
  for (const key of ['antilink', 'antiword', 'antispam', 'exemptAdmins', 'welcome']) bool(v[key], key)
  v.allowedDomains = [...new Set(array(v.allowedDomains, 100, 'allowed domains').map(value => {
    const domain = text(value, 253, 'allowed domain').toLowerCase()
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw Error('Use domain names such as example.com, without a URL or wildcard.')
    return domain
  }))]
  v.words = [...new Set(array(v.words, 200, 'prohibited phrases').map(w => text(w, 100, 'prohibited phrase').toLocaleLowerCase()))]
  integer(v.spamWindowSeconds, 5, 120, 'Spam window'); integer(v.spamMaxMessages, 3, 100, 'Message threshold'); integer(v.spamRepeatThreshold, 3, 20, 'Repeated-message threshold')
  integer(v.moderationCooldownSeconds, 10, 3600, 'Moderation cooldown'); integer(v.warningThreshold, 1, 20, 'Warning threshold')
  if (!['warn', 'delete', 'warn-delete'].includes(v.action) || !['none', 'kick'].includes(v.escalation)) throw Error('Choose valid moderation actions.')
  v.welcomeTemplate = text(v.welcomeTemplate, 1000, 'welcome template', true)
  return Object.fromEntries(Object.keys(d).map(key => [key, v[key]]))
}
export function matchesPhrase(message, phrase) {
  // Unicode word boundaries; treat user phrases as literal text, never as regex code.
  const escaped = phrase.toLocaleLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'iu').test(message)
}
export function unauthorizedLink(message, allowed = []) {
  // Remove standalone email addresses before looking for URLs or bare domains.
  // A negative lookbehind alone can still match a suffix such as "example.com".
  const withoutEmails = message.replace(/(?<![^\s<>])[^\s<>@/:]+@(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '')
  const links = withoutEmails.match(/(?:https?:\/\/|www\.)[^\s<>]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>]*)?/gi) || []
  return links.some(link => {
    try { const host = new URL(/^https?:\/\//i.test(link) ? link : 'https://' + link).hostname.toLowerCase(); return !allowed.some(d => host === d || host.endsWith('.' + d)) }
    catch { return true }
  })
}
