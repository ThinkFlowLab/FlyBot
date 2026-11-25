// Load the operator-supplied model API config at container start.
// The management server (lane 2 owns the config API) resolves the platform
// default plus optional user override (override wins) and injects one secret
// file or env pointer. This image never bakes a key, never logs one, and does
// not enforce credits or usage limits.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { validateModelEndpoint } from './model-http-policy.mjs'

export const DEFAULT_FILES = [
  '/run/secrets/flybot-workspace-model-api.json',
  '/data/secrets/model-api.json',
]
export const ENV_FILE = 'FLYBOT_WORKSPACE_MODEL_API_FILE'
const ALLOWED_PREFIXES = ['/run/secrets/', '/data/secrets/']
const MAX_BYTES = 16 * 1024
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/
const MODEL = /^[A-Za-z0-9._:/-]{1,128}$/

export function keyRefFor(provider) {
  return `${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

export function redact(value) {
  if (value == null) return value
  if (typeof value === 'string') {
    return value.replace(/("api_key"\s*:\s*")([^"]*)(")/gi, '$1***$3')
      .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
  }
  if (typeof value === 'object') {
    const copy = Array.isArray(value) ? [...value] : { ...value }
    if (copy.api_key !== undefined) copy.api_key = '***'
    return copy
  }
  return value
}

export class ModelApiError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ModelApiError'
  }
}

function assertAllowedPath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) {
    throw new ModelApiError('model API file path is invalid')
  }
  if (input.includes('\0') || input.includes('\n')) {
    throw new ModelApiError('model API file path is invalid')
  }
  let resolved
  try {
    resolved = realpathSync(input)
  } catch {
    throw new ModelApiError('model API file is not readable')
  }
  if (!ALLOWED_PREFIXES.some((prefix) => resolved === prefix.slice(0, -1) || resolved.startsWith(prefix))) {
    throw new ModelApiError('model API file must live under /run/secrets or /data/secrets')
  }
  const st = statSync(resolved)
  if (!st.isFile()) throw new ModelApiError('model API path is not a file')
  if (st.size > MAX_BYTES) throw new ModelApiError('model API file is too large')
  return resolved
}

export function parseModelApi(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new ModelApiError('model API file is not valid JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ModelApiError('model API file must be a JSON object')
  }
  const provider = typeof data.provider === 'string' ? data.provider.trim().toLowerCase() : ''
  const apiKey = typeof data.api_key === 'string' ? data.api_key : ''
  const baseUrl = data.base_url == null ? undefined : String(data.base_url).trim()
  const model = data.model == null ? undefined : String(data.model).trim()
  if (!PROVIDER.test(provider)) throw new ModelApiError('model API provider is invalid')
  if (apiKey.length < 1 || apiKey.length > 8192 || apiKey !== apiKey.trim()) {
    throw new ModelApiError('model API key is invalid')
  }
  if (baseUrl !== undefined) {
    let url
    try { url = new URL(baseUrl) } catch { throw new ModelApiError('model API base_url is invalid') }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ModelApiError('model API base_url must be http(s)')
    }
    if (url.username || url.password) {
      throw new ModelApiError('model API base_url must not include credentials')
    }
  }
  try {
    if (baseUrl !== undefined) {
      if (data.http_endpoint_grant !== undefined && data.base_url !== baseUrl) throw new Error()
      validateModelEndpoint(baseUrl, data.http_endpoint_grant)
    }
    else if (data.http_endpoint_grant !== undefined) throw new Error()
  } catch { throw new ModelApiError('model API endpoint or HTTP task grant rejected') }
  if (model !== undefined && !MODEL.test(model)) throw new ModelApiError('model API model is invalid')
  // The management server resolves platform default vs optional user override
  // (override wins) and writes one file. The container does not merge, and it
  // does not enforce credits or usage limits.
  let source
  if (data.source != null && String(data.source).trim() !== '') {
    source = String(data.source).trim().toLowerCase()
    if (source !== 'platform' && source !== 'user') {
      throw new ModelApiError('model API source must be platform or user')
    }
  }
  return { provider, api_key: apiKey, base_url: baseUrl, model, source, api_key_env: keyRefFor(provider),
    ...(data.http_endpoint_grant !== undefined ? {http_endpoint_grant: data.http_endpoint_grant} : {}) }
}

export function contentsToModelApi(raw) {
  const text = String(raw).trim()
  if (text === '') return undefined
  return parseModelApi(text)
}

export function readModelApiFile(path) {
  return contentsToModelApi(readFileSync(assertAllowedPath(path), 'utf8'))
}

export function resolveModelApiPath(env = process.env) {
  const configured = env[ENV_FILE]
  if (configured && configured.trim() !== '') return configured.trim()
  for (const candidate of DEFAULT_FILES) {
    try {
      statSync(candidate)
      return candidate
    } catch { /* try the next default */ }
  }
  return undefined
}

export function loadModelApi(env = process.env) {
  const path = resolveModelApiPath(env)
  if (path === undefined) return undefined
  return readModelApiFile(path)
}

// Apply non-secret fields and the API key env var. Never log the key.
export function applyModelApi(config, env = process.env, log = console) {
  if (!config) return env
  if (config.http_endpoint_grant !== undefined) {
    // The native DSH provider SDK has no audited exact/no-redirect transport.
    // Do not export this plaintext credential to that SDK or a stale provider.
    validateModelEndpoint(config.base_url, config.http_endpoint_grant)
    delete env[config.api_key_env]
    for (const name of ['PROVIDER', 'BASE_URL', 'NAME', 'SOURCE']) delete env['FLYBOT_WORKSPACE_MODEL_' + name]
    log.info?.('model API ready through the DS-Bot loopback proxy')
    return env
  }
  env[config.api_key_env] = config.api_key
  env.FLYBOT_WORKSPACE_MODEL_PROVIDER = config.provider
  if (config.base_url) env.FLYBOT_WORKSPACE_MODEL_BASE_URL = config.base_url
  if (config.model) env.FLYBOT_WORKSPACE_MODEL_NAME = config.model
  if (config.source) env.FLYBOT_WORKSPACE_MODEL_SOURCE = config.source
  log.info?.(
    `model API ready: provider=${config.provider}`
    + (config.model ? ` model=${config.model}` : '')
    + (config.base_url ? ` base_url=${config.base_url}` : '')
    + (config.source ? ` source=${config.source}` : ' source=resolved')
    + ` key_env=${config.api_key_env}`,
  )
  return env
}
