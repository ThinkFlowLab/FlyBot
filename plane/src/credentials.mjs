// The two credentials of the management plane, and the only place either is minted or checked.
//
//   op_<32 hex>   operator token — what a person/agent uses against /api/* (account-scoped)
//   ctl_<32 hex>  instance control token — what the plane hands an instance, never accepted on /api/*
//
// Only the sha256 of either is stored; comparison is timing-safe. `redact()` is what logs use.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const OPERATOR_PREFIX = 'op_'
const CONTROL_PREFIX = 'ctl_'
const TOKEN_RE = /^(?:op|ctl)_[0-9a-f]{32}$/

export function mintOperatorToken(store, accountId) {
  if (!store || typeof store.upsertAccount !== 'function') throw new TypeError('mintOperatorToken needs a store')
  if (typeof accountId !== 'string' || accountId === '') throw new TypeError('mintOperatorToken needs an account id')
  const token = `${OPERATOR_PREFIX}${randomBytes(16).toString('hex')}`
  store.upsertAccount({
    id: accountId,
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
  })
  return token
}

export function mintControlToken() {
  return `${CONTROL_PREFIX}${randomBytes(16).toString('hex')}`
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function digest(token) {
  return createHash('sha256').update(token).digest()
}

// Accepts `Bearer <token>` (HTTP) or the bare token (tests, internal calls).
export function bearerToken(header) {
  if (typeof header !== 'string') return null
  const match = header.match(/^\s*Bearer\s+(\S+)\s*$/i)
  const token = match ? match[1] : header.trim()
  return token === '' ? null : token
}

export function verifyOperator(store, header) {
  const token = bearerToken(header)
  if (!token || !token.startsWith(OPERATOR_PREFIX) || !TOKEN_RE.test(token)) return null
  const expected = digest(token)
  let found = null
  for (const account of store.listAccounts()) {
    const stored = Buffer.from(account.tokenHash ?? '', 'hex')
    if (stored.length === expected.length && timingSafeEqual(stored, expected)) found = account
  }
  return found
}

export function verifyControl(instance, header) {
  const token = bearerToken(header)
  if (!token || !token.startsWith(CONTROL_PREFIX) || !TOKEN_RE.test(token)) return null
  if (!instance || typeof instance.controlTokenHash !== 'string') return null
  const stored = Buffer.from(instance.controlTokenHash, 'hex')
  const expected = digest(token)
  if (stored.length !== expected.length) return null
  return timingSafeEqual(stored, expected) ? { id: instance.id } : null
}

export function redact(token) {
  if (typeof token !== 'string') return '<redacted>'
  if (token.startsWith(CONTROL_PREFIX)) return `${CONTROL_PREFIX}<redacted>`
  if (token.startsWith(OPERATOR_PREFIX)) return `${OPERATOR_PREFIX}<redacted>`
  return '<redacted>'
}
