// Feature extension point (stable interface; see docs/DSBOT_PLUGIN_ARCHITECTURE.md §2.1).
//
// Each feature lives in runtime/flybot-workspace-web/features/<name>/index.js and default-
// exports a factory:
//
//   export default function feature(host) {
//     return {
//       endpoints: {                 // POST /api/flybot-workspace {endpoint: '<name>/<op>', payload}
//         async list(payload, call) { ... },   // call = { request, host }
//       },
//       pages: ['chat'],             // optional: page dirs this feature owns (documentation only)
//       migrate: async (bundle) => {},  // optional: per-user import of legacy rows (phase B)
//     }
//   }
//
// host = { name, identity, dataDir, featureDir(), runtime(), currentRuntime(), log, call(endpoint, payload) }
// Features never edit core files: adding a directory is enough. Endpoint names are
// namespaced by the directory name, so features cannot collide or shadow each other.
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runtime, currentRuntime } from './host.js'

export const FEATURE_NAME = /^[a-z][a-z0-9-]{0,39}$/
export const OP_NAME = /^[a-z][a-zA-Z0-9-]{0,63}$/
export const CHAT_DIRECTORY_FEATURES = ['chat', 'agents', 'personal', 'teams']
const startupFeatures = ['settings', ...CHAT_DIRECTORY_FEATURES]

export function featureHost({ name, identity, dataDir, log = () => {}, table = {} }) {
  const host = Object.freeze({
    name,
    identity,
    dataDir,
    featureDir() {
      const dir = join(dataDir, 'flybot-workspace', 'features', name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return dir
    },
    runtime,
    currentRuntime,
    log: (message) => log(`flybot-workspace-web[${name}]: ${message}`),
    // Call another feature's endpoint in-process (e.g. chat → 'memory/pages').
    // Rejects with code 'flybot-workspace/not-found' when that feature is absent.
    async call(endpoint, payload = null) {
      const handler = Object.hasOwn(table, endpoint) ? table[endpoint] : null
      if (!handler) throw Object.assign(new Error(`Unknown FlyBot endpoint ${String(endpoint).slice(0, 80)}`), { code: 'flybot-workspace/not-found' })
      return handler(payload, { request: null, host, internal: true })
    },
  })
  return host
}

export function registerFeature(table, name, spec) {
  if (!FEATURE_NAME.test(name)) throw new Error(`flybot-workspace-web: invalid feature name ${name}`)
  if (!spec || typeof spec !== 'object') throw new Error(`flybot-workspace-web: feature ${name} returned no spec`)
  for (const [op, handler] of Object.entries(spec.endpoints ?? {})) {
    if (!OP_NAME.test(op) || typeof handler !== 'function') throw new Error(`flybot-workspace-web: invalid endpoint ${name}/${op}`)
    const key = `${name}/${op}`
    if (Object.hasOwn(table, key)) throw new Error(`flybot-workspace-web: duplicate endpoint ${key}`)
    table[key] = handler
  }
  return table
}

// Load every features/<name>/index.js. A feature that fails to load is reported and
// skipped; the others and the core keep working.
export async function loadFeatures({ dir, identity, dataDir, log = console.error, onRegistered = () => {} }) {
  const table = {}
  const loaded = []
  const failed = []
  let names = []
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch { return { table, loaded, failed } }
  // Serve the shell and owned Chat directory before unrelated feature migrations.
  // Chat supplies the retained private-chat rows that Agents adopts on import.
  const priority = name => startupFeatures.includes(name) ? startupFeatures.indexOf(name) : startupFeatures.length
  names.sort((a,b) => priority(a) - priority(b) || a.localeCompare(b))
  for (const name of names) {
    if (!FEATURE_NAME.test(name)) { failed.push({ name, error: 'invalid name' }); continue }
    try {
      const mod = await import(pathToFileURL(join(dir, name, 'index.js')).href)
      const factory = mod.default
      if (typeof factory !== 'function') throw new Error('default export must be a factory function')
      const host = featureHost({ name, identity, dataDir, log, table })
      registerFeature(table, name, await factory(host))
      loaded.push(name)
      onRegistered(name, table, loaded)
    } catch (error) {
      failed.push({ name, error: String(error?.message ?? error).slice(0, 200) })
      log(`flybot-workspace-web: feature ${name} not loaded: ${String(error?.message ?? error).slice(0, 200)}`)
    }
  }
  return { table, loaded, failed }
}
