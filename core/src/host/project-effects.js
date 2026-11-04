// Persist intent with Project state, then execute through registered host adapters.
import { createHash } from 'node:crypto'
import { commandEffectVisible } from './project-command-receipts.js'
import { ownEntry, setEntry } from './store.js'

export const EFFECT_PROTOCOL = 'project-effect/v1'
export class EffectDeferred extends Error {
  constructor(message, { waitingFor = 'resource', retryAfterMs } = {}) { super(message); this.waitingFor = waitingFor; if (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 100 || retryAfterMs > 86400000)) throw new Error('Invalid deferred-effect retry interval'); this.retryAfterMs = retryAfterMs }
}
export class EffectCancelled extends Error {}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = message => Object.assign(new Error(message), { code: 'bot/effect' })
const stamp = row => `${row.generation}:${row.revision}`
const copy = value => structuredClone(value)

export function createProjectEffects(rt, { now = Date.now } = {}) {
  const handlers = new Map(), durable = new Map(), staged = new Set(), originals = new Map(), inline = new Set(), running = new Map()
  let draining = null, again = false, closed = false, recovered = false
  const rows = () => (rt.state.projectEffects ??= {})
  const retrySettings = kind => {
    const retry = { maxFailures: 6, baseDelayMs: 1000, maxDelayMs: 60000, ...rt.config?.projectEffectRetry?.[kind] }
    if (![retry.maxFailures, retry.baseDelayMs, retry.maxDelayMs].every(Number.isSafeInteger) || retry.maxFailures < 1 || retry.maxFailures > 100 || retry.baseDelayMs < 100 || retry.maxDelayMs < retry.baseDelayMs || retry.maxDelayMs > 86400000) throw fail('Invalid effect retry configuration')
    return retry
  }
  const current = token => {
    const row = ownEntry(rt.state.projectEffects ?? {}, token.id)
    return row?.generation === token.generation ? row : null
  }
  function stage({ kind, key, projectId, taskId = null, payload, replace = false }) {
    if (closed || rt.readOnly?.() !== undefined) throw fail('Effect store is not writable')
    retrySettings(kind)
    if (!handlers.has(kind) || typeof key !== 'string' || !key || key.length > 300 || typeof projectId !== 'string' || !projectId) throw fail('Invalid effect intent')
    const id = `effect-${digest([projectId, kind, key])}`, previous = ownEntry(rows(), id)
    if (previous && previous.version !== EFFECT_PROTOCOL) throw fail('Effect protocol upgrade is required')
    const intentSha256 = digest({ projectId, taskId, payload })
    if (previous?.intentSha256 === intentSha256) return { id, generation: previous.generation }
    if (previous && !replace) throw fail('Effect idempotency key was reused with different content')
    const history = previous ? [...(previous.history ?? []), { generation: previous.generation, intentSha256: previous.intentSha256, status: previous.status, receipt: previous.receipt ?? null, at: now() }] : []
    const row = { id, version: EFFECT_PROTOCOL, kind, key, projectId, taskId, payload: copy(payload), intentSha256,
      generation: (previous?.generation ?? 0) + 1, revision: 1, status: 'pending', failures: 0, executions: 0, dueAt: now(), createdAt: previous?.createdAt ?? now(), updatedAt: now(), history }
    if (!originals.has(id)) originals.set(id, previous)
    setEntry(rows(), id, row); staged.add(id)
    return { id, generation: row.generation }
  }
  // store.js captures these alongside its JSON snapshot and acknowledges only
  // after rename. A successful no-op/read-only save cannot activate an effect.
  const capture = () => Object.values(rt.state.projectEffects ?? {}).map(row => ({ id: row.id, generation: row.generation, revision: row.revision }))
  function saved(snapshot = []) {
    for (const token of snapshot) {
      const row = current(token)
      if (!row || token.revision > row.revision) continue
      const proof = durable.get(row.id), savedRevision = proof?.startsWith(`${row.generation}:`) ? Number(proof.split(':')[1]) : 0
      durable.set(row.id, `${row.generation}:${Math.max(savedRevision, token.revision)}`)
      staged.delete(row.id); originals.delete(row.id)
    }
  }
  async function persist(token) {
    for (let pass = 0; pass < 4; pass++) {
      const row = current(token)
      if (!row) throw fail('Effect generation changed before commit')
      const expected = stamp(row)
      try { await rt.save() }
      catch (error) { if (durable.get(row.id) !== expected) throw error /* A failed journal after rename is still a committed state snapshot. */ }
      if (current(token) !== row) throw fail('Effect generation changed during commit')
      if (durable.get(row.id) === stamp(row)) return copy(row)
      if (!durable.get(row.id)?.startsWith(`${row.generation}:`)) throw fail('Effect state commit was not confirmed')
    }
    throw fail('Effect changed repeatedly during commit; retry reconciliation')
  }
  function discardUncommitted(token) {
    const row = current(token)
    if (row && !durable.get(row.id)?.startsWith(`${row.generation}:`)) {
      const previous = originals.get(row.id)
      if (previous) {
        setEntry(rows(), row.id, previous)
        if (previous.status === 'running' && !running.has(row.id)) { change(previous, 'pending'); previous.dueAt = now() }
      } else delete rows()[row.id]
      originals.delete(row.id); staged.delete(row.id); return true
    }
    return false
  }
  function change(row, status) { row.status = status; row.updatedAt = now(); ++row.revision; return { id: row.id, generation: row.generation } }
  async function execute(token, isInline = false, transient) {
    if (running.has(token.id)) return running.get(token.id)
    const row = current(token)
    if (!row || row.version !== EFFECT_PROTOCOL || row.status !== 'pending' || staged.has(row.id) || durable.get(row.id) !== stamp(row)) return null
    const operation = (async () => {
      ++row.executions
      change(row, 'running')
      try { await persist(token) }
      catch (error) { change(row, 'pending'); row.dueAt = now() + 1000; throw error }
      const assertCurrent = () => { if (current(token) !== row || row.status !== 'running') throw new EffectCancelled('Effect was superseded') }
      let receipt, failure
      try {
        assertCurrent()
        const handler = handlers.get(row.kind)
        if (!handler) throw new EffectDeferred('Effect adapter is unavailable', { waitingFor: 'configuration' })
        const context = { assertCurrent, inline: isInline, actor: transient?.actor }
        await handler.validate?.(copy(row), context)
        assertCurrent()
        receipt = await handler.run(copy(row), context)
      } catch (error) { failure = error }
      if (current(token) !== row) {
        const replacement = ownEntry(rows(), token.id)
        const previous = replacement?.history.find(item => item.generation === token.generation)
        if (previous) {
          previous.lateReceipt = receipt ?? null; previous.lateError = failure ? 'Superseded execution did not complete' : null; ++replacement.revision
          if (durable.get(replacement.id)?.startsWith(`${replacement.generation}:`)) await persist({ id: replacement.id, generation: replacement.generation })
        }
        return null
      }
      if (!failure) { row.receipt = copy(receipt ?? {}); row.completedAt = now(); delete row.error; delete row.waitingFor; change(row, 'done') }
      else {
        row.error = failure instanceof EffectDeferred || failure instanceof EffectCancelled ? String(failure.message).slice(0, 500) : 'Effect adapter failed; inspect scoped execution evidence'
        row.waitingFor = failure instanceof EffectDeferred ? failure.waitingFor : null
        if (failure instanceof EffectCancelled) change(row, 'cancelled')
        else {
          if (!(failure instanceof EffectDeferred)) ++row.failures
          const retry = retrySettings(row.kind)
          row.dueAt = now() + (failure instanceof EffectDeferred ? failure.retryAfterMs ?? retry.baseDelayMs : Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** Math.min(row.failures, 20)))
          change(row, row.failures >= retry.maxFailures ? 'failed' : 'pending')
        }
      }
      await persist(token)
      if (failure && isInline) throw failure
      return copy(row)
    })()
    running.set(token.id, operation)
    try { return await operation } finally { if (running.get(token.id) === operation) running.delete(token.id) }
  }
  async function perform(spec, transient) {
    const token = stage(spec)
    inline.add(token.id)
    try {
      await persist(token)
      const row = current(token)
      if (!row) throw fail('Effect was superseded during commit')
      if (row.status === 'done') return copy(row.receipt)
      if (row.status === 'running' && running.has(row.id)) {
        const result = await running.get(row.id)
        if (result?.status === 'done') return copy(result.receipt)
        throw fail('Effect is still waiting for reconciliation')
      }
      if (row.status !== 'pending') throw fail('Effect needs reconciliation before replay')
      const result = await execute(token, true, transient)
      if (!result || result.status !== 'done') throw fail('Effect was superseded before completion')
      return result.receipt
    } finally { inline.delete(token.id) }
  }
  function recover() {
    if (recovered || rt.readOnly?.() !== undefined) return false
    recovered = true
    let changed = false
    for (const row of Object.values(rt.state.projectEffects ?? {})) {
      if (staged.has(row.id) || row.version !== EFFECT_PROTOCOL) continue
      durable.set(row.id, stamp(row))
      if (row.status === 'running') { change(row, 'pending'); row.dueAt = now(); row.recoveredAt = now(); staged.add(row.id); changed = true }
    }
    return changed
  }
  function drain() {
    again = true
    if (draining) return draining
    draining = (async () => {
      do {
        again = false
        if (closed || rt.readOnly?.() !== undefined) return
        // Retry only revisions of an already committed generation. Never commit
        // a caller's new, unconfirmed business intent on its behalf.
        for (const row of Object.values(rt.state.projectEffects ?? {})) {
          const proof = durable.get(row.id)
          if (proof && proof !== stamp(row) && proof.startsWith(`${row.generation}:`)) await persist({ id: row.id, generation: row.generation })
        }
        const due = Object.values(rt.state.projectEffects ?? {}).filter(row => row.version === EFFECT_PROTOCOL && row.status === 'pending' && row.dueAt <= now() && !staged.has(row.id) && !inline.has(row.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        for (let index = 0; index < due.length; index += 2) {
          if (closed) return
          const batch = await Promise.allSettled(due.slice(index, index + 2).map(row => execute({ id: row.id, generation: row.generation })))
          const rejected = batch.find(result => result.status === 'rejected')
          if (rejected) throw rejected.reason
        }
      } while (again)
    })().finally(() => { draining = null })
    return draining
  }
  function list(projectId, actor, { taskId, limit = 50 } = {}) {
    rt.requireProjectAccess(actor, projectId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail('Effect page limit must be between 1 and 200')
    return Object.values(rt.state.projectEffects ?? {}).filter(row => row.projectId === projectId && commandEffectVisible(rt.state, row, actor) && (!taskId || row.taskId === taskId)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit)
      .map(({ payload: _payload, history: _history, key: _key, ...row }) => ({ ...copy(row), committed: durable.get(row.id) === stamp(row) }))
  }
  async function retry(body, actor) {
    const row = ownEntry(rt.state.projectEffects ?? {}, body.effectId)
    if (!row || row.projectId !== body.projectId) throw fail('Effect is unavailable in this Project')
    rt.requireProjectAccess(actor, row.projectId, 'configure')
    if (!commandEffectVisible(rt.state, row, actor)) throw fail('Effect is private to another command principal')
    if (rt.readOnly?.() !== undefined || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId ?? '')) throw fail('Effect retry needs a writable host and stable requestId')
    if (row.version !== EFFECT_PROTOCOL) throw fail('Effect protocol upgrade is required')
    const prior = row.retries?.find(item => item.requestId === body.requestId)
    if (prior) {
      if (prior.by !== actor.memberId) throw fail('Retry requestId belongs to another actor')
      return { effectId: row.id, status: row.status, already: true }
    }
    if (row.status !== 'failed') throw fail('Only exhausted effects may be retried')
    ;(row.retries ??= []).push({ requestId: body.requestId, by: actor.memberId, at: now(), failures: row.failures })
    row.failures = 0; row.dueAt = now(); change(row, 'pending')
    await persist({ id: row.id, generation: row.generation }); rt.projectScheduler?.wake()
    return { effectId: row.id, status: row.status }
  }
  return { stage, persist, capture, saved, discardUncommitted, perform, recover, drain, list, retry,
    intentCommitted(token) { if (!token?.id) return false; const row = current(token); return Boolean(row?.version === EFFECT_PROTOCOL && durable.get(row.id)?.startsWith(`${row.generation}:`)) },
    register(kind, handler, { replace = false } = {}) {
      if (handlers.has(kind) && !replace) throw fail('Effect adapter is already registered')
      if (replace && Object.values(rt.state.projectEffects ?? {}).some(row => row.kind === kind && running.has(row.id))) throw fail('Effect adapter is executing; defer replacement')
      handlers.set(kind, handler)
    },
    async close() { closed = true; await Promise.allSettled([...running.values()]) } }
}

export function install(rt) {
  rt.projectEffects = createProjectEffects(rt)
  rt.ctx.effect(() => () => rt.projectEffects.close(), 'ds-bot: Project effects')
}
