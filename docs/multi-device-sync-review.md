# Multi-device WhatsApp synchronization review

## Scope and deployment status

Implemented in the existing Node/Express/Baileys application. The dashboard, scheduler, delivery engine, authentication, media uploads and existing account storage remain in place. No new runtime dependencies are required.

After the user approved deployment/recovery and restored SSH access, code commit `54dc930b200868608b7afe7459010107094e4879` was deployed to EC2. A fresh private backup was taken after graceful PM2 stop. Both dashboard users, their active login sessions, environment values and existing private files passed preservation checks. PM2 is online with one fork, and the additive workspace migration completed. No existing WhatsApp session directory was overwritten or deleted.

## Findings

The user confirmed both devices use the same HTTPS URL and dashboard login. Creator-based account filtering therefore does not explain that particular symptom. These bugs were found in the code:

1. Re-pairing disabled `wantConnection`, deleted the auth directory, then invoked startup, which refused to run with `wantConnection` disabled. This could destroy saved session data and still fail to provide a code.
2. Registered startup completed before the socket connected. Another reconnect request could then create a second socket using the same keys. An old socket's close event could also clear the replacement socket and overwrite its status.
3. Dashboard polling stopped while an input, textarea or select remained focused. A mobile form could keep displaying an outdated connection status and group list.
4. WhatsApp group metadata existed only in process memory. It disappeared on restart or failed refresh, although saved list selections were already account-scoped on disk.
5. Account API authorization used the creator's user ID. Separate authorized dashboard users had no mechanism to join the same business.
6. Saving a whole configuration from a stale browser could overwrite another device's recent changes.

Read-only EC2 inspection found one WhatsApp account marked logged out and its auth directory missing. A matching private backup contained 32,491 auth files. The destructive re-pair path explains how this could happen; the inspection does not establish which browser action triggered deletion. Three dashboard sessions for the same registered user were present.

## Changes

| File | Change |
| --- | --- |
| `whatsapp-manager.js` | One manager singleton and socket per account; concurrent reconnect/pair requests coalesce; existing live sockets are reused; old socket events are ignored; bounded retry and connection timeouts; explicit pairing flag; intentional disconnect persists; genuine re-pairing uses a new generation without deleting old credentials. Testable factory retains existing production exports. |
| `workspace-store.js` | Additive SQLite workspace, membership, preference and invitation tables. Legacy owner IDs become stable workspace IDs. Email-bound, hashed, single-use invitation codes enable shared business access without SMTP. Revocation takes effect on the next request. |
| `bot.js` | Workspace authorization for account APIs, state, health, uploads and logs; owner-only session removal; business/team controls; relative same-origin requests; server state polling every three seconds while inputs are focused; draft preservation; generation checks for late responses; reconnect versus genuine pairing controls; shared group refresh. |
| `automation-store.js` | Private persisted group snapshots and monotonically increasing configuration revisions. Saved messages, recipients, jobs and selections remain in existing account directories. |
| `scripts/recover-missing-sessions.js` | Offline recovery preview/apply tool. Validates account/creator/generation identity and registered backup credentials; refuses symlinks and existing target auth directories; verifies copied files by SHA-256; saves current metadata privately before updating reconnect flags. Does not touch SQLite, `.env`, messages or automations. |
| `test/whatsapp-manager.test.js` | Mock socket concurrency, stale event, logout/re-pair, retry, restart and startup cancellation coverage. |
| `test/workspace-store.test.js` | Migration preservation, business isolation, invitation validation/expiry, owner restrictions and immediate revocation coverage. |
| `test/session-recovery.test.js` | Recovery preview, matching backup restore, overwrite refusal and unrelated-data preservation. |
| `test/production-smoke.test.js` | Independent login sessions, shared member API access, revision conflicts, persistent groups, membership revocation, media and restart regression checks; isolated authentication database and reliable teardown. |
| `test-support/dashboard-browser.js` | Separate desktop and mobile Chromium contexts and cookies, cross-device saved group list, focused-input polling and refresh checks, alongside existing messaging/automation/layout/console coverage. |

The unrelated pre-existing edit in `auth-store.js` is outside this change and is left untouched. `.env`, account metadata, database files, private keys and session directories remain ignored by Git.

## Authorization and storage

Every authenticated request resolves current workspace membership on the server. An account's `workspaceId` determines access. Its original `ownerId` is retained as the storage identity so existing `accounts/<ownerId>/<accountId>/auth` directories are not relocated. Automation and media directories remain keyed by the same account UUID. An invitation never grants access to a different business implicitly. Removing membership immediately invalidates shared-business access through existing dashboard sessions.

Selecting a business stores a server-side preference shared by that user's devices. Selecting an account only fetches state; page refresh, login and polling never request pairing or create browser-owned sockets. Pairing codes remain temporary and are not persisted in metadata.

Same-origin API requests, HTTPS proxy handling, Secure/HttpOnly/SameSite cookies, CSRF tokens, Origin checks and business ownership protections remain enabled. There is no hardcoded localhost API URL, wildcard CORS workaround or browser WhatsApp session store.

## Verification

Local Node.js 24: `npm.cmd test` exercises twelve test cases, including a broad HTTP/server/browser integration test. Real headless Chrome runs two independent cookie contexts with desktop and mobile dimensions. The integration test verifies that a selected group list becomes visible through focused mobile polling, keeps the unsaved mobile message draft, renders after blur, and survives refresh. It also covers saved messages, automation dropdowns, separate/combined delivery destinations, timing intervals, media uploads and process restart persistence.

The manager uses fake Baileys sockets and fixture credentials to prove one-socket concurrency, stale event protection, registered-session restart, genuine logout/new generation behavior, old auth preservation, transient failures and intentional disconnect during startup. No real WhatsApp send or pairing was performed in these tests. Browser runtime exceptions and console errors are checked; test process output is checked for fixture password leakage.

Production uses Node.js 22.23.3 with one PM2 fork. SSH was initially blocked, then became reachable after the user checked access. All twelve tests passed in an isolated EC2 directory with production dependencies and fixture databases. Chromium was unavailable on EC2; real browser coverage ran on Windows, while server/API/lifecycle/recovery coverage ran on both runtimes.

Following deployment, public login/signup returned HTTP 200. Authenticated dashboard, state, health and authorization requests passed through the local HTTPS Nginx proxy with full certificate validation for the public IP. Both users retained separate business access. Temporary verification sessions were removed after testing. HTTP Basic Auth issued no challenge. Recent server logs had no unhandled failure or startup error indicators.

Immediately before deployment, the live account registry contained zero WhatsApp accounts and two dashboard users. The approved recovery tool therefore performed no writes. During subsequent verification, a new account using the former number appeared under the second user, with a different account UUID and business owner. It reported `logged_out` and `requiresPairing: true`. The original backup still has registered auth credentials, one saved message and two automations belonging to the original user's business. Restoring or transferring those records would require a separate ownership decision; they were not merged into the other business or used to create a duplicate connection.

## Prepared deployment and recovery order

After approval and restored SSH access, the assistant will perform these steps; no manual code or configuration editing is needed:

1. Recheck current PM2 state, metadata and backup identity without displaying credentials. Preview recovery against the latest actual server state; refuse unexpected generations or paths.
2. Stop only the existing `whatsapp-bot` process gracefully. Back up the current database, environment, account metadata, media, automation files and all session directories into the existing private backup area. Retain the previous code revision for rollback.
3. Pull the reviewed revision. Verify installed dependencies and run isolated Node.js 22 tests without pointing test databases at production data.
4. If the original matching auth directory is still missing, apply the tested offline recovery tool to that missing directory only. Verify copied file hashes and unchanged unrelated data. Never overwrite existing authentication files.
5. Restart the same single PM2 fork. Startup applies the additive workspace migration and attempts to reconnect registered credentials. Verify preserved user/password/session records, account and automation IDs, health, public HTTPS, and absence of new startup errors.
6. Verify backend state through an authorized session and compare real phone/laptop views. Roll back code if needed; retain recovered files and existing sessions. Do not replace the live SQLite database with an older backup.

Example recovery invocation, for the assistant's approved offline deployment only:

```sh
node scripts/recover-missing-sessions.js --root /home/ec2-user/whatsapp-bot --backup "$private_backup/data"
# After graceful PM2 stop and a fresh private backup:
node scripts/recover-missing-sessions.js --root /home/ec2-user/whatsapp-bot --backup "$private_backup/data" --apply --stopped
```

## Remaining live verification and compatibility limits

- A real laptop and phone should verify the same public HTTPS URL, login or authorized workspace membership, account status and groups after deployment. The automated checks simulate this flow but do not control the user's physical devices.
- Backup credentials may have been revoked by WhatsApp. Recovery preserves and tries the registered session; it cannot guarantee that WhatsApp will accept old keys. A genuine logout still requires linking through WhatsApp.
- Keep one PM2 fork on this server. Multiple Node workers or multiple servers need a shared connection owner/lock; this change does not introduce distributed infrastructure.
- The installed Baileys release remains `7.0.0-rc14`; pairing APIs are retained. This task does not upgrade the SDK or change its protocol. Official lifecycle guidance: https://github.com/WhiskeySockets/docs/blob/main/advanced/troubleshooting.mdx
- A first successful server group fetch is needed to create an initial snapshot for existing accounts. Later restarts preserve that snapshot even while disconnected.
- Configuration revisions protect the updated dashboard against stale full-form writes. Compatibility callers that omit a revision retain the prior API behavior.
