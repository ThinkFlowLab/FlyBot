import { isActionCardId, nativeChoiceCard } from '../../lib/action-cards.js'
import { livePrivateChat } from '../../lib/native-chat.js'

export function nativePrivateCards(rt, agent, conversation, mapping) {
  if (!rt || !mapping || agent.archived || conversation.archived_at !== null || rt.readOnly?.() !== undefined) return []
  const {native_bot_id:botId,native_session_id:anchor} = mapping
  const bot = rt.botOf?.(botId)
  const identity = bot?.flybotWorkspace
  if (bot?.hidden || identity?.agent_id !== agent.id || identity.workspace_id !== agent.workspace_id) return []
  const sessionId = livePrivateChat(rt,botId,anchor)
  if (!sessionId || rt.groupOwners?.has(sessionId) || rt.taskOwners?.has(sessionId)) return []
  const key = `agent:${agent.id}:${conversation.id}`
  const keys = identity.sessionKeys ?? {}
  if ((keys[key] && keys[key] !== anchor) ||
      Object.entries(keys).some(([ref,saved]) => ref !== key && saved === anchor)) return []

  const botName = agent.name
  const cards = []
  const choice = nativeChoiceCard(rt,sessionId)
  if (choice) cards.push({...choice,botName,allowCustom:choice.question.allowCustom === true})
  if (typeof rt.answerApproval === 'function') {
    for (const approval of rt.approvalsView?.() ?? []) {
      const {id,answerable,roomId,taskId} = approval
      if (answerable && isActionCardId(id) && approval.botId === botId && approval.sessionId === sessionId &&
          roomId === undefined && taskId === undefined) cards.push({id,type:'approval',botName,approval})
    }
  }
  return cards
}
