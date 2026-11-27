import { isActionCardId, nativeChoiceCard } from '../action-cards.js'

export { ACTION_CARD_ID as GROUP_CARD_ID, answerActionCard as answerGroupCard,
  parseActionCardAnswer as groupCardAnswer, actionCardView as groupCardView } from '../action-cards.js'

function groupSession(rt, room, botId, sessionId) {
  const owner = rt.groupOwners?.get(sessionId)
  return typeof sessionId === 'string' && room.sessions?.[botId] === sessionId && owner?.roomId === room.id && owner.botId === botId
}

export function nativeGroupCards(rt, conversationId) {
  const room = Object.values(rt?.state?.rooms ?? {}).find(item => item.flybotWorkspace?.conversation_id === conversationId)
  if (!room || !Array.isArray(room.members) || rt.readOnly?.() !== undefined) return []
  const cards = []
  const seats = new Map()
  for (const botId of room.members) {
    const bot = rt.botOf?.(botId)
    const ref = bot?.flybotWorkspace?.agent_id
    if (typeof ref !== 'string' || !ref) continue
    seats.set(botId, ref)
    const sessionId = room.sessions?.[botId]
    if (!groupSession(rt, room, botId, sessionId)) continue
    const card = nativeChoiceCard(rt,sessionId)
    if (card) cards.push({...card,ref})
  }
  if (typeof rt.answerApproval === 'function') for (const approval of rt.approvalsView?.() ?? []) {
    const {id,roomId,botId,sessionId,taskId,answerable} = approval
    const ref = seats.get(botId)
    if (!answerable || !ref || roomId !== room.id || !isActionCardId(id)) continue
    const task = rt.taskOwners?.get(sessionId)
    const activeTask = task?.roomId === room.id && task.botId === botId && typeof taskId === 'string' && task.taskId === taskId
    if (groupSession(rt, room, botId, sessionId) || activeTask) cards.push({id,type:'approval',ref,approval})
  }
  return cards
}

export function ownedGroupCards(group, cards) {
  const participants = new Set((group.members ?? []).filter(member => member.suspended !== true).map(member => member.owner_id))
  const seats = new Map((group.agents ?? []).filter(seat => seat.mine === true &&
    typeof seat.owner?.owner_id === 'string' && participants.has(seat.owner.owner_id))
    .map(seat => [seat.agent_ref, seat.name]))
  return cards.filter(card => seats.has(card.ref)).map(card => ({...card,botName:seats.get(card.ref)}))
}
