const group = 'Group Administration', media = 'Media Tools', utility = 'WhatsApp Utilities'
const definitions = [
  ['tagall', group, 'Mention every current group member.', 'tagall [message]', 'admin'],
  ['hidetag', group, 'Mention members without listing their names.', 'hidetag <message>', 'admin'],
  ['kick', group, 'Remove a mentioned or quoted member.', 'kick @member', 'admin'],
  ['promote', group, 'Promote a mentioned or quoted member.', 'promote @member', 'admin'],
  ['demote', group, 'Demote a mentioned or quoted administrator.', 'demote @member', 'admin'],
  ['mute', group, 'Allow only administrators to send group messages.', 'mute', 'admin'],
  ['unmute', group, 'Allow all group members to send messages.', 'unmute', 'admin'],
  ['antilink', group, 'Moderate links using this group’s allowed domains.', 'antilink on|off', 'admin'],
  ['antiword', group, 'Moderate prohibited words and phrases.', 'antiword on|off|add <phrase>|remove <phrase>|list|clear confirm', 'admin'],
  ['antispam', group, 'Moderate repeated messages and excessive frequency.', 'antispam on|off', 'admin'],
  ['welcome', group, 'Welcome new members with a group-specific template.', 'welcome on|off|set <template>', 'admin'],
  ['warn', group, 'Warn a mentioned or quoted member.', 'warn @member [reason]', 'admin'],
  ['sticker', media, 'Convert an image or short video to a sticker.', 'sticker (attach or reply to media)', 'owner'],
  ['toimg', media, 'Convert a sticker to a PNG image.', 'toimg (reply to a sticker)', 'owner'],
  ['tomp3', media, 'Extract MP3 audio from a video.', 'tomp3 (attach or reply to video)', 'owner'],
  ['autoreply', utility, 'Manage account-specific automatic reply rules.', 'autoreply on|off|add <trigger> | <reply>|remove <id>|list', 'owner'],
  ['schedule', utility, 'Use the existing scheduler and saved messages.', 'schedule at <ISO date with offset> | <message ID> | list:<name> or contact:<ID>; schedule every <count> <minutes|hours|days> | <message ID> | <destination>; schedule list|cancel <job ID>', 'owner'],
  ['broadcast', utility, 'Queue a saved message to an authorized recipient list.', 'broadcast <saved message ID> | <recipient list>; broadcast confirm <code>', 'owner'],
  ['statussave', utility, 'Return accessible status media with the sender’s consent.', 'statussave (reply to accessible status media)', 'owner'],
  ['menu', 'Basic', 'List enabled commands.', 'menu', 'owner'],
  ['help', 'Basic', 'Explain a command and its usage.', 'help [command]', 'owner'],
  ['ping', 'Basic', 'Check bot responsiveness.', 'ping', 'owner'],
  ['alive', 'Basic', 'Show connection status.', 'alive', 'owner']
]
export const COMMANDS = definitions.map(([name, category, description, usage, permission]) => ({ name, category, description, usage, permission }))
export const COMMAND_BY_NAME = new Map(COMMANDS.map(command => [command.name, command]))
export const CATEGORIES = [group, media, utility]
export const ownerOnly = new Set(['autoreply', 'schedule', 'broadcast', 'statussave'])
export const adminActions = new Set(['kick', 'promote', 'demote', 'mute', 'unmute', 'warn', 'antilink', 'antiword', 'antispam', 'welcome'])
