# Recurring messages and WhatsApp Status

In Automations, choose a saved message, select Groups, WhatsApp Status, Contacts, or a combination, then choose **Repeat at intervals**. Enter a whole number and select minutes, hours, or days. Text, uploaded images, and uploaded videos use the existing message/media controls. Status viewers come from the connected account's synced contacts; no manual viewer numbers are required. WhatsApp privacy rules still determine visibility.

Text-only Status posts use an opaque green/teal background (`#008069`) and WhatsApp's system text font. These style options apply only to text Status, preserving ordinary messages and image/video content.

Status eligibility uses the PN/LID pairs in the authenticated contact snapshot before consulting Baileys' mapping cache. Missing mappings are resolved in bounded batches. An unrelated unmapped blocked/excluded identifier does not stop all eligible viewers: contacts whose eligibility cannot be verified are withheld individually. Custom allow lists stay restrictive and blocked/excluded contacts remain excluded across aliases. The Sync WhatsApp contacts button verifies the audience and reports eligible viewers; the authenticated preview endpoint returns counts only, never contact identifiers. Previewing does not publish a Status.

One-time jobs that failed before any delivery plan or send offer **Retry**. They are not automatically replayed: multiple failed attempts might represent the same intended Status. Jobs with partial or unconfirmed delivery retain the existing progress-aware controls instead of a fresh-run Retry button.

The first run defaults to one interval after saving. An optional future first-run date anchors the cadence. Intervals use elapsed time (one day = 24 hours). Existing date schedules, clock presets, and advanced cron expressions remain available.

**Interval between groups** is a separate setting from campaign repetition. A fixed 5-minute sending interval means Group 1 at the start, Group 2 after 5 minutes, Group 3 after 10 minutes, and so on. Fixed spacing supports seconds, minutes, hours, or days (up to 365 days). Existing random ranges remain available up to 600 seconds. Contacts and within-run repeats use the same spacing; a Status-only run posts once without an inter-group delay. Combined runs preserve the existing order of group/contact sends followed by one Status post.

Each schedule has Edit, Pause, Resume, and Delete controls. Editing keeps a paused schedule paused. Pause stops future sends after any send already in flight settles. A delivery plan already started keeps its original message and destinations; edits apply to subsequent occurrences. Editing a running or queued job waits until its worker stops. Cancel remains available for existing workflows.

## Background execution and recovery

- Account schedules, next interval times, delivery plans, and progress are saved privately in the existing account automation JSON. Writes use a temporary file, fsync, and atomic rename. Linux also flushes the containing directory.
- One PM2 fork owns execution. Existing per-job guards, the worker queue, and cron overlap protection prevent concurrent occurrences. Do not launch multiple independent workers against the same account files.
- Completed intervals advance from the saved cadence. Downtime skips elapsed slots and processes one overdue interval, rather than posting a backlog. Repeated timer callbacks for the same occurrence are ignored.
- Recurring work interrupted by a restart resumes automatically. Explicitly paused schedules stay paused. Interrupted one-time sends preserve the existing manual-resume behavior.
- A disconnected WhatsApp account keeps its interval schedule and retries connectivity after 30 seconds. The dashboard does not need to remain open.
- The deadline before each next group/contact delivery is persisted. Restart and pause/resume preserve the remaining wait; previously sent groups are skipped. Long gaps release the worker slot and use background timers, so another campaign can run while a job is waiting. A full campaign does not overlap its own previous run, even if group spacing takes longer than the campaign repeat interval.
- Every delivery saves its intent and a stable Baileys message ID before dispatch. Confirmed sends are not replayed. An attempt whose result cannot be confirmed is marked uncertain and is not automatically retried, including after an acknowledgement/checkpoint crash. This avoids automatic duplicates but can leave a delivery unposted when acknowledgement is lost; exactly-once remote delivery cannot be guaranteed. Subsequent scheduled occurrences continue normally. The dashboard explains unconfirmed deliveries.

## Validation

The Node test suite covers interval validation, text/image/video dispatch, combined destinations, repeat timer rearming, missed intervals, pause/resume/delete, offline retry, restart recovery, and interrupted acknowledgement persistence. HTTP tests cover ownership/authentication, uploads, create/edit actions, and schedules surviving an actual server restart. Existing authentication, account lifecycle, workspace isolation, messages, and group-list tests remain enabled.

On Windows, installed Chrome is used for actual dashboard button clicks at desktop and mobile viewport sizes, editing minutes to hours to days, pause/resume/delete, refresh persistence, independent device state, layout overflow, and browser console/network errors. EC2 runs the same server/unit suite; Chrome checks are optional when no browser is installed.

All test users, messages, phone-like identifiers, media, account storage, and databases are isolated fixtures. Automated delivery tests use a fake WhatsApp socket; they do not publish test messages or Status posts to customer accounts. Real device media playback and Status visibility remain dependent on WhatsApp and account privacy settings.
