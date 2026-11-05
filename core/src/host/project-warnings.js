import { chiefActionRefusals } from './project-delivery-options.js'
// One disclosure and delivery boundary; warnings are facts, never routing authority.
import { createHash } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
import { inspectionFacts } from './project-chief-control.js'
import { inspectionLifecycle } from './project-chief-lifecycle.js'
import { operationsContact } from './project-chief-assistance.js'
import { EffectCancelled } from './project-effects.js'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = message => Object.assign(new Error(message), { code: 'bot/warning' })
const hour = 3600000
const terminal = new Set(['accepted', 'cancelled'])
export function warningData(value, depth = 0) {
  if (depth > 8) return '[depth limited]'
  if (value && typeof value === 'object' && ['thinking', 'reasoning'].includes(value.type)) return { type: value.type, omitted: true }
  if (typeof value === 'string') return value.replace(/(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}|Bearer\s+[^\s"']+/gi, '[redacted]').slice(0, 2000)
  if (Array.isArray(value)) return value.slice(-40).map(row => warningData(row, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:env|cwd|path|eventLog|log|home|configDir|token|secret|password|apiKey|privateKey|authorization|credential|thinking|reasoning|encrypted_content)$/i.test(key)).map(([key, child]) => [key, warningData(child, depth + 1)]))
  return value ?? null
}
export function createProjectWarnings(rt, { now = Date.now } = {}) {
  const state = rt.state, rows = () => (state.projectWarnings ??= {})
  const scoped = (table, id, projectId) => { const row = ownEntry(table ?? {}, id); return row?.projectId === projectId ? row : null }
  const taskOf = row => scoped(state.tasks, row.taskId, row.projectId)
  const attemptOf = row => scoped(state.projectAttempts, row.attemptId, row.projectId)
  const runOf = row => scoped(state.projectExecutions, row.runId, row.projectId)
  const workerOf = row => scoped(state.projectHarnessWorkers, row.workerId, row.projectId)
  function scope(row) {
    const task = taskOf(row), attempt = attemptOf(row), run = runOf(row), worker = workerOf(row)
    return { projectId: row.projectId, taskId: row.taskId ?? null, attemptId: task?.deliveryAttemptId ?? row.attemptId ?? null, generation: task?.collaboration?.generation ?? null, requirementsSha256: task ? hash([task.title, task.criteria, task.projectTask?.requirements?.revision]) : null, candidateSha: attempt?.candidateSha ?? null,
      runId: row.runId ?? null, invocation: run?.invocation ?? null, workerId: row.workerId ?? null, workerGeneration: worker?.generation ?? null, executionStartedAt: worker?.executionStartedAt ?? null }
  }
  function current(row) {
    if (row.supersededBy) return false
    const task = taskOf(row), attempt = attemptOf(row), run = runOf(row), worker = workerOf(row)
    if (rt.readProject(row.projectId)?.status !== 'active' || row.taskId && (!task || task.projectId !== row.projectId || terminal.has(task.status) || task.deliveryAttemptId !== row.attemptId)) return false
    if (row.workerId && (!worker || worker.generation !== row.source.workerGeneration || (worker.executionStartedAt ?? null) !== row.source.executionStartedAt || row.kind === 'sdk-duration' && !['running', 'waiting-input'].includes(worker.status))) return false
    if (row.runId && (!run || run.invocation !== row.source.invocation || !['queued', 'running', 'correction-pending'].includes(run.status))) return false
    if (row.kind === 'task-attention') { const thresholds = state.projectChiefPolicies?.[row.projectId]?.inspection?.thresholds; if (!thresholds || !inspectionFacts(state, task, thresholds, now()).reasons.includes(row.reason)) return false }
    if (row.kind === 'merge-wait' && (!attempt?.merge || ['merged', 'cancelled'].includes(attempt.merge.status) || attempt.candidateSha !== row.source.candidateSha)) return false
    return !row.taskId || scope(row).generation === row.source.generation && scope(row).requirementsSha256 === row.source.requirementsSha256
  }
  function facts(row) {
    const task = taskOf(row), attempt = attemptOf(row), worker = workerOf(row), run = runOf(row)
    const lease = worker && ownEntry(state.projectResourceLeases ?? {}, worker.leaseId)
    const allocation = lease?.projectId === row.projectId && lease.generation === worker?.generation ? { id: lease.id, generation: lease.generation, resourceId: lease.resourceId, status: lease.status, preparation: lease.preparation ? { status: lease.preparation.status, exitConfirmed: lease.preparation.exitConfirmed } : null } : null
    const scopedTaskId = run?.taskId ?? run?.source?.blockedTaskId ?? null
    const eligible = run ? Object.values(state.tasks ?? {}).filter(t => t.projectId === row.projectId && !terminal.has(t.status) && (!scopedTaskId || t.id === scopedTaskId)) : []
    const history = task?.collaboration?.history ?? []
    const evidence = attempt?.evidence ?? {}
    const blockers = [task?.collaboration?.block?.reason, worker?.authenticationFailure?.code, worker?.capabilityFailure?.code, evidence.tests?.passed === false ? 'Tests did not pass; inspect exact outcome and candidate' : null, evidence.tests?.sha && evidence.tests.sha !== attempt?.candidateSha ? 'Tests refer to a different candidate' : null, evidence.review?.sha && evidence.review.sha !== attempt?.candidateSha ? 'Review refers to a different candidate' : null, worker?.pending?.kind === 'permission' ? 'Execution is waiting for explicit authorization' : null, attempt?.merge?.reason, worker && !rt.projectHarness?.exitConfirmed?.(worker.id) ? 'Worker exit is not confirmed; no release may be inferred' : null].filter(Boolean)
    return warningData({ observedAt: now(), source: scope(row), current: current(row), blockers, task: task ? { title: task.title, status: task.status, criteria: task.criteria, waiting: task.collaboration?.block ?? null, destination: task.collaboration?.botId, question: task.chiefQuestion ? { recipient: task.chiefQuestion.recipient?.kind, at: task.chiefQuestion.at } : null } : null,
      execution: worker ? { id: worker.id, harness: worker.harness, role: worker.role, logicalSessionId: worker.logicalSessionId, backendSessionId: worker.backendSessionId, resourceId: worker.resourceId, allocation, status: worker.status, startedAt: worker.executionStartedAt, lastEventAt: worker.lastEventAt, activity: worker.activity ?? null, observation: rt.projectHarness?.observe?.(worker.id) ?? { connection: 'unknown', process: 'unknown' }, pending: worker.pending ? { kind: worker.pending.kind } : null, exitConfirmed: rt.projectHarness?.exitConfirmed?.(worker.id) ?? false } : null,
      chief: run ? { scope: { kind: scopedTaskId ? 'task' : 'project', taskId: scopedTaskId, snapshotSha256: run.snapshotSha256 ?? null }, eligibleTaskCount: eligible.length, eligibleTaskPreview: eligible.slice(0, 5).map(t => ({ id: t.id, title: t.title, status: t.status, waiting: t.collaboration?.block?.reason ?? null })), id: run.id, purpose: run.purpose, status: run.status, waitingFor: run.waitingFor, invocation: run.invocation, createdAt: run.createdAt, startedAt: run.startedAt, workerId: run.workerId, recovery: run.recovery, recentSuccessAt: Math.max(0, ...Object.values(state.projectExecutions ?? {}).filter(other => other.projectId === row.projectId && other.kind === 'chief-control' && other.purpose === 'inspection' && other.status === 'done').map(other => other.finishedAt ?? 0)), occupying: Object.values(state.projectExecutions ?? {}).filter(other => other.projectId === row.projectId && other.kind === 'chief-control' && other.status === 'running').map(other => ({ id: other.id, startedAt: other.startedAt, workerId: other.workerId })) } : null,
      progress: { implementation: evidence.implementation, tests: evidence.tests, review: evidence.review, merge: evidence.merge, environment: attempt?.workspacePreparations?.slice(-3), materialization: Object.values(attempt?.workspaces ?? {}).map(w => w.materialization).filter(Boolean) },
      merge: attempt?.merge ? { ...attempt.merge, pr: attempt.pr, candidateSha: attempt.candidateSha, policy: rt.config.projectRepositories?.[attempt.requirement?.repository]?.mergePolicy } : null,
      handoffs: history.slice(-20).map(h => ({ id: h.id, from: h.from, to: h.to, reason: h.reason, status: h.status, at: h.createdAt, evidence: h.evidence })),
      recoveryActions: Object.values(state.projectChiefDecisions ?? {}).filter(d => d.taskId === row.taskId).slice(-10).map(d => ({ action: d.action, status: d.status, at: d.at, reason: d.reason })),
      unknown: ['SDK activity is not proof of artifact progress; missing events are not proof of death', 'Unavailable live process, provider or command observations remain unknown'] })
  }
  function summary(row) {
    const data = facts(row)
    return { id: row.id, kind: row.kind, projectId: row.projectId, taskId: row.taskId ?? null, at: row.at, observedAt: data.observedAt, task: data.task ? { title: data.task.title, status: data.task.status, destination: data.task.destination } : null, elapsedMs: Math.max(0, now() - row.since), thresholdMs: row.thresholdMs, bucket: row.bucket,
      historical: !data.current, recordedSource: row.source, expectedScope: hash(data.source), source: data.source, reason: row.reason, blockers: data.blockers, execution: data.execution, chief: data.chief,
      merge: data.merge ? { repository: data.merge.pr?.repository, number: data.merge.pr?.number, candidateSha: data.merge.candidateSha, baseBranch: data.merge.baseBranch, status: data.merge.status, reason: data.merge.reason, observedAt: data.merge.observedAt ?? null, reviewDecision: data.merge.reviewDecision ?? 'unknown', checkCount: data.merge.checkCount ?? null, checks: data.merge.checks?.filter(c => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)), threads: data.merge.threads ?? { status: 'unknown' } } : null,
      progress: { candidateSha: attemptOf(row)?.candidateSha ?? null, implementationSha: data.progress.implementation?.sha ?? null, environment: data.progress.environment?.slice(-1) ?? [], tests: data.progress.tests ? { sha: data.progress.tests.sha, passed: data.progress.tests.passed, status: data.progress.tests.status, reason: data.progress.tests.reason, at: data.progress.tests.at } : null, review: data.progress.review ? { sha: data.progress.review.sha, verdict: data.progress.review.verdict } : null, merge: data.progress.merge ? { sha: data.progress.merge.sha, mergeCommitSha: data.progress.merge.mergeCommitSha } : null },
      refusedChiefActions: taskOf(row) ? chiefActionRefusals(state, taskOf(row)).slice(-5) : [], delivery: row.delivery ?? null, declaredReads: Object.values(row.reads ?? {}).map(({ memberId, at }) => ({ memberId, at })), unknown: data.unknown, topics: ['execution', 'chief', 'progress', 'merge', 'handoffs', 'recoveryActions', 'events'] }
  }
  async function query(body, actor) {
    rt.requireProjectAccess(actor, body.projectId, 'configure')
    if (!body.warningId) {
      const offset = body.offset ?? 0, limit = body.limit ?? 10
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw fail('Invalid warning page')
      const all = Object.values(rows()).filter(r => r.projectId === body.projectId).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
      return { items: all.slice(offset, offset + limit).map(summary), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null }
    }
    const row = ownEntry(rows(), body.warningId)
    if (!row || row.projectId !== body.projectId) throw fail('Warning belongs to another Project')
    const head = summary(row)
    if (!body.topic) return head
    if (!head.topics.includes(body.topic)) throw fail('Unknown warning topic')
    const value = body.topic === 'events' ? await rt.projectHarness?.events?.(row.workerId, body) ?? { status: 'unavailable', reason: 'No SDK event source' } : facts(row)[body.topic]
    rt.requireProjectAccess(actor, body.projectId, 'configure')
    if (head.expectedScope !== hash(scope(row))) throw fail('Warning execution changed during query; refresh the summary')
    const safe = warningData(value), text = JSON.stringify(safe), sha256 = hash(safe), offset = body.offset ?? 0, limit = body.limit ?? 4000
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw fail('Invalid warning disclosure page')
    if (body.sha256 && body.sha256 !== sha256) throw fail('Warning topic changed; restart its bounded read')
    return { warningId: row.id, topic: body.topic, observedAt: now(), historical: head.historical, expectedScope: head.expectedScope, sha256, notModified: body.ifNoneMatch === sha256, offset, totalChars: text.length, text: body.ifNoneMatch === sha256 ? '' : text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null }
  }
  async function notify(effect) {
    const row = ownEntry(rows(), effect.payload.warningId)
    if (!row || !current(row)) throw new EffectCancelled('Warning execution was superseded')
    if (row.recipient === 'chief') {
      const run = await rt.projectChiefControl.request(row.projectId, 'inspection', { warningId: row.id, ...(row.taskId ? { blockedTaskId: row.taskId } : {}) })
      row.delivery = { kind: 'chief', runId: run.id }; await rt.save(); return row.delivery
    }
    const project = rt.readProject(row.projectId)
    let contact
    try { contact = operationsContact(rt, row.projectId, state.projectChiefPolicies?.[row.projectId]?.operationsContact) } catch { /* Revoked contact falls back to a current project manager. */ }
    const memberId = [contact?.memberId, project.ownerUserId, ...(project.roles?.maintainers ?? [])].filter(Boolean).find(id => state.members?.[id]?.status !== 'disabled' && rt.projectCan({ memberId: id }, row.projectId, 'configure'))
    if (!memberId) throw new EffectCancelled('No authorized Project warning recipient remains')
    rt.requireProjectAccess({ memberId }, row.projectId, 'configure')
    const participation = contact ? rt.personalAgents?.participationFor(contact.agentId, row.projectId) : rt.personalAgents?.defaultParticipation(row.projectId, memberId)
    const identity = participation && rt.personalAgents.agentOf(participation.agentId)
    if (!identity || identity.status !== 'active' || participation.status !== 'active' || identity.ownerId !== memberId) {
      row.delivery = { kind: 'human-mailbox', memberId, query: 'warnings', warningId: row.id, eventEntityType: 'warning' }; await rt.save(); return row.delivery
    }
    const carrier = ownEntry(state.projectAgents ?? {}, participation.carrierId) ?? { id: participation.carrierId, projectId: row.projectId, memberId, personalAgentId: identity.id, participationId: participation.id, visibility: 'private', kind: 'consultation-mailbox' }
    rt.personalAgents.requireParticipation(carrier)
    state.projectAgents ??= {}; setEntry(state.projectAgents, carrier.id, carrier)
    state.projectAgentTranscripts ??= {}; const messages = (state.projectAgentTranscripts[carrier.id] ??= [])
    if (!messages.some(m => m.id === row.id)) messages.push({ id: row.id, version: 'conversation-handoff/v1', kind: 'warning', direction: 'outgoing', status: 'completed', projectId: row.projectId, warningId: row.id, returnTo: carrier.id, initiatedBy: memberId, text: JSON.stringify(summary(row)), at: row.at })
    const token = rt.projectAgentInbox.stage(carrier, messages.find(m => m.id === row.id))
    await rt.projectEffects.persist(token)
    row.delivery = { kind: 'personal-agent', memberId, agentId: identity.id, messageId: row.id, effectId: token.id }; await rt.save(); return row.delivery
  }
  rt.projectEffects?.register('warning.notify', { run: notify }, { replace: true })
  async function offer(spec) {
    const prototype = { ...spec }, source = scope(prototype)
    const id = `warning-${hash([spec.projectId, spec.kind, source, spec.since, spec.bucket]).slice(0, 40)}`
    const prior = ownEntry(rows(), id)
    if (prior && rt.projectEffects.intentCommitted(prior.effect)) return prior
    const identity = hash([spec.projectId, spec.kind, source, spec.since, spec.reason])
    const previous = !prior && Object.values(rows()).findLast(row => row.identity === identity && !row.supersededBy)
    const row = prior ?? { ...spec, id, identity, source, at: now() }
    const token = rt.projectEffects.stage({ kind: 'warning.notify', key: id, projectId: row.projectId, taskId: row.taskId ?? null, payload: { warningId: id } })
    row.effect = token; setEntry(rows(), id, row)
    if (previous) previous.supersededBy = id
    try { await rt.projectEffects.persist(token) }
    catch (error) { if (rt.projectEffects.discardUncommitted(token) && !prior) { delete rows()[id]; if (previous) delete previous.supersededBy }; throw error }
    return row
  }
  let pending
  function reconcile() {
    if (pending) return pending
    pending = (async () => {
      if (rt.readOnly?.() !== undefined) return
      for (const w of Object.values(state.projectHarnessWorkers ?? {})) {
        if (!['running', 'waiting-input'].includes(w.status) || !w.executionStartedAt || now() - w.executionStartedAt < hour) continue
        const task = ownEntry(state.tasks ?? {}, w.taskId)
        if (w.role !== 'chief' && (!task || terminal.has(task.status) || task.deliveryAttemptId !== w.attemptId)) continue
        await offer({ projectId: w.projectId, taskId: w.role === 'chief' ? null : w.taskId, attemptId: w.role === 'chief' ? null : w.attemptId, workerId: w.id, ...(w.role === 'chief' ? { runId: w.chiefRunId } : {}), kind: 'sdk-duration', recipient: w.role === 'chief' ? 'operator' : 'chief', since: w.executionStartedAt, thresholdMs: hour, bucket: Math.floor((now() - w.executionStartedAt) / hour), reason: 'SDK execution exceeded another hour; inspect current activity and actual artifacts before deciding' })
      }
      for (const run of Object.values(state.projectExecutions ?? {})) {
        if (run.kind !== 'chief-control' || run.purpose !== 'inspection' || !['queued', 'running', 'correction-pending'].includes(run.status)) continue
        const timing = inspectionLifecycle(state.projectChiefPolicies?.[run.projectId]?.inspection)
        const queued = run.status === 'queued', limit = queued ? timing.queueTimeoutMs : timing.runTimeoutMs, since = queued ? run.queuedAt ?? run.createdAt : run.startedAt ?? run.createdAt
        const worker = ownEntry(state.projectHarnessWorkers ?? {}, run.workerId)
        const workerId = worker?.projectId === run.projectId && worker.chiefRunId === run.id && worker.chiefInvocation === run.invocation ? worker.id : null
        if (now() - since >= limit) await offer({ projectId: run.projectId, runId: run.id, workerId, kind: queued ? 'chief-queue' : 'chief-duration', recipient: 'operator', since, thresholdMs: limit, bucket: 1, reason: 'Chief inspection needs attention; notification grants no operational permission' })
      }
      for (const task of Object.values(state.tasks ?? {})) {
        const a = ownEntry(state.projectAttempts ?? {}, task.deliveryAttemptId), policy = state.projectChiefPolicies?.[task.projectId]
        if (!a || terminal.has(task.status) || !policy?.enabled) continue
        const common = { projectId: task.projectId, taskId: task.id, attemptId: a.id, recipient: 'chief' }
        if (a.merge && !['merged', 'cancelled'].includes(a.merge.status) && now() - a.merge.createdAt >= 2 * hour) await offer({ ...common, kind: 'merge-wait', since: a.merge.createdAt, thresholdMs: 2 * hour, bucket: Math.floor((now() - a.merge.createdAt) / (2 * hour)), reason: 'Merge wait exceeded another two hours; inspect exact candidate, checks, review and provider observations' })
        const thresholds = policy.inspection?.thresholds
        if (thresholds) {
          const facts = inspectionFacts(state, task, thresholds, now())
          for (const reason of facts.reasons) await offer({ ...common, workerId: task.collaboration?.claim?.workerId && state.projectHarnessWorkers?.[task.collaboration.claim.workerId] ? task.collaboration.claim.workerId : null, kind: 'task-attention', since: task.collaboration?.claim?.createdAt ?? task.updatedAt ?? a.createdAt ?? task.collaboration?.history.at(-1)?.createdAt ?? now(), thresholdMs: null, bucket: hash(reason), reason })
        }
      }
    })().finally(() => { pending = null })
    return pending
  }
  async function action(body, actor) {
    rt.requireProjectAccess(actor, body.projectId, 'configure')
    if (rt.readOnly?.() !== undefined) throw fail('Warnings are read-only')
    const row = ownEntry(rows(), body.warningId)
    if (!row || row.projectId !== body.projectId || !current(row) || body.expectedScope !== hash(scope(row))) throw fail('Warning scope changed; refresh before an action')
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId ?? '')) throw fail('Warning action needs a stable requestId')
    if (body.action === 'acknowledge') {
      const key = hash([actor.memberId, actor.agentId ?? null, actor.chiefJobId ?? null])
      row.reads ??= {}; row.reads[key] = { memberId: actor.memberId, at: now(), requestId: body.requestId, scope: body.expectedScope, declaration: 'explicit-read' }; await rt.save()
      return { acknowledged: true, warningId: row.id }
    }
    if (body.action === 'inspect') {
      const run = await rt.projectChiefControl.request(row.projectId, 'inspection', { warningId: row.id, requestId: body.requestId, ...(row.taskId ? { blockedTaskId: row.taskId } : {}) })
      return { runId: run.id, status: run.status }
    }
    if (body.action !== 'stop') throw fail('Warning action must be acknowledge, inspect or stop')
    if (row.runId) return rt.projectChiefControl.stop({ ...body, runId: row.runId, invocation: row.source.invocation }, actor)
    const task = taskOf(row), claim = task?.collaboration?.claim
    if (!row.workerId || claim?.workerId !== row.workerId || claim.status !== 'active') throw fail('Warning does not own the active execution')
    await rt.projectPools.revokeExecution(task.id, claim.id, 'Authorized stop of this execution; Task and draft retained')
    if (task.collaboration.claim === claim) { claim.status = 'interrupted'; const a = attemptOf(row); if (a?.status === 'running') a.status = 'interrupted'; await rt.save() }
    return { stopped: claim.exitConfirmed === true, waitingFor: claim.exitConfirmed ? null : 'worker-exit', taskCancelled: false }
  }
  return { reconcile, query, action, isCurrent: id => { const row = ownEntry(rows(), id); return Boolean(row && current(row)) }, summaries: projectId => [...new Map(Object.values(rows()).filter(row => row.projectId === projectId && current(row)).map(row => [hash([row.kind, row.source, row.reason]), row])).values()].slice(-4).map(summary) }
}
export function install(rt) { rt.projectWarnings = createProjectWarnings(rt) }
