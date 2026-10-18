// Real-model test bench for the live E2E suite (#204): a dsh web whose profile links
// this checkout, talking to the real DeepSeek endpoint with DEEPSEEK_API_KEY from the
// caller's environment. The mock bench stays core/dev/bench.sh; this one never starts a
// mock and refuses to run without a real key, so the two suites cannot mix.
//
//   node dev/live-e2e/bench.mjs <name> <web-port> [start|stop|reset|status]
//
// Data lives in <repo>/.dsh-test-<name> (never under ~/.dsh; `reset` wipes the Bot team
// and Sessions before starting). Environment: DEEPSEEK_API_KEY (required; fails loudly
// when missing or the mock's), DEEPSEEK_BASE_URL (optional; defaults to the official
// endpoint — point it at dev/llm-tap.mjs to record per-call usage), DSH_HARNESS (a
// deepseek-harness checkout with its dependencies installed).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const [NAME, PORT_TEXT, ACTION = 'start'] = process.argv.slice(2)
const die = (message) => { console.error(message); process.exit(1) }
if (!NAME || !/^[a-z0-9-]+$/.test(NAME) || !PORT_TEXT) die('usage: node dev/live-e2e/bench.mjs <name> <web-port> [start|stop|reset|status]')
const WEB_PORT = Number(PORT_TEXT)
if (!Number.isInteger(WEB_PORT) || WEB_PORT <= 0) die(`not a port: ${PORT_TEXT}`)
if (WEB_PORT === 3080) die('port 3080 belongs to the real service')

const HOME_DIR = join(ROOT, `.dsh-test-${NAME}`)
if (HOME_DIR === homedir() || HOME_DIR.startsWith(`${homedir()}/.dsh`)) die(`refusing to use ${HOME_DIR}: the bench never touches the user's own DSH data`)

const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
if (!apiKey || apiKey === 'mock-key' || apiKey.length < 16) die('DEEPSEEK_API_KEY is missing, too short, or the mock\'s; a real key is required (never printed)')

const harness = process.env.DSH_HARNESS ?? join(ROOT, 'deepseek-harness')
if (!existsSync(join(harness, 'package.json'))) die(`no deepseek-harness checkout at ${harness}; set DSH_HARNESS (see CONTRIBUTING.md)`)

const PLUGIN = join(ROOT, 'core')
const webPidFile = join(HOME_DIR, 'web.pid')
const logFile = join(HOME_DIR, 'web.log')
const sleep = ms => new Promise(done => setTimeout(done, ms))
const alive = (pid) => { try { process.kill(-pid, 0); return true } catch { return false } }

async function stopWeb() {
  if (!existsSync(webPidFile)) return
  const pid = Number(readFileSync(webPidFile, 'utf8').trim())
  try { process.kill(-pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 50 && alive(pid); i += 1) await sleep(200)
  try { process.kill(-pid, 'SIGKILL') } catch {}
  rmSync(webPidFile, { force: true })
}

function ensureProfile() {
  const profile = join(HOME_DIR, 'profiles/web')
  const manifest = join(profile, 'package.json')
  // The install marker is the linked package itself: a crash between writing the
  // manifest and finishing the install must not look like a done install.
  if (existsSync(manifest) && readFileSync(manifest, 'utf8').includes(`"link:${PLUGIN}"`) && existsSync(join(profile, 'node_modules/ds-bot'))) return
  mkdirSync(profile, { recursive: true })
  // Pin the harness checkout's own package manager, so corepack runs the version the
  // harness expects instead of a cached default.
  let packageManager = ''
  try { packageManager = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8')).packageManager ?? '' } catch {}
  const manifestContent = {
    name: 'dsh-profile-web',
    private: true,
    ...(packageManager ? { packageManager } : {}),
    dependencies: { 'ds-bot': `link:${PLUGIN}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } },
  }
  writeFileSync(manifest, `${JSON.stringify(manifestContent, null, 2)}\n`)
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const result = spawnSync('pnpm', ['install'], { cwd: profile, stdio: 'inherit', env: { ...process.env, DSH_HOME: HOME_DIR } })
  if (result.status !== 0) die(`pnpm install failed in ${profile}`)
}

async function start() {
  mkdirSync(HOME_DIR, { recursive: true })
  ensureProfile()
  // The real catalog supplies its own context window: no models overlay.
  writeFileSync(join(HOME_DIR, 'bench.patch.yml'), '[]\n')
  if (existsSync(webPidFile) && alive(Number(readFileSync(webPidFile, 'utf8')))) return status()
  rmSync(logFile, { force: true })
  // The login token URL lands in web.log, which the evidence sanitizer strips before
  // anything is uploaded. Detached, the child is its own process group: the pid file
  // names the group, and a later stop reaches the whole tree.
  const out = openSync(logFile, 'a')
  const child = spawn('pnpm', ['-s', 'dsh', '--profile', 'web', '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml', '--patch', join(HOME_DIR, 'bench.patch.yml'), '--no-open', '--port', String(WEB_PORT)], {
    cwd: harness,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      DSH_HOME: HOME_DIR,
      DEEPSEEK_API_KEY: apiKey,
      ...(process.env.DEEPSEEK_BASE_URL ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } : {}),
    },
  })
  child.unref()
  writeFileSync(webPidFile, `${child.pid}\n`)
  for (let i = 0; i < 180; i += 1) {
    await sleep(1000)
    if (existsSync(logFile) && readFileSync(logFile, 'utf8').includes('dsh web: http')) return status()
    if (!alive(child.pid)) {
      await stopWeb()
      die(`dsh web exited early; see ${logFile} (tokens redacted):\n${tailSanitized()}`)
    }
  }
  await stopWeb()
  die(`dsh web did not start; see ${logFile} (tokens redacted):\n${tailSanitized()}`)
}

function tailSanitized() {
  if (!existsSync(logFile)) return ''
  return readFileSync(logFile, 'utf8').split('\n').slice(-20).map(line => line.replace(/\?token=\S+/g, '?token=…')).join('\n')
}

function status() {
  const running = existsSync(webPidFile) && alive(Number(readFileSync(webPidFile, 'utf8')))
  console.log(`web: ${running ? `running (pid ${readFileSync(webPidFile, 'utf8').trim()})` : 'stopped'}`)
  console.log(`home: ${HOME_DIR}  web: http://127.0.0.1:${WEB_PORT}  model: real (key from the environment)`)
}

switch (ACTION) {
  case 'start':
    await start()
    break
  case 'stop':
    await stopWeb()
    status()
    break
  case 'reset': {
    await stopWeb()
    rmSync(join(HOME_DIR, 'cookies.txt'), { force: true })
    rmSync(join(HOME_DIR, 'bot'), { recursive: true, force: true })
    const sessions = join(HOME_DIR, 'sessions')
    if (existsSync(sessions)) {
      for (const dir of readdirSync(sessions)) {
        if (!dir.includes('workspace')) continue
        for (const entry of readdirSync(join(sessions, dir))) {
          if (entry.startsWith('session-')) rmSync(join(sessions, dir, entry), { recursive: true, force: true })
        }
      }
    }
    await start()
    break
  }
  case 'status':
    status()
    break
  default:
    die(`unknown action ${ACTION}`)
}
