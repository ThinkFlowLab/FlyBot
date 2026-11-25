import { sniffMime } from '../artifacts/render.js'

const API = 'https://api.dev.runwayml.com/v1'
const ASSET_ORIGIN = /^https:\/\/[a-z0-9]{1,63}\.cloudfront\.net\//i
const JSON_LIMIT = 128 * 1024
const MP4_LIMIT = 8 * 1024 * 1024
const TASK_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const PENDING = new Set(['PENDING', 'THROTTLED', 'RUNNING'])

export const VIDEO_RATIOS = {landscape: '1280:720', portrait: '720:1280'}

export class VideoError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

async function discard(response) {
  await response.body?.cancel().catch(() => {})
}

async function readBounded(response, limit) {
  if (!response.body) throw new VideoError('failed')
  const advertised = Number(response.headers.get('content-length'))
  if (advertised > limit) {
    await discard(response)
    throw new VideoError('too_large')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) throw new VideoError('too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

async function request(config, path, payload, fetcher) {
  const post = payload !== undefined
  const headers = {Authorization: 'Bearer ' + config.api_key, 'X-Runway-Version': '2024-11-06', Accept: 'application/json'}
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
    throw new VideoError(post ? 'uncertain' : 'temporary')
  }
  if (!response.ok || response.redirected) {
    await discard(response)
    if ([401, 403].includes(response.status)) throw new VideoError('auth')
    if (response.status === 429) throw new VideoError('busy')
    if (response.status >= 500 || response.status === 408 || response.redirected) throw new VideoError(post ? 'uncertain' : 'temporary')
    throw new VideoError('failed')
  }
  try {
    return JSON.parse((await readBounded(response, JSON_LIMIT)).toString('utf8'))
  } catch {
    throw new VideoError(post ? 'uncertain' : 'temporary')
  }
}

export async function submitVideo(config, job, fetcher = globalThis.fetch) {
  const result = await request(config, '/text_to_video', {
    model: 'gen4.5',
    promptText: job.prompt,
    ratio: VIDEO_RATIOS[job.shape],
    duration: 5,
  }, fetcher)
  if (typeof result?.id !== 'string' || !TASK_ID.test(result.id)) throw new VideoError('uncertain')
  return result.id
}

export async function videoResult(config, id, fetcher = globalThis.fetch) {
  if (!TASK_ID.test(id)) throw new VideoError('failed')
  const result = await request(config, '/tasks/' + id, undefined, fetcher)
  if (result?.id !== id) throw new VideoError('failed')
  if (PENDING.has(result.status)) return null
  if (result.status !== 'SUCCEEDED' || !Array.isArray(result.output)) throw new VideoError('failed')
  return downloadVideo(result.output[0], fetcher)
}

function mediaAddress(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || !ASSET_ORIGIN.test(raw)) throw new VideoError('failed')
  let url
  try { url = new URL(raw) } catch { throw new VideoError('failed') }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !url.pathname.endsWith('.mp4')) throw new VideoError('failed')
  return url.href
}

function isMp4(data) {
  if (sniffMime(data) !== 'video/mp4') return false
  let movie = false
  let media = false
  for (let offset = 0; offset < data.length;) {
    if (offset + 8 > data.length) return false
    let size = data.readUInt32BE(offset)
    let header = 8
    if (size === 1) {
      header = 16
      if (offset + header > data.length) return false
      const extended = data.readBigUInt64BE(offset + 8)
      if (extended > BigInt(data.length - offset)) return false
      size = Number(extended)
    } else if (size === 0) {
      size = data.length - offset
    }
    if (size < header || offset + size > data.length) return false
    const type = data.toString('ascii', offset + 4, offset + 8)
    if (type === 'moov' && size > header) movie = true
    if (type === 'mdat' && size > header) media = true
    offset += size
  }
  return movie && media
}

async function downloadVideo(raw, fetcher) {
  const url = mediaAddress(raw)
  let response
  try {
    // The media CDN receives only its signed URL, never the API credential.
    response = await fetcher(url, {
      method: 'GET', headers: {Accept: 'video/mp4'}, redirect: 'error', signal: AbortSignal.timeout(45_000),
    })
  } catch {
    throw new VideoError('temporary')
  }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (!response.ok || response.redirected || (type && !['video/mp4', 'application/octet-stream'].includes(type))) {
    await discard(response)
    throw new VideoError(response.status >= 500 && !response.redirected ? 'temporary' : 'failed')
  }
  let data
  try {
    data = await readBounded(response, MP4_LIMIT)
  } catch (error) {
    throw error instanceof VideoError ? error : new VideoError('temporary')
  }
  if (!isMp4(data)) throw new VideoError('failed')
  return data
}
