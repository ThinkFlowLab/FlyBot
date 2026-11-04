import { roleOf } from '../shared/project-policy.js'
// Bounded public assistance facts; no private conversation forwarding or operational authority.
import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = message => Object.assign(new Error(message), { code: 'bot/chief-protocol' })
export function autonomyPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['maxRecoveryActions', 'maxRecoveryMs', 'guidance'].includes(key))) throw fail('Invalid Chief autonomy guidance')
  const result = { maxRecoveryActions: 4, maxRecoveryMs: 3600000, guidance: '', ...value }
  if (!Number.isSafeInteger(result.maxRecoveryActions) || result.maxRecoveryActions < 0 || result.maxRecoveryActions > 20 || !Number.isSafeInteger(result.maxRecoveryMs) || result.maxRecoveryMs < 1000 || result.maxRecoveryMs > 604800000 || typeof result.guidance !== 'string' || result.guidance.length > 8000) throw fail('Invalid Chief autonomy budgets')
  return result
}
export function assistanceRequest(decision) {
  if (decision.recipient !== undefined && !['initiator', 'operations'].includes(decision.recipient)) throw fail('Consultation recipient needs initiator or operations')
  const value = decision.assistance
  if (value === undefined && decision.recipient !== 'operations') return null
  const keys = ['cause', 'evidence', 'attempted', 'requestedOperation', 'requiredPermission', 'verification', 'resumeCondition']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 1200)) throw fail('assistance needs bounded cause/evidence/attempted/requestedOperation/requiredPermission/verification/resumeCondition strings')
  return { version: 'chief-assistance/v1', ...Object.fromEntries(keys.map(key => [key, value[key].trim()])) }
}
export function operationsContact(rt, projectId, value) {
  if (value === null || value === undefined) return null
  if (!value || Object.keys(value).some(key => !['memberId', 'agentId'].includes(key)) || typeof value.memberId !== 'string' || typeof value.agentId !== 'string') throw fail('Operations contact requires an explicit member and personal agent')
  const identity = rt.personalAgents.agentOf(value.agentId), participation = rt.personalAgents.participationFor(value.agentId, projectId)
  if (!identity || identity.status !== 'active' || identity.ownerId !== value.memberId || !participation || participation.status !== 'active' || participation.ownerId !== value.memberId || !rt.projectCan({ memberId: value.memberId }, projectId, 'configure')) throw fail('Operations contact needs a current Owner/Maintainer and active owned Project participation')
  return { memberId: value.memberId, agentId: value.agentId }
}
export function assistanceScope(state, task, recipient = 'initiator') {
  const attempt = state.projectAttempts?.[task.deliveryAttemptId]
  return { version: 'chief-assistance-scope/v1', generation: task.collaboration?.generation ?? 0, requirementsRevision: task.projectTask?.requirements?.revision ?? null, requirementsSha256: hash([task.title ?? null, task.criteria ?? null]), attemptId: task.deliveryAttemptId ?? null, candidateSha: attempt?.candidateSha ?? null, recipient, contactSha256: recipient === 'operations' ? hash([state.projectChiefPolicies?.[task.projectId]?.operationsContact ?? null, roleOf(state.projects?.[task.projectId], state.projectChiefPolicies?.[task.projectId]?.operationsContact?.memberId)]) : null }
}
export function consultationCurrent(state, row, task) {
  if (!task || task.projectId !== row.projectId || ['accepted', 'cancelled'].includes(task.status) || task.chiefQuestion?.decisionId !== row.chiefDecisionId) return false
  return !row.assistanceScope || hash(row.assistanceScope) === hash(assistanceScope(state, task, row.assistanceScope.recipient))
}
export function compensationSchedules(state, projectId, primaryId) {
  return Object.values(state.projectScheduledTasks ?? {}).filter(row => row.projectId === projectId && row.target?.kind === 'project-chief' && row.id !== primaryId && row.status !== 'deleted').slice(-10).map(row => ({ id: row.id, enabled: row.enabled, status: row.status, when: row.config.when, nextCheckAt: row.enabled ? row.nextDueAt ?? null : null, deliveries: Object.values(row.deliveries ?? {}).slice(-3).map(({ id, status, at, finishedAt }) => ({ id, status, at, finishedAt })) }))
}
export function assistanceFacts(state, task) {
  const recipient = task.chiefQuestion?.recipient
  const participation = recipient?.participationId && state.personalAgentParticipations?.[recipient.participationId]
  const row = participation && state.projectAgentTranscripts?.[participation.carrierId]?.find(item => item.id === recipient.consultationId)
  const effect = state.projectEffects?.[row?.notificationEffect?.id]
  return { recipient: recipient ? { kind: recipient.kind, memberId: recipient.memberId, agentId: recipient.agentId ?? null, consultationId: recipient.consultationId ?? null } : null, current: row ? consultationCurrent(state, row, task) : null, phase: row ? consultationCurrent(state, row, task) ? row.inbox?.phase ?? (row.status === 'completed' ? 'handled' : 'pending') : 'superseded' : null, notification: effect ? { status: effect.status, attempts: effect.executions, nextAt: effect.status === 'pending' ? effect.dueAt : null } : null, claimExpiresAt: row?.inbox?.phase === 'processing' ? row.inbox.claim?.expiresAt ?? null : null, repliedAt: row?.finishedAt ?? null }
}
