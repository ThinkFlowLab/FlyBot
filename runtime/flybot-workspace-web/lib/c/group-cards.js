import { Fault, isObject } from '../b4/http.js'

export const GROUP_CARD_ID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const cardId = new RegExp(`^${GROUP_CARD_ID}$`)

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
    if (!groupSession(rt, room, botId, sessionId) || typeof rt.answerQuestion !== 'function') continue
    const question = rt.state.questions?.[sessionId]
    if (!cardId.test(question?.id ?? '') || typeof question.question !== 'string' || !question.question.trim() ||
        !Array.isArray(question.options) || !question.options.length || question.options.length > 6 ||
        question.options.some(option => typeof option?.label !== 'string' || !option.label.trim())) continue
    cards.push({id:question.id,type:'choice',ref,sessionId,question})
  }
  if (typeof rt.answerApproval === 'function') for (const approval of rt.approvalsView?.() ?? []) {
    const {id,roomId,botId,sessionId,taskId,answerable} = approval
    const ref = seats.get(botId)
    if (!answerable || !ref || roomId !== room.id || !cardId.test(id ?? '')) continue
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

export function groupCardView(rt, card) {
  const display = (value, limit) => typeof value === 'string' && value.trim()
    ? (rt.redactSecrets?.(value) ?? value).slice(0,limit).toWellFormed() : undefined
  const view = {id:card.id,type:card.type,bot_name:display(card.botName,120) ?? 'Bot'}
  if (card.type === 'choice') return {...view,question:display(card.question.question,1000),detail:display(card.question.detail,1000),
    multiple:card.question.multiSelect === true,
    options:card.question.options.map(option => ({label:display(option.label,300),description:display(option.description,500)}))}
  return {...view,tool:display(card.approval.tool,160),reason:display(card.approval.reason,500),
    detail:display(card.approval.detail?.text,1000),code:display(card.approval.detail?.code,2400)}
}

export function groupCardAnswer(body) {
  if (isObject(body) && Object.keys(body).length === 1) {
    if (body.choice === 'allow' || body.choice === 'reject') return {choice:body.choice}
    const {selected} = body
    if (Array.isArray(selected) && selected.length >= 1 && selected.length <= 6 &&
        selected.every(index => Number.isInteger(index) && index >= 0 && index < 6) && new Set(selected).size === selected.length) {
      return {selected}
    }
  }
  throw new Fault(400,'invalid','请选择有效的卡片操作。')
}

export async function answerGroupCard(rt, card, answer) {
  try {
    if (card.type === 'approval' && answer.choice) {
      await rt.answerApproval(card.id, answer.choice)
      return
    }
    if (card.type === 'choice' && answer.selected &&
        (card.question.multiSelect === true || answer.selected.length === 1) &&
        answer.selected.every(index => index < card.question.options.length)) {
      await rt.answerQuestion(card.sessionId, card.id, {selected:answer.selected.map(index => card.question.options[index].label)})
      return
    }
  } catch (error) {
    if (error?.code === 'bot/stale') throw new Fault(409,'stale','这张卡片已处理或不再可用。')
    if (error?.code === 'bot/invalid') throw new Fault(400,'invalid','请选择有效的卡片操作。')
    throw error
  }
  throw new Fault(400,'invalid','请选择有效的卡片操作。')
}
