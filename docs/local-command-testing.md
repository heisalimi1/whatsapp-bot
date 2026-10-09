# Isolated local command testing

The local sandbox runs the current source with its own empty data outside the
Git checkout: `%LOCALAPPDATA%\WhatsAppBot\command-sandbox\<project identifier>`
on Windows. Its login database, account metadata, WhatsApp authentication,
automations, uploads, temporary files and logs all stay there. Nothing is copied
from the existing local or AWS bot. It binds only to `127.0.0.1`, normally on port
3001; if occupied it chooses the next free port up to 3010 without stopping any
existing server. The launcher prints the exact localhost URL.

## First connection

1. Open the sandbox URL, normally **http://localhost:3001/**.
2. Choose **Create Account**. Create a separate local tester login. Your existing
   AWS/other-localhost login is intentionally not imported. Enter passwords only
   in the browser. Signup/login work without SMTP; emailed password resets are
   unavailable without a mail service.
3. Open **Accounts → Connect WhatsApp**. Enter a **spare WhatsApp number**, then
   use that phone's **Linked Devices → Link a device → Link with phone number**
   flow and the displayed pairing code. Pairing must be completed on your phone;
   the prepared sandbox does not contain a preconnected account.
4. Use only a disposable test group and consenting test contacts. Make the spare
   account a group administrator. Do not link the production bot number here.
5. Refresh groups in **Recipients & Groups**. Create a group-list draft, tick the
   test group and save. Add any test contacts needed for individual delivery.
6. Create a saved message named **Sandbox hello**, text **Hello from the local
   command test**, and save it. Refresh to check persistence.
7. Open **Bot Commands**, enable the tools you want to test, and **Save account
   settings**. Then select the test group, configure its rules and **Save group
   settings**. The default prefix is `.`; all 19 feature commands start disabled.

Send owner commands from the connected spare account's phone or its linked
devices. A dashboard login does not make a different phone the WhatsApp command
owner. Basic commands can be tried in the spare account's own chat. Group actions
need verified administrator permissions even when sent by the account owner.
The default command cooldown is five seconds for repeat uses of the same command.

## Checklist for all 23 commands

| Commands | Test and expected result |
| --- | --- |
| `.menu`, `.help`, `.ping`, `.alive` | Menu lists enabled commands, help explains usage, ping returns Pong, alive reports the connection. Try `.help antiword`. |
| `.tagall`, `.hidetag` | Send `.tagall Test announcement` and `.hidetag Test announcement` in the test group. Mentions target current members; hidetag does not list their names. |
| `.promote`, `.demote` | Mention/reply to a willing test member, promote them, then demote them. Verify permissions in WhatsApp. The bot and group founder are protected. |
| `.mute`, `.unmute` | Mute the test group; a non-admin cannot post. Unmute it and verify they can post again. |
| `.kick` | Mention/reply to a disposable non-admin test member. Verify removal, then invite them back when desired. |
| `.antilink` | Set an allowed domain in group settings. Use `.antilink on`; a non-admin tester posts an allowed link, then a different domain. Only the latter should trigger the configured action. Use `.antilink off` afterwards. |
| `.antiword` | Use `.antiword add sandbox phrase`, `.antiword list`, then `.antiword on`. A non-admin posts that phrase; check the warning/action. Try `.antiword remove sandbox phrase`, and `.antiword clear confirm` when desired. |
| `.antispam` | Enable with `.antispam on`; a non-admin repeats a synthetic message to the configured threshold (default four repeats within 15 seconds). Check warning and cooldown; use `.antispam off` afterwards. |
| `.welcome` | Set `.welcome set Hello {member}, welcome to {group}!`, then `.welcome on`. A new test member joins; verify one welcome. Duplicate events for the same member within ten minutes are suppressed. |
| `.warn` | Reply to a non-admin's message with `.warn Please keep to the test topic.` Check the scoped count under Bot Commands → Member warnings and test Reset. Keep escalation set to review during initial testing. |
| `.sticker` | Attach/reply to a small image with `.sticker`, then try a short MP4 video. Receive a static/animated sticker. Defaults are 8 MB and 10 seconds. |
| `.toimg` | Reply to the generated sticker with `.toimg`; receive a PNG. Animated stickers use their first frame. |
| `.tomp3` | Reply to a short video with an audio track using `.tomp3`; receive MP3 audio. A silent video should produce a clear error. |
| `.autoreply` | Add `.autoreply add sandboxhello | Hello, test reply!`, then `.autoreply on`. Another test phone sends `sandboxhello` in a private chat. Expect one reply, with repeat triggers respecting the cooldown. `.autoreply list` provides rule IDs for removal. |
| `.schedule` | Use the saved message and a saved test destination as shown below. Check the new job in Automations, verify delivery, then test `.schedule list` and `.schedule cancel <job ID>`. Existing pause/resume/edit controls still apply. |
| `.broadcast` | In Bot Commands tick test recipients, apply a recipient-list draft, confirm their authorization and save settings. Use the syntax below. Verify paced delivery; large lists require the displayed one-use confirmation. |
| `.statussave` | Obtain a test contact's permission, check the Status permission box and enable the command. Reply to their accessible image/video Status using `.statussave`. Expect a copy in the command chat. View-once, expired or inaccessible media and text-only Status are not recoverable. |

Permission checks can be tested by sending an administrative command from a
non-admin test participant. Verify it is refused without changing group members.
For moderation tests, use a non-admin sender because admin exemptions default on.

## Scheduling and broadcast examples

Use your sandbox's actual saved message/contact identifiers in place of
placeholders. After login, the read-only **http://localhost:3001/api/state** page
shows these under `cfg.messages[].id` and `cfg.recipients[].id`. If your sandbox
uses another port, substitute that port. Reading this page requires no code,
configuration or JSON editing. Do not share its private contact data.

```text
.schedule every 1 minutes | <saved message ID> | list:<test group-list name>
.schedule every 1 hours | <saved message ID> | contact:<test recipient ID>
.schedule every 1 days | <saved message ID> | status
.schedule at <future ISO date with +01:00 or Z offset> | <saved message ID> | list:<test group-list name>
.schedule list
.schedule cancel <job ID>
.broadcast <saved message ID> | <authorized test-recipient list>
.broadcast confirm <displayed confirmation>
```

Cancel the one-minute recurring schedule after verifying two deliveries. For
Status-posting schedules, the spare account's Status audience must contain only
the test viewers you intend. Campaign recurrence and the wait between group
deliveries remain separate controls in Automations.

## Persistence, browsers and stopping

Refresh the dashboard and verify messages, lists, jobs, rules and warning counts
remain. Test at narrow/mobile viewport widths in Chrome DevTools. For a real phone
dashboard over localhost, use an explicitly prepared secure tunnel; the phone's
own `localhost` is a different device. This sandbox is not exposed to the LAN.

VS Code terminal commands are available when you want to control this local
instance; the initial launch is handled for you:

```sh
npm run sandbox:status
npm run sandbox:stop
npm run sandbox
```

Stopping affects only this sandbox through its local authenticated control pipe.
Its accounts, login database, media and spare-number credentials remain intact.
Starting again reconnects the sandbox's registered spare account automatically.
To test restart reliability, leave a test schedule pending, stop/start the sandbox,
then verify reconnection, schedule recovery and no duplicate confirmed deliveries.
The unrelated process on port 3000 and all AWS/PM2 processes are untouched.

Browser DevTools Console should show no JavaScript errors. User errors appear in
the dashboard or as safe command replies. Private server logs stay in the
sandbox's `application.log`; do not paste passwords, pairing codes, credentials or
contact data into chat. Tests run automatically with `npm test` using additional
temporary isolated fixtures and mocked WhatsApp sockets.
