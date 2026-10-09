# Production pre-deployment review

## Current check result — 2026-10-09

- **80/80 automated tests passed** on Node 22.23.3 in the exact source-only
  release candidate, excluding the unrelated authentication edit. This includes
  real Chromium desktop/mobile checks and **17 backup/release tests**. The
  earlier 79-test workspace suite also passed on Node 24.21.0; the additional
  test verifies deadline cancellation during SQLite backup on Node 22.23.3.
- **23 commands** are included: 12 group, 3 media, 4 utilities, 4 basic.
- The explicit 35-file release review passes. No private runtime files are
  selected or staged. Main matches GitHub main at the existing commit; no push
  or commit has been performed. The source-only candidate was assembled outside
  the repository for validation, without copying customer data or `.env`.
- Production dependency audit reports **zero known vulnerabilities**. Actual
  Sharp and FFmpeg conversions pass locally; built-in SQLite online backup
  preserves committed WAL records and original files in isolated tests.
- AWS CLI authentication and SSM access now pass. The server runs Node 22.23.3,
  PM2 is online with PID 110438, and the local dashboard returns HTTP 200.
  The clean server checkout and GitHub main match at `a6722f6eaffa`.
- EC2 Sharp 0.35.5 and the exact Linux binary selected by ffmpeg-static 5.3.0
  passed synthetic WebP/animated WebP/MP3 conversion checks. FFmpeg was tested
  outside the live checkout; its temporary test files were removed.
- **Production backup verified without downtime:** the improved helper saved
  53,902 private files and the SQLite snapshot in
  `/home/ec2-user/.whatsapp-bot-backups/predeployment-2026-10-09T17-07-20-702Z-3bc8921f/`.
  A separate read-only verification passed all JSON, SHA-256, directory,
  owner-only permission, manifest/marker and SQLite integrity checks.
  Live directory changes caused two inventory retries; the backup succeeded
  on round two, refreshing six files rather than recopying the entire tree.
  PM2's PID remained 110438, the dashboard returned HTTP 200, and the production
  checkout stayed clean at `a6722f6eaffa`. No deployment or PM2 restart occurred.

The remainder describes the prepared workflow. No deployment is authorized.

The proposed release targets the existing GitHub `main` and the existing
Session Manager workflow. No push, production code update, PM2 restart, database
reset, session deletion or AWS security-setting change is authorized by this
pre-deployment phase.

## Local release review

`deploy/production-release-files.json` is the explicit list of source, tests,
templates and documentation intended for release. `scripts/production-preflight.js`
checks that list, rejects private runtime paths and high-confidence secret
patterns, validates 23 commands and checks staged files. It does not stage,
commit, push or deploy. Pattern scanning is a review aid, not a guarantee against
every possible secret format. Never use an indiscriminate `git add .`.

The unrelated `auth-store.js` edit is excluded. Obsolete phone/password properties
were removed from the tracked sample `messages.json`. Production private
configuration is not overwritten by this local edit. `.env.example` remains a
public template; real configuration, SQLite/WAL files, WhatsApp credentials,
backups and sandbox runtime data are excluded. The local sandbox launcher/tests
are ordinary source code, not private runtime files.

## Remote checks and backup

Run the existing workflow's `preflight` action only to verify access. Its check
mode fetches GitHub metadata and probes backup-directory write access, but cannot
update the checkout or restart PM2. Browser AWS sign-in must be completed for the
local CLI profile; a Console session alone does not renew the CLI credentials.

The new `backup` action executes `deploy/ssm-predeployment-backup.js` through the
existing SSM SSH transport. It does not install the script on the server or
change production code. The backup stays in
`/home/ec2-user/.whatsapp-bot-backups/predeployment-<timestamp>/`, with owner-only
directories/files, outside Git. SQLite's online backup API captures committed WAL
data and verifies integrity. Other private files are copied to temporary files
inside a fresh private backup, JSON-validated, SHA-256 checked, and renamed only
after the source descriptor/path versions agree. Nanosecond modification/change
times, inode, size and mode detect writes or replacements during the read.
Transient missing files and directory changes are retried. Successful copies
are reused; subsequent rounds refresh only changed files. Empty directories and
legacy `groups.txt` are included. Only stale copies inside the new backup may
be removed; production files and previous backups are never edited or deleted.

The defaults allow four attempts per file, three inventory attempts, four
consistency rounds and a five-minute overall deadline. Complete file membership,
directory versions and source versions must agree before and after the SQLite
snapshot. The SQLite copy is made self-contained by changing journaling only
on the backup copy. A format-2 private manifest records hashes and verification
counters. `verifyPredeploymentBackup` independently validates every saved JSON,
hash, directory, permission and the SQLite integrity result. PM2 must stay online
with the same PID. `VERIFIED` is written last, after all checks pass. Failures
produce a sanitized reason code, without filenames or credential values.

Baileys uses ordinary truncating `writeFile` calls with a process-local mutex.
The backup process cannot acquire that mutex, so copying while a write is in
progress can capture incomplete JSON. The old helper also aborted on a deleted
key and repeatedly recopied the whole tree, making its race window unnecessarily
long. The new tests reproduce these races deterministically and check bounded
failure when writes never settle. The successful production run directly
observed directory changes and retried them. A live observation of the three affected
production originals found them valid and unchanged over twelve seconds;
there is no evidence those original credentials were corrupt.

This is an online pre-deployment restore point, not a cross-store transaction
freeze or an off-instance disaster-recovery backup. After final approval, the
existing deployment workflow additionally stops the app briefly and creates a
fresh backup immediately before updating it. That stopped backup provides the
final coordinated rollback snapshot. If ongoing writes exhaust the online limits,
report the backup as unverified. Propose a separate backup-only maintenance step:
first obtain explicit approval, gracefully stop only `whatsapp-bot`, copy and
verify all private files and SQLite data, then immediately restart the existing
process even if verification fails. This must not pull code, install dependencies,
or deploy. No stop/restart is permitted by the current backup investigation.

The existing bot requires Node 22.13 or later. The online backup helper additionally
requires the built-in SQLite backup API (Node 22.16 or later); this has been
verified on Node 22.23.3 locally and on EC2. Sharp/FFmpeg are verified using real
synthetic media conversions locally and on EC2. The EC2 runtime and production
dependency installation are checked over SSM. Installation of new dependencies
into the live checkout is deferred until approval. No live customer messages
are sent.

## Final approval gate

Before asking for final deployment approval, report:

- Automated test results and reviewed file count.
- Session Manager access, current server/GitHub commits and clean server checkout.
- PM2 online status/PID, Node version and native dependency results.
- Verified backup path and SQLite integrity.
- Any blocked checks or risks.

Approval covers committing/pushing the reviewed source to `main`, invoking the
existing deployment action, its brief PM2 stop/restart, automatic additive
migration and final dashboard/session verification. Backups/environment/session
files must never be staged. If anything remains blocked, report it and wait;
do not request approval as though the release is ready.
