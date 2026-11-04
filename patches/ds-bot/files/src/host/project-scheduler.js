// Persisted Project admission queue. The existing Workflow service still dispatches Runs.
import { createHash, randomUUID } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
import { taskRepository } from './project-task-repository.js'
import { initialRoleTarget } from './project-role-admission.js'
import { attemptIdle, capacitySuspended } from './project-execution-capacity.js'
import { preflightRepository } from './project-repository-policy.js'
const ACTIVE = new Set(['queued', 'running', 'working', 'paused', 'legacy'])
const error = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function releasedParentWait(state, attemptId) {
  const attempt = ownEntry(state.projectAttempts ?? {}, attemptId), task = ownEntry(state.tasks ?? {}, attempt?.taskId)
  return Boolean(task?.collaboration?.status === 'waiting-children' &&
    !Object.values(state.projectResourceLeases ?? {}).some(lease => lease.attemptId === attemptId && lease.status !== 'released') &&
    !Object.values(state.bots ?? {}).some(bot => bot.ephemeral && bot.attemptId === attemptId))
}

export function createProjectScheduler(rt, { preflight = preflightRepository } = {}) {
  const { state } = rt
  const entries = () => (state.projectQueue ??= {})
  const savingAdmissions = new Set(), savingQueueEntries = new Set()
  let recovered = false
  let tail = Promise.resolve()
  let waking = null, wakeAgain = false
  const serial = fn => { const result = tail.then(fn, fn); tail = result.then(() => {}, () => {}); return result }
  function slots(projectId) {
    const keys = new Set()
    for (const run of Object.values(state.projectExecutions ?? {})) if (run.projectId === projectId && run.kind !== 'chief-control' && ACTIVE.has(run.status)) keys.add(run.attemptId ?? run.id)
    for (const attempt of Object.values(state.projectAttempts ?? {})) if (attempt.projectId === projectId && ['preparing', 'running'].includes(attempt.status)) keys.add(attempt.id)
    for (const bot of Object.values(state.bots)) if (bot.projectId === projectId && bot.ephemeral && bot.attemptId) keys.add(bot.attemptId)
    for (const lease of Object.values(state.projectResourceLeases ?? {})) if (lease.projectId === projectId && lease.role !== 'chief' && lease.status !== 'released' && lease.attemptId) keys.add(lease.attemptId)
    for (const key of [...keys]) {
      if (releasedParentWait(state, key) || capacitySuspended(state, state.projectAttempts?.[key] ?? {})) keys.delete(key)
    }
    return keys.size
  }
  const quota = project => project.quota?.maxConcurrent ?? 2
  async function captureWait(task, source) {
    const attempt = state.projectAttempts?.[task.deliveryAttemptId]
    const wait = source ?? (task.chiefQuestion ? { kind: 'chief-input', id: task.chiefQuestion.decisionId } : task.collaboration?.status === 'waiting-children' ? { kind: 'children', id: task.projectTask?.wait?.id ?? task.collaboration.currentHandoffId } : null)
    if (!attempt || !wait || attempt.taskId !== task.id) return
    if (attempt.capacityWait?.source.id === wait.id && attempt.capacityWait.status !== 'admitted') return
    const previous = attempt.capacityWait
    attempt.capacityWait = { version: 'project-capacity-wait/v1', source: structuredClone(wait), status: 'suspended', attemptId: attempt.id, at: Date.now() }
    try { await rt.save() } catch (error) { if (previous === undefined) delete attempt.capacityWait; else attempt.capacityWait = previous; throw error }
  }
  function capacity(projectId) {
    const result = { activeSlots: slots(projectId), waitingInput: 0, waitingResume: 0, exitUnknown: 0 }
    for (const attempt of Object.values(state.projectAttempts ?? {})) {
      const task = state.tasks?.[attempt.taskId]
      if (attempt.projectId !== projectId || task?.deliveryAttemptId !== attempt.id || !attempt.capacityWait || ['accepted', 'cancelled'].includes(task.status)) continue
      if (attempt.capacityWait.status === 'admitted') continue
      if (!attemptIdle(state, attempt.id)) ++result.exitUnknown
      else if (task.chiefQuestion || task.collaboration?.status === 'waiting-children') ++result.waitingInput
      else ++result.waitingResume
    }
    return result
  }
  async function admitPool(task, definition) {
    if (definition.role === 'chief') return true
    const attempt = state.projectAttempts?.[task.deliveryAttemptId], wait = attempt?.capacityWait
    if (!wait) return true
    if (wait.status === 'admitted') return !savingAdmissions.has(attempt.id)
    if (task.chiefQuestion || task.collaboration?.status !== 'queued' || !attemptIdle(state, attempt.id)) return false
    const c = task.collaboration
    let entry = Object.values(entries()).find(row => row.kind === 'resume' && row.attemptId === attempt.id && row.handoffId === c.currentHandoffId && row.generation === c.generation)
    if (!entry) {
      entry = { id: `queue-${randomUUID()}`, kind: 'resume', projectId: task.projectId, taskId: task.id, attemptId: attempt.id, handoffId: c.currentHandoffId, generation: c.generation, targetBotId: definition.id, initialTarget: { role: definition.role }, memberId: c.initiatedBy ?? attempt.initiatedBy, status: 'waiting', enqueuedAt: Date.now(), updatedAt: Date.now() }
      setEntry(entries(), entry.id, entry); savingQueueEntries.add(entry.id)
      try { await rt.save() } catch (error) { delete entries()[entry.id]; throw error } finally { savingQueueEntries.delete(entry.id) }
    }
    // Queue admission runs outside the pool lock: drain can itself admit a new pool Task.
    void wake()
    return false
  }
  function revalidate(projectId) {
    let changed = false
    for (const entry of Object.values(entries())) {
      if (entry.projectId !== projectId || entry.status !== 'waiting') continue
      const task = ownEntry(state.tasks, entry.taskId)
      const actor = { memberId: entry.memberId }
      if (!task || ['accepted', 'cancelled'].includes(task.status) || !rt.projectCan(actor, projectId, 'task-write', task)) {
        entry.status = 'cancelled'
        entry.reason = 'Task ended or requester no longer has Project authority'
        entry.updatedAt = Date.now()
        changed = true
      }
    }
    return changed
  }
  function resourceBlock(projectId, target) {
    try { const definitions = rt.projectAgents?.deliveryDefinitions(projectId); rt.projectResources?.plan(projectId, rt.config.projectDispatch === 'workflow' ? definitions : { ...definitions, roles: definitions?.roles.filter(row => row.role === (target?.role ?? 'developer')) }); return null }
    catch (failure) { return String(failure.message).slice(0, 300) }
  }
  async function request(body, actor) {
    const task = ownEntry(state.tasks, String(body.taskId ?? ''))
    if (!task?.projectId) throw error('Unknown Project Task')
    const project = rt.requireProjectAccess(actor, task.projectId, 'create')
    rt.requireProjectAccess(actor, project.id, 'task-write', task)
    if (task.projectTask?.admission.status !== 'accepted' && task.projectTask) {
      const token = rt.projectTaskLifecycle.stageIntake(task)
      if (token) await rt.projectEffects.persist(token)
      return { admission: structuredClone(task.projectTask.admission), waitingFor: 'chief' }
    }
    rt.projectTaskLifecycle?.requireExecutable(task)
    const execution = taskRepository(rt, project, task, body)
    await preflight(rt, execution.project)
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId)) throw error('A run needs a stable requestId')
    const requestKey = createHash('sha256').update(`${project.id}\n${task.id}\n${body.requestId}`).digest('hex')
    const prior = Object.values(state.projectAttempts ?? {}).find(attempt => attempt.requestKey === requestKey)
    if (prior) {
      if (body.repository !== undefined && body.repository !== prior.requirement?.repository || body.targetRole !== undefined && prior.initialTarget && body.targetRole !== prior.initialTarget.role) throw error('Execution request content changed on replay')
      return { attempt: structuredClone(prior), already: true }
    }
    const queued = Object.values(entries()).find(entry => entry.requestKey === requestKey || entry.taskId === task.id && entry.status === 'waiting')
    if (queued) {
      if (body.repository !== undefined && queued.repositoryBinding && body.repository !== queued.repositoryBinding.repository || body.targetRole !== undefined && body.targetRole !== queued.initialTarget?.role) throw error('Queued request target cannot change on replay')
      return { queue: structuredClone(queued), already: true }
    }
    if (['accepted', 'cancelled'].includes(task.status)) throw error('Task has ended')
    if (Object.values(state.projectAttempts ?? {}).some(attempt => attempt.taskId === task.id && ['preparing', 'running', 'waiting-acceptance'].includes(attempt.status))) throw error('Task already has an active Attempt')
    const initialTarget = initialRoleTarget(rt, task, body)
    const resourceReason = resourceBlock(project.id, initialTarget)
    if (slots(project.id) < quota(project) && !resourceReason && !Object.values(entries()).some(row => row.projectId === project.id && row.status === 'waiting')) return rt.projectDelivery.endpoint('project-task-run', { ...body, repositoryBinding: execution.binding, ...(initialTarget ? { initialTarget } : {}) }, actor)
    const entry = { id: `queue-${randomUUID()}`, projectId: project.id, taskId: task.id, requestId: body.requestId, requestKey,
      memberId: actor.memberId, repositoryBinding: execution.binding, ...(initialTarget ? { initialTarget } : {}), status: 'waiting', ...(resourceReason ? { reason: resourceReason } : {}), enqueuedAt: Date.now(), updatedAt: Date.now() }
    setEntry(entries(), entry.id, entry)
    await rt.save()
    return { queue: structuredClone(entry) }
  }
  async function drain() {
    if (rt.readOnly?.() || !rt.sharedProjectMode?.() || !rt.flybotIsRead?.('workflow/state')) return
    let changed = false
    for (const task of Object.values(state.tasks)) if (task.chiefQuestion || task.collaboration?.status === 'waiting-children') await captureWait(task)
    for (const project of rt.listProjects()) if (revalidate(project.id)) changed = true
    const pending = Object.values(entries()).filter(entry => entry.status === 'waiting').sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id))
    for (const entry of pending) {
      if (savingQueueEntries.has(entry.id)) continue
      const project = rt.readProject(entry.projectId)
      if (!project || project.status !== 'active') { entry.status = 'blocked'; entry.reason = 'Project is archived or unavailable'; changed = true; continue }
      if (slots(project.id) >= quota(project)) continue
      if (entry.kind === 'resume') {
        const task = state.tasks[entry.taskId], attempt = state.projectAttempts?.[entry.attemptId], c = task?.collaboration
        if (!attempt || task.deliveryAttemptId !== attempt.id || c?.generation !== entry.generation || c.currentHandoffId !== entry.handoffId || c.botId !== entry.targetBotId || c.status !== 'queued' || task.chiefQuestion) { entry.status = 'cancelled'; entry.reason = 'Continuation changed'; changed = true; continue }
        if (!attemptIdle(state, attempt.id)) { entry.reason = 'Execution exit unconfirmed'; changed = true; continue }
        try {
          await rt.projectDelegations?.background(entry.memberId)
          rt.requireProjectAccess({ memberId: entry.memberId }, project.id, 'task-write', task)
          rt.projectTaskLifecycle?.requireExecutable(task)
          const catalog = rt.projectAgents?.deliveryDefinitions(project.id)
          if (catalog && !catalog.roles.some(row => row.id === entry.targetBotId && row.status !== 'retired')) throw error('Continuation role was retired')
          const blocked = resourceBlock(project.id, entry.initialTarget)
          if (blocked) { entry.reason = blocked; changed = true; continue }
          const previous = structuredClone(attempt.capacityWait)
          savingAdmissions.add(attempt.id)
          attempt.capacityWait.status = 'admitted'; attempt.capacityWait.queueId = entry.id; attempt.capacityWait.admittedAt = Date.now()
          entry.status = 'started'; entry.updatedAt = Date.now(); delete entry.reason
          try { await rt.save() } catch (failure) { attempt.capacityWait = previous; entry.status = 'waiting'; throw failure } finally { savingAdmissions.delete(attempt.id) }
        } catch (failure) { entry.status = 'blocked'; entry.reason = String(failure.message).slice(0, 300) }
        changed = true; continue
      }
      let execution
      try { execution = taskRepository(rt, project, state.tasks[entry.taskId], { repositoryBinding: entry.repositoryBinding }); await preflight(rt, execution.project) }
      catch (failure) { entry.status = 'blocked'; entry.reason = failure.message; entry.updatedAt = Date.now(); changed = true; continue }
      if (!entry.repositoryBinding) { entry.repositoryBinding = execution.binding; await rt.save() }
      let initialTarget
      try { initialTarget = initialRoleTarget(rt, state.tasks[entry.taskId], { initialTarget: entry.initialTarget }) }
      catch (failure) { entry.status = 'blocked'; entry.reason = failure.message; entry.updatedAt = Date.now(); changed = true; continue }
      if (initialTarget && !entry.initialTarget) { entry.initialTarget = initialTarget; await rt.save() }
      const blocked = resourceBlock(project.id, initialTarget)
      if (blocked) { entry.reason = blocked; changed = true; continue }
      entry.status = 'starting'
      entry.updatedAt = Date.now()
      await rt.save()
      try {
        const result = await rt.projectDelivery.endpoint('project-task-run', { taskId: entry.taskId, requestId: entry.requestId, repositoryBinding: entry.repositoryBinding, initialTarget: entry.initialTarget }, { memberId: entry.memberId })
        entry.status = result.attempt?.status === 'failed' ? 'failed' : 'started'
        entry.attemptId = result.attempt?.id ?? null
        if (result.attempt?.failure) entry.reason = result.attempt.failure.message
      } catch (failure) { entry.status = 'failed'; entry.reason = String(failure.message ?? failure).slice(0, 1000) }
      entry.updatedAt = Date.now()
      changed = true
    }
    if (changed) await rt.save()
  }
  async function cancel(body, actor) {
    const entry = ownEntry(entries(), String(body.queueId ?? ''))
    if (!entry) throw error('Unknown queued request')
    const task = ownEntry(state.tasks, entry.taskId)
    rt.requireProjectAccess(actor, entry.projectId, 'task-write', task)
    if (entry.kind === 'resume') throw error('Cancel or change the Task through Chief; a continuation cannot become a new request')
    if (!['waiting', 'blocked'].includes(entry.status)) throw error('Queued request has already started or ended')
    entry.status = 'cancelled'; entry.updatedAt = Date.now(); entry.reason = 'Cancelled by an authorized member'
    await rt.save()
    return { queue: structuredClone(entry) }
  }
  async function retry(body, actor) {
    const entry = ownEntry(entries(), String(body.queueId ?? ''))
    if (!entry) throw error('Unknown queued request')
    const task = ownEntry(state.tasks, entry.taskId)
    rt.requireProjectAccess(actor, entry.projectId, 'run-control')
    if (!task || task.projectId !== entry.projectId || ['accepted', 'cancelled'].includes(task.status)) throw error('Task has ended or is unavailable')
    if (entry.kind === 'resume') {
      if (entry.status !== 'blocked') throw error('Only a blocked continuation can be retried')
      await rt.projectDelegations?.background(entry.memberId)
      if (!rt.projectCan({ memberId: entry.memberId }, entry.projectId, 'task-write', task)) throw error('Original requester no longer has Project authority')
      entry.status = 'waiting'; delete entry.reason; await rt.save(); return { queue: structuredClone(entry) }
    }
    if (entry.status !== 'blocked') throw error('Only a blocked queue request can be retried')
    // Recovery must not replace the initiating human with the operator's authority.
    const requester = { memberId: entry.memberId }
    if (!rt.projectCan(requester, entry.projectId, 'task-write', task)) throw error('Original requester no longer has Project authority')
    await rt.projectDelegations?.background(entry.memberId)
    const project = rt.requireProjectAccess(actor, entry.projectId, 'run-control')
    await preflight(rt, taskRepository(rt, project, task, { repositoryBinding: entry.repositoryBinding }).project)
    rt.requireProjectAccess(actor, entry.projectId, 'run-control')
    if (['accepted', 'cancelled'].includes(task.status)) throw error('Task has ended')
    if (!rt.projectCan(requester, entry.projectId, 'task-write', task)) throw error('Original requester no longer has Project authority')
    if (Object.values(state.projectAttempts ?? {}).some(attempt => attempt.taskId === task.id && ['preparing', 'running', 'waiting-acceptance'].includes(attempt.status))) throw error('Task already has an active Attempt')
    const initialTarget = initialRoleTarget(rt, task, { targetRole: body.targetRole ?? entry.initialTarget?.role })
    ;(entry.recoveries ??= []).push({ by: actor.memberId, previousReason: entry.reason ?? null, at: Date.now() })
    if (initialTarget) entry.initialTarget = initialTarget
    entry.status = 'waiting'; delete entry.reason; entry.updatedAt = Date.now()
    await rt.save()
    return { queue: structuredClone(entry) }
  }
  function recover() {
    if (recovered || rt.readOnly?.()) return false
    recovered = true
    let changed = false
    for (const entry of Object.values(entries())) if (entry.status === 'starting') {
      const attempt = Object.values(state.projectAttempts ?? {}).find(attempt => attempt.requestKey === entry.requestKey)
      entry.status = attempt ? 'started' : 'waiting'
      entry.attemptId = attempt?.id ?? null
      changed = true
    }
    return changed
  }
  function wake() {
    wakeAgain = true
    if (waking) return waking
    waking = Promise.resolve().then(async () => {
      do {
        wakeAgain = false
        // One complete pass at a time, including resource reconciliation and dispatch.
        await rt.projectDelivery?.reconcileExecutions?.()
        await rt.projectResources?.reconcile?.()
        await serial(drain)
        if (rt.projectEffects) await rt.projectEffects.drain()
        else await rt.projectPools?.pump()
        await rt.projectScheduledTasks?.pump()
        await rt.projectChiefControl?.pump()
      } while (wakeAgain)
    }).catch(failure => { wakeAgain = false; rt.warn('Project queue: %s', failure.message) }).finally(() => {
      waking = null
      // Preserve an event arriving between the final pass and promise settlement.
      if (wakeAgain) void wake()
    })
    return waking
  }
  return { request: (body, actor) => serial(() => request(body, actor)), cancel: (body, actor) => serial(() => cancel(body, actor)),
    retry: (body, actor) => serial(() => retry(body, actor)).then(result => { void wake(); return result }),
    captureWait, capacity, admitPool, slots, revalidate, recover, drain: () => serial(drain), wake }
}
export function install(rt) {
  rt.projectScheduler = createProjectScheduler(rt)
  if (!rt.sharedProjectMode?.()) return
  rt.ctx.effect(() => {
    const timer = setInterval(() => rt.projectScheduler.wake(), 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: Project admission queue')
}
