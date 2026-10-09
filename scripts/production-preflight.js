import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { COMMANDS } from '../commands/catalog.js'

export function privateReleasePath(file) {
  const normalized = file.replaceAll('\\', '/'), basename = normalized.split('/').at(-1)
  return normalized.startsWith('/') || normalized.split('/').some(part => ['..', 'accounts', 'auth', 'backups', '.whatsapp-bot-backups', 'sandbox-data', '.sandbox'].includes(part)) ||
    /^\.env(?:\.|$)/.test(basename) && basename !== '.env.example' ||
    /\.(?:sqlite3?|db)(?:[-.]|$)|\.(?:pem|key|session|log)$/.test(basename) ||
    /^(?:accounts\.json|messages\.local\.json|creds\.json|process\.json|private-files-before\.json|manifest\.json)$/.test(basename)
}
export function inspectReleaseText(file, content) {
  const findings = []
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) findings.push('private key')
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(content)) findings.push('AWS access key')
  if (/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/.test(content)) findings.push('JWT-like token')
  if (file === 'messages.json') {
    const data = JSON.parse(content)
    if (['phone', 'dashboardPassword', 'dashboardPasswordHash', 'apiKey', 'token'].some(key => Object.hasOwn(data, key))) findings.push('obsolete/private defaults')
  }
  // Results contain only the file and finding type, never the matched values.
  return findings
}
export function checkRelease(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deploy/production-release-files.json'), 'utf8'))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  if (git(['branch', '--show-current']) !== manifest.branch) throw Error('The release must be prepared on main.')
  if (new Set(manifest.files).size !== manifest.files.length) throw Error('Duplicate release file paths.')
  const findings = []
  for (const file of manifest.files) {
    if (privateReleasePath(file)) { findings.push({ file, issue: 'private runtime path' }); continue }
    const ignored = spawnSync('git', ['check-ignore', '--no-index', file], { cwd: root, stdio: 'ignore' })
    if (ignored.status !== 1) { findings.push({ file, issue: ignored.status === 0 ? 'release source is ignored by Git' : 'Git ignore validation failed' }); continue }
    const absolute = path.resolve(root, file)
    if (!absolute.startsWith(root + path.sep) || !fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink()) { findings.push({ file, issue: 'missing or unsafe release file' }); continue }
    for (const issue of inspectReleaseText(file, fs.readFileSync(absolute, 'utf8'))) findings.push({ file, issue })
  }
  const staged = git(['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean)
  for (const file of staged) if (!manifest.files.includes(file) || privateReleasePath(file)) findings.push({ file, issue: 'staged outside the reviewed release' })
  const categories = Object.fromEntries([...new Set(COMMANDS.map(c => c.category))].map(category => [category, COMMANDS.filter(c => c.category === category).length]))
  if (COMMANDS.length !== 23 || categories['Group Administration'] !== 12 || categories['Media Tools'] !== 3 || categories['WhatsApp Utilities'] !== 4 || categories.Basic !== 4) findings.push({ file: 'commands/catalog.js', issue: 'unexpected command catalog' })
  return { ok: findings.length === 0, branch: manifest.branch, reviewedSourceFiles: manifest.files.length, stagedFiles: staged.length, commandCount: COMMANDS.length, categories, excludedLocalEdits: manifest.excludedLocalEdits, findings, runtimeSandboxDataOutsideGit: true }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = checkRelease(); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1 }
  catch { console.error('The release check could not complete. No files were staged or published.'); process.exitCode = 1 }
}
