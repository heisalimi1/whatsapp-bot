import { COMMANDS } from './catalog.js'
import { groupJid, validateAccountSettings } from './settings.js'

// Register after the existing login, CSRF and account-ownership middleware.
export function registerCommandRoutes(app, { store, media, dataFor, groupsFor }) {
  const owner = (req, res, next) => req.workspace.role === 'owner' ? next() : res.status(403).json({ error: 'Only the business owner can change bot command settings.' })
  const knownGroup = (req, res, next) => groupJid(req.params.group) && groupsFor(req.params.id).some(g => g.id === req.params.group) ? next() : res.status(404).json({ error: 'Refresh groups and choose a group belonging to this WhatsApp account.' })
  const fail = (res, error) => res.status(error.status || 400).json({ error: error.message || 'Command settings could not be saved.' })
  app.get('/api/accounts/:id/commands', (req, res) => {
    const w = req.workspace.id, a = req.params.id
    res.json({ ...store.settings(w, a), catalog: COMMANDS, mediaAvailability: media.availability(), statistics: store.statistics(w, a),
      groups: groupsFor(a).filter(g => groupJid(g.id)).map(g => ({ ...g, settings: store.group(w, a, g.id), warnings: store.warnings(w, a, g.id) })) })
  })
  app.put('/api/accounts/:id/commands', owner, async (req, res) => {
    try {
      const config = validateAccountSettings(req.body?.config), data = await dataFor(req.params.id)
      if (Object.values(config.broadcast.lists).some(ids => ids.some(id => !data.recipients.some(r => r.id === id)))) throw Error('Choose broadcast recipients saved for this account.')
      if (config.commands.tomp3.enabled && !media.availability().tomp3) throw Error('The local FFmpeg dependency is unavailable.')
      res.json({ ...store.saveSettings(req.workspace.id, req.params.id, config, req.body?.revision), message: 'Bot command settings saved.' })
    } catch (error) { fail(res, error) }
  })
  app.put('/api/accounts/:id/commands/groups/:group', owner, knownGroup, (req, res) => {
    try {
      if (!Number.isSafeInteger(req.body?.revision)) throw Error('Reload group settings before saving.')
      store.saveGroup(req.workspace.id, req.params.id, req.params.group, req.body?.config, req.body.revision)
      res.json({ ok: true, revision: store.settings(req.workspace.id, req.params.id).revision, message: 'Group command settings saved.' })
    } catch (error) { fail(res, error) }
  })
  app.delete('/api/accounts/:id/commands/groups/:group/warnings/:member', owner, knownGroup, (req, res) => {
    try { store.resetWarnings(req.workspace.id, req.params.id, req.params.group, req.params.member); res.json({ ok: true, message: 'Member warnings reset.' }) }
    catch (error) { fail(res, error) }
  })
}
