// Shared test helpers for B3 feature modules: boot the real plugin entry with a
// fresh volume and call moved legacy routes through '<feature>/v1' on
// POST /api/flybot-workspace, exactly as the browser shim does.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { API_PATH } from '../src/dispatch.js'
import { loadIdentity } from '../src/identity.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..', '..')

export function fakeCtx() {
  const routes = new Map()
  return {
    routes,
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    effect(fn) { fn() },
  }
}

export function volume() {
  const root = mkdtempSync(join(tmpdir(), 'ot-feature-'))
  const pages = join(root, 'pages')
  const data = join(root, 'data')
  mkdirSync(pages)
  mkdirSync(data)
  return { root, pages, data }
}

export async function boot(vol = volume()) {
  const ctx = fakeCtx()
  const result = apply(ctx, { pagesDir: vol.pages, dataDir: vol.data })
  const features = await result.features
  const api = ctx.routes.get(API_PATH)
  async function endpoint(name, payload) {
    const response = await api.fetch(new Request(`http://10.0.0.2:8080${API_PATH}`, { method: 'POST', body: JSON.stringify({ endpoint: name, payload }) }))
    return response.json()
  }
  async function call(feature, method, path, body, idempotencyKey) {
    const result = await endpoint(`${feature}/v1`, { method, path, body, idempotency_key: idempotencyKey })
    if (!result.ok) throw new Error(`${feature}/v1 failed: ${JSON.stringify(result.error)}`)
    const value = result.value
    if (value.download) value.text = Buffer.from(value.download.data, 'base64').toString('utf8')
    return value
  }
  return { ctx, vol, call, endpoint, features, identity: result.identity }
}

// Legacy data for test accounts, exported by the real platform code.
export function legacyBundles(features) {
  const run = spawnSync('python3', [join(HERE, 'fixtures', 'legacy_bundle.py'), ...features], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.status !== 0) throw new Error('legacy bundle fixture failed: ' + String(run.stderr).slice(-2000))
  return JSON.parse(run.stdout)
}

export function deliverBundle(vol, name, text) {
  const dir = join(vol.data, 'flybot-workspace', 'import')
  const {routingInstanceId, instanceId} = loadIdentity({env:process.env, dataDir:vol.data})
  const bundle = JSON.parse(text)
  bundle.instance_id ??= routingInstanceId ?? instanceId
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(bundle))
}

export const WS = 'a'.repeat(32)

export async function bootMemory(vol = volume(), {personal = WS, teams = []} = {}) {
  const bot = await boot(vol)
  bot.features.table['agents/personal-binding'] = async () => ({workspace_id:personal})
  bot.features.table['teams/activeWorkspaces'] = async () => teams.map(id => ({id}))
  return bot
}

let counter = 0
export const key = () => `test-key-${String(++counter).padStart(6, '0')}-${process.pid}`
