import { validLongText } from '../featurekit/http.js'
import { Fault, isObject } from './b4/http.js'

export const ACTION_CARD_ID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const cardId = new RegExp(`^${ACTION_CARD_ID}$`)
export const isActionCardId = value => typeof value === 'string' && cardId.test(value)

export function nativeChoiceCard(rt, sessionId) {
  if (typeof rt.answerQuestion !== 'function') return
  const question = rt.state?.questions?.[sessionId]
  if (!isActionCardId(question?.id) || typeof question.question !== 'string' || !question.question.trim() ||
      !Array.isArray(question.options) || !question.options.length || question.options.length > 6 ||
      question.options.some(option => typeof option?.label !== 'string' || !option.label.trim())) return
  return {id:question.id,type:'choice',sessionId,question}
}

export function actionCardView(rt, card) {
  const display = (value, limit) => typeof value === 'string' && value.trim()
    ? (rt.redactSecrets?.(value) ?? value).slice(0,limit).toWellFormed() : undefined
  const view = {id:card.id,type:card.type,bot_name:display(card.botName,120) ?? 'Bot'}
  if (card.type === 'choice') return {...view,question:display(card.question.question,1000),detail:display(card.question.detail,1000),
    multiple:card.question.multiSelect === true, ...(card.allowCustom ? {allow_custom:true} : {}),
    options:card.question.options.map(option => ({label:display(option.label,300),description:display(option.description,500)}))}
  return {...view,tool:display(card.approval.tool,160),reason:display(card.approval.reason,500),
    detail:display(card.approval.detail?.text,1000),code:display(card.approval.detail?.code,2400)}
}

const invalidAnswer = () => new Fault(400,'invalid','请选择有效的卡片操作。')

export function parseActionCardAnswer(body, allowCustom = false) {
  if (isObject(body) && Object.keys(body).length === 1) {
    if (body.choice === 'allow' || body.choice === 'reject') return {choice:body.choice}
    if (allowCustom && validLongText(body.custom,1000) && body.custom.isWellFormed() && body.custom.trim()) {
      return {custom:body.custom.trim()}
    }
    const {selected} = body
    if (Array.isArray(selected) && selected.length >= 1 && selected.length <= 6 &&
        selected.every(index => Number.isInteger(index) && index >= 0 && index < 6) && new Set(selected).size === selected.length) {
      return {selected}
    }
  }
  throw invalidAnswer()
}

export async function answerActionCard(rt, card, answer, requestId) {
  try {
    if (card.type === 'approval' && answer.choice) {
      await rt.answerApproval(card.id, answer.choice)
      return
    }
    if (card.type === 'choice' && answer.custom && card.allowCustom) {
      await rt.answerQuestion(card.sessionId, card.id, {custom:answer.custom}, requestId)
      return
    }
    if (card.type === 'choice' && answer.selected &&
        (card.question.multiSelect === true || answer.selected.length === 1) &&
        answer.selected.every(index => index < card.question.options.length)) {
      await rt.answerQuestion(card.sessionId, card.id, {selected:answer.selected.map(index => card.question.options[index].label)}, requestId)
      return
    }
  } catch (error) {
    if (error?.code === 'bot/stale') throw new Fault(409,'stale','这张卡片已处理或不再可用。')
    if (error?.code === 'bot/invalid') throw invalidAnswer()
    throw error
  }
  throw invalidAnswer()
}
