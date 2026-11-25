// Build an extension-point factory (src/features.js contract) from a feature
// spec shared by the B3 features:
//   { name, migrations: [sql], importTables?: {table: [columns]}, routes: [{pattern, handle}],
//     endpoints?: (context) => ({op: fn}), search?: (store, needle, limit) => items }
// The factory opens the feature's own SQLite file under host.featureDir(),
// applies migrations, imports pending legacy bundles for this feature, and
// registers '<name>/v1' (legacy routes), '<name>/routes' and, when present,
// '<name>/search'.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { openStore } from './store.js'
import { importBundle, importBundles } from './bundle.js'
import { createV1Endpoint, ownerId } from './v1.js'

export function defineFeature(spec) {
  return function feature(host) {
    const store = openStore(join(host.featureDir(), `${spec.name}.sqlite3`))
    store.migrate(spec.name, spec.migrations ?? [])
    store.exec('CREATE TABLE IF NOT EXISTS ot_imports (digest TEXT PRIMARY KEY, feature TEXT NOT NULL, rows INTEGER NOT NULL, imported INTEGER NOT NULL)')
    const instanceId = host.identity?.routingInstanceId ?? host.identity?.instanceId
    const imported = spec.importTables ? importBundles({ store, dataDir: host.dataDir, feature: spec, instanceId }) : []
    for (const item of imported) if (item.status === 'rejected') host.log(`import ${item.name} rejected: ${item.reason}`)
    const context = { store, host, identity: host.identity, owner: ownerId(), log: host.log, feature: spec.name }
    const endpoints = {
      v1: createV1Endpoint({ feature: spec.name, routes: spec.routes ?? [], context }),
      async routes() { return { routes: (spec.routes ?? []).map((route) => route.pattern.source), imported } },
      ...(spec.endpoints ? spec.endpoints(context) : {}),
    }
    if (spec.search) {
      endpoints.search = async (payload) => {
        const needle = String(payload?.q ?? '').trim()
        const limit = Math.min(Math.max(Number(payload?.limit) || 20, 1), 50)
        if (!needle || needle.length > 80) return { items: [] }
        return { items: spec.search(store, needle, limit) }
      }
    }
    return {
      endpoints,
      pages: spec.pages ?? [],
      store,
      imported,
      async migrate(bundle) {
        const digest = createHash('sha256').update(JSON.stringify(bundle), 'utf8').digest('hex')
        return importBundle(store, spec, bundle, digest, { instanceId, dataDir: host.dataDir, featureDir: host.featureDir() })
      },
    }
  }
}
