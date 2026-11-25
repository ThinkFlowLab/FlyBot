// Write-only compatibility for the SAME native DS-Bot secret store. Transport
// imports are sealed for this runtime; no value is ever returned or logged.
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { openJsonStore } from '../../lib/b4/json-store.js'
import { loadSealKey, loadImportSealKey, seal, unseal } from '../../lib/b4/seal.js'
import { importJsonBundles } from '../../lib/b4/importer.js'

export default function skillSecrets(host) {
  const key = loadSealKey({ fallbackFile: join(host.featureDir(), 'seal.key'), preferFallback: true })
  const store = openJsonStore(host.featureDir(), 'imports', () => ({ pending: {}, imports: [] }))
  importJsonBundles({ host, feature: { name: 'skill-secrets', importTables: { skill_secrets: ['name','updated'] } }, store, sealKey: loadImportSealKey(),
    apply(draft, tables, secrets) {
      draft.pending ||= {}
      for (const row of tables.skill_secrets || []) {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(row.name) || !secrets['secret:' + row.name]) throw new Error('invalid secret import')
        if (!draft.pending[row.name]) draft.pending[row.name] = { value: seal(key, 'skill-secret:' + row.name, secrets['secret:' + row.name]), updated: row.updated }
      }
    }, log: () => host.log('skill secret import rejected; bundle retained') })
  let queue = Promise.resolve()
  const serial = fn => { const p = queue.then(fn,fn); queue = p.catch(() => {}); return p }
  async function runtime() {
    const { rt } = await host.runtime()
    await rt.loadSecrets()
    if (rt.secretStoreStatus().locked) throw new Fault(409, 'secret_store_locked', 'Unlock the native DS-Bot secret store first')
    for (const [name, row] of Object.entries(store.read().pending || {})) {
      if (!rt.secretsView().some(s => s.name === name)) await rt.secretEndpoint('secret-set', { name, value: unseal(key, 'skill-secret:' + name, row.value), scope: 'all', purpose: 'Migrated FlyBot skill secret' })
      store.update(d => { delete d.pending[name] })
    }
    return rt
  }
  const listing = rt => ({ items: rt.secretsView().map(s => ({ name: s.name, updated: Math.floor(s.updatedAt/1000) })) })
  return { endpoints: { v1: compatHandler(['GET','POST','DELETE'].map(method => ({ method, path: /^\/v1\/skill-secrets$/,
    handle: ({ body = {}, query }) => serial(async () => {
      if (query) throw new Fault(400, 'invalid', 'Unexpected query')
      const rt = await runtime()
      if (method !== 'GET') {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(body.name || '')) throw new Fault(400, 'invalid', 'Invalid secret name')
        if (method === 'POST' && body.action !== 'delete') {
          if (body.action !== 'set') throw new Fault(400, 'invalid', 'Provide action=set or delete')
          if (typeof body.value !== 'string' || body.value.length < 1 || body.value.length > 4096) throw new Fault(400, 'invalid', 'Provide a secret value')
          if (!rt.secretsView().some(s => s.name === body.name) && rt.secretsView().length >= 50) throw new Fault(429, 'quota', 'Secret limit reached')
          await rt.secretEndpoint('secret-set', { name: body.name, value: body.value, scope: 'all' })
        } else {
          if (!rt.secretsView().some(s => s.name === body.name)) throw new Fault(404, 'not_found', 'Secret not found')
          await rt.secretEndpoint('secret-delete', { name: body.name })
        }
      }
      return [200, listing(rt)]
    }) }))) } }
}
