import crypto from 'node:crypto'
import { COMMANDS, COMMAND_BY_NAME, adminActions } from './catalog.js'
import { userJid, groupJid, matchesPhrase, unauthorizedLink } from './settings.js'
import { containsViewOnce, mediaFrom, MediaError, BoundedQueue } from './media.js'

export class CommandError extends Error {}
const timeout = (promise, milliseconds = 20000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new CommandError('WhatsApp did not confirm the request. It will not be retried automatically.')), milliseconds) })]).finally(() => clearTimeout(timer))
}
class BoundedMap extends Map {
  constructor(limit = 5000) { super(); this.limit = limit }
  set(key, value) { this.delete(key); super.set(key, value); if (this.size > this.limit) this.delete(this.keys().next().value); return this }
}
function contentOf(message) { return message?.ephemeralMessage?.message || message?.documentWithCaptionMessage?.message || message || {} }
function parseMessage(message) {
  if (containsViewOnce(message.message)) return null
  const body = contentOf(message.message)
  const text = String(body.conversation || body.extendedTextMessage?.text || body.imageMessage?.caption || body.videoMessage?.caption || '').slice(0, 10000)
  const info = Object.values(body).find(value => value && typeof value === 'object' && value.contextInfo)?.contextInfo || {}
  return { text, info, body }
}
export function createCommandEngine({ store, getAccount, getSocket, media, services, now = Date.now, log = () => {} }) {
  const queue = new BoundedQueue(4, 64), rates = new BoundedMap(), cooldowns = new BoundedMap(), spam = new BoundedMap(), serial = new Map()
  let stopped = false
  function allow(key, limit, window) {
    const times = (rates.get(key) || []).filter(time => now() - time < window)
    if (times.length >= limit) return false
    times.push(now()); rates.set(key, times); return true
  }
  function cooldown(key, seconds) { if (now() - (cooldowns.get(key) || 0) < seconds * 1000) return false; cooldowns.set(key, now()); return true }
  async function checkedSocket(context) {
    if (stopped || await getSocket(context.account.id) !== context.socket) throw new CommandError('WhatsApp connection changed. Please try a new command after reconnecting.')
    return context.socket
  }
  async function send(context, content) {
    const socket = await checkedSocket(context), id = crypto.randomUUID().replace(/-/g, '').toUpperCase()
    // Claim outgoing identifiers before sending; delivery echoes cannot execute commands.
    store.claim(context.account.workspaceId, context.account.id, `message:${context.chat}:${id}`)
    return timeout(socket.sendMessage(context.chat, content, { messageId: id }))
  }
  const reply = (context, text) => send(context, { text: String(text).slice(0, 12000) })
  async function aliases(socket, jid) {
    const value = userJid(jid), set = new Set(value ? [value] : [])
    if (!value) return set
    try {
      const mapping = socket.signalRepository?.lidMapping
      const other = value.endsWith('@lid') ? await timeout(Promise.resolve(mapping?.getPNForLID?.(value)), 3000) : await timeout(Promise.resolve(mapping?.getLIDForPN?.(value)), 3000)
      if (userJid(other)) set.add(userJid(other))
    } catch { /* Fail closed when an alias cannot be verified. */ }
    return set
  }
  async function metadata(context) {
    if (!groupJid(context.chat)) throw new CommandError('This command is available in WhatsApp groups only.')
    if (!context.metadata) {
      await checkedSocket(context)
      try { context.metadata = await timeout(context.socket.groupMetadata(context.chat)) }
      catch { throw new CommandError('Could not verify this group’s current participants and permissions.') }
      if (!context.metadata || context.metadata.id !== context.chat || !Array.isArray(context.metadata.participants) || context.metadata.participants.length > 5000) throw new CommandError('Could not verify this group.')
    }
    return context.metadata
  }
  function participant(context, identities) {
    return context.metadata.participants.find(member => [member.id, member.phoneNumber, member.lid].map(userJid).some(jid => jid && identities.has(jid)))
  }
  const admin = member => !!member && (['admin', 'superadmin'].includes(member.admin) || member.isAdmin === true || member.isSuperAdmin === true)
  async function permissions(context) {
    if (!groupJid(context.chat)) return { senderAdmin: false, botAdmin: false }
    await metadata(context)
    const sender = participant(context, await aliases(context.socket, context.sender))
    const self = new Set([userJid(context.socket.user?.id), userJid(context.socket.user?.lid)].filter(Boolean))
    for (const value of await aliases(context.socket, context.socket.user?.id)) self.add(value)
    const bot = participant(context, self)
    if (!bot || !sender) throw new CommandError('Group membership could not be verified.')
    return { senderAdmin: admin(sender), botAdmin: admin(bot), sender, bot }
  }
  async function requireAdmin(context, botRequired = false) {
    const permission = await permissions(context)
    if (!permission.senderAdmin) throw new CommandError('Only a current group administrator can use this command.')
    if (botRequired && !permission.botAdmin) throw new CommandError('Make the connected WhatsApp account a group administrator before using this command.')
    return permission
  }
  async function target(context, argument) {
    await metadata(context)
    const candidates = context.info.mentionedJid?.length ? context.info.mentionedJid : context.info.participant ? [context.info.participant] : [argument.split(/\s+/)[0]]
    if (candidates.length !== 1) throw new CommandError('Select exactly one member using a mention, reply or member identifier.')
    const value = String(candidates[0] || ''), jid = userJid(value) || (/^\+?\d{8,15}$/.test(value) ? value.replace(/^\+/, '') + '@s.whatsapp.net' : '')
    if (!jid) throw new CommandError('Mention or reply to a valid current group member.')
    const member = participant(context, await aliases(context.socket, jid))
    if (!member) throw new CommandError('That member is not in this group.')
    const self = new Set([userJid(context.socket.user?.id), userJid(context.socket.user?.lid)].filter(Boolean))
    for (const value of await aliases(context.socket, context.socket.user?.id)) self.add(value)
    if ([member.id, member.phoneNumber, member.lid].map(userJid).some(j => self.has(j)) || member.admin === 'superadmin' || member.isSuperAdmin) throw new CommandError('The connected account and group owner cannot be targeted.')
    return member
  }
  async function updateParticipant(context, member, action) {
    await checkedSocket(context)
    let result
    try { result = await timeout(context.socket.groupParticipantsUpdate(context.chat, [member.id], action)) }
    catch { throw new CommandError('WhatsApp did not complete the member change. Check group permissions before trying a new command.') }
    if (!Array.isArray(result) || !result.length || result.some(item => String(item.status) !== '200')) throw new CommandError('WhatsApp rejected the member change. Check the member’s current permissions.')
  }
  async function warn(context, member, reason, group) {
    const memberId = userJid(member.phoneNumber) || userJid(member.id)
    const count = store.warn(context.account.workspaceId, context.account.id, context.chat, memberId)
    await send(context, { text: `Warning ${count}/${group.warningThreshold}: ${reason}`, mentions: [member.id] })
    if (count >= group.warningThreshold && group.escalation === 'kick' && !admin(member)) {
      const p = await permissions(context)
      if (!p.botAdmin) { await reply(context, 'The warning limit was reached, but removal needs the connected account to be a group administrator.'); return }
      await updateParticipant(context, member, 'remove')
    }
  }
  function settingsFor(context) { return store.settings(context.account.workspaceId, context.account.id) }
  function groupFor(context) { return store.group(context.account.workspaceId, context.account.id, context.chat) }
  function saveGroup(context, value) { return store.saveGroup(context.account.workspaceId, context.account.id, context.chat, value) }
  function saveSettings(context, mutate) {
    const { config, revision } = settingsFor(context); mutate(config)
    return store.saveSettings(context.account.workspaceId, context.account.id, config, revision)
  }
  async function execute(context, name, argument) {
    const config = context.config, definition = COMMAND_BY_NAME.get(name)
    if (name === 'menu' || name === 'help') {
      if (name === 'help' && argument) {
        const requested = COMMAND_BY_NAME.get(argument.replace(config.prefix, '').toLowerCase())
        if (!requested) throw new CommandError('That command is not recognized.')
        await reply(context, `${requested.description}\nUsage: ${config.prefix}${requested.usage}\n${config.commands[requested.name].enabled ? 'Enabled' : 'Disabled by the account owner'}`)
      } else await reply(context, 'Bot commands\n' + COMMANDS.filter(c => config.commands[c.name].enabled).map(c => `${config.prefix}${c.name} — ${c.description}`).join('\n') + '\nUse ' + config.prefix + 'help <command> for instructions.')
      return
    }
    if (name === 'ping') return reply(context, 'Pong!')
    if (name === 'alive') return reply(context, 'WhatsApp is connected. Bot commands run on the server, even when the dashboard is closed.')
    if (definition.category === 'Group Administration') {
      await metadata(context)
      if (adminActions.has(name)) await requireAdmin(context, ['kick', 'promote', 'demote', 'mute', 'unmute'].includes(name))
      if (name === 'tagall' || name === 'tag') {
        if (name === 'tag' && !argument) throw new CommandError(`Usage: ${config.prefix}tag <message>`)
        const identities = new Map()
        for (const member of context.metadata.participants) {
          const jid = userJid(member.id), canonical = userJid(member.phoneNumber) || jid
          if (jid && canonical && !identities.has(canonical)) identities.set(canonical, jid)
        }
        const members = [...identities.values()]
        if (name === 'tag') {
          // Hidden mentions share one message, regardless of the group size.
          // The persistent incoming receipt prevents replay after reconnect/restart.
          await send(context, { text: argument, mentions: members })
        } else for (let offset = 0; offset < members.length; offset += 100) {
          // Visible member lists remain bounded to keep each text readable.
          const batch = members.slice(offset, offset + 100)
          await send(context, { text: (argument ? argument + '\n' : '') + batch.map(jid => '@' + jid.split('@')[0]).join(' '), mentions: batch })
        }
      } else if (['kick', 'promote', 'demote'].includes(name)) {
        const member = await target(context, argument)
        if (name === 'kick' && admin(member)) throw new CommandError('Demote an administrator before removing them.')
        await updateParticipant(context, member, { kick: 'remove', promote: 'promote', demote: 'demote' }[name]); await reply(context, 'Member permissions updated.')
      } else if (name === 'mute' || name === 'unmute') {
        await checkedSocket(context)
        try { await timeout(context.socket.groupSettingUpdate(context.chat, name === 'mute' ? 'announcement' : 'not_announcement')) }
        catch { throw new CommandError('WhatsApp could not change group messaging permissions.') }
        await reply(context, name === 'mute' ? 'Only administrators can send group messages.' : 'All group members can send messages.')
      } else if (name === 'warn') {
        const member = await target(context, argument)
        if (admin(member)) throw new CommandError('Administrators are not automatically escalated. Review their permissions directly.')
        const tokens = argument.trim().split(/\s+/)
        const first = tokens[0] || ''
        const hasTargetToken = first.startsWith('@') || !!userJid(first) || /^\+?\d{8,15}$/.test(first)
        const reason = (hasTargetToken ? tokens.slice(1).join(' ') : argument.trim()).slice(0, 500)
        await warn(context, member, reason || 'Please follow the group rules.', groupFor(context))
      } else {
        const group = groupFor(context), [operation, ...rest] = argument.split(/\s+/), value = rest.join(' ').trim()
        if (['on', 'off'].includes(operation)) group[name] = operation === 'on'
        else if (name === 'antiword' && operation === 'add') { if (!value) throw new CommandError('Use antiword add <word or phrase>.'); group.words = [...new Set([...group.words, value.toLocaleLowerCase()])] }
        else if (name === 'antiword' && operation === 'remove') group.words = group.words.filter(w => w !== value.toLocaleLowerCase())
        else if (name === 'antiword' && operation === 'list') return reply(context, group.words.join('\n') || 'No prohibited phrases are configured.')
        else if (name === 'antiword' && operation === 'clear' && value === 'confirm') group.words = []
        else if (name === 'welcome' && operation === 'set') group.welcomeTemplate = value
        else throw new CommandError(`Usage: ${config.prefix}${definition.usage}`)
        try { saveGroup(context, group) } catch { throw new CommandError('Invalid group setting. Check phrase length, list size or template length.') }
        await reply(context, 'Group settings saved. The dashboard will show the same settings.')
      }
      return
    }
    if (['sticker', 'toimg', 'tomp3', 'statussave'].includes(name)) {
      if (name === 'statussave' && (!config.statusSaveConsent || context.info.remoteJid !== 'status@broadcast' || !context.info.quotedMessage)) throw new CommandError('Enable sender-consent confirmation in the dashboard and reply to accessible Status media. Forwarded or expired statuses cannot be recovered.')
      const source = mediaFrom(context.info.quotedMessage || context.body)
      return media.process(name, source, config.media, content => send(context, content))
    }
    if (name === 'autoreply') {
      const [operation, ...rest] = argument.split(/\s+/), value = rest.join(' ')
      if (operation === 'list') return reply(context, config.autoreply.rules.map(r => `${r.id}: ${r.trigger} → ${r.reply}`).join('\n') || 'No automatic reply rules are configured.')
      try {
        saveSettings(context, settings => {
          if (operation === 'on' || operation === 'off') settings.autoreply.enabled = operation === 'on'
          else if (operation === 'add') {
            const [trigger, ...reply] = value.split('|')
            settings.autoreply.rules.push({ id: crypto.randomUUID(), trigger: trigger.trim(), reply: reply.join('|').trim() })
          } else if (operation === 'remove') settings.autoreply.rules = settings.autoreply.rules.filter(r => r.id !== value.trim())
          else throw new CommandError('Use autoreply on|off|add <trigger> | <reply>|remove <rule ID>|list.')
        })
      } catch (error) { throw new CommandError(error instanceof CommandError ? error.message : 'Enter a valid trigger and reply, with at most 50 rules.') }
      return reply(context, 'Automatic reply settings saved.')
    }
    if (name === 'schedule') {
      const result = await services.schedule(context, argument)
      return reply(context, result)
    }
    if (name === 'broadcast') {
      const result = await services.broadcast(context, argument)
      return reply(context, result)
    }
  }
  async function moderate(context) {
    const config = context.config, group = groupFor(context)
    if (!['antilink', 'antiword', 'antispam'].some(name => config.commands[name].enabled && group[name])) return false
    const p = await permissions(context)
    if (context.owner || (group.exemptAdmins && p.senderAdmin)) return false
    let reason
    if (config.commands.antilink.enabled && group.antilink && unauthorizedLink(context.text, group.allowedDomains)) reason = 'This link is not allowed in this group.'
    if (config.commands.antiword.enabled && group.antiword && group.words.some(word => matchesPhrase(context.text, word))) reason = 'Please avoid prohibited words or phrases.'
    if (config.commands.antispam.enabled && group.antispam) {
      const key = `${context.account.id}:${context.chat}:${userJid(p.sender.phoneNumber) || userJid(p.sender.id)}`, normalized = context.text.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
      const fingerprint = normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : ''
      const recent = (spam.get(key) || []).filter(item => now() - item.at < group.spamWindowSeconds * 1000)
      recent.push({ at: now(), fingerprint }); spam.set(key, recent.slice(-100))
      if (recent.length > group.spamMaxMessages || (fingerprint && recent.filter(item => item.fingerprint === fingerprint).length >= group.spamRepeatThreshold)) reason = 'Please avoid repeated messages or excessive message frequency.'
    }
    if (!reason) return false
    // Deleted offending messages may continue within the cooldown, but warnings do not.
    if (group.action.includes('delete') && p.botAdmin) {
      try { await checkedSocket(context); await timeout(context.socket.sendMessage(context.chat, { delete: context.message.key })) }
      catch { log('Command moderation deletion was not confirmed.') }
    }
    if (cooldown(`moderation:${context.account.id}:${context.chat}:${context.sender}`, group.moderationCooldownSeconds)) {
      if (group.action.includes('warn')) await warn(context, p.sender, reason, group)
      else if (!p.botAdmin) await reply(context, 'Message deletion requires the connected account to be a group administrator.')
    }
    return true
  }
  async function handle(accountId, socket, message) {
    if (stopped || !message?.key?.id || !message.message || message.key.remoteJid === 'status@broadcast') return
    const chat = message.key.remoteJid
    if (!groupJid(chat) && !userJid(chat)) return
    // Never execute history replay, future-dated messages or edited-message wrappers.
    const timestamp = Number(message.messageTimestamp || 0) * 1000
    if (!Number.isFinite(timestamp) || timestamp < now() - 7 * 86400000 || timestamp > now() + 300000) return
    const parsed = parseMessage(message); if (!parsed || (!parsed.text && !parsed.body.imageMessage && !parsed.body.videoMessage)) return
    const account = await getAccount(accountId)
    if (!account?.workspaceId || await getSocket(accountId) !== socket) return
    const { config } = store.settings(account.workspaceId, accountId)
    const looksLikeCommand = parsed.text.startsWith(config.prefix)
    // Commands are accepted only from this connected account's own devices.
    // Ignore other people's commands before moderation, replies or receipt writes.
    if (looksLikeCommand && message.key.fromMe !== true) return
    const sender = userJid(message.key.fromMe ? socket.user?.id : groupJid(chat) ? message.key.participant : chat)
    if (!sender) return
    const context = { account, socket, message, chat, sender, config, ...parsed, owner: message.key.fromMe === true }
    let isCommand = looksLikeCommand
    if (message.key.fromMe && !isCommand) return
    if (message.key.fromMe && await services.isAutomationMessage?.(accountId, message.key.id)) return
    let name, argument, definition
    if (isCommand) {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(parsed.text.slice(config.prefix.length))
      if (match) { name = match[1].toLowerCase(); argument = (match[2] || '').trim(); definition = COMMAND_BY_NAME.get(name) }
      if (!definition || !config.commands[name]?.enabled) { isCommand = false; name = undefined }
    }
    if (!isCommand && !config.commands.autoreply.enabled && !['antilink', 'antiword', 'antispam'].some(c => config.commands[c].enabled)) return
    if (!store.claim(account.workspaceId, accountId, `message:${chat}:${message.key.id}`)) return
    try {
      if (!isCommand) {
        if (groupJid(chat) && await moderate(context)) return
        if (!looksLikeCommand && config.commands.autoreply.enabled && config.autoreply.enabled && !groupJid(chat) && !message.key.fromMe) {
          const rule = config.autoreply.rules.find(r => matchesPhrase(parsed.text, r.trigger))
          if (rule && cooldown(`autoreply:${accountId}:${chat}`, config.autoreply.cooldownSeconds) && allow(`reply-account:${accountId}`, config.perAccountPerMinute, 60000)) await reply(context, rule.reply)
        }
        return
      }
      if (!allow(`account:${accountId}`, config.perAccountPerMinute, 60000) || !allow(`chat:${accountId}:${chat}`, config.perChatPerMinute, 60000) || !cooldown(`command:${accountId}:${chat}:${sender}:${name}`, config.cooldownSeconds)) throw new CommandError('The previous command is still within its cooldown. Please wait a moment.')
      await execute(context, name, argument)
      store.statistic(account.workspaceId, accountId, name, true)
    } catch (error) {
      if (name) store.statistic(account.workspaceId, accountId, name, false)
      // Do not log messages, group identifiers, phone numbers, download URLs or raw exceptions.
      log('Bot command failed:', name || 'moderation')
      if (allow(`error:${accountId}:${chat}`, 3, 60000)) {
        try { await reply(context, error instanceof CommandError || error instanceof MediaError ? error.message : 'The command could not be completed. Check its settings and WhatsApp permissions.') } catch {}
      }
    }
  }
  async function welcome(accountId, socket, update) {
    if (stopped || update?.action !== 'add' || !groupJid(update.id) || !Array.isArray(update.participants)) return
    const account = await getAccount(accountId)
    if (!account?.workspaceId || await getSocket(accountId) !== socket) return
    const { config } = store.settings(account.workspaceId, accountId), group = store.group(account.workspaceId, accountId, update.id)
    if (!config.commands.welcome.enabled || !group.welcome) return
    const context = { account, socket, chat: update.id, config }
    await metadata(context)
    const self = await aliases(socket, socket.user?.id)
    if (!participant(context, self)) return
    const members = [...new Set(update.participants.slice(0, 100).map(p => userJid(typeof p === 'string' ? p : p.id)).filter(Boolean))]
    for (const jid of members) {
      const member = participant(context, await aliases(socket, jid)); if (!member || self.has(jid)) continue
      const canonical = userJid(member.phoneNumber) || userJid(member.id)
      if (!store.welcome(account.workspaceId, accountId, update.id, canonical)) continue
      const name = String(member.notify || member.name || '@' + member.id.split('@')[0]).slice(0, 80)
      await send(context, { text: group.welcomeTemplate.replaceAll('{member}', name).replaceAll('{group}', String(context.metadata.subject || 'the group').slice(0, 128)).slice(0, 4000), mentions: [member.id] })
    }
  }
  function enqueue(accountId, socket, event, payload) {
    if (stopped || queue.active + queue.pending.length >= queue.capacity) return Promise.resolve(false)
    const chat = event === 'messages.upsert' ? payload.key?.remoteJid : payload.id
    const key = `${accountId}:${chat}`, previous = serial.get(key) || Promise.resolve()
    const task = queue.run(async () => {
      await previous.catch(() => {})
      if (event === 'messages.upsert') await handle(accountId, socket, payload)
      else await welcome(accountId, socket, payload)
    }).catch(() => { log('Bot event processing failed.') }).finally(() => { if (serial.get(key) === task) serial.delete(key) })
    serial.set(key, task); return task
  }
  return {
    async onEvent(socket, accountId, event, update) {
      if (event === 'messages.upsert') {
        if (update.type !== 'notify' || !Array.isArray(update.messages)) return
        // Bounded event batch; over-capacity work is dropped without replying or re-execution.
        await Promise.all(update.messages.slice(0, 64).map(message => enqueue(accountId, socket, event, message)))
      } else if (event === 'group-participants.update') await enqueue(accountId, socket, event, update)
    },
    async stop() { stopped = true; media.stop?.(); await Promise.allSettled([...serial.values()]) },
    metrics() { return { active: queue.active, queued: queue.pending.length } }
  }
}
