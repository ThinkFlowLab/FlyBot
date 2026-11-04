// Durable Task inbox. Receipts describe transport/declared handling, not comprehension.
import { createHash } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
import { EffectCancelled, EffectDeferred } from './project-effects.js'
export const INPUT_PROTOCOL = 'project-task-input/v1'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clone = value => structuredClone(value)
const bodyHash = text => createHash('sha256').update(text).digest('hex')
const verify = row => { if (typeof row.text !== 'string' || bodyHash(row.text) !== row.sha256) throw refuse('Task input content changed after acceptance') }
const refuse = text => Object.assign(new Error(text), { code: 'bot/task-input' })
const ended = task => ['accepted', 'cancelled'].includes(task.status) || ['cancelled', 'closed', 'stopping'].includes(task.collaboration?.status)
const stable = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)

export function createProjectInputs(rt) {
  let tail = Promise.resolve()
  const chiefPermits = new WeakMap()
  const serial = fn => { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p }
  const rows = () => (rt.state.projectTaskInputs ??= {})
  const taskOf = id => { const task = ownEntry(rt.state.tasks, id); if (!task?.projectId) throw refuse('Unknown Project Task'); return task }
  const writable = () => { if (rt.readOnly?.() !== undefined) throw refuse('Task inbox is read-only') }
  const authorized = (row, task) => {
    if (row.sourceAuthorityRevoked === true) return false
    if (!['human', 'github'].includes(row.source.kind)) return true
    try { rt.requireProjectAccess({ memberId: row.source.memberId }, task.projectId, 'task-write', task); return true } catch { return false }
  }
  const pending = task => Object.values(rt.state.projectTaskInputs ?? {}).filter(row => row.projectId === task.projectId && row.taskId === task.id && row.status === 'accepted' && row.version === INPUT_PROTOCOL && authorized(row, task))
  function current(task, claim) {
    const active = task.collaboration?.claim
    if (ended(task) || !active || active.status !== 'active' || active.id !== claim?.id || active.generation !== claim.generation || active.botId !== claim.botId || task.collaboration.generation !== claim.generation) throw refuse('Task input claim is stale')
    return active
  }
  function stage(task, source, text, kind) {
    writable()
    const id = `task-input-${digest([task.projectId, task.id, source])}`
    const previous = ownEntry(rows(), id), sha256 = bodyHash(text)
    if (previous) {
      if (previous.version !== INPUT_PROTOCOL) throw refuse('Task input protocol upgrade is required')
      verify(previous)
      if (previous.sha256 !== sha256 || previous.kind !== kind) throw refuse('Input event identity was reused with different content')
      return { row: previous, created: false }
    }
    const row = { id, version: INPUT_PROTOCOL, projectId: task.projectId, taskId: task.id, source: clone(source), kind, text, sha256, status: 'accepted', createdAt: Date.now(), deliveries: [] }
    setEntry(rows(), id, row)
    return { row, created: true }
  }
  async function publish(body, actor) {
    writable()
    const task = taskOf(body.taskId)
    if (body.projectId !== task.projectId) throw refuse('Task input belongs to another Project')
    rt.requireProjectAccess(actor, task.projectId, 'task-write', task); rt.projects.requireActive(task.projectId)
    if (ended(task) || !stable(body.requestId) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw refuse('Input needs an active Task, stable requestId and 1–4000 characters')
    // Public callers cannot forge webhook/handoff provenance or responsibility.
    if (body.source !== undefined || body.recipient !== undefined || body.claim !== undefined) throw refuse('Input routing and provenance are host-owned')
    const { row, created } = stage(task, { kind: 'human', memberId: actor.memberId, eventId: body.requestId, revision: 1 }, body.text, 'feedback')
    let token
    try {
      token = rt.projectEffects.stage({ kind: 'input.notify', key: row.id, projectId: task.projectId, taskId: task.id, payload: { inputId: row.id, initiatedBy: actor.memberId } })
      await rt.projectEffects.persist(token)
    } catch (error) { if (created && (!token || rt.projectEffects.discardUncommitted(token))) delete rows()[row.id]; throw error }
    rt.projectScheduler?.wake()
    return { input: metadata(row, task), already: !created }
  }
  function stageHandoff(task, handoff) {
    return stage(task, { kind: 'handoff', eventId: handoff.id, revision: 1 }, handoff.reason, 'handoff')
  }
  function metadata(row, task) {
    if (row.version !== INPUT_PROTOCOL) return { id: row.id, version: row.version, projectId: row.projectId, taskId: row.taskId, status: 'unsupported-protocol', phase: 'unavailable' }
    const delivery = row.deliveries.at(-1)
    const inactive = ended(task) || !authorized(row, task)
    return { id: row.id, version: row.version, projectId: row.projectId, taskId: row.taskId, source: clone(row.source), kind: row.kind, sha256: row.sha256, createdAt: row.createdAt,
      status: inactive && row.status === 'accepted' ? 'cancelled' : row.status, recipient: { botId: task.collaboration?.botId ?? null, generation: task.collaboration?.generation ?? null },
      phase: row.status === 'handled' ? 'handled' : row.status === 'cancelled' || inactive ? 'cancelled' : delivery?.handledAt ? 'handled' : delivery?.readAt ? 'read-confirmed' : delivery?.observedAt ? 'observed' : delivery?.sentAt ? 'delivered' : delivery ? 'inbox-accepted' : 'accepted',
      lastDelivery: delivery ? clone(delivery) : null }
  }
  function list(body, actor) {
    const task = taskOf(body.taskId)
    if (task.projectId !== body.projectId) throw refuse('Task input belongs to another Project')
    rt.requireProjectAccess(actor, task.projectId)
    const limit = body.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw refuse('Input page limit must be1–200')
    const all = Object.values(rt.state.projectTaskInputs ?? {}).filter(row => row.taskId === task.id && row.projectId === task.projectId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const index = body.after === undefined ? -1 : all.findIndex(row => row.id === body.after)
    if (body.after !== undefined && index < 0) throw refuse('Input cursor is outside this Task')
    const page = all.slice(index + 1, index + 1 + limit)
    return { inputs: page.map(row => { if (row.version === INPUT_PROTOCOL) verify(row); return { ...metadata(row, task), ...(row.version === INPUT_PROTOCOL ? { text: row.text } : {}) } }), next: index + 1 + page.length < all.length ? page.at(-1).id : null }
  }
  async function prepare(taskId, claim, { next = false } = {}) {
    writable()
    const task = taskOf(taskId); current(task, claim)
    if (Object.values(rt.state.projectTaskInputs ?? {}).some(row => row.projectId === task.projectId && row.taskId === task.id && row.version !== INPUT_PROTOCOL)) throw refuse('Task input protocol upgrade is required')
    const selected = pending(task).filter(row => row.kind !== 'handoff' || row.source.eventId === task.collaboration.currentHandoffId).filter(row => !next || !row.deliveries.some(d => d.claimId === claim.id && d.generation === claim.generation && (d.sentAt !== undefined || d.observedAt !== undefined))).slice(0, 2)
    const batchId = `input-batch-${digest([claim.id, claim.generation, selected.map(row => [row.id, row.sha256])])}`
    if (!selected.length) return { batchId, inputs: [], remaining: 0 }
    for (const row of selected) verify(row)
    for (const row of selected) if (!row.deliveries.some(d => d.batchId === batchId)) row.deliveries.push({ batchId, claimId: claim.id, botId: claim.botId, generation: claim.generation, acceptedAt: Date.now() })
    const token = rt.projectEffects.stage({ kind: 'input.inbox', key: batchId, projectId: task.projectId, taskId: task.id, payload: { batchId, claimId: claim.id, generation: claim.generation } })
    await rt.projectEffects.persist(token); current(task, claim)
    return { batchId, inputs: selected.map(({ id, kind, source, text, sha256 }) => ({ id, kind, source: clone(source), text, sha256 })), remaining: pending(task).filter(row => !selected.some(item => item.id === row.id) && (row.kind !== 'handoff' || row.source.eventId === task.collaboration.currentHandoffId) && !row.deliveries.some(d => d.claimId === claim.id && d.generation === claim.generation && (d.sentAt !== undefined || d.observedAt !== undefined))).length }
  }
  function deliveryRows(task, claim, batchId) {
    return Object.values(rt.state.projectTaskInputs ?? {}).filter(row => row.version === INPUT_PROTOCOL && row.projectId === task.projectId && row.taskId === task.id).map(row => ({ row, delivery: row.deliveries.find(d => d.batchId === batchId && d.claimId === claim.id && d.generation === claim.generation && d.botId === claim.botId) })).filter(pair => pair.delivery)
  }
  async function transport(taskId, claim, batchId, signal) {
    writable()
    const task = taskOf(taskId); current(task, claim)
    const selected = deliveryRows(task, claim, batchId)
    if (!selected.length) return false
    if (!['adapter-written', 'sdk-output'].includes(signal.kind) || typeof signal.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(signal.sha256)) throw refuse('Input transport needs exact host evidence')
    for (const { row, delivery } of selected) {
      verify(row)
      if (signal.kind === 'adapter-written') { delivery.sentAt ??= Date.now(); delivery.transportSha256 ??= signal.sha256 }
      else { delivery.observedAt ??= Date.now(); delivery.observation = { kind: signal.kind, sha256: signal.sha256 } }
    }
    await rt.save(); return true
  }
  function receiptError(task, claim, kind, field, message, correctable = true, manifest) {
    const batches = manifest ?? [...new Set(Object.values(rt.state.projectTaskInputs ?? {}).filter(row => row.taskId === task.id && row.projectId === task.projectId && row.version === INPUT_PROTOCOL).flatMap(row => row.deliveries.filter(d => d.claimId === claim?.id && d.generation === claim?.generation && d.botId === claim?.botId).map(d => d.batchId)))].slice(0, 8).map(batchId => ({ batchId, inputs: deliveryRows(task, claim, batchId).filter(({ row }) => ['accepted', 'handled'].includes(row.status) && authorized(row, task)).map(({ row }) => ({ id: row.id, sha256: row.sha256 })) }))
    return Object.assign(refuse(message), { receiptFeedback: { version: 'input-receipt-feedback/v1', kind, field, correctable, taskId: task.id, claimId: claim?.id ?? null, generation: claim?.generation ?? null, batches: correctable ? batches : [], sideEffects: 'receipt rejected before acknowledgement; no read/handled declaration applied' } })
  }
  function acknowledgementPlan(taskId, claim, receipts) {
    if (receipts === undefined) return []
    writable()
    const task = taskOf(taskId)
    try { current(task, claim) } catch { throw receiptError(task, claim, 'stale-claim', 'claim', 'Task input claim is stale', false) }
    const batches = Array.isArray(receipts) ? receipts : [receipts]
    if (!batches.length || batches.length > 8) throw receiptError(task, claim, 'schema', 'inputReceipts', 'Input acknowledgement needs one to eight injected batches')
    return batches.map(receipt => {
      if (!receipt || typeof receipt.batchId !== 'string' || !Array.isArray(receipt.read) || !Array.isArray(receipt.handled) || receipt.read.length > 2 || receipt.handled.length > 2) throw receiptError(task, claim, 'schema', 'inputReceipts', 'Input acknowledgement needs the injected batch and bounded read/handled IDs')
      const selected = deliveryRows(task, claim, receipt.batchId), allowed = new Map(selected.map(pair => [pair.row.id, pair]))
      if (!selected.length) {
        const historical = Object.values(rt.state.projectTaskInputs ?? {}).some(row => row.deliveries?.some(d => d.batchId === receipt.batchId))
        throw receiptError(task, claim, historical ? 'stale-or-foreign-batch' : 'unknown-batch', 'batchId', 'Input receipt is outside the current injected batch', !historical)
      }
      for (const id of [...receipt.read, ...receipt.handled]) if (typeof id !== 'string' || !allowed.has(id)) {
        const source = typeof id === 'string' && ownEntry(rt.state.projectTaskInputs ?? {}, id)
        throw receiptError(task, claim, source && (source.taskId !== task.id || source.projectId !== task.projectId) ? 'foreign-input' : 'uninjected-input', 'read/handled', 'Input receipt is outside the current injected batch', !source || source.taskId === task.id && source.projectId === task.projectId)
      }
      if (!receipt.handled.every(id => receipt.read.includes(id))) throw receiptError(task, claim, 'handled-not-read', 'handled', 'Input receipt is outside the current injected batch: handled must be a subset of read')
      if (receipt.read.some(id => !['accepted', 'handled'].includes(allowed.get(id).row.status) || !authorized(allowed.get(id).row, task))) throw receiptError(task, claim, 'source-revoked', 'read', 'Input was cancelled or source authority was revoked', false)
      for (const id of receipt.read) { try { verify(allowed.get(id).row) } catch { throw receiptError(task, claim, 'content-changed', 'sha256', 'Task input content changed after acceptance', false) } }
      return { receipt, allowed }
    })
  }
  async function acknowledge(taskId, claim, receipts) {
    const plans = acknowledgementPlan(taskId, claim, receipts)
    if (!plans.length) return
    const undo = [], task = taskOf(taskId)
    const change = (object, key, value) => { undo.push({ object, key, before: object[key], after: value }); object[key] = value }
    for (const { receipt, allowed } of plans) {
      for (const id of receipt.read) { const { delivery } = allowed.get(id); if (delivery.readAt === undefined) change(delivery, 'readAt', Date.now()); change(delivery, 'readProof', 'current-role-declaration') }
      for (const id of receipt.handled) { const { row, delivery } = allowed.get(id); change(row, 'status', 'handled'); if (delivery.handledAt === undefined) change(delivery, 'handledAt', Date.now()); change(delivery, 'handledProof', 'validated-current-role-decision') }
    }
    let token
    try {
      if (rt.projectEffects) {
        token = rt.projectEffects.stage({ kind: 'input.receipt', key: digest([claim.id, claim.generation, receipts]), projectId: task.projectId, taskId, payload: { claimId: claim.id, generation: claim.generation, receiptSha256: digest(receipts) } })
        await rt.projectEffects.persist(token)
      } else await rt.save()
    } catch (error) {
      if (!token || rt.projectEffects.discardUncommitted(token)) for (const item of undo.reverse()) if (item.object[item.key] === item.after) { if (item.before === undefined) delete item.object[item.key]; else item.object[item.key] = item.before }
      for (const { allowed } of plans) for (const { row } of allowed.values()) if (row.status === 'accepted' && row.sourceAuthorityRevoked) { row.status = 'cancelled'; row.cancellation = 'Source Project membership was revoked' }
      throw error
    }
  }
  async function prepareChief(snapshot, run) {
    writable()
    let budget = 8000
    for (const saved of snapshot) {
      const task = taskOf(saved.taskId)
      if (task.projectId !== run.projectId || ended(task) || (task.collaboration?.generation ?? 0) !== saved.generation) throw refuse('Chief inbox snapshot scope or generation changed')
      const selected = []
      for (const row of pending(task).filter(row => row.kind !== 'handoff')) {
        if (selected.length === 2) break
        if (row.text.length > budget) continue
        budget -= row.text.length; selected.push(row)
      }
      if (!selected.length) continue
      const batchId = `input-batch-${digest([run.id, task.id, saved.generation, selected.map(row => [row.id, row.sha256])])}`
      for (const row of selected) verify(row)
      for (const row of selected) if (!row.deliveries.some(d => d.batchId === batchId)) row.deliveries.push({ batchId, chiefRunId: run.id, botId: `${task.projectId}:chief`, generation: saved.generation, acceptedAt: Date.now() })
      const token = rt.projectEffects.stage({ kind: 'input.inbox', key: batchId, projectId: task.projectId, taskId: task.id, payload: { batchId, chiefRunId: run.id, generation: saved.generation } })
      await rt.projectEffects.persist(token)
      saved.taskInbox = { batchId, inputs: selected.map(({ id, kind, text, sha256 }) => ({ id, kind, text, sha256 })), remaining: pending(task).filter(row => row.kind !== 'handoff').length - selected.length }
    }
  }
  function chiefPlan(taskId, saved, run, receipts) {
    if (receipts === undefined) return null
    writable()
    const task = taskOf(taskId)
    if (ended(task) || run.projectId !== task.projectId || saved.taskId !== task.id || (task.collaboration?.generation ?? 0) !== saved.generation) throw receiptError(task, null, 'stale-snapshot', 'snapshot', 'Chief input receipt is outside its current snapshot', false)
    const feedback = (kind, field, message, correctable = true) => receiptError(task, null, kind, field, message, correctable, saved.taskInbox ? [{ batchId: saved.taskInbox.batchId, inputs: saved.taskInbox.inputs.map(({ id, sha256 }) => ({ id, sha256 })) }] : [])
    if (!saved.taskInbox || receipts?.batchId !== saved.taskInbox.batchId || !Array.isArray(receipts.read) || !Array.isArray(receipts.handled) || receipts.read.length > 2 || receipts.handled.length > 2) throw feedback('snapshot-schema', 'inputReceipts', 'Chief input receipt is outside its current snapshot')
    const manifest = new Map(saved.taskInbox.inputs.map(row => [row.id, row.sha256]))
    const selected = new Map(Object.values(rt.state.projectTaskInputs ?? {}).filter(row => row.projectId === task.projectId && row.taskId === task.id && manifest.get(row.id) === row.sha256 && ['accepted', 'handled'].includes(row.status) && authorized(row, task)).map(row => [row.id, { row, delivery: row.deliveries.find(d => d.batchId === receipts.batchId && d.chiefRunId === run.id && d.generation === saved.generation) }]).filter(([, pair]) => pair.delivery))
    for (const id of [...receipts.read, ...receipts.handled]) if (typeof id !== 'string' || !selected.has(id)) {
      const row = typeof id === 'string' && ownEntry(rt.state.projectTaskInputs ?? {}, id)
      const foreign = row && (row.taskId !== task.id || row.projectId !== task.projectId), revoked = row && (!authorized(row, task) || row.status === 'cancelled')
      throw feedback(foreign ? 'foreign-input' : revoked ? 'source-revoked' : 'uninjected-input', 'read/handled', 'Chief acknowledged an input outside its injected snapshot', !foreign && !revoked)
    }
    if (!receipts.handled.every(id => receipts.read.includes(id))) throw feedback('handled-not-read', 'handled', 'Chief acknowledged an input outside its injected snapshot: handled must be read')
    for (const id of receipts.read) { try { verify(selected.get(id).row) } catch { throw feedback('content-changed', 'sha256', 'Task input content changed after acceptance', false) } }
    return { taskId, projectId: task.projectId, generation: saved.generation, runId: run.id, receipts: clone(receipts), selected, committed: false }
  }
  function commitChiefPlan(plan) {
    if (!plan || plan.committed) return false
    for (const id of plan.receipts.read) {
      const { row, delivery } = plan.selected.get(id)
      if (!['accepted', 'handled'].includes(row.status) || !authorized(row, taskOf(plan.taskId))) throw refuse('Chief input source was cancelled or revoked')
      verify(row); delivery.readAt ??= Date.now(); delivery.readProof = 'current-chief-declaration'
    }
    for (const id of plan.receipts.handled) { const { row, delivery } = plan.selected.get(id); row.status = 'handled'; delivery.handledAt ??= Date.now(); delivery.handledProof = 'validated-chief-decision' }
    plan.committed = true
    return true
  }
  async function acknowledgeChief(taskId, saved, run, receipts) {
    const plan = chiefPlan(taskId, saved, run, receipts)
    if (commitChiefPlan(plan)) await rt.save()
  }
  function requireHandled(taskId, actor) {
    const task = taskOf(taskId)
    if (Object.values(rt.state.projectTaskInputs ?? {}).some(row => row.projectId === task.projectId && row.taskId === task.id && row.version !== INPUT_PROTOCOL)) throw refuse('Task input protocol upgrade is required')
    const permit = actor?.taskInputPermit && chiefPermits.get(actor.taskInputPermit)
    const allowed = permit && permit.taskId === taskId && permit.projectId === task.projectId && permit.generation === (task.collaboration?.generation ?? 0) && actor.chiefJobId === permit.runId ? new Set(permit.receipts.handled) : new Set()
    if (pending(task).some(row => row.kind !== 'handoff' && !allowed.has(row.id))) throw refuse('Task still has unhandled inputs; current role or Chief must acknowledge them before closure')
  }
  return { publish: (body, actor) => serial(() => publish(body, actor)), list, stageHandoff,
    stageRequirements(task, audit) {
      if (audit.executorRole !== 'chief' || audit.taskId !== task.id || audit.projectId !== task.projectId || !audit.runId) throw refuse('Scoped Chief requirements decision required')
      return stage(task, { kind: 'chief-decision', eventId: audit.id, revision: task.projectTask.requirements.revision }, JSON.stringify(task.projectTask.requirements), 'requirements-change')
    },
    discardRequirements(id) { const row = ownEntry(rows(), id); if (row?.source.kind === 'chief-decision' && !row.deliveries.length) delete rows()[id] },
    // Internal Source adapter only; public input.publish cannot set provenance.
    stageExternal(task, source, text) {
      if (source?.kind !== 'github' || !source.memberId || typeof text !== 'string' || !text.length || text.length > 4000 || ended(task)) throw refuse('Invalid active external Task input')
      return stage(task, source, text, 'external-feedback')
    },
    discardExternal(id) { const row = ownEntry(rows(), id); if (row?.source.kind === 'github' && !row.deliveries.length) delete rows()[id] },
    chiefActor(actor, taskId, saved, run, receipts) {
      const plan = chiefPlan(taskId, saved, run, receipts)
      if (!plan) return actor
      if (actor.chiefJobId !== run.id) throw refuse('Chief input permit belongs to another Run')
      const token = {}; chiefPermits.set(token, plan)
      return { ...actor, taskInputPermit: token }
    },
    commitChief(actor, { afterDecision = false } = {}) {
      const plan = actor?.taskInputPermit && chiefPermits.get(actor.taskInputPermit)
      if (!plan || plan.committed) return false
      if (!afterDecision) { if ((taskOf(plan.taskId).collaboration?.generation ?? 0) !== plan.generation) throw refuse('Chief input snapshot generation changed'); requireHandled(plan.taskId, actor) }
      return commitChiefPlan(plan)
    },
    releaseChief(actor) { if (actor?.taskInputPermit) chiefPermits.delete(actor.taskInputPermit) },
    finishChiefHandoff(taskId, handoffId, decisionId) {
      const task = taskOf(taskId)
      for (const row of pending(task).filter(row => row.kind === 'handoff' && row.source.eventId === handoffId)) { row.status = 'handled'; row.routingReceipt = { chiefDecisionId: decisionId, at: Date.now(), proof: 'validated-chief-routing-decision' } }
    },
    revokeSource(projectId, memberId) {
      for (const row of Object.values(rt.state.projectTaskInputs ?? {})) if (row.projectId === projectId && ['human', 'github'].includes(row.source.kind) && row.source.memberId === memberId) { row.sourceAuthorityRevoked = true; if (row.status === 'accepted') { row.status = 'cancelled'; row.cancelledAt = Date.now(); row.cancellation = 'Source Project membership was revoked' } }
    },
    finishHandoff(taskId, claim) {
      const task = taskOf(taskId); current(task, claim)
      for (const row of pending(task).filter(row => row.kind === 'handoff' && row.source.eventId === task.collaboration.currentHandoffId)) { row.status = 'handled'; row.routingReceipt = { claimId: claim.id, generation: claim.generation, at: Date.now(), proof: 'validated-role-routing-decision' } }
    },
    discardHandoff(id) { const row = ownEntry(rows(), id); if (row?.kind === 'handoff' && !row.deliveries.length) delete rows()[id] },
    prepare: (taskId, claim, options) => serial(() => prepare(taskId, claim, options)), transport: (taskId, claim, batch, signal) => serial(() => transport(taskId, claim, batch, signal)),
    validateReceipt: (taskId, claim, receipts) => serial(() => { acknowledgementPlan(taskId, claim, receipts); return true }),
    validateChiefReceipt: chiefPlan,
    acknowledge: (taskId, claim, receipts) => serial(() => acknowledge(taskId, claim, receipts)),
    prepareChief: (snapshot, run) => serial(() => prepareChief(snapshot, run)), acknowledgeChief: (taskId, saved, run, receipts) => serial(() => acknowledgeChief(taskId, saved, run, receipts)), requireHandled,
    pending(taskId) { return pending(taskOf(taskId)).filter(row => row.kind !== 'handoff').map(row => metadata(row, taskOf(taskId))) } }
}
export function install(rt) {
  rt.projectInputs = createProjectInputs(rt)
  rt.projectEffects.register('input.receipt', { run: row => ({ ...row.payload, status: 'declared' }) })
  rt.projectEffects.register('input.inbox', { run: row => ({ batchId: row.payload.batchId, status: 'durable-inbox' }) })
  rt.projectEffects.register('input.notify', {
    async validate(row) {
      const task = ownEntry(rt.state.tasks, row.taskId), input = ownEntry(rt.state.projectTaskInputs ?? {}, row.payload.inputId)
      if (!task || task.projectId !== row.projectId || !input || input.taskId !== task.id || input.projectId !== task.projectId || ended(task) || input.status !== 'accepted') throw new EffectCancelled('Task input ended or changed')
      try { rt.requireProjectAccess({ memberId: row.payload.initiatedBy }, row.projectId, 'task-write', task) } catch { throw new EffectCancelled('Input source Project authority was revoked') }
      await rt.projectDelegations?.background(row.payload.initiatedBy)
    },
    async run(row) {
      const task = rt.state.tasks[row.taskId]
      const wake = await rt.projectHarness?.taskInputWake?.(task.id)
      if (wake?.woken) return { inputId: row.payload.inputId, batchId: wake.batchId, status: 'safe-idle-turn' }
      if (task.chiefQuestion || ['blocked', 'arbitration', 'chief-working'].includes(task.collaboration?.status) || wake?.waitingFor === 'safe-turn-budget') {
        if (!rt.state.projectChiefPolicies?.[task.projectId]?.enabled) throw new EffectDeferred('Chief recovery is not configured', { waitingFor: 'configuration' })
        const run = await rt.projectChiefControl.request(task.projectId, 'inspection', { blockedTaskId: task.id, requestId: row.payload.inputId, reason: 'Task input awaits current responsibility' })
        return { inputId: row.payload.inputId, chiefRunId: run.id, status: 'chief-notified' }
      }
      return { inputId: row.payload.inputId, status: 'queued-for-safe-boundary', waitingFor: wake?.waitingFor ?? 'safe-turn' }
    },
  })
}
