// Sealed secrets for B4 features (model API key, Composio key, MCP bearer
// tokens). AES-256-GCM, the purpose string is authenticated data so a blob
// cannot be replayed under another purpose. The 32-byte key comes from an
// operator/manager file (FLYBOT_WORKSPACE_SEAL_KEY_FILE, default
// /run/secrets/flybot-workspace-seal.key) or, without one, a private 0600 key file
// on this user's volume. Plain values never touch disk, logs or responses.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, openSync, readFileSync, writeSync, closeSync, fstatSync, constants } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_KEY_FILE = '/run/secrets/flybot-workspace-seal.key'

function parseKey(raw) {
  const text = raw.toString('utf8').trim()
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex')
  if (raw.length === 32) return Buffer.from(raw)
  throw Object.assign(new Error('seal key file must hold 32 bytes or 64 hex characters'), { code: 'flybot-workspace/seal-key' })
}

// Transport keys must never fall back to a newly-generated local storage key.
export function loadImportSealKey(env = process.env) {
  try { return parseKey(readFileSync(env.FLYBOT_WORKSPACE_SEAL_KEY_FILE || DEFAULT_KEY_FILE)) }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw Object.assign(new Error('runtime import key unavailable or invalid'), { code: 'flybot-workspace/import-key' })
  }
}

export function loadSealKey({ env = process.env, fallbackFile, preferFallback = false }) {
  // Keep the key that encrypted an existing local store when a manager mount
  // arrives later. Never rotate it just because transport configuration changed.
  if (preferFallback) {
    try { return parseKey(readFileSync(fallbackFile)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const configured = env.FLYBOT_WORKSPACE_SEAL_KEY_FILE || DEFAULT_KEY_FILE
  try { return parseKey(readFileSync(configured)) } catch (error) {
    if (env.FLYBOT_WORKSPACE_SEAL_KEY_FILE && error?.code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(fallbackFile), { recursive: true, mode: 0o700 })
  const fd = openSync(fallbackFile, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077)) throw Object.assign(new Error('seal key must be a private file'), { code: 'flybot-workspace/seal-key' })
    const existing = readFileSync(fd)
    if (existing.length) return parseKey(existing)
    const key = randomBytes(32)
    writeSync(fd, key.toString('hex'))
    return key
  } finally { closeSync(fd) }
}

export function seal(key, purpose, plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(String(purpose)))
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return 'v1.' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

export function unseal(key, purpose, blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) throw Object.assign(new Error('sealed value is corrupt'), { code: 'flybot-workspace/sealed' })
  const raw = Buffer.from(blob.slice(3), 'base64url')
  if (raw.length < 29) throw Object.assign(new Error('sealed value is corrupt'), { code: 'flybot-workspace/sealed' })
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    decipher.setAAD(Buffer.from(String(purpose)))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch { throw Object.assign(new Error('sealed value is corrupt'), { code: 'flybot-workspace/sealed' }) }
}

// flybot_workspace/model_api.py wrap() format (HMAC-SHA256 keystream + tag), used by
// platform export bundles that hand legacy secrets to this runtime.
export function unwrapLegacy(key, blobHex) {
  const raw = Buffer.from(String(blobHex), 'hex')
  if (raw.length < 48 || raw.toString('hex') !== String(blobHex).toLowerCase()) throw Object.assign(new Error('corrupt wrapped value'), { code: 'flybot-workspace/sealed' })
  const nonce = raw.subarray(0, 16), cipher = raw.subarray(16, -32), tag = raw.subarray(-32)
  const expected = createHmac('sha256', key).update(Buffer.concat([nonce, cipher])).digest()
  if (!timingSafeEqual(expected, tag)) throw Object.assign(new Error('corrupt wrapped value'), { code: 'flybot-workspace/sealed' })
  const out = Buffer.alloc(cipher.length)
  for (let offset = 0, counter = 0; offset < cipher.length; counter += 1) {
    const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(counter))
    const block = createHmac('sha256', key).update(Buffer.concat([nonce, ctr])).digest()
    for (let i = 0; i < block.length && offset < cipher.length; i += 1, offset += 1) out[offset] = cipher[offset] ^ block[i]
  }
  return out.toString('utf8')
}
