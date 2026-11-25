import { MAX_GLB_BYTES, validGlb } from '../../lib/glb.js'

const API = 'https://api.meshy.ai'
const MODEL = 'meshy-7.1'
const STAGES = { preview: '/openapi/v2/text-to-3d', refine: '/openapi/v2/text-to-3d', image: '/openapi/v1/image-to-3d' }
const ASSET_ADDRESS = /^https:\/\/assets\.meshy\.ai\//i
const TASK_ID = /^[A-Za-z0-9_-]{1,192}$/
const JSON_LIMIT = 128 * 1024
const TYPES = new Set(['model/gltf-binary', 'application/octet-stream'])
const REMESH = {should_remesh: true, topology: 'triangle', target_polycount: 12000}
const TEXTURE = {enable_pbr: false, texture_resolution: '2k'}

export function model3dProviderConfigured(config) {
  return config?.provider === 'meshy' && config.model === MODEL && typeof config.api_key === 'string' && config.api_key.length > 0
}

class ModelError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function discard(response) {
  void response.body?.cancel().catch(() => {})
}

async function readBounded(response, limit) {
  if (!response.body) throw new ModelError('failed')
  if (Number(response.headers.get('content-length')) > limit) {
    discard(response)
    throw new ModelError('too_large')
  }
  const data = Buffer.allocUnsafe(limit)
  let length = 0
  for await (const chunk of response.body) {
    if (chunk.byteLength > limit - length) throw new ModelError('too_large')
    data.set(chunk, length)
    length += chunk.byteLength
  }
  return data.subarray(0, length)
}

async function meshApi(config, path, payload, fetcher) {
  const post = payload !== undefined
  const uncertain = post ? 'uncertain' : 'temporary'
  const headers = {Authorization: 'Bearer ' + config.api_key, Accept: 'application/json'}
  if (post) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetcher(API + path, {
      method: post ? 'POST' : 'GET',
      headers,
      ...(post ? {body: JSON.stringify(payload)} : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    })
  } catch {
    throw new ModelError(uncertain)
  }
  if (!response.ok || response.redirected) {
    discard(response)
    if (!response.redirected) {
      if (response.status === 403 && post) throw new ModelError('rejected')
      if ([401, 402, 403].includes(response.status)) throw new ModelError('auth')
      if (response.status === 429) throw new ModelError('busy')
      if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new ModelError('failed')
    }
    throw new ModelError(uncertain)
  }
  try {
    return JSON.parse((await readBounded(response, JSON_LIMIT)).toString('utf8'))
  } catch {
    throw new ModelError(uncertain)
  }
}

export async function submitModel3d(config, stage, job, fetcher = globalThis.fetch) {
  const base = {target_formats: ['glb'], moderation: true}
  let body
  if (stage === 'preview') {
    body = {...base, ...REMESH, mode: 'preview', ai_model: MODEL, prompt: job.prompt}
  } else if (stage === 'refine' && TASK_ID.test(job.preview_id ?? '')) {
    // Default to the texture model inherited from Meshy's successful preview.
    body = {...base, ...TEXTURE, mode: 'refine', preview_task_id: job.preview_id, texture_prompt: job.prompt}
  } else if (stage === 'image') {
    const imageUrl = 'data:' + job.image_mime + ';base64,' + job.image_base64
    body = {...base, ...REMESH, ...TEXTURE, ai_model: MODEL, image_url: imageUrl, should_texture: true}
  } else {
    throw new ModelError('failed')
  }
  const value = await meshApi(config, STAGES[stage], body, fetcher)
  if (typeof value?.result !== 'string' || !TASK_ID.test(value.result)) throw new ModelError('uncertain')
  return value.result
}

function assetAddress(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || !ASSET_ADDRESS.test(raw) || /[\u0000-\u0020\u007f\\]/.test(raw)) {
    throw new ModelError('failed')
  }
  let url
  try { url = new URL(raw) } catch { throw new ModelError('failed') }
  if (url.origin !== 'https://assets.meshy.ai' || url.username || url.password || url.hash || !url.pathname.endsWith('.glb')) {
    throw new ModelError('failed')
  }
  return url.href
}

async function downloadModel3d(raw, fetcher) {
  const address = assetAddress(raw)
  let response
  try {
    // The signed asset URL is sufficient. The model API key stays on the API origin.
    response = await fetcher(address, {
      method: 'GET', headers: {Accept: 'model/gltf-binary'}, redirect: 'error', signal: AbortSignal.timeout(45_000),
    })
  } catch {
    throw new ModelError('temporary')
  }
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (!response.ok || response.redirected || (type && !TYPES.has(type))) {
    discard(response)
    const transient = !response.redirected && [403, 408, 429, 500, 502, 503, 504].includes(response.status)
    throw new ModelError(transient ? 'temporary' : 'failed')
  }
  let data
  try {
    data = await readBounded(response, MAX_GLB_BYTES)
  } catch (error) {
    throw error instanceof ModelError ? error : new ModelError('temporary')
  }
  if (!validGlb(data)) throw new ModelError('failed')
  return data
}

export async function model3dResult(config, stage, id, fetcher = globalThis.fetch) {
  if (!Object.hasOwn(STAGES, stage) || typeof id !== 'string' || !TASK_ID.test(id)) throw new ModelError('failed')
  const task = await meshApi(config, STAGES[stage] + '/' + id, undefined, fetcher)
  if (task?.id !== id) throw new ModelError('failed')
  if (task.status === 'PENDING' || task.status === 'IN_PROGRESS') {
    const progress = Number.isFinite(task.progress) ? Math.max(0, Math.min(99, Math.floor(task.progress))) : 0
    return {done: false, progress}
  }
  if (task.status !== 'SUCCEEDED') throw new ModelError('failed')
  if (stage === 'preview') return {done: true}
  return {done: true, data: await downloadModel3d(task.model_urls?.glb, fetcher)}
}
