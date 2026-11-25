// B4 per-user import: platform bundles (flybot_workspace/dsbot_bundle.py
// build_with_secrets) land in the settings, model-api and connectors stores.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importJsonBundles } from '../lib/b4/importer.js'
import { unseal } from '../lib/b4/seal.js'
import * as settings from '../features/settings/settings.js'
import * as modelApi from '../features/model-api/model-api.js'
import * as connectors from '../features/connectors/connectors.js'

const KEY = Buffer.from([...Array(32).keys()]) // test key; fixture wrapped with it
const INSTANCE = '1'.repeat(32)
const host = dataDir => ({ dataDir, identity: { instanceId: '2'.repeat(32), routingInstanceId: INSTANCE } })
const WRAPPED = JSON.parse(readFileSync(new URL('./fixtures/b4-secrets.json', import.meta.url), 'utf8'))
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex')
const sorted = obj => Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]))
const canon = v => JSON.stringify(Array.isArray(v) ? v.map(sorted) : sorted(v))

function bundle(feature, tables, secrets) {
  const out = { format: 'flybot-workspace-dsbot-import', version: 1, feature, instance_id: INSTANCE, tables: {}, manifest: {} }
  for (const [name, rows] of Object.entries(tables)) {
    out.tables[name] = canon(rows)
    out.manifest[name] = { rows: rows.length, sha256: sha(out.tables[name]) }
  }
  if (secrets) { out.secrets = secrets; out.secrets_sha256 = sha(JSON.stringify(sorted(secrets))) }
  return out
}
function place(dataDir, name, value) {
  const dir = join(dataDir, 'flybot-workspace', 'import')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(value))
  return join(dir, name)
}

test('settings bundle imports once and is removed; re-delivery is a no-op', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'b4i-'))
  const feature = settings.createSettingsFeature({ dir: join(dataDir, 'f') })
  const spec = { name: 'settings', importTables: settings.IMPORT_TABLES }
  const value = bundle('settings', {
    user_settings: [{ user_id: 'u', document: JSON.stringify({ language: 'zh-CN' }), revision: 3, updated: 10 }],
    user_onboarding: [{ user_id: 'u', industry: 'x', role: 'y', completed: 1, revision: 2, created: 1, updated: 2 }],
  })
  const file = place(dataDir, 'settings.bundle', value)
  place(dataDir, 'other.bundle', { feature: 'meetings' })
  const run = () => importJsonBundles({ host: host(dataDir), feature: spec, store: feature.store, apply: settings.applyImport })
  assert.deepEqual(run(), [{ name: 'settings.bundle', status: 'imported' }])
  assert.equal(existsSync(file), false)
  assert.equal(existsSync(join(dataDir, 'flybot-workspace', 'import', 'other.bundle')), true, 'other features untouched')
  const state = feature.store.read()
  assert.equal(state.settings.revision, 3)
  assert.equal(state.onboarding.completed, 1)
  place(dataDir, 'settings.bundle', value)
  assert.deepEqual(run(), [{ name: 'settings.bundle', status: 'already-imported' }])
})

test('JSON importers retain wrong-target and untargeted bundles with all data unchanged', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'b4i-'))
  const feature = settings.createSettingsFeature({ dir: join(dataDir, 'f') })
  const spec = { name: 'settings', importTables: settings.IMPORT_TABLES }
  const initial = feature.store.read()
  const value = bundle('settings', {
    user_settings: [{ user_id: 'u', document: JSON.stringify({ language: 'zh-CN' }), revision: 3, updated: 10 }],
  })
  const foreign = place(dataDir, 'foreign.bundle', { ...value, instance_id: host(dataDir).identity.instanceId })
  const missing = place(dataDir, 'missing.bundle', { ...value, instance_id: undefined })
  const results = importJsonBundles({ host: host(dataDir), feature: spec, store: feature.store, apply: settings.applyImport })
  assert.deepEqual(results.map(({ status, reason }) => [status, reason]), [
    ['rejected', 'import target mismatch'], ['rejected', 'import target mismatch'],
  ])
  assert.deepEqual(feature.store.read(), initial)
  assert.equal(existsSync(foreign) && existsSync(missing), true)
})

test('tampered tables or secrets are rejected and left in place', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'b4i-'))
  const api = modelApi.createModelApi({ dir: join(dataDir, 'm'), sealKey: KEY, env: {}, policy: { bases: [] }, platform: () => null })
  const value = bundle('model-api', { model_api_configs: [{ id: 'a', provider: 'openai', base_url: 'https://api.example/v1', model: 'm', revision: 1, updated: 1, key_set: 1 }] }, { model_api_key: WRAPPED.model_api_key })
  value.secrets.model_api_key = WRAPPED.composio_key
  const file = place(dataDir, 'm.bundle', value)
  const [result] = importJsonBundles({ host: host(dataDir), feature: { name: 'model-api', importTables: modelApi.IMPORT_TABLES }, store: api.store, sealKey: KEY, apply: modelApi.importApplier(KEY) })
  assert.equal(result.status, 'rejected')
  assert.match(result.reason, /secrets digest/)
  assert.equal(existsSync(file), true)
  assert.equal(api.store.read().account ?? null, null)
})

test('model-api and connectors secrets are unwrapped and re-sealed, never stored plain', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'b4i-'))
  const api = modelApi.createModelApi({ dir: join(dataDir, 'm'), sealKey: KEY, env: {}, policy: { bases: [] }, platform: () => null })
  place(dataDir, 'm.bundle', bundle('model-api', { model_api_configs: [{ id: 'a', provider: 'openai', base_url: 'https://api.example/v1', model: 'gpt-test', revision: 2, updated: 1, key_set: 1 }] }, { model_api_key: WRAPPED.model_api_key }))
  importJsonBundles({ host: host(dataDir), feature: { name: 'model-api', importTables: modelApi.IMPORT_TABLES }, store: api.store, sealKey: KEY, apply: modelApi.importApplier(KEY) })
  assert.equal(api.resolveForProxy().api_key, 'sk-test-fixture-0001')
  assert.doesNotMatch(readFileSync(api.store.file, 'utf8'), /sk-test-fixture/)

  const conn = connectors.createConnectors({ dir: join(dataDir, 'c'), sealKey: KEY, identity: { instanceId: 'i' }, env: {} })
  const sid = 'b'.repeat(32)
  place(dataDir, 'c.bundle', bundle('connectors', {
    composio_user: [{ user_ref: 'flybot-workspace-' + 'c'.repeat(32) }],
    composio_keys: [{ user_id: 'u', key_hint: '••••0001', revision: 1, updated: 1 }],
    composio_connections: [{ id: 'd'.repeat(32), toolkit: 'gmail', account_id: 'ca_1', status: 'ACTIVE', status_reason: null, created: 1, updated: 1 }],
    custom_mcp_servers: [{ id: sid, name: 'Docs', origin: 'https://mcp.example.com', revision: 1, created: 1, updated: 1 }],
  }, { composio_key: WRAPPED.composio_key, ['mcp:' + sid]: WRAPPED.mcp }))
  const [result] = importJsonBundles({ host: host(dataDir), feature: { name: 'connectors', importTables: connectors.IMPORT_TABLES }, store: conn.store, sealKey: KEY, apply: connectors.importApplier(KEY) })
  assert.equal(result.status, 'imported')
  const state = conn.store.read()
  assert.equal(state.composio_user, 'flybot-workspace-' + 'c'.repeat(32))
  assert.equal(unseal(KEY, 'flybot-workspace.composio.key', state.composio.key_sealed), 'ak_test_fixture_0001')
  assert.equal(state.connections.length, 1)
  assert.equal(JSON.parse(unseal(KEY, 'flybot-workspace.mcp.' + sid, state.mcp_servers[0].config_sealed)).bearer_token, 'test-bearer-0001')
  assert.doesNotMatch(readFileSync(conn.store.file, 'utf8'), /ak_test_fixture|test-bearer/)
})
