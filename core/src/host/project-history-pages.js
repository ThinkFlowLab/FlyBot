import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
const fail = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })
const digest = text => createHash('sha256').update(text).digest('hex')
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max

// Scan immutable evidence with bounded memory, then read only the requested range.
export async function sealedLogPage(evidence, body) {
  const offset = body.offset ?? 0, limit = body.limit ?? 8192
  if (!integer(offset, 0, Number.MAX_SAFE_INTEGER) || !integer(limit, 4, 8192)) throw fail('Invalid log page: limit must be 4–8192 bytes')
  if (body.expectedSha256 !== undefined && body.expectedSha256 !== evidence.sha256) throw fail('Log source changed; restart from current evidence', 'bot/conflict')
  const file = await open(evidence.log, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || offset > before.size) throw fail('Invalid log source or offset')
    const hash = createHash('sha256'), chunk = Buffer.alloc(65536)
    let position = 0
    while (position < before.size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, before.size - position), position)
      if (!bytesRead) throw fail('Log changed during read', 'bot/conflict')
      hash.update(chunk.subarray(0, bytesRead)); position += bytesRead
    }
    if (hash.digest('hex') !== evidence.sha256) throw fail('Log changed; evidence is stale', 'bot/conflict')
    const bytes = Buffer.alloc(Math.min(limit, before.size - offset))
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset)
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytesRead !== bytes.length) throw fail('Log changed during read', 'bot/conflict')
    let length = bytes.length, text
    while (length >= Math.max(0, bytes.length - 3)) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); break }
      catch { length-- } // Keep an incomplete final UTF-8 character for the next page.
    }
    if (text === undefined || bytes.length && !length) throw fail('Log offset is not a UTF-8 boundary')
    return { text, sha: evidence.sha ?? null, sha256: evidence.sha256, offset, totalBytes: before.size, nextOffset: offset + length < before.size ? offset + length : null, bounded: true }
  } finally { await file.close() }
}

function snapshotHash(items, count) {
  const hash = createHash('sha256')
  for (let i = 0; i < count; i++) hash.update(JSON.stringify(items[i])).update('\n')
  return hash.digest('hex')
}
export function agentHistoryPage(items, body, scope) {
  const limit = body.limit ?? 50
  if (!integer(limit, 1, 100)) throw fail('Invalid history limit')
  let cursor
  if (body.cursor !== undefined) {
    if (typeof body.cursor !== 'string' || body.cursor.length > 2048) throw fail('Invalid history cursor')
    try { cursor = JSON.parse(Buffer.from(body.cursor, 'base64url').toString('utf8')) }
    catch { throw fail('Invalid history cursor') }
    if (!cursor || cursor.scope !== scope || !integer(cursor.count, 0, items.length) || !integer(cursor.offset, 0, cursor.count)) throw fail('History cursor belongs to another scope or unavailable snapshot', 'bot/conflict')
  }
  const total = cursor?.count ?? items.length, sha256 = snapshotHash(items, total)
  if (cursor && cursor.sha256 !== sha256) throw fail('History snapshot changed; restart pagination', 'bot/conflict')
  const encode = offset => Buffer.from(JSON.stringify({ scope, offset, count: total, sha256 })).toString('base64url')
  if (body.messageIndex !== undefined) {
    if (!integer(body.messageIndex, 0, total - 1)) throw fail('Invalid history message index')
    const text = JSON.stringify(items[body.messageIndex]), sourceHash = digest(text), offset = body.textOffset ?? 0, length = body.textLimit ?? 4000
    if (!integer(offset, 0, text.length) || !integer(length, 1, 4000)) throw fail('Invalid message source page')
    if (body.expectedSha256 !== undefined && body.expectedSha256 !== sourceHash) throw fail('Message source changed', 'bot/conflict')
    const next = Math.min(offset + length, text.length)
    return { text: text.slice(offset, next), offset, nextOffset: next < text.length ? next : null, totalChars: text.length, sha256: sourceHash, cursor: encode(body.messageIndex), messageIndex: body.messageIndex }
  }
  if (body.expectedSha256 !== undefined && body.expectedSha256 !== sha256) throw fail('History snapshot changed', 'bot/conflict')
  const tail = !cursor && body.offset === undefined
  let offset = cursor?.offset ?? body.offset ?? Math.max(0, total - limit)
  if (!integer(offset, 0, total)) throw fail('Invalid history offset')
  const messages = [], end = Math.min(total, offset + limit)
  for (let index = offset; index < end; index++) {
    const row = items[index], text = JSON.stringify(row)
    const item = Buffer.byteLength(text) <= 8192 ? structuredClone(row) : { id: row.id, kind: row.kind, at: row.at, text: typeof row.text === 'string' ? row.text.slice(0, 1000) : '', truncated: true, sourceRef: { messageIndex: index, cursor: encode(index), expectedSha256: digest(text) } }
    messages.push(item)
    if (Buffer.byteLength(JSON.stringify(messages)) > 30000) {
      if (tail) { while (Buffer.byteLength(JSON.stringify(messages)) > 30000) { messages.shift(); offset++ } }
      else { messages.pop(); break }
    }
  }
  const next = offset + messages.length
  return { messages, offset, total, sha256, nextOffset: next < total ? next : null, nextCursor: next < total ? encode(next) : null, previousCursor: offset > 0 ? encode(Math.max(0, offset - limit)) : null, bounded: true, retained: true }
}
