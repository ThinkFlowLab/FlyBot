// B4: the account's model API settings, owned by the user's own DS-Bot.
// Port of the account scope of flybot_workspace/model_api.py + app.save_model_api.
// The key is sealed on the volume (lib/b4/seal.js) and only ever leaves this
// process through the in-process override that the #379 loopback model proxy
// (runtime/flybot-image/ds-bot-bridge.mjs) reads, so DS-Bot itself still holds
// only the per-boot placeholder token. Plain-HTTP public endpoints are allowed
// only when the operator's exact-HTTP policy (#375) lists the exact base URL;
// the policy file is operator-mounted read-only and never written here.
import { lstatSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { fail, isObject, bodyOf, nowSeconds } from '../../lib/b4/http.js'
import { openJsonStore } from '../../lib/b4/json-store.js'
import { seal, unseal } from '../../lib/b4/seal.js'
import { MODEL_HTTP_FORMAT, publicHttpBase } from '../../../flybot-image/model-http-policy.mjs'
import { loadModelApi } from '../../../flybot-image/model-api.js'

export const PROVIDERS = ['openai', 'azure', 'anthropic', 'custom']
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/
export const POLICY_ENV = 'FLYBOT_WORKSPACE_MODEL_HTTP_POLICY_FILE'
export const DEFAULT_POLICY_FILE = '/run/secrets/flybot-workspace-model-http.json'
export const OVERRIDE = Symbol.for('flybot-workspace.model-api.override')
const PURPOSE = 'flybot-workspace.model-api.account'
const IMAGE_PURPOSE = 'flybot-workspace.model-api.image'
const FIXED_PROVIDERS = {
  video: {provider: 'runway', model: 'gen4.5', name: 'Runway', label: '视频'},
  music: {provider: 'elevenlabs', model: 'music_v2_5', name: 'ElevenLabs', label: '音乐'},
  model3d: {provider: 'meshy', model: 'meshy-7.1', name: 'Meshy', label: '3D'},
}
const DEFAULT_IMAGE_BASE = 'https://api.openai.com/v1'
const DEFAULT_IMAGE_MODEL = 'gpt-image-1.5'

// Operator exact-HTTP policy (same document as #375's model-http.json). A
// missing file means no public HTTP endpoint is allowed; a malformed,
// symlinked or group/world-writable file is refused (fail closed).
export function loadHttpPolicy(env = process.env) {
  const file = env[POLICY_ENV] || DEFAULT_POLICY_FILE
  let st
  try { st = lstatSync(file) } catch { return Object.freeze({ bases: [], source: null }) }
  if (!st.isFile() || (st.mode & 0o022) || st.size > 16384) return Object.freeze({ bases: [], source: 'rejected' })
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(doc) || JSON.stringify(Object.keys(doc).sort()) !== '["allowed_http_model_bases","version"]' || doc.version !== 1
      || !Array.isArray(doc.allowed_http_model_bases) || doc.allowed_http_model_bases.length > 16
      || !doc.allowed_http_model_bases.every(publicHttpBase)) return Object.freeze({ bases: [], source: 'rejected' })
    return Object.freeze({ bases: Object.freeze([...doc.allowed_http_model_bases]), source: 'operator' })
  } catch { return Object.freeze({ bases: [], source: 'rejected' }) }
}
export const policyAllows = (policy, base) => policy.bases.includes(base)

function localHttpAllowed(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost') return true
  const kind = isIP(host)
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (kind === 6) return host === '::1' || /^(fc|fd|fe[89ab])/i.test(host)
  return false
}

export function validBaseUrl(value, policy) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512 || /[\x00-\x1f]/.test(value)) return false
  let url
  try { url = new URL(value) } catch { return false }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname || url.search || url.hash || /[?#]/.test(value)) return false
  if (url.protocol === 'http:' && !localHttpAllowed(url.hostname)) return policyAllows(policy, value)
  return true
}
const isPublicHttp = (value, policy) => typeof value === 'string' && value.startsWith('http://') && policyAllows(policy, value)
export const validProvider = value => typeof value === 'string' && PROVIDERS.includes(value)
export const validModel = value => typeof value === 'string' && MODEL.test(value)
export const validApiKey = value => typeof value === 'string' && value.length >= 8 && value.length <= 4096 && !/[\x00-\x08\x0a-\x1f]/.test(value)

const EMPTY = { provider: null, base_url: null, model: null, api_key_set: false, revision: 0, scope: 'account' }
export const publicView = row => row
  ? { scope: 'account', provider: row.provider, base_url: row.base_url, model: row.model, api_key_set: Boolean(row.key_sealed), revision: row.revision }
  : { ...EMPTY }

export function createModelApi({ dir, sealKey, env = process.env, clock = nowSeconds, policy = loadHttpPolicy(env), platform = () => { try { return loadModelApi(env) || null } catch { return null } } }) {
  const store = openJsonStore(dir, 'model-api')
  const row = () => store.read().account ?? null

  function effective() {
    const account = row()
    if (account?.key_sealed) return { ...visible(publicView(account)), source: 'account' }
    const base = platform()
    if (base) return { scope: 'platform', provider: base.provider, base_url: base.base_url ?? null, model: base.model ?? null, api_key_set: true, source: 'platform' }
    return { scope: 'platform', provider: null, base_url: null, model: null, api_key_set: false, source: 'none' }
  }
  const visible = view => ({ provider: view.provider, base_url: view.base_url, model: view.model, api_key_set: view.api_key_set, scope: view.scope })
  const get = () => ({ model_api: publicView(row()), effective: effective() })

  function save(raw) {
    const body = bodyOf(raw, ['revision', 'changes'])
    const { revision, changes } = body
    if (!Number.isInteger(revision) || revision < 0 || revision > 2 ** 31 || !isObject(changes) || Object.keys(changes).length === 0) {
      fail(400, 'invalid', 'Provide the current revision and a non-empty changes object')
    }
    if (Object.keys(changes).some(key => !['provider', 'base_url', 'model', 'api_key'].includes(key))) fail(400, 'invalid', 'Unknown model API field')
    return store.update((draft) => {
      const current = publicView(draft.account)
      if (revision !== current.revision) fail(409, 'conflict', 'Model API settings changed elsewhere; reload and retry', current)
      const provider = 'provider' in changes ? changes.provider : current.provider
      const baseUrl = 'base_url' in changes ? changes.base_url : current.base_url
      const model = 'model' in changes ? changes.model : current.model
      const clearing = 'api_key' in changes && changes.api_key === null
      const replacing = 'api_key' in changes && changes.api_key !== null
      if (replacing && !validApiKey(changes.api_key)) fail(400, 'invalid', 'API key must be 8–4096 characters')
      // Revoking a stored key must work even after the operator removed an HTTP exception.
      if (!(clearing && Object.keys(changes).length === 1)) {
        if (!validProvider(provider) || !validBaseUrl(baseUrl, policy) || !validModel(model)) {
          fail(400, 'invalid', 'Provide a supported provider, authorized model base URL and model name')
        }
      }
      if (!clearing && isPublicHttp(baseUrl, policy) && provider !== 'openai' && provider !== 'custom') {
        fail(400, 'invalid', 'HTTP model exceptions require an OpenAI-compatible task provider')
      }
      if (!replacing && !clearing && draft.account && provider === current.provider && baseUrl === current.base_url && model === current.model) {
        return { model_api: current }
      }
      if (!draft.account && clearing && !replacing && provider == null) return { model_api: current }
      const keySealed = clearing ? null : replacing ? seal(sealKey, PURPOSE, changes.api_key) : (draft.account?.key_sealed ?? null)
      draft.account = { provider, base_url: baseUrl, model, key_sealed: keySealed, revision: current.revision + 1, updated: clock() }
      return { model_api: publicView(draft.account) }
    })
  }

  // In-process only: what the loopback model proxy uses for this user's
  // DS-Bot turns. Re-validated on every call against the current policy.
  function resolveForProxy() {
    const account = row()
    if (!account?.key_sealed) return null
    if (!validProvider(account.provider) || !validBaseUrl(account.base_url, policy) || !validModel(account.model)) return null
    const grant = isPublicHttp(account.base_url, policy) ? { base_url: account.base_url, format: MODEL_HTTP_FORMAT } : undefined
    if (grant && account.provider !== 'openai' && account.provider !== 'custom') return null
    return {
      provider: account.provider, base_url: account.base_url, model: account.model,
      api_key: unseal(sealKey, PURPOSE, account.key_sealed), source: 'user',
      ...(grant ? { http_endpoint_grant: grant } : {}),
    }
  }

  function imageView(row = store.read().image) {
    return {base_url:row?.base_url ?? DEFAULT_IMAGE_BASE,model:row?.model ?? DEFAULT_IMAGE_MODEL,
      api_key_set:Boolean(row?.key_sealed),revision:row?.revision ?? 0}
  }

  function saveImage(raw) {
    const {revision,changes} = bodyOf(raw,['revision','changes'])
    if (!Number.isSafeInteger(revision) || !isObject(changes) || !Object.keys(changes).length) fail(400,'invalid','请填写图片模型配置。')
    bodyOf(changes,['base_url','model','api_key'])
    return store.update(draft => {
      const current = imageView(draft.image ?? null)
      if (revision !== current.revision) fail(409,'conflict','配置已更新，请重新加载。',current)
      const base_url = String(changes.base_url ?? current.base_url).trim().replace(/\/+$/,'')
      const model = String(changes.model ?? current.model).trim()
      if (!base_url.startsWith('https://') || !validBaseUrl(base_url,policy) || !validModel(model)) {
        fail(400,'invalid','请填写支持图片生成的 HTTPS 接口地址和模型名。')
      }
      const api_key = changes.api_key
      if (api_key !== undefined && api_key !== null && !validApiKey(api_key)) fail(400,'invalid','请输入有效的图片 API 密钥。')
      const key_sealed = api_key === undefined ? (draft.image?.key_sealed ?? null)
        : api_key === null ? null : seal(sealKey,IMAGE_PURPOSE,api_key)
      draft.image = {base_url,model,key_sealed,revision:revision+1}
      return {image_api:imageView(draft.image)}
    })
  }

  function resolveImage() {
    const image = store.read().image
    if (!image?.key_sealed || !image.base_url.startsWith('https://') ||
      !validBaseUrl(image.base_url,policy) || !validModel(image.model)) return null
    return {base_url:image.base_url,model:image.model,api_key:unseal(sealKey,IMAGE_PURPOSE,image.key_sealed)}
  }

  function mediaView(kind, config = store.read()[kind]) {
    const {provider, model} = FIXED_PROVIDERS[kind]
    return {provider, model, has_api_key: Boolean(config?.key_sealed), revision: config?.revision ?? 0}
  }

  function saveMedia(kind, raw) {
    const {revision, api_key} = bodyOf(raw, ['revision', 'api_key'])
    if (!Number.isSafeInteger(revision) || revision < 0
      || (api_key !== null && (!validApiKey(api_key) || !/^[!-~]+$/.test(api_key)))) {
      fail(400, 'invalid', `请输入有效的 ${FIXED_PROVIDERS[kind].name} API 密钥。`)
    }
    return store.update(draft => {
      const current = mediaView(kind, draft[kind] ?? null)
      if (revision !== current.revision) fail(409, 'conflict', '配置已更新，请重新加载。', current)
      draft[kind] = {
        key_sealed: api_key === null ? null : seal(sealKey, 'flybot-workspace.model-api.' + kind, api_key),
        revision: revision + 1,
      }
      return {[kind + '_api']: mediaView(kind, draft[kind])}
    })
  }

  function resolveMedia(kind) {
    const config = store.read()[kind]
    if (!config?.key_sealed) return null
    const {provider, model} = FIXED_PROVIDERS[kind]
    return {provider, model, api_key: unseal(sealKey, 'flybot-workspace.model-api.' + kind, config.key_sealed)}
  }

  const mediaRoutes = Object.entries(FIXED_PROVIDERS).flatMap(([kind, {label}]) => {
    const path = new RegExp(`^/v1/model-api/${kind}$`)
    return [
      {method: 'GET', path, handle: async ({query}) => {
        if (query) fail(400, 'invalid', `无效的${label}模型请求。`)
        return [200, {[kind + '_api']: mediaView(kind)}]
      }},
      {method: 'POST', path, handle: async ({body}) => [200, saveMedia(kind, body)]},
    ]
  })

  return {
    store, get, save, effective, resolveForProxy, resolveImage, policy,
    resolveVideo: () => resolveMedia('video'),
    resolveMusic: () => resolveMedia('music'),
    resolveModel3d: () => resolveMedia('model3d'),
    legacy: [
      ...mediaRoutes,
      { method:'GET', path:/^\/v1\/model-api\/image$/, handle:async () => [200,{image_api:imageView()}] },
      { method:'POST', path:/^\/v1\/model-api\/image$/, handle:async ({body}) => [200,saveImage(body)] },
      { method: 'GET', path: /\/v1\/model-api/, handle: async ({ query }) => { if (query) fail(400, 'invalid', 'Invalid request'); return [200, get()] } },
      { method: 'POST', path: /\/v1\/model-api/, handle: async ({ body }) => [200, save(body)] },
    ],
  }
}

// Per-user import (flybot_workspace/dsbot_bundle.py 'model-api', account scope).
export const IMPORT_TABLES = { model_api_configs: ['id', 'provider', 'base_url', 'model', 'revision', 'updated', 'key_set'] }
export function importApplier(sealKey) {
  return (draft, tables, secrets) => {
    const [row] = tables.model_api_configs ?? []
    if (!row || (draft.account && draft.account.revision > row.revision)) return
    const key = typeof secrets.model_api_key === 'string' && validApiKey(secrets.model_api_key) ? secrets.model_api_key : null
    draft.account = { provider: row.provider, base_url: row.base_url, model: row.model,
      key_sealed: key ? seal(sealKey, PURPOSE, key) : null, revision: Math.max(1, Number(row.revision) || 1), updated: row.updated }
  }
}
