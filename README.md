# WhatsApp Bot

Dashboard and scheduled messaging service built with Node.js, Express, Baileys, and per-account JSON storage.

## Local start

Use Node.js 22.13 or newer and install the locked dependencies:

```sh
npm ci
node bot.js
# or: npm start
```

The dashboard binds to `127.0.0.1:3000` by default. Visit `/signup` to create a user account, then sign in with its email and password. The first user inherits existing unowned WhatsApp accounts during the one-time migration. For an existing installation, restrict dashboard access to the owner until that first account has been created; then open access for other signups. Users can connect more WhatsApp accounts from the dashboard. User accounts, sessions, and password-reset records are stored in the local `auth.sqlite` database, created automatically with private file permissions. Run `npm test` for the automated integration checks.

## Production files and configuration

Copy `.env.example` to `.env` on the server only and keep it restricted to its owner (`chmod 600 .env`); it is ignored by Git. Both `node bot.js` and the PM2 ecosystem config load it. Account authentication never reads credentials from `messages.local.json`. Keep the repository-owned `messages.json` as defaults; private overrides belong in ignored `messages.local.json`.

Password reset emails are optional for account signup and login. To enable resets, configure `PUBLIC_BASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and (when required by the mail host) `SMTP_USER` and `SMTP_PASSWORD` in the server-only `.env`. Reset tokens are single-use, expire after one hour, and are sent in a URL fragment so they are not included in HTTP requests or access logs. Forgot-password responses do not reveal whether an email is registered.

For the Nginx setup in `deploy/nginx-whatsapp-bot.conf.example`, leave `DASHBOARD_HOST=127.0.0.1`, use port `3000`, and set `DASHBOARD_TRUST_PROXY=loopback`. The app then trusts forwarded scheme and host information only from loopback, so HTTPS-origin validation and `Secure` cookies work behind local Nginx. Do not set trust proxy if another machine can connect directly to port 3000. For direct Node TLS, bind only when needed and keep TLS key files outside this repository.

## PM2

From this directory, install PM2 and launch the single fork-mode process:

```sh
npm install -g pm2
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

Run the exact startup command printed by `pm2 startup` once as instructed for the EC2 user. After that, `pm2 save` records the process list for reboot recovery. One PM2 instance is intentional: multiple workers would create duplicate WhatsApp sockets and schedulers.

The simple alternative, when environment variables have already been exported into the shell, is:

```sh
pm2 start bot.js --name whatsapp-bot
pm2 save
pm2 startup
```

Rotate PM2 logs and inspect the app with:

```sh
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 status
pm2 monit
pm2 logs whatsapp-bot --lines 100
```

Application logs go to stdout/stderr for PM2 to rotate. The authenticated `/api/log` dashboard view retains only the last 500 process log lines in memory. Never log passwords, pairing codes, cookies, auth state, API tokens, or private keys.

## AWS and HTTPS

For Nginx termination, expose inbound TCP 443 to the intended clients and TCP 22 only from restricted administrator IP ranges. Port 80 may be exposed only for HTTP-to-HTTPS redirects or certificate renewal. Do not open 3000 or WhatsApp's outbound service ports inbound. Permit outbound DNS and HTTPS so Node can reach WhatsApp and package/certificate services. Restrict the EC2 security group and host firewall consistently.

Set a real DNS name to the EC2 public address, install Nginx and a certificate (for example, using the host's ACME client), replace the placeholder server name and certificate paths in the template, validate with `sudo nginx -t`, then reload Nginx. Keep the private TLS key outside the Git checkout with owner-only permissions. The Nginx template is a starting point and does not obtain DNS or certificates automatically.

The `/health` endpoint requires dashboard authentication and reports aggregate status only: process uptime, resident memory, sampled CPU, scheduler state, account connection counts, active/queued jobs, and failed-job count. `pm2 status`, `pm2 monit`, restart counts, and the rotated logs are the lightweight process monitor. Do not expose port 3000 to make a public health probe.

## Data and backups

Back up `auth.sqlite`, `accounts.json`, the complete `accounts/` tree (including per-user WhatsApp `auth/` directories and each `automation.json`), `messages.json`, and any server-only `messages.local.json` and media files needed by jobs. Keep `.env` and TLS private keys in a separate encrypted secrets backup or password manager. WhatsApp auth directories and contact/group configuration are sensitive. Store encrypted backups in a private, access-controlled location with a separate encryption key; never use GitHub for these files. Test restores on an isolated host and ensure only one live instance uses a given WhatsApp account session at a time.

Storage writes use temporary files and atomic rename on the same filesystem. This is appropriate for a small single-process deployment; do not run multiple app instances against these JSON files. Keep disk space monitored and retain dated backups outside the EC2 root volume.

## Safe update and rollback

Keep `.env`, `messages.local.json`, `accounts.json`, `accounts/`, and media outside Git tracking. Before deployment, make a dated encrypted backup and confirm `git status --short` has no private files. Then:

```sh
git status --short
git pull --ff-only
npm ci --omit=dev
pm2 restart whatsapp-bot --update-env
pm2 status
pm2 logs whatsapp-bot --lines 100
```

With the ecosystem file, `pm2 restart whatsapp-bot --update-env` reloads its config; if the process is stopped or needs a new config, use `pm2 start ecosystem.config.cjs --env production`. For rollback, inspect `git log -n 5 --oneline`, check the working tree, then use `git switch --detach <previous-commit>` and reinstall/restart. Return to the deployment branch with `git switch <branch>` afterward. Do not use `git reset --hard` or `git clean`; restore data from backup only through an explicit, verified procedure.

## Bot Commands

The existing dashboard now includes opt-in group administration, media conversion,
automatic replies and command-based scheduling/broadcasts. See
[Bot Commands: features, tests, migration, deployment and rollback](docs/bot-commands.md).
New feature commands start disabled; no additional secret is required.
For a separate local instance with empty test data and a spare WhatsApp account,
see [the isolated local testing guide](docs/local-command-testing.md).
The [production pre-deployment review](docs/production-predeployment.md) describes
the explicit release file list and the backup/approval checks.

## Runtime and capacity

The app allows at most two active send jobs and 500 saved jobs per account. A t3.micro is suitable only for a small number of accounts and modest scheduling volume; Baileys connections, media sends, and Nginx compete for limited memory/CPU. Start with one account, monitor `pm2 monit` and EC2 memory, and increase instance size before increasing concurrency. The PM2 memory restart threshold is 500 MB and should be adjusted only after observing real usage.

The authentication database uses Node's built-in SQLite module, available without a flag from Node 22.13. Deploy on a supported LTS line (Node 22.13 or later) and validate the Baileys release there. The locked Baileys package is `7.0.0-rc14`, a release candidate; WhatsApp compatibility can change independently of this code.
