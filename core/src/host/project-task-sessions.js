import { createHash } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const resumeError = message => Object.assign(new Error(message), { code: 'bot/context-resume' })
export const taskSessionId = (projectId, taskId, role) => `task-session-${digest([projectId, taskId, role]).slice(0, 32)}`

function contextDefinition(session) {
  const text = session.context?.text
  const start = '<untrusted-role-context>\n', end = '\n</untrusted-role-context>'
  if (typeof text !== 'string' || !text.includes(start) || !text.endsWith(end)) throw resumeError('Original role context is unavailable; cannot infer a new Session')
  if (!/^[a-f0-9]{64}$/.test(session.context.sha256 ?? '') || createHash('sha256').update(text).digest('hex') !== session.context.sha256) throw resumeError('Original role context hash is unavailable or changed')
  let data
  try { data = JSON.parse(text.slice(text.indexOf(start) + start.length, -end.length)) } catch { throw resumeError('Original role context cannot be decoded') }
  if (data.version !== 'project-role-context/v1' || data.projectId !== session.projectId || data.role !== session.role || typeof data.persona !== 'string' || !Array.isArray(data.skills)) throw resumeError('Original role context has another scope or contract')
  return { role: session.role, instructions: data.persona, resolvedSkills: data.skills, skills: data.skills.map(skill => skill.name), revision: data.revision }
}
export function roleDefinitionKey(session) {
  if (session.definitionKey !== undefined) {
    if (typeof session.definitionKey !== 'string' || !/^[a-f0-9]{64}$/.test(session.definitionKey)) throw resumeError('Role definition fingerprint is invalid')
    return session.definitionKey
  }
  const definition = session.definition ?? contextDefinition(session)
  return digest({ role: session.role, ...(definition.policyRole && definition.policyRole !== session.role ? { policyRole: definition.policyRole } : {}), persona: definition.instructions ?? '', skills: (definition.resolvedSkills ?? definition.skills ?? []).map(skill => typeof skill === 'string' ? skill : { name: skill.name, sha256: skill.sha256 }) })
}
function workerSession(state, worker) {
  const attempt = ownEntry(state.projectAttempts ?? {}, worker.attemptId)
  if (!attempt || attempt.projectId !== worker.projectId || attempt.taskId !== worker.taskId) return null
  return [attempt.roleSessions?.[worker.role], ...(attempt.roleSessionHistory ?? [])].find(session => session?.id === worker.sessionKey && session.projectId === worker.projectId && session.taskId === worker.taskId && session.role === worker.role) ?? null
}
function latestRoleWorker(state, record) {
  return Object.entries(state.projectHarnessWorkers ?? {}).filter(([, worker]) => worker.logicalSessionId === record.id && worker.projectId === record.projectId && worker.taskId === record.taskId && worker.role === record.role)
    .sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0)).at(-1)
}
export function pinTaskRoleDefinition(state, scope, definition, revision = 0, catalog) {
  catalog ??= ownEntry(state.projectAgentDefinitions ?? {}, scope.projectId)
  const currentRevision = catalog?.revision ?? revision
  revision = currentRevision
  const logical = taskSession(state, scope, catalog)
  state.projectRoleDefinitionSnapshots ??= {}
  const snapshots = state.projectRoleDefinitionSnapshots
  let frozen = logical.definitionRef && ownEntry(snapshots, logical.definitionRef)
  if (logical.definitionRef && (!frozen || frozen.version !== 'project-role-definition/v1' || frozen.projectId !== scope.projectId || frozen.role !== scope.role || frozen.sha256 !== digest(frozen.definition))) throw resumeError('Pinned Task-role definition is unavailable or changed')
  if (!frozen) {
    const initial = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'memory'))
    let selected = initial, origin = 'initial-definition'
    const previous = logical.bindings.at(-1)
    const observed = latestRoleWorker(state, logical)
    const worker = observed?.[1].backendSessionId ? observed[1] : previous && ownEntry(state.projectHarnessWorkers ?? {}, previous.workerId)
    if (worker) {
      const session = worker && workerSession(state, worker)
      if (!session) throw resumeError('Original Task-role Session is unavailable for definition migration')
      const old = session.definition ?? contextDefinition(session)
      selected = { ...initial, ...Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'revision')), execution: session.execution ?? initial.execution }
      revision = session.definitionRevision ?? old.revision ?? revision
      origin = 'legacy-latest-role-context'
    }
    const sha256 = digest(selected), id = `role-definition-${digest([scope.projectId, scope.role, sha256])}`
    frozen = ownEntry(snapshots, id)
    if (!frozen) { frozen = { version: 'project-role-definition/v1', id, projectId: scope.projectId, role: scope.role, revision, sha256, definition: structuredClone(selected), origin, createdAt: Date.now() }; setEntry(snapshots, id, frozen) }
    logical.definitionRef = id
  }
  const registered = catalog?.roles.find(row => row.role === scope.role)
  if (catalog && !registered || registered?.status === 'retired') throw resumeError('Task role was retired; explicit reassignment is required')
  const live = registered ?? definition
  const current = live.execution ?? {}, pinned = frozen.definition.execution ?? {}
  const available = (pinned.resourceIds ?? []).filter(id => (current.resourceIds ?? []).includes(id))
  if ((live.policyRole ?? live.role) !== (frozen.definition.policyRole ?? frozen.definition.role) || (current.harness ?? 'flybot') !== (pinned.harness ?? 'flybot') || pinned.resourceIds?.length && !available.length || frozen.definition.toolPolicy?.shell === true && live.toolPolicy?.shell === false) throw resumeError('Task-role execution permission or resource binding was revoked; explicit recovery is required')
  const retained = structuredClone(frozen.definition)
  if (retained.execution) retained.execution.resourceIds = available
  const observed = latestRoleWorker(state, logical)
  const priorWorker = observed?.[1].backendSessionId ? observed[1] : ownEntry(state.projectHarnessWorkers ?? {}, logical.bindings.at(-1)?.workerId)
  if (priorWorker && available.length) {
    if (!available.includes(priorWorker.resourceId)) throw resumeError('The prior Session resource is no longer authorized')
    retained.execution.resourceIds = [priorWorker.resourceId]
  }
  return { definition: retained, revision: frozen.revision, definitionRef: frozen.id, definitionKey: roleDefinitionKey({ role: scope.role, definition: frozen.definition }),
    ...(frozen.sha256 !== digest(Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'memory'))) ? { change: { pinnedRevision: frozen.revision, currentRevision, retainedOriginalDefinition: true } } : {}) }
}
export function discardUnpreparedTaskDefinitions(state, taskId) {
  let changed = false
  for (const logical of Object.values(state.projectTaskSessions ?? {})) {
    if (logical.taskId !== taskId || !logical.definitionRef || logical.bindings.length || latestRoleWorker(state, logical)) continue
    const prepared = Object.values(state.projectAttempts ?? {}).some(attempt => attempt.taskId === taskId && attempt.projectId === logical.projectId && (attempt.roleSessions?.[logical.role] || attempt.roleSessionHistory?.some(session => session.role === logical.role)))
    if (prepared) continue
    delete logical.definitionRef
    changed = true
  }
  return changed
}

// Logical Sessions outlive processes and Attempts. Backend bindings never cross cwd/profile.
export function taskSession(state, session, currentCatalog) {
  const task = ownEntry(state.tasks ?? {}, session.taskId)
  const id = taskSessionId(session.projectId, session.taskId, session.role)
  let record = ownEntry(state.projectTaskSessions ?? {}, id)
  const catalog = currentCatalog ?? ownEntry(state.projectAgentDefinitions ?? {}, session.projectId)
  const registered = catalog?.roles.find(row => row.role === session.role && row.status !== 'retired')
  if (!task || task.projectId !== session.projectId || typeof session.role !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(session.role) || session.role === 'chief' || !record && (catalog ? !registered : !['developer', 'tester', 'reviewer'].includes(session.role))) throw new Error('Task Session scope changed')
  state.projectTaskSessions ??= {}
  if (!record) { record = { id, projectId: session.projectId, taskId: session.taskId, role: session.role, bindings: [], createdAt: Date.now() }; setEntry(state.projectTaskSessions, id, record) }
  if (record.projectId !== session.projectId || record.taskId !== session.taskId || record.role !== session.role) throw new Error('Task Session identity changed')
  return record
}
export function backendBindingKey({ harness, resourceId, principalId, cwd, model, profile, definition }) {
  return digest({ harness, resourceId, principalId, cwd, model, home: profile.home, configDir: profile.configDir, baseUrl: profile.baseUrl ?? null, definition })
}
// Both lifecycle proofs are produced by the host, never by role output. A prior
// service exit must be tied to the exact lease the supervisor reconciled.
export function confirmedWorkerExit(state, worker) {
  if (!worker || !Number.isSafeInteger(worker.generation) || worker.generation < 1) return false
  if (worker.status !== 'released') {
    const lease = ownEntry(state.projectResourceLeases ?? {}, worker.leaseId), proof = worker.releaseProof
    return Boolean(worker.status === 'failed' && worker.releasedAt && worker.exit?.code === 0 && proof?.kind === 'sdk-stop-ack-and-process-exit' && proof.workerId === worker.id && proof.generation === worker.generation &&
      lease?.status === 'released' && lease.projectId === worker.projectId && lease.attemptId === worker.attemptId && lease.role === worker.role && lease.resourceId === worker.resourceId && lease.generation === worker.generation &&
      lease.worker?.kind === 'sdk' && lease.worker.handle === worker.id && lease.releaseProof?.kind === proof.kind && lease.releaseProof.workerId === worker.id && lease.releaseProof.generation === worker.generation && lease.releaseProof.at === proof.at)
  }
  const proof = worker.releaseProof
  if (proof?.kind === 'sdk-worker-not-started') {
    const lease = ownEntry(state.projectResourceLeases ?? {}, worker.leaseId)
    return worker.spawnPhase === 'aborted' && worker.executionStartedAt == null && proof.workerId === worker.id && proof.generation === worker.generation && lease?.status === 'released' && lease.generation === worker.generation && lease.worker?.handle === worker.id && lease.projectId === worker.projectId && lease.attemptId === worker.attemptId && lease.resourceId === worker.resourceId && lease.role === worker.role && lease.releaseProof?.kind === proof.kind && lease.releaseProof.workerId === worker.id && lease.releaseProof.at === proof.at
  }
  if (proof?.kind === 'sdk-stop-ack-and-process-exit') return proof.generation === worker.generation
  if (proof?.kind !== 'systemd-prior-invocation-exited' || !/^[a-f0-9]{32}$/.test(proof.previousInvocationId ?? '')) return false
  const lease = ownEntry(state.projectResourceLeases ?? {}, worker.leaseId)
  return Boolean(lease?.status === 'released' && lease.projectId === worker.projectId && lease.attemptId === worker.attemptId && lease.role === worker.role && lease.resourceId === worker.resourceId && lease.generation === worker.generation &&
    lease.worker?.kind === 'sdk' && lease.worker.handle === worker.id && lease.processScope?.kind === 'systemd-control-group' && lease.processScope.killMode === 'control-group' && lease.processScope.invocationId === proof.previousInvocationId &&
    lease.releaseProof?.kind === proof.kind && lease.releaseProof.previousInvocationId === proof.previousInvocationId)
}
export function resumableBinding(state, record, key, { legacyKey, definitionKey } = {}) {
  let previous = record.bindings.at(-1)
  if (previous && !ownEntry(state.projectHarnessWorkers ?? {}, previous.workerId)) throw resumeError('Latest Task Session binding is unconfirmed')
  const latest = latestRoleWorker(state, record)
  if (latest && latest[0] !== previous?.workerId) {
    const [workerId, worker] = latest
    const lease = ownEntry(state.projectResourceLeases ?? {}, worker.leaseId)
    const released = lease?.status === 'released' && lease.projectId === record.projectId && lease.generation === worker.generation && lease.resourceId === worker.resourceId
    const cold = !worker.backendSessionId && (worker.executionStartedAt === null || worker.executionStartedAt === undefined && worker.releaseProof?.kind === 'sdk-worker-spawn-failed')
    if (cold && released && worker.status === 'released' && worker.releaseProof?.generation === worker.generation && worker.releaseProof?.workerId === workerId) {
      // A persist-before-dispatch marker (or proven failed spawn) establishes that
      // no model context was started. Keep any earlier real context authoritative.
    } else {
      if (!confirmedWorkerExit(state, worker) || !released) throw resumeError('Latest Task Session exit is unconfirmed')
      if (!worker.backendSessionId) throw resumeError('Latest Task-role context has no recoverable backend Session')
      previous = { version: worker.bindingVersion, definitionKey: worker.definitionKey, key: worker.bindingKey, sessionId: worker.backendSessionId, workerId, attemptId: worker.attemptId, policySha256: workerSession(state, worker)?.policy?.sha256 ?? null, recoveredFromWorker: true }
    }
  }
  if (!previous) return null
  if (previous.key !== key) {
    const worker = ownEntry(state.projectHarnessWorkers ?? {}, previous.workerId)
    const session = worker && workerSession(state, worker)
    if (previous.version || previous.key !== legacyKey || !session || roleDefinitionKey(session) !== definitionKey) throw resumeError('Latest Task-role context cannot resume with this execution binding; a fresh Session is forbidden')
  }
  const worker = ownEntry(state.projectHarnessWorkers ?? {}, previous.workerId)
  const lease = worker && ownEntry(state.projectResourceLeases ?? {}, worker.leaseId)
  if (!worker || worker.projectId !== record.projectId || worker.taskId !== record.taskId || worker.role !== record.role || worker.logicalSessionId !== record.id || worker.bindingKey !== previous.key || !confirmedWorkerExit(state, worker) || lease?.status !== 'released' || lease.projectId !== record.projectId || lease.resourceId !== worker.resourceId || lease.generation !== worker.generation || worker.backendSessionId !== previous.sessionId) throw resumeError('Previous Task Session exit or binding is unconfirmed')
  return previous
}
