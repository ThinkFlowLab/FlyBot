// Per-user import of B4 legacy data (flybot_workspace/dsbot_bundle.py
// build_with_secrets) into the JSON stores of the settings, model-api and
// connectors features. Bundles arrive as /data/flybot-workspace/import/<name>.bundle
// (manager job). Tables are verified with the shared featurekit manifest
// check; sealed secrets (model_api.wrap format, runtime seal key) are verified
// against secrets_sha256, unwrapped in memory and re-sealed for this volume.
// A bundle digest is recorded so re-delivery is a no-op; the file is removed
// after a verified import; bundles for other features are left in place.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { requireBundleTarget, verifyBundle } from '../../featurekit/bundle.js'
import { unwrapLegacy } from './seal.js'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.bundle$/
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const sorted = obj => Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]))

export function readSecrets(bundle, sealKey) {
  if (bundle.seal_key_id && bundle.seal_key_id !== createHash('sha256').update(sealKey).digest('hex')) throw new Error('runtime import key mismatch; preserve bundle and restore manager key mount')
  const secrets = bundle.secrets
  if (secrets === undefined) return {}
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new Error('invalid secrets')
  if (bundle.secrets_sha256 !== sha256(JSON.stringify(sorted(secrets)))) throw new Error('secrets digest mismatch')
  const out = {}
  for (const [name, blob] of Object.entries(secrets)) out[name] = unwrapLegacy(sealKey, blob)
  return out
}

// feature: { name, importTables }, store: lib/b4/json-store, apply(draft, tables, secrets)
export function importJsonBundles({ host, feature, store, sealKey = null, apply, log = () => {} }) {
  const dir = join(host.dataDir, 'flybot-workspace', 'import')
  const instanceId = host.identity?.routingInstanceId ?? host.identity?.instanceId
  let names = []
  try { names = readdirSync(dir).filter(name => NAME.test(name)).sort() } catch { return [] }
  const results = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const text = readFileSync(file, 'utf8')
      const bundle = JSON.parse(text)
      if (bundle?.feature !== feature.name) continue
      requireBundleTarget(bundle, instanceId)
      const digest = sha256(text)
      if ((store.read().imports ?? []).includes(digest)) { unlinkSync(file); results.push({ name, status: 'already-imported' }); continue }
      const tables = verifyBundle(bundle, feature)
      if (bundle.seal_key_id && bundle.seal_key_id !== createHash('sha256').update(sealKey).digest('hex')) throw new Error('runtime import key mismatch; preserve bundle and restore manager key mount')
      const secrets = bundle.secrets === undefined ? {} : sealKey ? readSecrets(bundle, sealKey) : null
      if (secrets === null) throw new Error('bundle has secrets but this runtime has no seal key')
      store.update((draft) => {
        apply(draft, tables, secrets)
        draft.imports = [...(draft.imports ?? []), digest].slice(-50)
      })
      unlinkSync(file)
      results.push({ name, status: 'imported' })
    } catch (error) {
      results.push({ name, status: 'rejected', reason: String(error?.message ?? error).slice(0, 200) })
      log(`import ${name} rejected: ${String(error?.message ?? error).slice(0, 200)}`)
    }
  }
  return results
}
