import { MAX_MEDIA_BYTES } from '../artifacts/model.js'

export const MUSIC_DURATIONS = new Set([15, 30, 60])

const MODEL = 'music_v2_5'
const COMPOSE_URL = 'https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192'
const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000]

export function musicProviderConfigured(config) {
  return config?.provider === 'elevenlabs' && config.model === MODEL && typeof config.api_key === 'string' && config.api_key.length > 0
}

function generationError(code) {
  return Object.assign(new Error('Music generation failed'), { code })
}

function isMp3(audio) {
  let offset = 0
  let end = audio.length
  if (audio.toString('latin1', 0, 3) === 'ID3') {
    if (audio.length < 10 || audio[3] < 2 || audio[3] > 4 || audio.subarray(6, 10).some(n => n >= 128)) return false
    const size = audio[6] * 0x200000 + audio[7] * 0x4000 + audio[8] * 0x80 + audio[9]
    offset = 10 + size + (audio[3] === 4 && (audio[5] & 0x10) ? 10 : 0)
  }
  if (end >= 128 && audio.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128
  let frames = 0
  while (offset + 4 <= end) {
    const header = audio[offset + 1]
    if (audio[offset] !== 0xff || (header & 0xfe) !== 0xfa) return false
    const rate = audio[offset + 2]
    const bitrate = MPEG1_LAYER3_BITRATES[rate >> 4]
    const sampleRate = MPEG1_SAMPLE_RATES[(rate >> 2) & 3]
    if (!bitrate || !sampleRate) return false
    offset += Math.floor(144000 * bitrate / sampleRate) + ((rate >> 1) & 1)
    frames++
  }
  return frames >= 2 && offset === end
}

function discardBody(response) {
  void response.body?.cancel().catch(() => {})
}

async function readAudio(response) {
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  const length = Number(response.headers.get('content-length'))
  if (type !== 'audio/mpeg' || length > MAX_MEDIA_BYTES || !response.body) {
    discardBody(response)
    throw generationError('uncertain')
  }
  const buffer = Buffer.allocUnsafe(MAX_MEDIA_BYTES)
  let bytes = 0
  for await (const chunk of response.body) {
    if (bytes + chunk.byteLength > buffer.length) throw generationError('uncertain')
    buffer.set(chunk, bytes)
    bytes += chunk.byteLength
  }
  const audio = buffer.subarray(0, bytes)
  if (!isMp3(audio)) throw generationError('uncertain')
  return audio
}

export async function generateMusic(config, job) {
  if (!musicProviderConfigured(config)) throw generationError('unconfigured')
  let response
  try {
    response = await fetch(COMPOSE_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(180_000),
      headers: { 'xi-api-key': config.api_key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        prompt: job.prompt,
        music_length_ms: job.duration * 1000,
        model_id: MODEL,
        force_instrumental: Boolean(job.instrumental),
      }),
    })
  } catch {
    throw generationError('uncertain')
  }
  if (!response.ok) {
    discardBody(response)
    if (response.status === 401 || response.status === 403) throw generationError('auth')
    if (response.status === 429) throw generationError('busy')
    if (response.status === 408 || response.status < 400 || response.status >= 500) throw generationError('uncertain')
    throw generationError('failed')
  }
  try { return await readAudio(response) }
  catch { throw generationError('uncertain') }
}
