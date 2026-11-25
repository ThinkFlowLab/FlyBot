export const PRIVATE_TEXT_LIMIT = 20000

import { digest } from '../../featurekit/http.js'

const SEND_KEY = /^[A-Za-z0-9_-]{16,64}$/

export function sendId(kind, role, conversationId, key) {
  return digest(`${kind}-${role}:${conversationId}:${key}`).slice(0, 32)
}

export function textReplyKey(row, meta) {
  const key = meta?.clientKey
  if (row.role !== 'assistant' || typeof key !== 'string' || !SEND_KEY.test(key)) return null
  return row.id === sendId('text', 'reply', row.conversation_id, key) ? key : null
}

export function textReplyAttempt(meta) {
  return Number.isSafeInteger(meta?.replyAttempt) && meta.replyAttempt > 0 ? meta.replyAttempt : 1
}
