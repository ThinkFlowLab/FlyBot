// Current authority limits retained execution context; it never replaces its persona.
import { attemptProject } from './project-task-repository.js'
import { repositorySettings } from './project-repository-policy.js'
import { ownEntry } from './store.js'
import { pinTaskRoleDefinition } from './project-task-sessions.js'
const refuse = message => Object.assign(new Error(message), { code: 'bot/execution-revoked' })
export async function requireExecutionAuthority(rt, session) {
  if (rt.readOnly?.() !== undefined) throw refuse('Execution lost its writable host authority')
  const task = ownEntry(rt.state.tasks ?? {}, session.taskId)
  if (!task || task.projectId !== session.projectId) throw refuse('Execution Task scope changed')
  const claim = session.poolClaimId && task.collaboration?.claim
  const attempt = ownEntry(rt.state.projectAttempts ?? {}, session.attemptId)
  const memberId = claim ? task.collaboration.initiatedBy : attempt?.initiatedBy
  const sourceSessionId = task.collaboration?.sourceSessionId
  if (claim && (typeof memberId !== 'string' || !memberId)) throw refuse('Execution initiating human is unavailable')
  function current(afterAwait = false) {
    if (ownEntry(rt.state.tasks ?? {}, session.taskId) !== task) throw refuse('Execution Task scope changed')
    if (claim && (task.collaboration?.initiatedBy !== memberId || task.collaboration.sourceSessionId !== sourceSessionId || task.deliveryAttemptId !== session.attemptId || task.collaboration?.claim !== claim || claim.id !== session.poolClaimId || claim.generation !== session.generation || task.collaboration.generation !== session.generation || claim.status !== 'active')) throw refuse(afterAwait ? 'Execution claim was revoked during authority validation' : 'Execution claim changed before execution')
    if (session.poolClaimId && !claim) throw refuse('Execution claim is unavailable')
    if (task.projectTask && attempt?.requirement?.projectTaskRevision !== task.projectTask.requirements.revision) throw refuse('Execution requirements version changed; stop the old Attempt before resuming')
    if (['accepted', 'cancelled'].includes(task.status)) throw refuse('Execution Task has ended')
    if (rt.readOnly?.() !== undefined) throw refuse('Execution lost its writable host authority')
    if (attempt?.repositoryBinding) repositorySettings(rt, attemptProject(rt, rt.projects.repository.get(task.projectId), attempt))
  }
  current()
  if (memberId) {
    rt.requireProjectAccess({ memberId }, task.projectId, 'task-write', task)
    await rt.projectDelegations?.background(memberId, task.collaboration?.sourceSessionId)
    current(true)
    rt.requireProjectAccess({ memberId }, task.projectId, 'task-write', task)
  }
  rt.projects?.requireActive(task.projectId)
  if (session.definitionRef) {
    const frozen = ownEntry(rt.state.projectRoleDefinitionSnapshots ?? {}, session.definitionRef)
    if (!frozen) throw refuse('Pinned execution role definition is unavailable')
    let catalog = rt.projectAgents?.deliveryDefinitions(session.projectId)
    if (catalog && !catalog.roles.some(role => role.role === session.role) && claim) {
      const retired = ownEntry(rt.state.projectRetiredRoles ?? {}, `${session.projectId}:${session.role}`)
      if (retired?.id === claim.botId && (claim.role ?? session.role) === session.role) catalog = { ...catalog, roles: [...catalog.roles, retired] }
    }
    const retained = pinTaskRoleDefinition(rt.state, session, frozen.definition, session.definitionRevision, catalog)
    const live = catalog?.roles.find(role => role.role === session.role)
    if (!frozen.definition.execution?.resourceIds?.length && live?.execution?.resourceIds?.length) throw refuse('Implicit host execution is no longer authorized by the role resource pool')
    const execution = retained.definition.execution ?? {}
    if (session.resourceLease && !execution.resourceIds?.includes(session.resourceLease.resourceId)) throw refuse('The execution resource is no longer authorized')
    if (!session.resourceLease && execution.resourceIds?.length) throw refuse('Implicit host execution is no longer authorized by the role resource pool')
  }
  if (session.resourceLease) {
    const resource = rt.projectResources?.requireBinding(session.projectId, session.resourceLease)
    const harness = session.execution?.harness ?? session.definition?.execution?.harness ?? 'flybot'
    if (resource && (resource.disabled || !resource.harnesses?.includes(harness) || harness === 'flybot' && resource.type !== 'local')) throw refuse('Execution resource or Harness capability was revoked')
  }
  current()
}

// Called by the existing serialized scheduler pass, never by a new timer.
export async function reconcileExecutionAuthority(rt) {
  if (rt.readOnly?.() !== undefined) return
  for (const attempt of Object.values(rt.state.projectAttempts ?? {})) {
    for (const session of Object.values(attempt.roleSessions ?? {})) {
      const task = ownEntry(rt.state.tasks ?? {}, session.taskId), claim = task?.collaboration?.claim
      if (!session.poolClaimId || session.status === 'released' || claim?.id !== session.poolClaimId || claim.status !== 'active' || claim.workerId !== session.botId) continue
      try { await requireExecutionAuthority(rt, session) }
      catch (error) {
        await rt.projectPools?.revokeExecution(task.id, claim.id, String(error.message).slice(0, 1000))
      }
    }
  }
}
