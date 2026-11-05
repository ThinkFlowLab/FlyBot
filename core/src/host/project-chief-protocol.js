import { assistanceRequest } from './project-chief-assistance.js'
// Protocol feedback is data for Chief judgement, never a workflow or permission grant.
export const CHIEF_AUTONOMY = 'Within the explicitly authorized Project goals, your first priority is autonomous progress supported by verifiable results. Diagnose errors using current host facts and approved recovery tools; correct malformed decisions or choose another lawful path. After host restart, assess current exit and checkpoint evidence; an old restart message alone does not require a human decision. Do not repeat the same return/route without new facts. Consult the appropriate personal project agent only when needed information, authority or a human-only decision is missing. The host never selects that escalation for you. Never invent evidence or bypass exit, permission or acceptance gates.'
const actions = new Set(['close', 'route', 'return', 'request-tests', 'needs-human', 'continue', 'admit', 'revise', 'cancel', 'reopen', 'resolve-dependency', 'retry-notification', 'reconcile-exit', 'stop-execution'])
export function chiefProtocolError(field, expected, taskId = null) {
  return Object.assign(new Error(`Chief protocol: ${field} needs ${expected}`), { code: 'bot/chief-protocol', fields: [{ field, expected }], taskId: typeof taskId === 'string' ? taskId.slice(0, 100) : null })
}
export function parseChiefResponse(text, roles, { onInvalid } = {}) {
  let value
  try { value = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, '')) }
  catch { throw chiefProtocolError('response', 'one valid JSON object with summary and decisions') }
  if (!value || typeof value !== 'object' || typeof value.summary !== 'string' || value.summary.length > 8000 || !Array.isArray(value.decisions) || value.decisions.length > 30) throw chiefProtocolError('response', 'a bounded summary and an array of at most30 decisions')
  const seen = new Set()
  for (const decision of value.decisions) {
    try {
      const taskId = decision?.taskId
      if (typeof taskId !== 'string' || !taskId || taskId.length > 100) throw chiefProtocolError('taskId', 'an exact Task ID from the current snapshot')
      if (seen.has(taskId)) throw chiefProtocolError('decisions', 'at most one decision per Task in this response', taskId)
      seen.add(taskId)
      if (!actions.has(decision.action)) throw chiefProtocolError('action', 'a supported Chief action', taskId)
      if (typeof decision.reason !== 'string' || !decision.reason.trim() || decision.reason.length > 4000) throw chiefProtocolError('reason', 'bounded nonempty text up to4000 characters', taskId)
      if (['route', 'return'].includes(decision.action)) {
        if (typeof decision.targetBotId !== 'string' || !decision.targetBotId.trim() || !roles.some(row => row.id === decision.targetBotId && row.role !== 'chief')) throw chiefProtocolError('targetBotId', 'one exact active logical Bot ID from logicalBots, excluding Chief', taskId)
      }
      if (decision.criteria !== undefined) {
        if (!Array.isArray(decision.criteria)) throw chiefProtocolError('criteria', 'an evidence array, separate from requirements.criteria text', taskId)
        for (const [index, item] of decision.criteria.entries()) {
          if (!item || typeof item.criterion !== 'string' || typeof item.passed !== 'boolean' || typeof item.evidence !== 'string') throw chiefProtocolError(`criteria[${index}]`, 'criterion/evidence strings and a passed boolean; never inferred or repaired', taskId)
        }
      }
      if (decision.action === 'needs-human') assistanceRequest(decision)
      else if (decision.recipient !== undefined || decision.assistance !== undefined) throw chiefProtocolError('assistance', 'consultation fields only on needs-human', taskId)
      if (decision.requirements !== undefined) {
        if (!decision.requirements || typeof decision.requirements !== 'object' || Array.isArray(decision.requirements)) throw chiefProtocolError('requirements', 'an object of bounded text requirements', taskId)
        for (const key of ['title', 'criteria', 'impact', 'scope']) if (decision.requirements[key] !== undefined && (typeof decision.requirements[key] !== 'string' || !decision.requirements[key].trim() || decision.requirements[key].length > 16000)) throw chiefProtocolError(`requirements.${key}`, 'bounded nonempty text, not an evidence array', taskId)
      }
    } catch (error) { if (!onInvalid) throw error; onInvalid(decision, error) }
  }
  if (value.roleProposals !== undefined && (!Array.isArray(value.roleProposals) || value.roleProposals.length > 4)) throw chiefProtocolError('roleProposals', 'a bounded array of at most4 proposals')
  return value
}
export function correctionBudget(policy) {
  const value = policy?.inspection?.correctionBudget ?? 2
  if (!Number.isSafeInteger(value) || value < 0 || value > 4) throw new Error('Chief correctionBudget must be an integer from0 to4')
  return value
}
