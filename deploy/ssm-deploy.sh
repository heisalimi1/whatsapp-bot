#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
cd /home/ec2-user/whatsapp-bot
test "$(id -un)" = ec2-user
test -w . && test -w .git
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain --untracked-files=no)"
git fetch origin main --quiet
before="$(git rev-parse HEAD)"
target="$(git rev-parse origin/main)"
printf 'Server commit: %.12s; GitHub main: %.12s\n' "$before" "$target"
# Refuse a release that puts private storage under Git's control.
test -z "$(git ls-tree -r --name-only "$target" -- .env accounts.json accounts auth auth.sqlite auth.sqlite-wal auth.sqlite-shm messages.local.json images groups.txt log.txt)"
git merge-base --is-ancestor "$before" "$target"
npm ls --omit=dev --depth=0 > /dev/null 2>&1
node --input-type=module <<'NODE'
import cp from 'node:child_process';import assert from 'node:assert/strict';
const apps=JSON.parse(cp.execFileSync('pm2',['jlist'],{encoding:'utf8'})).filter(a=>a.name==='whatsapp-bot');
assert.equal(apps.length,1);assert.equal(apps[0].pm2_env.status,'online');
console.log(JSON.stringify({deploymentAccess:true,node:process.version,pm2:'online',pid:apps[0].pid}));
NODE
curl --silent --fail --max-time 5 --output /dev/null http://127.0.0.1:3000/login
mkdir -p /home/ec2-user/.whatsapp-bot-backups
probe="$(mktemp /home/ec2-user/.whatsapp-bot-backups/ssm-access-check.XXXXXXXX)"
rm -- "$probe"
if [ "${1:-}" = --check ]; then
  printf 'Deployment access verified. No code, production data or PM2 processes changed.\n'
  exit 0
fi
if [ "$before" = "$target" ]; then
  printf 'Already deployed; PM2 was not restarted.\n'
  exit 0
fi
backup="/home/ec2-user/.whatsapp-bot-backups/ssm-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup/data"
git archive HEAD | gzip > "$backup/code-before.tar.gz"
printf '%s\n' "$before" > "$backup/commit-before"
export SSM_DEPLOY_BACKUP="$backup"
trap 'pm2 restart whatsapp-bot > "$backup/recovery-restart.log" 2>&1 || true' ERR
pm2 stop whatsapp-bot > "$backup/pm2-stop.log" 2>&1
for item in .env accounts.json accounts auth auth.sqlite auth.sqlite-wal auth.sqlite-shm messages.local.json messages.json images groups.txt log.txt; do
  if [ -e "$item" ]; then cp -a -- "$item" "$backup/data/"; fi
done
node --input-type=module <<'NODE'
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const files=[],digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const visit=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isSymbolicLink())throw Error('Private storage contains an unsupported symbolic link');if(item.isDirectory())visit(file);else if(item.isFile())files.push({file,digest:digest(file)});}};
for(const dir of ['accounts','auth','images'])if(fs.existsSync(dir))visit(dir);
for(const file of ['.env','accounts.json','messages.local.json','auth.sqlite','auth.sqlite-wal','auth.sqlite-shm'])if(fs.existsSync(file))files.push({file,digest:digest(file)});
fs.writeFileSync(path.join(process.env.SSM_DEPLOY_BACKUP,'private-files-before.json'),JSON.stringify(files),{mode:0o600});
console.log('Private production data backed up.');
NODE
git merge --ff-only origin/main --quiet
npm ci --omit=dev > "$backup/npm-install.log" 2>&1
node --check bot.js
node --check whatsapp-manager.js
node --input-type=module <<'NODE'
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const files=JSON.parse(fs.readFileSync(path.join(process.env.SSM_DEPLOY_BACKUP,'private-files-before.json'),'utf8'));
for(const entry of files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex'),entry.digest,'Private production data changed during deployment');
console.log(JSON.stringify({privateFilesPreserved:files.length}));
NODE
pm2 restart whatsapp-bot > "$backup/pm2-restart.log" 2>&1
pm2 save > "$backup/pm2-save.log" 2>&1
for attempt in $(seq 1 20); do
  if curl --silent --fail --max-time 2 --output /dev/null http://127.0.0.1:3000/login; then break; fi
  sleep 1
done
curl --silent --fail --max-time 5 --output /dev/null http://127.0.0.1:3000/login
node --input-type=module <<'NODE'
import cp from 'node:child_process';import assert from 'node:assert/strict';
const apps=JSON.parse(cp.execFileSync('pm2',['jlist'],{encoding:'utf8'})).filter(a=>a.name==='whatsapp-bot');
assert.equal(apps.length,1);assert.equal(apps[0].pm2_env.status,'online');
console.log(JSON.stringify({deployed:cp.execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim(),pm2:'online'}));
NODE
trap - ERR
