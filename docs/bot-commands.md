# Bot Commands: implementation and operational report

## Scope and audit

This is an additive extension of the existing application. No AWS deployment,
GitHub push, PM2 restart, live WhatsApp test, production environment change, or production
data operation was performed for this work.

The existing architecture is retained:

| Existing component | Responsibility and reuse |
| --- | --- |
| `bot.js` | Express authentication/CSRF/account middleware, inline dashboard, account data cache, cron/interval timers, two-job delivery worker, graceful shutdown |
| `whatsapp-manager.js` | One existing Baileys socket per account, pairing, credential generations, reconnect, contact and Status privacy synchronization |
| `auth-store.js`, `workspace-store.js` | SQLite login/session/reset data and business membership; existing migrations 1 and 2 |
| `automation-store.js` | Atomic per-account automation JSON, saved messages/media, recipients, group lists and persistent delivery checkpoints |
| `recurring-schedules.js`, `automation-delivery.js` | Existing validated destinations, per-recipient pacing, recurring schedules, restart recovery and duplicate prevention |
| Existing deployment files | PM2, Nginx and Session Manager workflow, unchanged |

The installed Baileys version remains **7.0.0-rc14**. Commands use its existing
message/group events and group APIs. No new socket, scheduler, Redis service,
server, or distributed worker was introduced.

Audit risks: Baileys is a release candidate and WhatsApp behavior can change;
phone/LID aliases need verification; group permissions change dynamically;
unconfirmed network side effects cannot provide exactly-once delivery. Also,
existing authentication modules capture the database path during imports, before
the application's `.env` loading body runs. The command store matches that
existing path. An alternate `AUTH_DATABASE_PATH` must already be present in the
process environment. This extension does not relocate any existing database.

## Implemented commands

There are **25 supported commands**.
The existing 19 feature commands start disabled. The four basic commands and the
requested `.leave` and `.block` commands start enabled for the connected account
owner only. Existing saved switches remain unchanged.

| Category | Supported |
| --- | --- |
| Group administration (13) | `tagall`, `tag`, `kick`, `promote`, `demote`, `mute`, `unmute`, `antilink`, `antiword`, `antispam`, `welcome`, `warn`, `leave` |
| Media (3) | `sticker` (image/short video), `toimg` (sticker to PNG), `tomp3` (video audio to MP3) |
| Utilities (5) | `autoreply`, `schedule`, `broadcast`, `statussave`, `block` |
| Basic (4) | `menu`, `help`, `ping`, `alive` |

## Dashboard and usage

**Bot Commands** extends the current sidebar and responsive dashboard. Select an
existing WhatsApp account, choose enabled commands, and save account settings.
Group moderation and welcome settings are saved separately after selecting a
group. The corresponding account command must also be enabled. Business owners
can change settings; business members can view them.

The dashboard supports prefix controls, category switches, cooldowns,
media limits, automatic reply CRUD, opted-in broadcast lists, group domain and
phrase lists, moderation thresholds/actions, welcome templates, and warning
review/reset. It preserves unsaved drafts while polling, detects conflicting
edits, and clears/hides previous business settings on account changes/removal.
Reload settings explicitly discards drafts.

The prefix defaults to `.` and can be changed per account. Examples below use
placeholders, not real contacts or account identifiers:

```text
.help antiword
.tagall Please read the announcement
.tag Please read this message
.kick @member
.promote @member
.demote @member
.mute
.unmute
.antilink on
.antiword add prohibited phrase
.antiword list
.antiword remove prohibited phrase
.antiword clear confirm
.antispam on
.welcome set Welcome {member} to {group}! Please read the rules.
.welcome on
.warn @member Please keep messages on topic.
.autoreply add hello | Hello! How can we help?
.autoreply list
.autoreply remove <rule ID>
.autoreply on
.schedule at 2030-01-01T09:00:00+01:00 | <saved message ID> | list:<group list>
.schedule every 2 hours | <saved message ID> | contact:<recipient ID>
.schedule every 1 days | <saved message ID> | status
.schedule list
.schedule cancel <job ID>
.broadcast <saved message ID> | <authorized recipient list>
.broadcast confirm <one-use confirmation>
```

`.tag <message>` sends one message with hidden mentions of current group members,
even in groups with more than 100 members. You can also reply to a group message
with just `.tag`: it copies that message's text, or forwards an accessible image,
video, document, audio/voice note or sticker with hidden mentions in the same
single post. Media captions remain with the attachment; no extra caption message
is sent. Explicit text after `.tag` takes precedence over a quoted message.
Without text or a supported reply it gives usage guidance and no mentions.
View-once content, protocol messages and cross-chat sources cannot be copied.
Replayed command events and outgoing echoes are
ignored using persistent receipts; unconfirmed sends are not retried. Existing
hidden-tag settings and statistics appear under `.tag` without rewriting old data.
After a confirmed send and a delivery/read receipt from another group recipient,
the bot revokes only the original `.tag` or `.tag <message>` command for everyone.
Both the replied-to source message and the tagged output remain. Server
acknowledgements and receipts from the bot's own devices
do not trigger cleanup. The command remains when sending fails or delivery stays
unconfirmed. Deletion failure does not repost the message or add a group reply.
Cleanup state is persisted in the existing SQLite database; reconnects can finish
already-confirmed cleanup. Duplicate receipts use an atomic claim, with no automatic
retry after an unconfirmed deletion. Cleanup accepts records for eight days;
older records are pruned when preparing new tags, matching command receipts.
`.tagall` keeps its visible member lists and bounded batches, with no generated
"Group announcement" placeholder when no text is supplied.

Media commands accept supported attachments or quoted media. Statussave requires
a quoted accessible Status image/video and explicit sender-consent confirmation
in the dashboard; it sends a copy back to the command chat and deletes its local
temporary file. It is not an archive or recovery tool. View-once, expired,
inaccessible, and text-only Status cannot be saved. Animated stickers converted
to images use their first frame. MP3 extraction requires a video audio track.

All commands are identified by Baileys `key.fromMe === true`, meaning the connected
account's WhatsApp/linked devices. Commands from everyone else are silently
ignored before replies, moderation or command side effects, including group
administrators and previously permitted users. No command can be delegated.
Existing stored access settings are projected to owner-only without rewriting
old database records. Ordinary automatic replies, moderation and welcomes remain
available; command messages from other people do not trigger them.
Administrative actions still require current group admin privileges.
Removal, promotion, demotion and mute changes additionally
require the bot to be an admin. The connected account and group founder cannot
be targeted. Replies, mentions and verified numeric/member identifiers work as
targets. PN/LID aliases are verified through the existing socket mapping.

Schedules use existing saved messages/destinations and existing Automations
controls. Dates require an explicit timezone offset. Recurrence and per-group
delivery intervals continue to use the current worker. Broadcasts require saved
account-owned contacts, recipient authorization, at least five seconds between
recipients, and a one-use two-minute confirmation above the configured threshold.
Changing the message, contact details, list or delivery delay invalidates that
confirmation. Only one active command broadcast per account is allowed.

## Files and dependencies

Added:

- `commands/catalog.js`: definitions, availability, command permissions.
- `commands/settings.js`: defaults, strict validation, phrase/domain matching.
- `commands/store.js`: account/group configuration, warnings, statistics,
  receipts and confirmations in the existing SQLite database.
- `commands/engine.js`: bounded routing, permission checks, moderation, welcomes,
  duplicate protection and command execution.
- `commands/media.js`: strict streaming download/decryption, Sharp/FFmpeg,
  bounded queue, temporary-file lifecycle.
- `commands/utilities.js`: existing scheduler/worker integration.
- `commands/routes.js`: authenticated account-scoped settings APIs.
- `commands/dashboard.js`: existing dashboard HTML/CSS/JavaScript extension.
- `test/command-engine.test.js`, `test/command-media.test.js`,
  `test/command-utilities.test.js`: isolated command tests.
- `docs/bot-commands.md`: this report.
- `scripts/local-command-sandbox.js`, `test/local-command-sandbox.test.js`,
  `docs/local-command-testing.md`: isolated local launcher, lifecycle tests and
  the spare-account testing guide; private data lives outside the repository.

Modified for this extension:

- `bot.js`: service initialization, command routes/page, shared job validators,
  command job creation/cancellation and graceful shutdown.
- `whatsapp-manager.js`: guarded command, receipt and connection listeners per existing socket, removed
  on close/disconnect; existing authentication/reconnect logic preserved.
- `package.json`, `package-lock.json`: direct `sharp@0.35.5` (already the installed
  transitive version) and `ffmpeg-static@5.3.0`.
- `test-support/dashboard-browser.js`, `test/production-smoke.test.js`,
  `test/whatsapp-manager.test.js`: browser/API/regression/lifecycle coverage.
- `README.md`: link to the feature and operational report.

Pre-existing workspace edits and Session Manager workflow files were left as
found. No secrets or private runtime files were added to the feature files.

## Additive database migration 3

Startup creates these new tables if missing and records migration 3 in the
existing `schema_migrations` table:

```text
bot_command_settings
bot_group_settings
bot_warnings
bot_command_receipts
bot_command_statistics
bot_welcome_receipts
bot_broadcast_confirmations
```

Existing authentication/business tables and records are not replaced. Settings,
warnings and queries are scoped by workspace and WhatsApp account; group/member
keys provide further isolation. Revisions reject stale settings writes with
HTTP 409. Event identifiers and confirmation tokens are stored as hashes rather
than raw message content/tokens. Receipts expire after eight days; messages older
than seven days and history append events cannot execute. Welcome deduplication
persists for ten minutes across restarts. Warning counts/settings do not expire.

Command-created jobs are stored in the existing account automation JSON rather
than a second job database. No WhatsApp credential migration is required.

### Additive migration 4: tag command cleanup

Startup adds `bot_tag_cleanup` and its expiry index to the same SQLite database.
Rows are scoped by workspace/account and the outgoing tagged message ID. They
contain the original owner command key, recipient identifiers, send/delivery flags
and an atomic cleanup claim; message text and WhatsApp credentials are not stored
in this table. Existing tables, accounts, settings and migrations are preserved.
This pending feature requires a reviewed deployment of migration 4. Code rollback
must retain the database and this table, so customer data is never reset.

## Security, reliability and performance

- New APIs sit behind existing login, CSRF, workspace and account ownership
  middleware. Modification requires the business owner; group APIs require a
  group already in that account's existing snapshot.
- Current metadata is used to check memberships and permissions. Failed alias or
  metadata verification cannot grant privileges.
- The router claims an event before side effects and never retries an unconfirmed
  WhatsApp mutation/send automatically. This favors avoiding duplicates; a crash
  after claiming but before sending can omit a command reply/action. It is not an
  exactly-once network guarantee. Scheduled jobs reuse existing checkpoints.
- Command output and known automation message IDs cannot create reply loops.
  Rate limits and cooldowns are account/chat scoped; private autoreplies also have
  their own cooldown. Normal non-command traffic does not generate denial spam.
- Four action workers and two basic-reply workers share a maximum of 64 accepted
  outstanding events. Waiting same-chat actions acquire a worker only when the
  previous action finishes; `.menu`, `.help`, `.ping` and `.alive` can reply while
  media or group actions are running. Actions within a chat remain ordered, and
  basic replies are ordered within their own lane. Overflow is dropped without
  replying/replaying. Tag delivery cleanup runs alongside incoming dispatch.
  Media uses one active task and a total capacity of eight. Rate-tracking maps
  are bounded to 5,000 entries. Rejected repeats do not consume the command
  allowance. Existing configured limits and cooldowns still apply.
- Send-time group metadata is cached for 30 seconds, with at most 256 groups per
  socket. Concurrent cache misses share a fetch. Membership/group changes and
  local administrative actions invalidate it; disconnect discards the cache.
  Explicit group membership and administrator checks always fetch fresh data.
  No extra perpetual timers/processes are added.
- Default media limits: 8 MB, 10 seconds, 25-second processing timeout; configurable
  ceilings: 16 MB, 30 seconds, 60 seconds. Images have a 16-million-pixel limit.
  Sharp cache/concurrency and FFmpeg threads are limited. Uploads have the existing
  command send confirmation timeout in addition to media processing time.
- Downloads pin HTTPS to `mmg.whatsapp.net`, reject redirects and private DNS
  addresses, enforce streaming byte limits, and verify WhatsApp HMAC and available
  plaintext/encrypted hashes. Baileys key derivation is reused; native HTTPS is
  used because the installed rc14 helper drops redirect/signal options.
- FFmpeg uses argument arrays without a shell, generated private paths, a format
  allowlist and restricted protocols. Actual video duration is checked, including
  Status copies. No arbitrary external URL downloads are allowed.
- Temporary files use generated private directories and are removed after upload,
  errors, timeouts, and normal shutdown. An OS crash/SIGKILL can leave an orphan
  in the OS temporary directory; no broad disk cleanup is attempted.
- Errors expose safe user messages. Logs include fixed error categories and
  timings for sends, metadata queries or commands taking at least one second;
  they omit incoming content, numbers, group IDs, URLs and raw exceptions.
  Dashboard command statistics expose aggregate
  successes/failures without raw messages.

Moderation/welcome availability still depends on connected sockets and actual
WhatsApp event delivery. A participant absent from newly fetched metadata is
skipped rather than welcomed without verified membership. Receipt retention,
bounded rate-map eviction, and in-memory cooldown reset after restart are known
limits. A single EC2/SQLite/JSON process is retained; no capacity claim for
thousands of connections is made. Load testing is needed before scaling.

## Verification

`npm test`: **63 passed, 0 failed, 0 skipped** on local Node.js 24.21.0.
The complete suite also passed **63/63 on Node.js 22.23.3**, including real
Chromium. Node 22 emits its existing experimental SQLite warning; this is not a
test failure. Syntax checks passed for all 18 changed/added JavaScript files.
`npm audit --omit=dev`: **0 known vulnerabilities** at verification time.

Coverage includes:

- Real Chromium desktop/mobile, all dashboard views, settings persistence,
  account changes/removal, concurrent edits, draft preservation, refresh,
  independent device logins, warning reset and no console errors.
- Actual HTTP login/session/CSRF/ownership controls, unknown command rejection,
  invalid group/contact ownership, saved text/media, recipients, jobs and restart.
- Mock WhatsApp sockets for command routing, admin/owner permissions, PN/LID
  targets, large mentions, moderation/warnings, welcome deduplication, autoreply,
  rates, receipt replay after database reopening, reconnect/listener lifecycle,
  pairing generations and original session marker preservation.
- Actual Sharp/FFmpeg with synthetic media: static/animated sticker, PNG, MP3,
  wrong types, oversized/over-duration input, Status copies, aborts/cleanup.
- Mock HTTPS/DNS with actual AES/HMAC/hash processing: streaming chunk boundaries,
  tampering, wrong hashes, redirects, private DNS and invalid decryption keys.
- Production job validation functions reused in isolated utility tests:
  schedules, existing timer/worker callbacks, cancellation, scoped contacts,
  consent, one-use broadcast confirmations and changed-content protection.
- Retired catalog entries cannot be executed, listed, configured or included in
  help. Old settings are projected onto the current catalog without mutating
  stored records; later explicit saves write the current command selection.
- The real local launcher excludes production settings, refuses repository or
  unrelated data directories, skips occupied ports, supports signup without
  SMTP, and retains its separate database/session data across stop/start.

Tests use temporary databases/directories, synthetic media, fictional contacts
and mocked sockets. Live WhatsApp delivery, QR scanning, real phone pairing,
live Status quoting, platform downloads, AWS/PM2 deployment and production load
testing were not performed.

## Deployment requirements (approval required)

No deployment has been performed. After explicit approval:

1. Review the feature diff separately from existing unrelated workspace edits.
2. Back up the existing SQLite database consistently (including WAL with a proper
   SQLite backup), account automation, WhatsApp auth tree and private environment
   to protected storage. Do not commit any of them.
3. Use Node.js 22.13 or later on a supported LTS line. Install with
   `npm ci --omit=dev`; permit the necessary package install scripts. The
   FFmpeg dependency downloads a platform-specific native binary, and Sharp
   requires a supported OS/architecture. Verify FFmpeg/Sharp installation on the
   target before enabling video commands. FFmpeg package/binary license terms
   must be reviewed if distributing bundled binaries.
4. No new required secret or `.env` setting exists. An optional process variable
   `COMMAND_FFMPEG_PATH` can point to an already-installed trusted executable.
   Default installation supplies FFmpeg automatically.
5. Start the existing application using the existing deployment workflow. The
   additive migration runs automatically. Re-enable only selected commands and
   check authenticated dashboard/API health before an approved live-account test.

No port, firewall, IAM, DNS, Nginx, SSL or PM2 configuration change is necessary
for this feature.

## Rollback

After approval, roll back code/dependencies through the existing deployment
workflow to the prior reviewed commit. Preserve `.env`, SQLite, all account data,
media and WhatsApp credential directories. Old code can ignore the command
tables and migration record; leaving them present preserves settings for a later
re-upgrade. Do not restore an older whole authentication database, which could
discard newer users/sessions/business records.

Command-created automation jobs remain ordinary existing jobs and can continue
under old code. Pause/cancel selected jobs from Automations before rollback if
that is desired. Removing the new tables is optional and requires a separate
approved, backed-up database change while the application is stopped; it is not
needed for the normal code rollback. Never use `git clean` or delete account/auth
directories as a rollback procedure.

## Primary implementation references

- [Baileys event types](https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/Events.ts)
- [Baileys delivery and group receipt events](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/socket/receiving-updates.md)
- [Sharp output/conversion API](https://sharp.pixelplumbing.com/api-output/)
- [FFmpeg protocol restrictions](https://ffmpeg.org/ffmpeg-protocols.html)
- [ffmpeg-static installation and binary licensing](https://github.com/eugeneware/ffmpeg-static)

## Leaving groups and blocking users

Only the connected WhatsApp account can invoke these commands from its own phone or linked devices. Other people's commands remain silent. `.leave` exits the current group without requiring administrator rights. It takes no arguments and cannot leave another group from a private chat.

Use `.block` while replying to a user, with one mention, with a full number including country code, or without arguments in that person's private chat. It blocks that user for the connected account; it does not remove them from a group. The connected account cannot block itself. Ambiguous targets, cross-chat quotes and unresolved identifiers are rejected. Success confirmations go to the account's private self chat, not to the blocked person or the group.

Both commands are included in the dashboard, menu and help. Existing saved settings are projected without rewriting customer records; either command can be disabled in Bot Commands. Duplicate events, reconnect replay and failed confirmations never repeat the action automatically. An unconfirmed WhatsApp response is not retried; verify membership or the block list before issuing a new command.
