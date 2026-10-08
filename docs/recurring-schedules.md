# Recurring messages and WhatsApp Status

In Automations, choose a saved message, select Groups, WhatsApp Status, Contacts, or a combination, then choose **Repeat at intervals**. Enter a whole number and select minutes, hours, or days. Text, uploaded images, and uploaded videos use the existing message/media controls. Status viewers come from the connected account's synced contacts; no manual viewer numbers are required. WhatsApp privacy rules still determine visibility.

The first run defaults to one interval after saving. An optional future first-run date anchors the cadence. Intervals use elapsed time (one day = 24 hours). Existing date schedules, clock presets, and advanced cron expressions remain available. The wait between individual sends is separate from the campaign repeat interval.

Each schedule has Edit, Pause, Resume, and Delete controls. Editing keeps a paused schedule paused. Pause stops future sends after any send already in flight settles. A delivery plan already started keeps its original message and destinations; edits apply to subsequent occurrences. Editing a running or queued job waits until its worker stops. Cancel remains available for existing workflows.

## Background execution and recovery

- Account schedules, next interval times, delivery plans, and progress are saved privately in the existing account automation JSON. Writes use a temporary file, fsync, and atomic rename. Linux also flushes the containing directory.
- One PM2 fork owns execution. Existing per-job guards, the worker queue, and cron overlap protection prevent concurrent occurrences. Do not launch multiple independent workers against the same account files.
- Completed intervals advance from the saved cadence. Downtime skips elapsed slots and processes one overdue interval, rather than posting a backlog. Repeated timer callbacks for the same occurrence are ignored.
- Recurring work interrupted by a restart resumes automatically. Explicitly paused schedules stay paused. Interrupted one-time sends preserve the existing manual-resume behavior.
- A disconnected WhatsApp account keeps its interval schedule and retries connectivity after 30 seconds. The dashboard does not need to remain open.
- Every delivery saves its intent and a stable Baileys message ID before dispatch. Confirmed sends are not replayed. An attempt whose result cannot be confirmed is marked uncertain and is not automatically retried, including after an acknowledgement/checkpoint crash. This avoids automatic duplicates but can leave a delivery unposted when acknowledgement is lost; exactly-once remote delivery cannot be guaranteed. Subsequent scheduled occurrences continue normally. The dashboard explains unconfirmed deliveries.

## Validation

The Node test suite covers interval validation, text/image/video dispatch, combined destinations, repeat timer rearming, missed intervals, pause/resume/delete, offline retry, restart recovery, and interrupted acknowledgement persistence. HTTP tests cover ownership/authentication, uploads, create/edit actions, and schedules surviving an actual server restart. Existing authentication, account lifecycle, workspace isolation, messages, and group-list tests remain enabled.

On Windows, installed Chrome is used for actual dashboard button clicks at desktop and mobile viewport sizes, editing minutes to hours to days, pause/resume/delete, refresh persistence, independent device state, layout overflow, and browser console/network errors. EC2 runs the same server/unit suite; Chrome checks are optional when no browser is installed.

All test users, messages, phone-like identifiers, media, account storage, and databases are isolated fixtures. Automated delivery tests use a fake WhatsApp socket; they do not publish test messages or Status posts to customer accounts. Real device media playback and Status visibility remain dependent on WhatsApp and account privacy settings.
