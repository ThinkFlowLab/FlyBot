// FlyBot private chats are Bot-owned native Session chains. Keep their
// stable saved ID separate from the live head that receives the next turn.
export const currentSession = bot => bot?.sessionId ?? bot?.id
const segmentsOf = part => Array.isArray(part?.segments)
  ? part.segments.filter(segment => typeof segment?.sessionId === 'string' && segment.sessionId)
  : []

export function privateChatThread(bot, sessionId) {
  if (!bot || !sessionId) return undefined
  const current = currentSession(bot)
  const foreground = segmentsOf(bot)
  if (current === sessionId || foreground.some(part => part.sessionId === sessionId)) {
    return { sessionId: current, segments: foreground }
  }
  if (!Array.isArray(bot.openParts)) return undefined
  const index = bot.openParts.findIndex(part => typeof part?.sessionId === 'string' && part.sessionId
    && (part.sessionId === sessionId || segmentsOf(part).some(segment => segment.sessionId === sessionId)))
  if (index === -1) return undefined
  const part = bot.openParts[index]
  return { sessionId: part.sessionId, segments: segmentsOf(part), index }
}

export function addPrivateChat(rt, bot, part) {
  if (!part.sessionId || rt.chatOwners.has(part.sessionId) || rt.pastOwners?.has(part.sessionId)) {
    throw new Error('Native private Session is already owned')
  }
  bot.flybotWorkspace ??= {}
  bot.flybotWorkspace.managedOpenParts = true
  ;(bot.openParts ??= []).push(part)
  rt.chatOwners.set(part.sessionId, bot.id)
  for (const segment of segmentsOf(part)) {
    rt.chatOwners.delete(segment.sessionId)
    rt.pastOwners?.set(segment.sessionId, {botId: bot.id})
  }
}

export function ownsPrivateChatPart(rt, botId, sessionId) {
  const past = rt.pastOwners?.get(sessionId)
  const active = rt.chatOwners?.get(sessionId)
  return past ? past.botId === botId && past.roomId === undefined && (active === undefined || active === botId)
    : active === botId
}

export function livePrivateChat(rt, botId, savedSessionId) {
  if (!ownsPrivateChatPart(rt, botId, savedSessionId)) return undefined
  const bot = rt.botOf(botId)
  const thread = privateChatThread(bot, savedSessionId)
  if (!thread || rt.chatOwners?.get(thread.sessionId) !== botId || rt.pastOwners?.has(thread.sessionId)) return undefined
  if (thread.segments.length) {
    const ids = new Set([thread.sessionId, ...thread.segments.map(part => part.sessionId)])
    const mapped = new Set(Object.values(bot.flybotWorkspace?.sessionKeys ?? {}).filter(id => ids.has(id)))
    if (mapped.size > 1) return undefined
  }
  return thread.sessionId
}
