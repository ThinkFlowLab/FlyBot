// Rewrite the image's template web profile so plugins stay at their image
// paths (link:) and the wrapper is the only FlyBot/ds-bot bundle.
// Run during the image build after `dsh plugin --profile web add` has created
// the official DSH web template, and again after `pnpm install` so symlinks
// are absolute and still work when the template is copied to /data.
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const home = process.env.DSH_HOME || '/opt/dsh-template'
const profile = join(home, 'profiles', 'web')
mkdirSync(profile, { recursive: true })

const ROOT = '/opt/flybot-workspace/runtime'
const LINKS = {
  '@flybot-workspace/flybot-runtime': `${ROOT}/flybot-image/plugin`,
  '@flybot-workspace/flybot-social-host': `${ROOT}/flybot-social-host`,
  '@flybot/social': `${ROOT}/flybot/plugins/social`,
  '@flybot-workspace/flybot-web-slots': `${ROOT}/flybot-web-slots`,
  '@flybot-workspace/flybot-social-web': `${ROOT}/flybot-web-slots/social-web`,
  '@flybot-workspace/web': `${ROOT}/flybot-workspace-web`,
  'ds-bot': `${ROOT}/ds-bot-upstream/ds-bot`,
}
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const OUR_BUNDLE = '@flybot-workspace/flybot-runtime'

const path = join(profile, 'package.json')
const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { name: 'dsh-profile-web', private: true }
const next = structuredClone(current)
next.private = true
next.dependencies = { ...(next.dependencies ?? {}) }
for (const [name, dir] of Object.entries(LINKS)) {
  next.dependencies[name] = `link:${dir}`
}
next.dsh = { ...next.dsh, profile: { ...next.dsh?.profile } }
const bundles = [...(next.dsh.profile.bundles ?? BASE_BUNDLES)]
// The wrapper calls createRuntime itself. Do not also bundle upstream ds-bot,
// or the runtime would start twice.
const filtered = bundles.filter((name) => name !== 'ds-bot' && name !== OUR_BUNDLE)
if (!filtered.includes('@deepseek-ai/dsh-base')) filtered.unshift('@deepseek-ai/dsh-base')
if (!filtered.includes('@deepseek-ai/dsh-web-app')) filtered.splice(1, 0, '@deepseek-ai/dsh-web-app')
if (!filtered.includes(OUR_BUNDLE)) filtered.push(OUR_BUNDLE)
if (!filtered.includes('@flybot-workspace/flybot-social-web')) filtered.push('@flybot-workspace/flybot-social-web')
// FlyBot pages and /api/flybot-workspace, served by this user's own DS-Bot.
if (!filtered.includes('@flybot-workspace/web')) filtered.push('@flybot-workspace/web')
next.dsh.profile.bundles = filtered

writeFileSync(path, JSON.stringify(next, null, 2) + '\n')
const workspace = join(profile, 'pnpm-workspace.yaml')
if (!existsSync(workspace)) {
  writeFileSync(workspace, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

// pnpm may write a relative symlink from /opt/dsh-template/profiles/web that
// breaks after the entrypoint copies the template to /data. Force absolute.
for (const [name, dir] of Object.entries(LINKS)) {
  const dest = join(profile, 'node_modules', name)
  mkdirSync(dirname(dest), { recursive: true })
  try { lstatSync(dest); rmSync(dest, { recursive: true, force: true }) } catch { /* no existing link */ }
  symlinkSync(dir, dest)
  console.log('linked', name, '->', dir)
}
console.log('prepared template profile', dirname(path), 'bundles=', next.dsh.profile.bundles.join(','))
