// B4: account model settings in the user's own DS-Bot (sealed key, #375 exact-HTTP policy).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { compatHandler } from '../lib/b4/compat.js'
import { seal, unseal, loadSealKey, unwrapLegacy } from '../lib/b4/seal.js'
import { createModelApi, loadHttpPolicy, validBaseUrl, OVERRIDE } from '../features/model-api/model-api.js'
import modelApiFeature from '../features/model-api/index.js'

const HTTP_BASE = 'http://113.46.219.251:8080/v1'
const KEY = 'sk-test-' + 'x'.repeat(24)
const tmp = () => mkdtempSync(join(tmpdir(), 'ot-b4-model-'))
const noPolicy = Object.freeze({ bases: [], source: null })
const httpPolicy = Object.freeze({ bases: [HTTP_BASE], source: 'operator' })
const make = (policy = noPolicy, platform = () => null) => createModelApi({ dir: tmp(), sealKey: randomBytes(32), policy, platform, clock: () => 5 })
const v1 = (api, method, body, query = '') => compatHandler(api.legacy)({ method, path: '/v1/model-api', body, query })

test('seal round trip, purpose binding, corrupt blobs refused', () => {
  const key = randomBytes(32)
  const blob = seal(key, 'a', 'secret-value')
  assert.equal(unseal(key, 'a', blob), 'secret-value')
  assert.throws(() => unseal(key, 'b', blob), /corrupt/)
  assert.throws(() => unseal(randomBytes(32), 'a', blob), /corrupt/)
  assert.ok(!blob.includes('secret-value'))
})

test('seal key: private volume fallback is created once and reused', () => {
  const dir = tmp()
  const file = join(dir, 'k', 'seal.key')
  const env = { FLYBOT_WORKSPACE_SEAL_KEY_FILE: '' }
  const a = loadSealKey({ env, fallbackFile: file })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(loadSealKey({ env, fallbackFile: file }), a)
  const operator = join(dir, 'operator.key')
  writeFileSync(operator, randomBytes(32).toString('hex'))
  assert.notDeepEqual(loadSealKey({ env: { FLYBOT_WORKSPACE_SEAL_KEY_FILE: operator }, fallbackFile: file }), a)
})

test('legacy model_api.wrap blobs unwrap (platform export bundles)', () => {
  // Fixture produced by flybot-workspace.model_api.wrap(bytes(range(32)), 'hello-wrap')
  const key = Buffer.from([...Array(32).keys()])
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-wrap.json', import.meta.url), 'utf8'))
  assert.equal(unwrapLegacy(key, fixture.blob), fixture.plaintext)
  assert.throws(() => unwrapLegacy(randomBytes(32), fixture.blob), /corrupt/)
})

test('GET/POST /v1/model-api: account override, key never returned, effective source', async () => {
  const platform = () => ({ provider: 'openai', base_url: 'https://platform.example/v1', model: 'p', api_key: 'never-shown-1234' })
  const volume = { dir: tmp(), sealKey: randomBytes(32), policy: noPolicy, platform }
  const api = createModelApi(volume)
  const empty = await v1(api, 'GET')
  assert.deepEqual([empty.body.model_api.revision, empty.body.effective.source], [0, 'platform'])
  assert.ok(!JSON.stringify(empty).includes('never-shown'))
  const saved = await v1(api, 'POST', { revision: 0, changes: { provider: 'openai', base_url: 'https://api.example.com/v1', model: 'gpt-x', api_key: KEY } })
  assert.equal(saved.status, 200)
  assert.deepEqual([saved.body.model_api.revision, saved.body.model_api.api_key_set], [1, true])
  assert.ok(!JSON.stringify(saved).includes(KEY))
  assert.ok(!readFileSync(api.store.file, 'utf8').includes(KEY), 'key is sealed at rest')
  assert.equal((await v1(api, 'GET')).body.effective.source, 'account')
  assert.equal((await v1(make(noPolicy, platform), 'GET')).body.effective.source, 'platform')
  const proxy = api.resolveForProxy()
  assert.deepEqual([proxy.api_key, proxy.source, proxy.http_endpoint_grant], [KEY, 'user', undefined])
  assert.equal((await v1(api, 'POST', { revision: 0, changes: { model: 'y' } })).status, 409)
  const same = await v1(api, 'POST', { revision: 1, changes: { model: 'gpt-x' } })
  assert.equal(same.body.model_api.revision, 1)
  const cleared = await v1(api, 'POST', { revision: 1, changes: { api_key: null } })
  assert.equal(cleared.body.model_api.api_key_set, false)
  assert.equal(api.resolveForProxy(), null)
  const reopened = createModelApi(volume)
  assert.equal(reopened.resolveForProxy(), null)
  assert.equal((await v1(reopened, 'GET')).body.effective.source, 'platform')
  for (const changes of [{ provider: 'evil' }, { api_key: 'short' }, { base_url: 'ftp://x.example' }, { foo: 1 }, { base_url: 'https://u:p@x.example/v1' }]) {
    assert.equal((await v1(api, 'POST', { revision: 2, changes })).status, 400, JSON.stringify(changes))
  }
})

test('#375 policy: public HTTP only for the exact operator base, OpenAI-compatible, grant attached', async () => {
  assert.equal(validBaseUrl(HTTP_BASE, noPolicy), false)
  assert.equal(validBaseUrl(HTTP_BASE, httpPolicy), true)
  assert.equal(validBaseUrl(HTTP_BASE + '/', httpPolicy), false)
  assert.equal(validBaseUrl('http://192.168.1.5:8000/v1', noPolicy), true, 'private dev HTTP stays allowed')
  const denied = make(noPolicy)
  assert.equal((await v1(denied, 'POST', { revision: 0, changes: { provider: 'openai', base_url: HTTP_BASE, model: 'DeepSeek-V4.1-Flash-1017', api_key: KEY } })).status, 400)
  const api = make(httpPolicy)
  assert.equal((await v1(api, 'POST', { revision: 0, changes: { provider: 'anthropic', base_url: HTTP_BASE, model: 'm', api_key: KEY } })).status, 400)
  const ok = await v1(api, 'POST', { revision: 0, changes: { provider: 'openai', base_url: HTTP_BASE, model: 'DeepSeek-V4.1-Flash-1017', api_key: KEY } })
  assert.equal(ok.status, 200)
  assert.deepEqual(api.resolveForProxy().http_endpoint_grant, { base_url: HTTP_BASE, format: 'flybot-workspace.exact-http-task.v1' })
})

test('policy file: missing, malformed, writable and valid', () => {
  const dir = tmp()
  assert.deepEqual(loadHttpPolicy({ FLYBOT_WORKSPACE_MODEL_HTTP_POLICY_FILE: join(dir, 'absent.json') }).bases, [])
  const file = join(dir, 'policy.json')
  writeFileSync(file, JSON.stringify({ version: 1, allowed_http_model_bases: [HTTP_BASE] }))
  chmodSync(file, 0o644)
  assert.deepEqual(loadHttpPolicy({ FLYBOT_WORKSPACE_MODEL_HTTP_POLICY_FILE: file }).bases, [HTTP_BASE])
  chmodSync(file, 0o666)
  assert.deepEqual(loadHttpPolicy({ FLYBOT_WORKSPACE_MODEL_HTTP_POLICY_FILE: file }).bases, [])
  chmodSync(file, 0o644)
  writeFileSync(file, JSON.stringify({ version: 1, allowed_http_model_bases: ['http://10.0.0.1:80/v1'] }))
  assert.equal(loadHttpPolicy({ FLYBOT_WORKSPACE_MODEL_HTTP_POLICY_FILE: file }).source, 'rejected')
})

test('feature factory publishes the in-process proxy override', async () => {
  const dir = tmp()
  const host = { dataDir: dir, featureDir: () => dir }
  const feature = modelApiFeature(host)
  assert.equal(typeof globalThis[OVERRIDE], 'function')
  assert.equal(globalThis[OVERRIDE](), null)
  await feature.endpoints.save({ revision: 0, changes: { provider: 'custom', base_url: 'https://llm.example/v1', model: 'm1', api_key: KEY } })
  assert.equal(globalThis[OVERRIDE]().api_key, KEY)
  const got = await feature.endpoints.get()
  assert.ok(!JSON.stringify(got).includes(KEY))
  await assert.rejects(feature.endpoints.imageProvider({}, { internal: false }), { code: 'model-api/not-found' })
  assert.equal(await feature.endpoints.imageProvider({}, { internal: true }), null)
  delete globalThis[OVERRIDE]
})

test('Runway video key is sealed per account, revision checked and absent from HTTP responses', async () => {
  const api = make()
  const call = (method, body) => compatHandler(api.legacy)({method, path: '/v1/model-api/video', body})
  const initial = await call('GET')
  assert.deepEqual(initial.body.video_api, {provider: 'runway', model: 'gen4.5', has_api_key: false, revision: 0})
  assert.equal(api.resolveVideo(), null)
  assert.equal((await call('POST', {revision: 0, api_key: 'invalid token'})).status, 400)
  const stored = await call('POST', {revision: 0, api_key: KEY})
  assert.equal(stored.status, 200)
  assert.equal(stored.body.video_api.has_api_key, true)
  assert.equal(stored.body.video_api.revision, 1)
  assert.equal(JSON.stringify(stored).includes(KEY), false)
  assert.equal(JSON.stringify(api.store.read()).includes(KEY), false)
  assert.deepEqual(api.resolveVideo(), {provider: 'runway', model: 'gen4.5', api_key: KEY})
  assert.equal(make().resolveVideo(), null)
  assert.equal((await call('POST', {revision: 0, api_key: null})).status, 409)
  assert.equal((await call('POST', {revision: 1, api_key: null})).status, 200)
  assert.equal(api.resolveVideo(), null)
})

test('ElevenLabs keys have independent encrypted storage and can only be resolved internally', async () => {
  const dir = tmp()
  const feature = modelApiFeature({featureDir: () => dir, dataDir: dir, log: () => {}})
  const call = (kind, method, body) => feature.endpoints.v1({method, path: '/v1/model-api/' + kind, body})
  const musicKey = 'music-key-test-' + 'a'.repeat(20)
  const empty = {provider: 'elevenlabs', model: 'music_v2_5', has_api_key: false, revision: 0}
  assert.deepEqual((await call('music', 'GET')).body.music_api, empty)
  assert.equal((await call('video', 'POST', {api_key: KEY, revision: 0})).status, 200)
  assert.equal(await feature.endpoints.musicProvider({}, {internal: true}), null)
  assert.equal((await call('music', 'POST', {api_key: 'contains a space', revision: 0})).status, 400)
  const saved = await call('music', 'POST', {api_key: musicKey, revision: 0})
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.music_api, {...empty, has_api_key: true, revision: 1})
  assert.ok(!JSON.stringify(saved).includes(musicKey))
  const api = createModelApi({dir, sealKey: loadSealKey({fallbackFile: join(dir, 'seal.key'), preferFallback: true})})
  assert.ok(!readFileSync(api.store.file, 'utf8').includes(musicKey))
  await assert.rejects(() => feature.endpoints.musicProvider({}, {}), {code: 'model-api/not-found'})
  assert.deepEqual(await feature.endpoints.musicProvider({}, {internal: true}), {
    provider: 'elevenlabs', model: 'music_v2_5', api_key: musicKey,
  })
  assert.equal(make().resolveMusic(), null)
  assert.equal((await call('music', 'POST', {api_key: null, revision: 0})).status, 409)
  assert.equal((await call('music', 'POST', {api_key: null, revision: 1})).status, 200)
  assert.equal(await feature.endpoints.musicProvider({}, {internal: true}), null)
  assert.equal((await feature.endpoints.videoProvider({}, {internal: true})).api_key, KEY)
  delete globalThis[OVERRIDE]
})
