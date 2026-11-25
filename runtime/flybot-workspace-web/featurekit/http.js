// Shared helpers for FlyBot feature modules running inside the user's
// DS-Bot. Errors keep the legacy management API shape
// ({error: {code, message, current?}}) so the existing pages work unchanged.
import { createHash, randomBytes } from 'node:crypto'

export class FeatureError extends Error {
  constructor(status, code, message, current) {
    super(message)
    this.status = status
    this.code = code
    this.current = current
  }
}

export function refuse(status, code, message, current) {
  throw new FeatureError(status, code, message, current)
}

export const HEX32 = /^[0-9a-f]{32}$/
export const newId = () => randomBytes(16).toString('hex')
export const nowSeconds = () => Math.floor(Date.now() / 1000)
export const digest = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

// Stable JSON (sorted keys, compact) for request hashes, matching Python's
// json.dumps(sort_keys=True, separators=(',', ':')) on plain JSON data.
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

export function validLongText(value, limit) {
  if (typeof value !== 'string' || value.length > limit) return false
  for (const ch of value) {
    const code = ch.codePointAt(0)
    if (code < 32 && ch !== '\t' && ch !== '\n' && ch !== '\r') return false
  }
  return true
}

// Legacy pagination contract: only limit (1-100, default 20) and cursor (32 hex).
export function pagination(query, allowed = []) {
  const keys = [...query.keys()]
  const allowedSet = new Set(['limit', 'cursor', ...allowed])
  if (keys.some((key) => !allowedSet.has(key)) || keys.some((key) => query.getAll(key).length !== 1)) {
    refuse(400, 'invalid', 'Invalid pagination parameters')
  }
  const limit = query.get('limit') ?? '20'
  const cursor = query.get('cursor') ?? ''
  if (!/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || (cursor && !HEX32.test(cursor))) {
    refuse(400, 'invalid', 'Invalid pagination parameters')
  }
  return { limit: Number(limit), cursor, args: query }
}

export function requireBodyKeys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'invalid', 'JSON object body required')
  const extra = Object.keys(body).filter((key) => !allowed.includes(key))
  if (extra.length) refuse(400, 'invalid', 'Unknown fields: ' + extra.slice(0, 5).join(', '))
  return body
}

export function idempotencyKey(headers) {
  const key = headers.get('idempotency-key') ?? ''
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
  return key
}
