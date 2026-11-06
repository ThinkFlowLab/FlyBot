// Test bench for the E2E suites: a dsh web whose profile links this checkout, talking to
// whatever DEEPSEEK_BASE_URL names. LIVE_E2E_MODE=live (#204) is the real DeepSeek endpoint
// with a real key from the caller's environment; LIVE_E2E_MODE=mock (#2565) is the scripted
// mock already listening on loopback and reads no key at all. This bench never starts a
// mock itself, and each mode refuses the other's configuration, so the two cannot mix.
//
//   node dev/live-e2e/bench.mjs <name> <web-port> [start|stop|reset|status]
//
// Data lives outside this checkout — `$LIVE_E2E_HOME`, else ~/.cache/flybot-live-e2e/<name> (never
// under ~/.dsh; `reset` wipes the Bot team and Sessions before starting). A home inside the
// checkout is refused: that workspace would hold the grader (#398). Environment: DEEPSEEK_API_KEY
// (required; fails loudly when the suite's own reading refuses it — see key.mjs),
// DEEPSEEK_BASE_URL (optional; defaults to the official endpoint — point it at
// dev/llm-tap.mjs to record per-call usage, or at core/dev/mock-llm.mjs in mock mode),
// DSH_HARNESS (a deepseek-harness checkout with its dependencies installed), LIVE_E2E_MODE
// (live, the default, or mock).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchHome } from './integrity.mjs'
import { keyProblem, keyReading, MOCK_KEY } from './key.mjs'
import { readMode } from './report.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const [NAME, PORT_TEXT, ACTION = 'start'] = process.argv.slice(2)
const die = (message) => { console.error(message); process.exit(1) }
if (!NAME || !/^[a-z0-9-]+$/.test(NAME) || !PORT_TEXT) die('usage: node dev/live-e2e/bench.mjs <name> <web-port> [start|stop|reset|status]')
const WEB_PORT = Number(PORT_TEXT)
if (!Number.isInteger(WEB_PORT) || WEB_PORT <= 0) die(`not a port: ${PORT_TEXT}`)
if (WEB_PORT === 3080) die('port 3080 belongs to the real service')

const { home: HOME_DIR, problem: homeProblem } = benchHome({ name: NAME, root: ROOT })
if (homeProblem) die(`${homeProblem}\n(the bench home must be outside ${ROOT}; export LIVE_E2E_HOME to choose it)`)

const MODE = readMode(process.env.LIVE_E2E_MODE)
if (MODE !== 'live' && MODE !== 'mock') die(`LIVE_E2E_MODE is ${MODE}; use live or mock`)
const loopbackEndpoint = () => {
  try { return /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)/.test(new URL(process.env.DEEPSEEK_BASE_URL ?? '').host) } catch { return false }
}
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
if (MODE === 'live') {
  const key = keyReading(apiKey)
  if (!key.usable) die(`DEEPSEEK_API_KEY ${keyProblem(key.reason)}; a real key is required (never printed)`)
} else if (!loopbackEndpoint()) {
  die('mock mode needs DEEPSEEK_BASE_URL on loopback, where the scripted mock listens; nothing was started')
}

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
  // The overlay pins the in-browser directory picker. A source checkout carries it; the
  // published runtime the mock job installs has no apps/ tree, and the smoke opens no
  // picker, so its absence is not a failure.
  const overlay = join(harness, 'apps/web/tests/pin-browse-picker.overlay.yml')
  const patches = [...(existsSync(overlay) ? ['--patch', 'apps/web/tests/pin-browse-picker.overlay.yml'] : []), '--patch', join(HOME_DIR, 'bench.patch.yml')]
  const child = spawn('pnpm', ['-s', 'dsh', '--profile', 'web', ...patches, '--no-open', '--port', String(WEB_PORT)], {
    cwd: harness,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      DSH_HOME: HOME_DIR,
      // In mock mode the bench never sees a key from this environment: the scripted mock
      // ignores auth, and a real key has no business in a run that measures no model.
      DEEPSEEK_API_KEY: MODE === 'mock' ? MOCK_KEY : apiKey,
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
  console.log(`home: ${HOME_DIR}  web: http://127.0.0.1:${WEB_PORT}  model: ${MODE === 'mock' ? 'scripted mock (no key)' : 'real (key from the environment)'}`)
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
