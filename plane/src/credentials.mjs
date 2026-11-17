// Two token families, one file, no overlap (#3113). An operator token (`op_…`) is what a person's
// API client presents to the management plane; a control token (`ctl_…`) is what the plane
// presents to one FlyBot instance. Neither verifies against the other's table, and only sha256
// digests are ever persisted — `mintOperatorToken` hands the plaintext back exactly once, and a
// log line that wants to name a token goes through `redact()`.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const OPERATOR_PREFIX = 'op_'
export const CONTROL_PREFIX = 'ctl_'

export function hash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

const mint = prefix => {
  const token = `${prefix}${randomBytes(16).toString('hex')}`
  return { token, digest: hash(token) }
}

export function mintControlToken() {
  return mint(CONTROL_PREFIX)
}

export function mintOperatorToken(store, accountId) {
  const account = store.findAccount(accountId)
  if (!account) throw new Error(`no account ${accountId}`)
  const minted = mint(OPERATOR_PREFIX)
  // The store keeps an array so a second mint does not silently retire a token that may still be
  // in a client's hands; retiring one is a later slice's job.
  account.operatorTokenHashes.push(minted.digest)
  store.persist()
  return minted
}

const bearer = authorization => {
  const match = /^Bearer (.+)$/.exec(String(authorization ?? ''))
  return match ? match[1] : null
}

const safeEqual = (a, b) => {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

// A control token never verifies here: its digest lives on an instance record, not on an account,
// so the scan below cannot match it even though the comparison itself is safe.
export function verifyOperator(store, authorization) {
  const token = bearer(authorization)
  if (!token || !token.startsWith(OPERATOR_PREFIX)) return null
  const digest = hash(token)
  for (const account of store.accounts()) {
    if (account.operatorTokenHashes.some(stored => safeEqual(stored, digest))) {
      return { accountId: account.id }
    }
  }
  return null
}

export function verifyControl(instance, authorization) {
  const token = bearer(authorization)
  if (!token || !token.startsWith(CONTROL_PREFIX) || !instance) return false
  return safeEqual(instance.controlTokenHash, hash(token))
}

export function redact(token) {
  const text = String(token ?? '')
  const at = text.indexOf('_')
  return at > 0 ? `${text.slice(0, at + 1)}****` : '****'
}
