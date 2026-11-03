// Project semantics on the original Task records. No separate queue or store.
import { ownEntry } from './store.js'
import { taskRepository } from './project-task-repository.js'
import { initialRoleTarget } from './project-role-admission.js'
import { createHash } from 'node:crypto'
import { stageRoleSummary, rollbackRoleSummary } from './project-context-memory.js'
import { EffectCancelled, EffectDeferred } from './project-effects.js'
const VERSION = 'project-task/v1'
const fail = message => Object.assign(new Error(message), { code: 'bot/task-contract' })
const copy = value => structuredClone(value)
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bounded = (value, name, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max) throw fail(`${name} requires bounded nonempty text`)
  return value.trim()
}
const repositoryValue = value => {
  if (value === null || typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && value.length <= 200) return value
  throw fail('Task repository must be owner/name or null')
}
const contract = task => {
  if (!task?.projectId || task.projectTask?.version !== VERSION) throw fail('Project Task contract is unavailable')
  return task.projectTask
}
function chief(task, decision) {
  if (decision?.executorRole !== 'chief' || !decision.id || !decision.runId || decision.projectId !== task.projectId || decision.taskId !== task.id || !decision.initiatedBy) throw fail('A scoped Chief decision is required')
  bounded(decision.reason, 'Chief reason', 4000)
}
export function createTaskContract(task, body = {}) {
  if (task.projectTask) return contract(task)
  const requirements = { ...(body.repository !== undefined ? { repository: repositoryValue(body.repository) } : {}), revision: 1, title: task.title, criteria: task.criteria ?? '', impact: body.impact ?? '', scope: body.scope ?? '', at: Date.now() }
  for (const field of ['impact', 'scope']) if (requirements[field]) requirements[field] = bounded(requirements[field], field)
  task.projectTask = { version: VERSION, admission: { status: 'proposed', decisions: [] }, requirements, requirementsHistory: [], dependencies: [], results: [] }
  return task.projectTask
}
export function admitTask(task, decision) {
  chief(task, decision)
  const row = contract(task), requirements = row.requirements
  if (row.admission.decisions.some(d => d.id === decision.id)) return false
  for (const field of ['title', 'criteria', 'impact']) bounded(requirements[field], field)
  if (['accepted', 'cancelled'].includes(task.status)) throw fail('Ended Task cannot be admitted')
  row.admission.status = 'accepted'
  row.admission.revision = requirements.revision
  row.admission.decisions.push({ ...copy(decision), at: Date.now() })
  return true
}
export function reviseTask(task, changes, decision) {
  chief(task, decision)
  const row = contract(task)
  if (['accepted', 'cancelled'].includes(task.status)) throw fail('Ended Task requirements cannot be rewritten')
  const next = { ...row.requirements }
  for (const key of ['title', 'criteria', 'impact', 'scope']) if (changes[key] !== undefined) next[key] = bounded(changes[key], key)
  if (changes.repository !== undefined) next.repository = repositoryValue(changes.repository)
  if (Object.keys(changes).some(key => !['title', 'criteria', 'impact', 'scope', 'repository'].includes(key))) throw fail('Unsupported Task requirement change')
  if (row.requirementsHistory.some(r => r.decisionId === decision.id) || row.requirements.decisionId === decision.id) return false
  row.requirementsHistory.push(copy(row.requirements))
  row.requirements = { ...next, revision: next.revision + 1, decisionId: decision.id, at: Date.now() }
  row.admission.revision = row.requirements.revision
  task.title = next.title; task.criteria = next.criteria
  return true
}
function descendant(state, id, wanted, visited = new Set()) {
  if (id === wanted) return true
  if (visited.has(id)) return false
  visited.add(id)
  const task = ownEntry(state.tasks ?? {}, id)
  return (task?.projectTask?.dependencies ?? []).some(row => descendant(state, row.taskId, wanted, visited))
}
export function addTaskDependencies(state, task, ids, wait) {
  const row = contract(task)
  if (!Array.isArray(ids) || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length) throw fail('A Task wait needs one to sixteen distinct child Tasks')
  if (row.wait && !['queued', 'resumed'].includes(row.wait.status)) throw fail('Task already has an unresolved wait')
  if (!wait?.id || !wait.botId || !wait.claimId) throw fail('Task wait needs a scoped execution continuation')
  bounded(wait.resumePoint, 'Task resume point')
  const children = ids.map(id => {
    const child = ownEntry(state.tasks ?? {}, id)
    if (!child || child.projectId !== task.projectId || !child.projectTask) throw fail('Dependency is unavailable in this Project')
    if (descendant(state, id, task.id)) throw fail('Task dependency cycle is forbidden')
    if (child.projectTask.parentTaskId && child.projectTask.parentTaskId !== task.id) throw fail('Child Task already belongs to another parent')
    return child
  })
  if (row.wait?.id === wait.id || row.waitHistory?.some(previous => previous.wait.id === wait.id)) throw fail('Task wait ID was reused for another execution')
  if (row.wait) (row.waitHistory ??= []).push({ wait: copy(row.wait), dependencies: copy(row.dependencies), at: Date.now() })
  row.dependencies = ids.map(taskId => ({ taskId, status: 'waiting' }))
  row.wait = { ...copy(wait), status: 'waiting', at: Date.now() }
  for (const child of children) { child.projectTask.parentTaskId = task.id; dependencyResult(state, child) }
  return copy(row.wait)
}
export function dependencyResult(state, child) {
  const parent = ownEntry(state.tasks ?? {}, child.projectTask?.parentTaskId)
  if (!parent || parent.projectId !== child.projectId) return false
  const dependency = parent.projectTask?.dependencies.find(row => row.taskId === child.id)
  if (!dependency) return false
  if (dependency.status === 'waived') {
    const result = dependency.result
    if (!result?.replacementTaskId) return false
    const replacement = ownEntry(state.tasks ?? {}, result.replacementTaskId)
    if (replacement && replacement.projectId === parent.projectId && replacement.status === 'accepted' && replacement.completedBy?.kind === 'chief' && dependencyFact(state, parent, replacement.id, { linked: false }).outcomeVersion === result.replacementVersion) return false
    dependency.status = 'waiting'; dependency.invalidatedResolution = copy(dependency.resolution); delete dependency.result
    if (parent.projectTask.wait?.status === 'ready') parent.projectTask.wait.status = 'waiting'
    return true
  }
  // A failed Attempt, cancelled child, or unadjudicated result never satisfies a wait.
  if (child.status !== 'accepted' || child.completedBy?.kind !== 'chief' || !child.completedBy.decisionId) {
    dependency.status = 'waiting'; delete dependency.result
    if (parent.projectTask.wait?.status === 'ready') parent.projectTask.wait.status = 'waiting'
    return true
  }
  dependency.status = 'satisfied'
  dependency.result = { taskId: child.id, decisionId: child.completedBy.decisionId, requirementsRevision: child.projectTask.requirements.revision,
    result: copy(child.result ?? null), attemptId: child.deliveryAttemptId ?? null, candidateSha: ownEntry(state.projectAttempts ?? {}, child.deliveryAttemptId)?.candidateSha ?? null, integrated: false }
  return true
}
function outcomeData(state, child) {
  const attempt = ownEntry(state.projectAttempts ?? {}, child.deliveryAttemptId)
  if (attempt && (attempt.projectId !== child.projectId || attempt.taskId !== child.id)) return null
  if (child.projectTask && (child.projectTask.version !== VERSION || !Number.isSafeInteger(child.projectTask.requirements?.revision))) return null
  return { projectId: child.projectId, taskId: child.id, status: child.status, requirementsRevision: child.projectTask?.requirements.revision ?? null,
    decisionId: child.completedBy?.decisionId ?? child.projectTask?.results.at(-1)?.decision?.id ?? null,
    attemptId: child.deliveryAttemptId ?? null, candidateSha: attempt?.candidateSha ?? null, repository: attempt?.requirement?.repository ?? null }
}
export function dependencyFact(state, parent, taskId, { linked = true } = {}) {
  const child = ownEntry(state.tasks ?? {}, taskId)
  if (ownEntry(state.tasks ?? {}, parent.id)?.projectId !== parent.projectId || !child || child.projectId !== parent.projectId) throw fail('Dependency is unavailable in this Project')
  if (linked && !parent.projectTask?.dependencies.some(row => row.taskId === taskId)) throw fail('Task is not a current dependency')
  const outcome = outcomeData(state, child)
  if (!outcome) throw fail('Dependency outcome contract or Attempt scope is unavailable')
  const data = { ...outcome, parentTaskId: parent.id, parentRequirementsRevision: parent.projectTask?.requirements.revision ?? null }
  return { ...data, version: fingerprint(data), outcomeVersion: fingerprint(outcome) }
}
export function taskOutcome(state, task) {
  const data = outcomeData(state, task)
  return data ? { ...data, version: fingerprint(data) } : { projectId: task.projectId, taskId: task.id, status: task.status, available: false, version: null }
}
export function resolveDependency(state, parent, body, decision) {
  chief(parent, decision)
  const row = contract(parent), dependency = row.dependencies.find(item => item.taskId === body?.taskId)
  if (!dependency || !['waiting', 'ready'].includes(row.wait?.status)) throw fail('Dependency wait changed or already resumed')
  const source = dependencyFact(state, parent, body.taskId)
  if (source.version !== body.version) throw fail('Dependency outcome changed after the Chief snapshot')
  if (!Array.isArray(body.evidence) || !body.evidence.length || body.evidence.length > 8) throw fail('Dependency resolution requires explicit evidence references')
  const evidence = body.evidence.map(value => bounded(value, 'Resolution evidence', 300))
  const intent = { taskId: body.taskId, version: body.version, evidence, replacementTaskId: body.replacementTaskId ?? null, replacementVersion: body.replacementVersion ?? null }
  if (dependency.resolution?.decisionId === decision.id) {
    if (dependency.resolution.intentSha256 !== fingerprint(intent)) throw fail('Dependency decision ID was reused with another intent')
    return copy(dependency)
  }
  let replacement
  if (body.replacementTaskId !== undefined) {
    replacement = dependencyFact(state, parent, body.replacementTaskId, { linked: false })
    const task = ownEntry(state.tasks, body.replacementTaskId)
    if (task.status !== 'accepted' || task.completedBy?.kind !== 'chief' || !task.completedBy.decisionId) throw fail('An accepted replacement with Chief evidence is required')
    if (descendant(state, task.id, parent.id)) throw fail('Replacement creates a Task dependency cycle')
    if (body.replacementVersion !== replacement.outcomeVersion) throw fail('Replacement outcome changed after the Chief snapshot')
  }
  dependency.status = 'waived'
  dependency.resolution = { decisionId: decision.id, runId: decision.runId, reason: decision.reason, evidence, sourceVersion: source.version, intentSha256: fingerprint(intent), at: Date.now() }
  dependency.result = { kind: 'chief-resolution', taskId: body.taskId, sourceTaskId: replacement?.taskId ?? null, decisionId: decision.id,
    ...(replacement ? { replacementTaskId: replacement.taskId, replacementVersion: replacement.outcomeVersion } : {}),
    candidateSha: replacement?.candidateSha ?? null, evidence, reason: decision.reason, verification: 'chief-judgement-not-host-tests', integrated: false }
  return copy(dependency)
}
export function readyTaskWait(state, task) {
  const row = contract(task), wait = row.wait
  if (!wait || !['waiting', 'ready'].includes(wait.status) || ['accepted', 'cancelled'].includes(task.status)) return null
  for (const dependency of row.dependencies) {
    const child = ownEntry(state.tasks ?? {}, dependency.taskId)
    if (!child || child.projectId !== task.projectId) throw fail('Task dependency scope changed')
    dependencyResult(state, child)
  }
  if (row.dependencies.some(dependency => !['satisfied', 'waived'].includes(dependency.status))) return null
  wait.status = 'ready'
  return { ...copy(wait), results: row.dependencies.map(dependency => copy(dependency.result)) }
}
export function cancelTask(task, decision) {
  chief(task, decision)
  const row = contract(task)
  const claim = task.collaboration?.claim
  if (claim?.status === 'active' && claim.chiefRunId !== decision.runId) throw fail('Active execution must stop before cancellation')
  if (row.results.some(result => result.decision?.id === decision.id)) return false
  if (task.status === 'accepted') throw fail('Completed Task must be reopened before cancellation')
  row.results.push({ status: 'cancelled', reason: decision.reason, decision: copy(decision), at: Date.now() })
  task.status = 'cancelled'
  if (claim?.chiefRunId === decision.runId) claim.status = 'completed'
  if (task.collaboration) { task.collaboration.status = 'cancelled'; ++task.collaboration.generation }
  return true
}
export function reopenTask(task, decision) {
  chief(task, decision)
  const row = contract(task)
  if (!['accepted', 'cancelled'].includes(task.status)) throw fail('Only an ended Task can be reopened')
  row.results.push({ status: task.status, result: copy(task.result ?? null), completedBy: copy(task.completedBy ?? null), decision: copy(decision), at: Date.now() })
  task.status = 'open'; task.progress = 0
  delete task.result; delete task.completedBy
  row.admission.status = 'accepted'
  return true
}

export function createProjectTaskLifecycle(rt) {
  const taskOf = id => {
    const task = ownEntry(rt.state.tasks ?? {}, id)
    if (!task?.projectId) throw fail('Project Task is unavailable')
    return task
  }
  function requireExecutable(task) {
    if (!task.projectTask) { rt.projectCompatibility?.requireLegacy(task); return }
    const row = contract(task)
    if (row.admission.status !== 'accepted') throw fail('Project Task requires Chief admission')
    if (row.wait && ['waiting', 'ready'].includes(row.wait.status)) throw fail('Project Task is waiting for child results')
    if (row.wait) for (const dependency of row.dependencies) {
      const child = taskOf(dependency.taskId)
      dependencyResult(rt.state, child)
      if (!['satisfied', 'waived'].includes(dependency.status)) throw fail('Project Task child result was invalidated; Chief must intervene')
    }
  }
  function requireCompletedDependencies(task) {
    if (!task.projectTask) return
    requireExecutable(task)
    for (const dependency of task.projectTask.dependencies) {
      const child = taskOf(dependency.taskId)
      dependencyResult(rt.state, child)
      if (!['satisfied', 'waived'].includes(dependency.status)) throw fail('Task still has unresolved child dependencies')
    }
  }
  function stageIntake(task) {
    if (!task.projectTask || task.projectTask.admission.status === 'accepted') return null
    return rt.projectEffects.stage({ kind: 'task.intake', key: `${task.id}:${task.projectTask.requirements.revision}`, projectId: task.projectId, taskId: task.id,
      payload: { requirementsRevision: task.projectTask.requirements.revision } })
  }
  function stageStart(task, decision, changes = {}) {
    const initialTarget = initialRoleTarget(rt, task, { targetRole: changes.targetRole })
    const execution = rt.projects.repository ? taskRepository(rt, rt.projects.repository.get(task.projectId), task, changes) : null
    return rt.projectEffects.stage({ kind: 'task.start', key: decision.id, projectId: task.projectId, taskId: task.id,
      payload: { decisionId: decision.id, ...(execution ? { repositoryBinding: execution.binding } : {}), ...(initialTarget ? { initialTarget } : {}), requirementsRevision: task.projectTask.requirements.revision, memberId: task.requesterId, sessionId: task.projectTask.executionRequester?.memberId === task.requesterId ? task.projectTask.executionRequester.sessionId : null } })
  }
  async function adjudicate(task, changes, audit, actor) {
    await rt.projectChiefControl.validateActor(actor)
    chief(task, audit)
    rt.projects.requireActive(task.projectId)
    if (changes.expectedRequirementsRevision !== undefined && task.projectTask.requirements.revision !== changes.expectedRequirementsRevision) throw fail('Task requirements changed during Chief validation')
    const previous = copy(task)
    let token, requirementInput
    try {
      if (audit.action === 'admit') {
        if (!task.projectTask) {
          if (task.collaboration?.claim?.status === 'active' || task.deliveryAttemptId && ['preparing', 'running', 'waiting-acceptance'].includes(rt.state.projectAttempts?.[task.deliveryAttemptId]?.status)) throw fail('Active legacy Task cannot change its admission contract')
          createTaskContract(task, changes.requirements ?? {})
        }
        if (changes.requirements) reviseTask(task, changes.requirements, { ...audit, id: `${audit.id}-requirements` })
        admitTask(task, audit)
        token = stageStart(task, audit, changes)
      } else if (audit.action === 'revise') {
        reviseTask(task, changes.requirements ?? {}, audit)
        const input = rt.projectInputs.stageRequirements(task, audit)
        requirementInput = input
        if (input) token = rt.projectEffects.stage({ kind: 'input.notify', key: input.row.id, projectId: task.projectId, taskId: task.id, payload: { inputId: input.row.id, initiatedBy: audit.initiatedBy } })
      } else if (audit.action === 'reopen') {
        if (task.collaboration?.claim?.status === 'active') throw fail('Active execution must stop before reopening')
        reopenTask(task, audit)
        dependencyResult(rt.state, task)
        token = stageStart(task, audit, changes)
      } else if (audit.action === 'resolve-dependency') {
        resolveDependency(rt.state, task, changes.dependency, audit)
        token = stageOwnResume(task) ?? rt.projectEffects.stage({ kind: 'task.transition', key: audit.id, projectId: task.projectId, taskId: task.id, payload: { decisionId: audit.id, action: audit.action } })
      } else if (audit.action === 'cancel') {
        cancelTask(task, audit)
        dependencyResult(rt.state, task)
        token = rt.projectEffects.stage({ kind: 'task.transition', key: audit.id, projectId: task.projectId, taskId: task.id, payload: { decisionId: audit.id, action: 'cancel' } })
      } else throw fail('Unsupported Chief Task adjudication')
      if (token) await rt.projectEffects.persist(token)
      else await rt.save()
    } catch (error) {
      if (!token || rt.projectEffects.discardUncommitted(token)) {
        if (requirementInput?.created) rt.projectInputs.discardRequirements(requirementInput.row.id)
        for (const key of Object.keys(task)) delete task[key]
        Object.assign(task, previous)
      }
      throw error
    }
    return copy(task.projectTask)
  }
  function prepareSplit(task, claim, decision) {
    requireExecutable(task)
    if (!task.projectTask) throw fail('Legacy Task must adopt the Project Task contract before splitting')
    if (!Array.isArray(decision.children) || !decision.children.length || decision.children.length > 16) throw fail('Split requires one to sixteen independently verifiable child Tasks')
    bounded(decision.resumePoint, 'Task resume point')
    const actor = { memberId: task.collaboration.initiatedBy }
    const project = rt.readProject(task.projectId)
    return decision.children.map(body => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Invalid child Task')
      for (const field of ['title', 'criteria', 'impact']) bounded(body[field], `Child ${field}`)
      return rt.prepareProjectTask({ title: body.title, criteria: body.criteria, impact: body.impact, scope: body.scope, projectTaskKind: body.projectTaskKind ?? task.projectTaskKind,
        projectId: task.projectId, botId: project.chief.botId }, actor)
    })
  }
  async function commitSplit(task, claim, decision, children) {
    const c = task.collaboration, previous = copy(c), previousContract = copy(task.projectTask)
    const tokens = []
    const summary = stageRoleSummary(rt.state, { task, claim, role: decision.role, summary: decision.summary, receiptId: `children-${decision.requestId ?? claim.id}` })
    for (const child of children) rt.state.tasks[child.id] = child
    try {
      addTaskDependencies(rt.state, task, children.map(child => child.id), { id: decision.requestId ?? claim.id, botId: claim.botId, claimId: claim.id, resumePoint: decision.resumePoint })
      c.status = 'waiting-children'; ++c.generation
      c.block = { kind: 'children', reason: 'Waiting for Chief-adjudicated child results', at: Date.now() }
      for (const child of children) tokens.push(stageIntake(child))
      // One durable snapshot contains parent wait, child records and outbox intents.
      await rt.projectEffects.persist(tokens[0])
    } catch (error) {
      const uncommitted = tokens.length && rt.projectEffects.discardUncommitted(tokens[0])
      if (uncommitted || !tokens.length) {
        for (const token of tokens.slice(1)) rt.projectEffects.discardUncommitted(token)
        for (const child of children) delete rt.state.tasks[child.id]
        rollbackRoleSummary(rt.state, summary)
        task.projectTask = previousContract
        task.collaboration = previous
      }
      throw error
    }
    return { status: 'waiting-children', childTaskIds: children.map(child => child.id), wait: copy(task.projectTask.wait) }
  }
  function stageOwnResume(task) {
    const ready = readyTaskWait(rt.state, task)
    if (!ready) return null
    return rt.projectEffects.stage({ kind: 'task.resume', key: `${task.id}:${ready.id}`, projectId: task.projectId, taskId: task.id, payload: { waitId: ready.id } })
  }
  function stageDependencyResume(child) {
    if (!child.projectTask?.parentTaskId) return null
    const parent = taskOf(child.projectTask.parentTaskId)
    dependencyResult(rt.state, child)
    const resume = stageOwnResume(parent)
    if (resume) return resume
    if (parent.collaboration?.status !== 'waiting-children' || !(child.status === 'cancelled' || child.status === 'open' && child.projectTask?.results.at(-1)?.decision?.action === 'reopen') || !['waiting', 'ready'].includes(parent.projectTask.wait?.status)) return null
    // A formal cancellation or reopening changes the dependency plan; this is
    // a semantic Chief decision, not a model call for each execution event.
    const outcome = dependencyFact(rt.state, parent, child.id)
    return rt.projectEffects.stage({ kind: 'task.dependency-review', key: `${parent.id}:${parent.projectTask.wait.id}:${child.id}:${outcome.version}`, projectId: parent.projectId, taskId: parent.id,
      payload: { waitId: parent.projectTask.wait.id, childTaskId: child.id, version: outcome.version } })
  }
  async function requestChange(body, actor) {
    const task = taskOf(body.taskId)
    rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
    rt.projects.requireActive(task.projectId)
    contract(task)
    if (!['revise', 'cancel', 'reopen'].includes(body.action) || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId ?? '')) throw fail('Task change needs a supported action and stable requestId')
    const reason = bounded(body.reason, 'Change reason', 4000)
    const requestedChange = { action: body.action, reason, requestedBy: actor.memberId }
    if (body.requirements !== undefined) {
      if (body.action !== 'revise' || !body.requirements || typeof body.requirements !== 'object' || Array.isArray(body.requirements)) throw fail('Only revision requests carry requirements')
      requestedChange.requirements = {}
      for (const [key, value] of Object.entries(body.requirements)) {
        if (!['title', 'criteria', 'impact', 'scope', 'repository'].includes(key)) throw fail('Unsupported requirement')
        requestedChange.requirements[key] = key === 'repository' ? repositoryValue(value) : bounded(value, key)
      }
    }
    const source = { requestId: body.requestId, requestedChange }
    const prior = Object.values(rt.state.projectExecutions ?? {}).find(row => row.projectId === task.projectId && row.taskId === task.id && row.purpose === 'task-change' && row.source?.requestId === body.requestId)
    if (prior && JSON.stringify(prior.source) !== JSON.stringify(source)) throw fail('Task change requestId was reused with different intent')
    return { run: await rt.projectChiefControl.request(task.projectId, 'task-change', source, task.id), applied: false }
  }
  return { requestChange, prepare: createTaskContract, requireExecutable, requireCompletedDependencies, stageIntake, adjudicate, prepareSplit, commitSplit, stageDependencyResume, taskOf, ready: task => readyTaskWait(rt.state, task) }
}

export function install(rt) {
  rt.projectTaskLifecycle = createProjectTaskLifecycle(rt)
  rt.projectEffects.register('task.transition', { run: async effect => ({ decisionId: effect.payload.decisionId, recorded: true }) })
  rt.projectEffects.register('task.intake', { async run(effect) {
    const task = rt.projectTaskLifecycle.taskOf(effect.taskId)
    if (['accepted', 'cancelled'].includes(task.status) || task.projectTask?.admission.status === 'accepted') throw new EffectCancelled('Task intake already resolved')
    if (!rt.state.projectChiefPolicies?.[task.projectId]?.enabled) throw new EffectDeferred('Chief admission authority is not configured', { waitingFor: 'configuration' })
    const run = await rt.projectChiefControl.request(task.projectId, 'intake', { requirementsRevision: effect.payload.requirementsRevision }, task.id)
    return { chiefRunId: run.id }
  } })
  rt.projectEffects.register('task.start', { async run(effect) {
    const task = rt.projectTaskLifecycle.taskOf(effect.taskId)
    if (['accepted', 'cancelled'].includes(task.status)) throw new EffectCancelled('Task ended before execution')
    rt.projectTaskLifecycle.requireExecutable(task)
    if (effect.payload.requirementsRevision !== task.projectTask.requirements.revision) throw new EffectCancelled('Task requirements changed before initial execution')
    const actor = { memberId: effect.payload.memberId, ...(effect.payload.sessionId ? { sessionId: effect.payload.sessionId } : {}) }
    await rt.projectDelegations.background(actor.memberId, actor.sessionId)
    rt.requireProjectAccess(actor, task.projectId, 'task-write', task)
    return rt.projectScheduler.request({ taskId: task.id, requestId: `chief-${effect.payload.decisionId}`, initialTarget: effect.payload.initialTarget, repositoryBinding: effect.payload.repositoryBinding }, actor)
  } })
  rt.projectEffects.register('task.dependency-review', { async run(effect) {
    const task = rt.projectTaskLifecycle.taskOf(effect.taskId), wait = task.projectTask?.wait
    if (task.collaboration?.status !== 'waiting-children' || wait?.id !== effect.payload.waitId || !['waiting', 'ready'].includes(wait.status) || dependencyFact(rt.state, task, effect.payload.childTaskId).version !== effect.payload.version) throw new EffectCancelled('Dependency condition changed or parent already resumed')
    if (!rt.state.projectChiefPolicies?.[task.projectId]?.enabled) throw new EffectDeferred('Chief dependency authority is not configured', { waitingFor: 'configuration' })
    const run = await rt.projectChiefControl.request(task.projectId, 'dependency-review', effect.payload, task.id)
    return { chiefRunId: run.id }
  } })
  rt.projectEffects.register('task.resume', { async run(effect) {
    const task = rt.projectTaskLifecycle.taskOf(effect.taskId)
    if (task.projectTask?.wait?.id !== effect.payload.waitId || ['accepted', 'cancelled'].includes(task.status)) throw new EffectCancelled('Parent wait ended or changed')
    return rt.projectPools.resumeChildren(task.id, effect.payload.waitId)
  } })
}
