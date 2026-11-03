import { cleanText } from './diagnostics.js'
import { textOf } from './text.js'
import { ownEntry } from './store.js'

const refused = () => Object.assign(new Error('You cannot access that personal conversation'), { code: 'bot/forbidden' })
const personalBot = bot => bot && !bot.projectAgent && !bot.ephemeral && !bot.projectId && !bot.remote
export function personalRoster(rt, actor) {
  if (!actor?.memberId) throw refused()
  const bots = Object.values(rt.state.bots).filter(bot => personalBot(bot) && rt.botOwnedBy(actor, bot.id))
  const rooms = Object.values(rt.state.rooms).filter(room => (!room.projectId || rt.projectCan?.(actor, room.projectId, 'read')) && !room.face && (rt.roomMemberOf(actor, room.id) || rt.roomOwnedBy(actor, room.id)) && (room.members ?? []).every(id => {
    const bot = ownEntry(rt.state.bots, id)
    return bot && !bot.projectAgent && !bot.ephemeral && !bot.remote && (!bot.projectId || bot.projectId === room.projectId)
  }))
  return { bots: bots.map(({ id, name, role, instructions, model, color, avatar, parentId, sessionId }) => ({ id, name, role, instructions, model, color, avatar, parentId, sessionId: rt.chatOf?.(id) ?? sessionId ?? id, parts: (rt.partsOf?.(id) ?? []).map(part => ({ sessionId: part.sessionId, number: part.number })) })), rooms: rooms.map(({ id, name, members, participants, mode, projectId }) => ({ id, name, ...(projectId ? { projectId } : {}), members, participants: (participants ?? []).map(({ id, kind, displayName, role, joinedSeq, leftSeq }) => ({ id, kind, displayName, role, joinedSeq, leftSeq })), mode })), mainBotIds: rt.state.mainBotIds.filter(id => bots.some(bot => bot.id === id)) }
}
export function requirePersonalSession(rt, actor, id) {
  const roster = personalRoster(rt, actor)
  const bot = rt.botOf(id)
  if (bot && roster.bots.some(row => row.id === bot.id)) return bot.sessionId ?? bot.id
  if (roster.rooms.some(row => row.id === id)) return id
  throw refused()
}

// Only calls present on this authorized page may acquire a result. Never expose
// arguments, non-text content or outputs of hidden Bot-to-Bot turns.
export function personalToolRows(records, hidden, redact) {
  const calls = new Map()
  for (const { event } of records) {
    if (hidden.has(event.data?.turn)) continue
    if (event.type === 'tool/call' && event.data?.callId && event.data.name !== 'ask_user') {
      calls.set(event.data.callId, { id: event.data.callId, tool: cleanText(event.data.name, { redact }).slice(0, 100), status: 'started', text: '' })
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message
      const call = calls.get(message?.toolCallId ?? event.data?.callId)
      if (!call) continue
      call.status = message?.isError ? 'failed' : 'completed'
      call.text = cleanText(textOf(message?.content), { redact }).slice(0, 2000)
    }
  }
  let remaining = 16000
  return [...calls.values()].slice(-20).map(row => {
    const text = row.text.slice(0, remaining); remaining -= text.length
    return { ...row, text }
  })
}

export function createPersonalStreams(rt) {
  const streams = new Map()
  const stream = (sessionId, next) => {
    const bot = rt.botOf(rt.selfOf?.(sessionId))
    if (!personalBot(bot) || rt.chatOf(bot.id) !== sessionId) return next()
    const entry = { text: '', turn: rt.live?.get(sessionId)?.turn }
    streams.set(sessionId, entry)
    return (async function* () {
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'text-delta' && entry.text.length < 64000) entry.text = (entry.text + chunk.text).slice(0, 64000)
          yield chunk
        }
      } finally { if (streams.get(sessionId) === entry) streams.delete(sessionId) }
    })()
  }
  const read = sessionId => {
    const entry = streams.get(sessionId), turn = rt.live?.get(sessionId)?.turn
    if (!entry || turn === undefined || entry.turn !== turn || (rt.state.exchangeTurns[sessionId] ?? []).includes(turn)) return null
    const bot = rt.botOf(rt.selfOf(sessionId))
    return personalBot(bot) && rt.chatOf(bot.id) === sessionId ? { text: cleanText(entry.text, { redact: rt.redactSecrets }), speaker: bot.name, botId: bot.id } : null
  }
  return { stream, read }
}

export function personalQuestion(rt, sessionId, actor) {
  const question = rt.state.questions[sessionId]
  if (!question) return null
  const bot = rt.botOf(sessionId)
  if (!(bot && rt.botOwnedBy(actor, bot.id)) && !rt.botOwnedBy(actor, question.botId) && !rt.roomOwnedBy(actor, sessionId)) return null
  const { id, header, question: text, detail, options, multiSelect, allowCustom } = question
  return { id, header, question: text, detail, options, multiSelect, allowCustom }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const attachmentName = name => Array.from(String(name ?? 'Attachment').split(/[\\/]/).at(-1)).filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').slice(0, 200)
export function personalImageContent(text, images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) throw refused()
  let bytes = 0
  const content = images.map(image => {
    if (!IMAGE_TYPES.has(image?.mediaType) || typeof image.data !== 'string' || image.data.length > 350000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw refused()
    const decoded = Buffer.from(image.data, 'base64')
    bytes += decoded.length
    if (!decoded.length || decoded.length > 256 * 1024 || bytes > 512 * 1024) throw refused()
    return { type: 'image', mediaType: image.mediaType, data: image.data, name: attachmentName(image.name) }
  })
  return [...(text.trim() ? [{ type: 'text', text }] : []), ...content]
}
export function personalMessageAttachments(event) {
  if (!['user/message', 'assistant/message'].includes(event.type)) return []
  const content = event.data?.message?.content ?? event.data?.content
  return (Array.isArray(content) ? content : []).filter(block => ['file', 'image'].includes(block?.type)
    && /^sha256:[a-f0-9]{64}$/.test(block.attachment?.attachmentId)
    && (block.type !== 'image' || IMAGE_TYPES.has(block.attachment.mediaType))).map(block => ({
      id: block.attachment.attachmentId, seq: event.seq, kind: block.type,
      name: attachmentName(block.attachment.name), bytes: block.attachment.bytes,
      mediaType: block.type === 'image' ? block.attachment.mediaType : 'application/octet-stream',
    }))
}

// Compose durable native content through the public attachment service. A browser
// supplies bytes, never a host path, pre-existing object ID or upload receipt.
export async function personalUploadContent(store, text, images = [], files = []) {
  if (!store || !Array.isArray(files) || !Array.isArray(images) || files.length + images.length > 4) throw refused()
  const content = images.length ? personalImageContent(text, images) : text.trim() ? [{ type: 'text', text }] : []
  let bytes = images.reduce((sum, image) => sum + Buffer.from(image.data, 'base64').length, 0)
  const prepared = files.map(file => {
    if (typeof file?.data !== 'string' || file.data.length > 350000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw refused()
    const data = Buffer.from(file.data, 'base64'); bytes += data.length
    if (data.length > 256 * 1024 || bytes > 512 * 1024) throw refused()
    return { data: file.data, name: attachmentName(file.name) }
  })
  for (const file of prepared) content.push({ type: 'file', attachment: await store.admitEncodedFile(file) })
  return store.admitPromptContent(content)
}
