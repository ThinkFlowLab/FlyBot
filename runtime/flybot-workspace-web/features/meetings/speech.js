import {refuse, requireBodyKeys, validLongText} from '../../featurekit/http.js'

const SAMPLE_RATE = 16000
const HEADER_BYTES = 44
const MAX_SECONDS = 15
const MAX_AUDIO_BYTES = HEADER_BYTES + MAX_SECONDS * SAMPLE_RATE * 2
const MAX_BASE64_BYTES = Math.ceil(MAX_AUDIO_BYTES / 3) * 4
const READY = new Set(['ready', 'standby', 'waking'])
const PREPARING = new Set(['checking', 'downloading', 'loading', 'cancelling'])

function provider(host) {
  const context = host.currentRuntime()?.ctx
  const speech = context?.get?.('speechToText')
  const snapshot = speech?.snapshot()
  const selected = snapshot?.providers?.find(item => item.id === snapshot.selection?.providerId && item.location === 'host-local')
  if (!selected) return {status: {phase: 'unavailable', ready: false}}
  const preparation = selected.preparation || {}
  const phase = preparation.phase || 'ready'
  const progress = phase === 'downloading' && preparation.totalBytes > 0
    ? Math.round(Math.min(1, preparation.completedBytes / preparation.totalBytes) * 100) : null
  return {speech, id: selected.id, status: {phase, ready: READY.has(phase), progress}}
}

function requireProvider(host) {
  const local = provider(host)
  if (!local.speech) refuse(503, 'speech_unavailable', '当前 DS-Bot 尚未启用本地语音识别。')
  return local
}

export async function speechStatus(req) {
  if (req.queryString) refuse(400, 'invalid', 'Invalid speech request')
  if (req.method === 'GET') return {body: provider(req.host).status}
  requireBodyKeys(await req.json(), [])
  const local = requireProvider(req.host)
  if (local.status.ready || PREPARING.has(local.status.phase)) return {body: local.status}
  try {
    local.speech.prepare(local.id)
  } catch {
    refuse(503, 'speech_setup_failed', '无法开始准备语音识别，请重试。')
  }
  const status = provider(req.host).status
  // The native provider can enqueue preparation before publishing its first status.
  return {body: status.phase === local.status.phase ? {...status, phase: 'checking'} : status}
}

function decodeWave(encoded) {
  if (typeof encoded !== 'string' || encoded.length > MAX_BASE64_BYTES ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) refuse(400, 'invalid_audio', '音频格式有误。')
  const wave = Buffer.from(encoded, 'base64')
  const size = wave.length
  if (size <= HEADER_BYTES || size > MAX_AUDIO_BYTES || (size - HEADER_BYTES) % 2 ||
      wave.toString('base64') !== encoded || wave.toString('ascii', 0, 4) !== 'RIFF' ||
      wave.readUInt32LE(4) !== size - 8 || wave.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
      wave.readUInt32LE(16) !== 16 || wave.readUInt16LE(20) !== 1 || wave.readUInt16LE(22) !== 1 ||
      wave.readUInt32LE(24) !== SAMPLE_RATE || wave.readUInt32LE(28) !== SAMPLE_RATE * 2 ||
      wave.readUInt16LE(32) !== 2 || wave.readUInt16LE(34) !== 16 ||
      wave.toString('ascii', 36, 40) !== 'data' || wave.readUInt32LE(40) !== size - HEADER_BYTES) {
    refuse(400, 'invalid_audio', '请上传最长 15 秒的 PCM 音频分段。')
  }
  return wave
}

export async function transcribe(req) {
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid transcription request')
  const {audio_base64} = requireBodyKeys(await req.json(MAX_BASE64_BYTES + 256), ['audio_base64'])
  const audio = decodeWave(audio_base64)
  const local = requireProvider(req.host)
  if (!local.status.ready) refuse(409, 'speech_not_ready', '请先准备语音识别。')
  let text
  try {
    const spec = local.speech.resolve({audio, providerId: local.id})
    const timeout = AbortSignal.timeout(60000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    const result = await local.speech.transcribe(spec, signal)
    text = result?.text
  } catch {
    refuse(502, 'speech_failed', '这段音频转写失败，可以重试。')
  }
  if (!validLongText(text, 8000)) refuse(502, 'speech_failed', '语音识别返回了无效结果，请重试。')
  return {body: {text: text.trim()}}
}
