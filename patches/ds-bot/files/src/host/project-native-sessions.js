// Native execution keeps exact Task-role context; Bot deletion is not exit proof.
import { createHash, randomUUID } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
import { taskSession, taskSessionId, roleDefinitionKey, pinTaskRoleDefinition } from './project-task-sessions.js'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const refuse = message => Object.assign(new Error(message), { code: 'bot/context-resume' })
const clone = value => structuredClone(value)
export function nativeExitConfirmed(state, row) {
  const proof = row?.releaseProof
  if (!row || row.version !== 'project-native-worker/v1' || row.status !== 'quiescent' || proof?.kind !== 'native-agent-quiescent' || proof.workerId !== row.id || proof.sessionId !== row.sessionId || proof.generation !== row.generation || proof.bindingKey !== row.bindingKey) return false
  if (!row.leaseId) return true
  const lease = ownEntry(state.projectResourceLeases ?? {}, row.leaseId)
  return Boolean(lease && lease.projectId === row.projectId && lease.attemptId === row.attemptId && lease.role === row.role && lease.sessionKey === row.sessionKey && lease.resourceId === row.resourceId && lease.generation === row.generation && lease.worker?.kind === 'native' && lease.worker.botId === row.id)
}
export function createProjectNativeSessions(rt) {
  const hostEpoch = randomUUID()
  const rows = () => (rt.state.projectNativeWorkers ??= {})
  const stopping = new Map()
  const binding = new Set()
  const bindingKey = (session, workspace) => digest({ projectId: session.projectId, taskId: session.taskId, role: session.role,
    harness: 'flybot', resourceId: session.resourceLease?.resourceId ?? null, cwd: workspace.path, definitionKey: roleDefinitionKey(session) })
  function previous(session, workspace) {
    const logical = taskSession(rt.state, session), last = logical.bindings.at(-1), key = bindingKey(session, workspace)
    if (!last) {
      const historical = Object.values(rt.state.projectAttempts ?? {}).filter(attempt => attempt.projectId === session.projectId && attempt.taskId === session.taskId).flatMap(attempt => [attempt.roleSessions?.[session.role], ...(attempt.roleSessionHistory ?? [])]).some(prior => prior && prior.id !== session.id && prior.role === session.role && prior.sessionId && (prior.execution?.harness ?? 'flybot') === 'flybot')
      if (historical) throw refuse('Legacy native Task-role context has no confirmed binding; explicit recovery is required instead of a fresh Session')
      return { logical, key, row: null }
    }
    const row = ownEntry(rows(), last.workerId)
    const lease = row?.leaseId && ownEntry(rt.state.projectResourceLeases ?? {}, row.leaseId)
    if (last.harness !== 'flybot' || !row || row.logicalSessionId !== logical.id || row.projectId !== session.projectId || row.taskId !== session.taskId || row.role !== session.role || last.key !== key || row.bindingKey !== key || last.sessionId !== row.sessionId || !nativeExitConfirmed(rt.state, row) || row.leaseId && lease?.status !== 'released' || rt.botOf(row.id)) throw refuse('Latest native Task-role Session is incompatible or its execution has not confirmed release; a fresh Session is forbidden')
    return { logical, key, row }
  }
  async function authority(session) {
    const task = ownEntry(rt.state.tasks ?? {}, session.taskId)
    if (!task || task.projectId !== session.projectId) throw refuse('Native Task scope changed')
    if (session.poolClaimId) {
      const claim = task.collaboration?.claim
      if (task.deliveryAttemptId !== session.attemptId || claim?.id !== session.poolClaimId || claim.generation !== session.generation || claim.status !== 'active') throw refuse('Native execution claim changed before binding')
      const actor = { memberId: task.collaboration.initiatedBy }
      rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
      await rt.projectDelegations?.background(actor.memberId, task.collaboration.sourceSessionId)
      rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
      if (task.collaboration.claim !== claim || claim.status !== 'active' || task.collaboration.generation !== session.generation) throw refuse('Native execution claim was revoked during binding')
    }
    if (session.definitionRef) {
      const frozen = ownEntry(rt.state.projectRoleDefinitionSnapshots ?? {}, session.definitionRef)
      if (!frozen) throw refuse('Native role definition is unavailable')
      pinTaskRoleDefinition(rt.state, session, frozen.definition, session.definitionRevision, rt.projectAgents?.deliveryDefinitions(session.projectId))
    }
    if (session.resourceLease) rt.projectResources?.requireBinding(session.projectId, session.resourceLease)
  }
  async function bind(session, workspace, botId) {
    await authority(session)
    const bot = rt.botOf(botId)
    if (!bot || bot.workspaceId !== workspace.id || bot.attemptId !== session.attemptId || session.status === 'released') throw refuse('Native carrier is unavailable for its registered Workspace')
    const selected = previous(session, workspace), original = selected.row
    let sessionId = rt.chatOf(botId)
    if (original) {
      if ((original.model ?? null) !== (bot.model ?? null)) throw refuse('Native Task-role model changed; explicit recovery is required')
      const resumed = await rt.resolveAgent(original.sessionId)
      if (resumed.session?.id !== original.sessionId || resumed.status !== 'idle' || typeof resumed.whenIdle !== 'function') throw refuse('Original native Session cannot be resumed safely')
      await resumed.whenIdle()
      await authority(session)
      const current = previous(session, workspace)
      if (current.row !== original || rt.botOf(botId) !== bot || session.status === 'released') throw refuse('Native resume binding changed while loading context')
      await rt.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
      sessionId = original.sessionId
      bot.sessionId = sessionId
      bot.segments = clone(original.segments ?? [])
      rt.indexSessions?.()
    }
    const row = { id: botId, hostEpoch, version: 'project-native-worker/v1', projectId: session.projectId, taskId: session.taskId, attemptId: session.attemptId,
      role: session.role, model: bot.model ?? null, logicalSessionId: selected.logical.id, sessionKey: session.id, sessionId, cwd: workspace.path, bindingKey: selected.key,
      definitionKey: roleDefinitionKey(session), generation: session.resourceLease?.generation ?? session.generation ?? 0,
      ...(session.resourceLease ? { leaseId: session.resourceLease.id, resourceId: session.resourceLease.resourceId } : {}), status: 'bound', createdAt: Date.now() }
    setEntry(rows(), botId, row)
    selected.logical.bindings.push({ harness: 'flybot', version: 'native-session/v1', key: row.bindingKey, sessionId, workerId: botId, attemptId: session.attemptId })
    session.botId = botId; session.sessionId = sessionId
    await rt.save()
    return { id: botId, sessionId }
  }
  async function stop(botId) {
    const row = ownEntry(rows(), botId)
    if (!row) return false
    if (nativeExitConfirmed(rt.state, row)) return clone(row.releaseProof)
    const bot = rt.botOf(botId), sessionId = bot && rt.chatOf(botId)
    row.status = 'stopping'; await rt.save()
    try {
      if (row.hostEpoch !== hostEpoch) throw refuse('Native execution belongs to an earlier host; reconcile actual prior exit before resuming')
      const agent = sessionId && await rt.resolveAgent(sessionId)
      if (!bot || !agent || agent.session?.id !== sessionId || typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function') throw refuse('Native worker stop is unconfirmed; keep its execution/resource held')
      agent.cancel({ kind: 'hook', reason: 'Project native execution release' })
      await agent.whenIdle()
      if (ownEntry(rows(), botId) !== row || rt.botOf(botId) !== bot || rt.chatOf(botId) !== sessionId || agent.status !== 'idle') throw refuse('Native worker changed before quiescence confirmation')
      row.sessionId = sessionId; row.segments = clone(bot.segments ?? [])
      const logical = taskSession(rt.state, row), last = logical.bindings.at(-1)
      if (last?.workerId !== botId || last.key !== row.bindingKey) throw refuse('Native worker is not the latest Task-role binding')
      last.sessionId = sessionId
      row.releaseProof = { kind: 'native-agent-quiescent', workerId: botId, sessionId, bindingKey: row.bindingKey, generation: row.generation, at: Date.now() }
      row.status = 'quiescent'
      await rt.save()
      return clone(row.releaseProof)
    } catch (error) { row.status = 'stop-unconfirmed'; delete row.releaseProof; row.failure = String(error.message).slice(0, 1000); await rt.save(); throw error }
  }
  return { previous, async bind(session, workspace, botId) {
      const key = taskSessionId(session.projectId, session.taskId, session.role)
      if (binding.has(key)) throw refuse('Native Task-role binding is already in progress')
      binding.add(key)
      try { return await bind(session, workspace, botId) } finally { binding.delete(key) }
    }, admits: botId => !['stopping', 'quiescent', 'stop-unconfirmed'].includes(ownEntry(rows(), botId)?.status),
    stop(botId) {
      if (stopping.has(botId)) return stopping.get(botId)
      const operation = stop(botId).finally(() => stopping.delete(botId)); stopping.set(botId, operation); return operation
    } }
}
