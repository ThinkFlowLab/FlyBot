import { createHash } from 'node:crypto'

const KINDS = new Set(['request', 'question', 'answer', 'progress', 'result', 'failure', 'cancel', 'cancel-observed'])
const FIELDS = ['version', 'kind', 'eventId', 'taskId', 'turnId', 'generation', 'seq', 'inputVersion', 'inputDigest', 'inReplyTo', 'payload']
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/
export function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
export function object(value, keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object')
  requireValue(Object.keys(value).every(key => keys.includes(key)), 'unknown field')
}
function text(value, max = 16384) {
  requireValue(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max, 'invalid text size')
}
export function validateInput(value) {
  object(value, ['requirement', 'excerpts', 'criteria'])
  text(value.requirement); text(value.criteria)
  requireValue(Array.isArray(value.excerpts) && value.excerpts.length > 0 && value.excerpts.length <= 16, 'invalid excerpts')
  const ids = new Set()
  for (const excerpt of value.excerpts) {
    object(excerpt, ['id', 'text'])
    requireValue(typeof excerpt.id === 'string' && ID.test(excerpt.id) && !ids.has(excerpt.id), 'invalid excerpt id')
    ids.add(excerpt.id); text(excerpt.text)
  }
  requireValue(Buffer.byteLength(JSON.stringify(value)) <= 16384, 'input too large')
}
export function canonical(value, depth = 0) {
  requireValue(depth < 16, 'value too deep')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value), 'nonfinite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`
  object(value, Object.keys(value ?? {}))
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex')

export function decode(raw) {
  requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= 32768, 'envelope too large')
  const event = JSON.parse(raw)
  object(event, FIELDS)
  requireValue(event.version === 1 && KINDS.has(event.kind), 'unsupported contract')
  for (const key of ['eventId', 'taskId', 'turnId']) requireValue(typeof event[key] === 'string' && ID.test(event[key]), `invalid ${key}`)
  for (const key of ['generation', 'seq', 'inputVersion']) requireValue(Number.isSafeInteger(event[key]) && event[key] >= (key === 'generation' ? 0 : 1), `invalid ${key}`)
  requireValue(typeof event.inputDigest === 'string' && /^[a-f0-9]{64}$/.test(event.inputDigest), 'invalid digest')
  if (event.inReplyTo !== undefined) requireValue(typeof event.inReplyTo === 'string' && ID.test(event.inReplyTo), 'invalid reply id')
  if (['answer', 'question', 'progress', 'result', 'failure', 'cancel-observed'].includes(event.kind)) requireValue(event.inReplyTo !== undefined, 'missing reply id')
  const payload = event.payload
  if (event.kind === 'request') {
    object(payload, ['input']); validateInput(payload.input)
  } else if (event.kind === 'result') {
    object(payload, ['summary', 'evidence']); text(payload.summary)
    requireValue(Array.isArray(payload.evidence) && payload.evidence.length > 0 && payload.evidence.length <= 16 && payload.evidence.every(id => typeof id === 'string' && ID.test(id)), 'invalid result evidence')
    requireValue(Buffer.byteLength(JSON.stringify(payload)) <= 16384, 'result too large')
  } else if (event.kind === 'cancel-observed') {
    object(payload, [])
  } else {
    object(payload, ['text']); text(payload.text, event.kind === 'progress' ? 2000 : 16384)
  }
  return event
}

export const encode = event => canonical(decode(JSON.stringify(event)))
