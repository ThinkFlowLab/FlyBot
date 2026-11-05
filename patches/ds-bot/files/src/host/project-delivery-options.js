// Read projections share the structural guards used by delivery commands.
import { createHash } from 'node:crypto'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const admissions = (state, task) => Object.values(state.projectQueue ?? {}).filter(row => row.projectId === task.projectId && row.taskId === task.id && row.continuation?.mode === 'next' && row.continuation.previousAttemptId === task.deliveryAttemptId).map(row => ({ id: row.id, status: row.status, reason: row.reason ?? null, expectedBaseSha: row.continuation.expectedBaseSha })).sort((a, b) => a.id.localeCompare(b.id))
const refuse = message => Object.assign(new Error(message), { code: 'bot/delivery' })
export function deliveryScope(state, task) {
  const a = state.projectAttempts?.[task.deliveryAttemptId]
  return digest([task.id, task.projectId, task.status, task.title, task.criteria, task.projectTask?.requirements, task.collaboration?.generation, task.collaboration?.claim?.id, task.deliveryAttemptId, a?.status, a?.requirement, a?.candidateSha, a?.pr, a?.evidence, a?.settlement, a?.cancelRequested, a?.supersededBy, admissions(state, task), Object.values(state.projectTaskInputs ?? {}).filter(row => row.taskId === task.id && row.projectId === task.projectId).map(row => [row.id, row.sha256, row.status, row.source]).sort((a, b) => a[0].localeCompare(b[0]))])
}
export function requireAttemptAcceptance(task, a) {
  if (!a || task.deliveryAttemptId !== a.id || a.taskId !== task.id || a.projectId !== task.projectId || ['accepted', 'cancelled'].includes(task.status) || a.cancelRequested || a.supersededBy) throw refuse('Attempt acceptance needs the current unfinished Task')
  if (!['waiting-acceptance', 'accepted'].includes(a.status) || a.status === 'accepted' && !a.settlement) throw refuse('Attempt is not waiting for scoped acceptance')
  if (task.projectTaskKind && task.projectTaskKind !== 'code') throw refuse('Scoped Attempt acceptance applies to code delivery only')
  if (!a.requirement) throw refuse('Current requirement snapshot is unavailable')
  if (task.title !== a.requirement.title || (task.criteria ?? '') !== a.requirement.criteria || task.projectTask && task.projectTask.requirements.revision !== a.requirement.projectTaskRevision) throw refuse('Current requirements changed; inspect fresh delivery facts')
  if (!a.pr || !a.candidateSha || !a.evidence?.tests?.passed || a.evidence.tests.sha !== a.candidateSha || a.evidence.review?.sha !== a.candidateSha || a.evidence.review.verdict !== 'approve') throw refuse('Current candidate, passing host tests and independent Review are required')
}
export function requireNextAttempt(task, a) {
  if (!a || a.taskId !== task.id || a.projectId !== task.projectId || task.deliveryAttemptId !== a.id || ['accepted', 'cancelled'].includes(task.status) || a.cancelRequested || a.supersededBy) throw refuse('Next delivery needs the current unfinished Task')
  if (a.status !== 'accepted' || !a.settlement) throw refuse('Accept the current Attempt before opening a separate delivery')
}
export function deliveryChoices(state, task, observation) {
  const a = state.projectAttempts?.[task.deliveryAttemptId], scope = deliveryScope(state, task), previous = state.projectChiefDecisions?.[task.chiefRecommendationId]
  const option = (action, check, note) => {
    try { check(); return { action, status: 'ready', reason: note } }
    catch (error) { return { action, status: 'blocked', reason: error.message } }
  }
  const merged = observation?.merged === true || a?.evidence?.merge?.scope === 'provider-confirmed-merge-observation' && a.evidence.merge.sha === a.candidateSha
  const acceptance = option('accept-attempt', () => requireAttemptAcceptance(task, a), 'Chief must judge delivered scope and remaining work; execution rechecks all evidence')
  if (acceptance.status === 'ready' && (observation?.status === 'unknown' || !merged)) Object.assign(acceptance, { status: observation?.status === 'unknown' ? 'unknown' : 'blocked', reason: observation?.status === 'unknown' ? 'Query the current provider merge result; no merge outcome is inferred' : 'Provider-confirmed merge is required for scoped acceptance' })
  return { expectedScope: scope, observedAt: Date.now(), admission: admissions(state, task).slice(-4), observation: observation ?? null, recommendation: previous?.taskId === task.id && previous.status === 'applied' ? { decisionId: previous.id, action: previous.action, reason: previous.reason, criteria: previous.criteria, expectedScope: previous.expectedScope, alreadyApplied: true } : null, recommendationSource: 'Chief decision action/reason/evidence in the original inference turn', actions: [acceptance,
    option('start-next', () => requireNextAttempt(task, a), 'Read fresh continuation-state; pin verified target HEAD, choose an implementation role and use task.run mode next'),
    merged ? { action: 'return', status: 'blocked', reason: 'A provider-confirmed merged PR cannot be reworked or reused for publication' } : { action: 'return', status: observation?.status === 'unknown' ? 'unknown' : 'ready', reason: 'Existing route/rework, exit, binding and current authority gates still apply' },
    { action: 'close', status: 'unknown', reason: 'Chief must establish every Task criterion, dependency and input; merged or accepted Attempt alone does not complete the Task' },
    { action: 'continue', status: 'ready', reason: 'Inspect current scoped facts or defer judgement without claiming completion' },
    { action: 'needs-human', status: 'ready', reason: 'Last resort chosen by Chief when information, authority or a human-only decision is missing; use the corresponding Personal Agent' }], note: 'Prechecks are neither authorization nor an exhaustive plan. Revalidate on execution; unknown facts do not imply success.' }
}
