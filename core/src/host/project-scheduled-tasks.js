// Logical targets reuse the original DSH Schedule store and clock. No business-specific timer.
import { randomUUID, createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CLOCK_KINDS } from './time-context.js'
import { textOf } from './text.js'
import { ownEntry, setEntry } from './store.js'
const refuse = message => Object.assign(new Error(message), { code: 'bot/scheduled-task' })
export function reminderEntries(text) {
  try {
    const batch = /^reminders_json: (.*)$/m.exec(text)
    if (batch) return JSON.parse(batch[1])
    const id = /^schedule_id_json: (.*)$/m.exec(text), at = /^occurrence_at: (.*)$/m.exec(text), prompt = /^reminder_prompt_json: (.*)$/m.exec(text)
    return id && at && prompt ? [{ schedule_id: JSON.parse(id[1]), occurrence_at: at[1], reminder_prompt: JSON.parse(prompt[1]) }] : []
  } catch { return [] }
}
export function createProjectScheduledTasks(rt) {
  const handlers = new Map(), rows = () => (rt.state.projectScheduledTasks ??= {})
  let tail = Promise.resolve()
  const serial = fn => { const result = tail.then(fn, fn); tail = result.catch(() => {}); return result }
  const backend = () => { if (!rt.logicalScheduleBackend) throw refuse('Original scheduled-task service is unavailable'); return rt.logicalScheduleBackend }
  function handler(target) { const value = handlers.get(target?.kind); if (!value) throw refuse('Logical scheduled target is unavailable'); return value }
  async function reconcile(row) {
    if (row.status === 'deleted') return
    const before = JSON.stringify([row.scheduleId, row.sessionId, row.knownSessions, row.status, row.enabled, row.config, row.revision, row.intent])
    const actor = { memberId: row.createdBy }
    rt.requireProjectAccess(actor, row.projectId, 'configure')
    const target = await handler(row.target).resolve(row.target, actor)
    const sessionId = rt.chatOf(target.botId)
    if (!row.scheduleId && row.enabled) {
      const catalog = await backend().catalog()
      const candidates = row.intent ? catalog.filter(item => !row.intent.existingIds.includes(item.id) && item.sessionId === sessionId && item.title === row.config.title && item.prompt === row.config.prompt) : []
      if (candidates.length > 1) throw refuse('Ambiguous interrupted scheduled-task creation; reconcile its original records')
      const record = candidates[0] ?? await backend().create({ target: target.botId, ...row.config })
      row.scheduleId = record.id
    } else if (row.scheduleId && row.sessionId !== sessionId) await backend().retarget(row.scheduleId, sessionId)
    if (row.scheduleId) {
      const catalog = await backend().catalog()
      const native = catalog.find(item => item.id === row.scheduleId), held = rt.state.pausedSchedules?.[row.scheduleId]
      if (!native && !held) throw refuse('Original scheduled task is missing; reconcile or delete its logical binding')
      const actual = native ?? held.record
      if (actual.prompt !== row.config.prompt || actual.title !== row.config.title) { row.config.prompt = actual.prompt; row.config.title = actual.title; ++row.revision }
      if (actual.kind === 'every') row.config.when = { kind: 'every', seconds: actual.everySeconds }
      if (actual.kind === 'daily') row.config.when = { kind: 'daily', time: actual.time.slice(0, 5), timeZone: actual.timeZone }
      if (actual.kind === 'weekly') row.config.when = { kind: 'weekly', time: actual.time.slice(0, 5), timeZone: actual.timeZone, weekdays: actual.weekdays }
      if (actual.kind === 'at' || actual.kind === 'after') row.config.when = { kind: 'at', at: actual.scheduledAt }
      if (held) row.enabled = false
      else row.enabled = native.status === 'active'
    }
    row.sessionId = sessionId; row.knownSessions = [...new Set([...(row.knownSessions ?? []), sessionId])]; row.status = row.enabled ? 'active' : 'paused'; delete row.intent
    if (before !== JSON.stringify([row.scheduleId, row.sessionId, row.knownSessions, row.status, row.enabled, row.config, row.revision, row.intent])) await rt.save()
  }
  async function save(body, actor) {
    const projectId = String(body.projectId ?? '')
    rt.requireProjectAccess(actor, projectId, 'configure')
    const prior = body.id ? ownEntry(rows(), body.id) : null
    if (body.id && (!prior || prior.projectId !== projectId || prior.status === 'deleted')) throw refuse('Unknown Project scheduled task')
    const target = prior?.target ?? { ...body.target, projectId }
    handler(target)
    if (prior && body.rebindAuthority === true) { (prior.authorityHistory ??= []).push({ memberId: prior.createdBy, at: Date.now() }); prior.createdBy = actor.memberId }
    if (prior?.scheduleId) await reconcile(prior)
    const config = { title: String(body.title ?? prior?.config.title ?? '').trim(), prompt: String(body.prompt ?? prior?.config.prompt ?? '').trim(), when: structuredClone(body.when ?? prior?.config.when) }
    if (Array.from(config.title).length > 120 || !config.title || !config.prompt || !config.when || config.prompt.length > 16000) throw refuse('Scheduled task needs a bounded title, prompt and timing configuration')
    const row = prior ?? { id: `logical-schedule-${randomUUID()}`, projectId, target, createdBy: actor.memberId, revision: 0, deliveries: {}, createdAt: Date.now() }
    const enabled = body.enabled ?? prior?.enabled ?? true
    if (typeof enabled !== 'boolean') throw refuse('Scheduled-task enabled must be boolean')
    if (prior?.scheduleId) {
      const resolved = await handler(target).resolve(target, actor)
      await backend().update({ sessionId: prior.sessionId, id: prior.scheduleId, target: resolved.botId, ...config }, actor)
      if (prior.enabled && !enabled) await backend().pause({ sessionId: prior.sessionId, id: prior.scheduleId })
      else if (!prior.enabled && enabled) { const record = await backend().resume({ sessionId: prior.sessionId, id: prior.scheduleId }); row.scheduleId = record.id }
    }
    row.config = config; row.enabled = enabled; ++row.revision; row.updatedBy = actor.memberId; row.updatedAt = Date.now()
    setEntry(rows(), row.id, row)
    if (!row.scheduleId && enabled) {
      row.intent = { at: Date.now(), existingIds: (await backend().catalog()).map(item => item.id) }
      await rt.save()
      await reconcile(row)
    } else { row.status = enabled ? 'active' : 'paused'; await rt.save() }
    return structuredClone(row)
  }
  async function accept(sessionId, entries) {
    const unmanaged = []
    for (const entry of entries) {
      const row = Object.values(rows()).find(row => row.scheduleId === entry.schedule_id)
      if (!row) { unmanaged.push(entry); continue }
      if (!row.knownSessions?.includes(sessionId) || !row.enabled || row.status === 'deleted' || entry.reminder_prompt !== row.config.prompt || !Number.isFinite(Date.parse(entry.occurrence_at))) continue
      const key = createHash('sha256').update(`${row.scheduleId}\n${new Date(entry.occurrence_at).toISOString()}`).digest('hex')
      if (ownEntry(row.deliveries, key)) continue
      setEntry(row.deliveries, key, { id: key, occurrenceAt: entry.occurrence_at, scheduleId: row.scheduleId, revision: row.revision, status: 'queued', at: Date.now() })
      await rt.save()
    }
    return unmanaged
  }
  async function pump() {
    for (const row of Object.values(rows())) {
      const targetHandler = handler(row.target)
      if (targetHandler.status) for (const delivery of Object.values(row.deliveries).filter(item => item.status !== 'queued' && item.status !== 'completed')) {
        const outcome = targetHandler.status({ row, delivery })
        if (!outcome) continue
        if (delivery.status !== outcome.status) { (delivery.transitions ??= []).push({ from: delivery.status, to: outcome.status, at: Date.now() }); delivery.transitions = delivery.transitions.slice(-8) }
        Object.assign(delivery, outcome)
        if (outcome.status !== 'running') delivery.finishedAt ??= Date.now()
        else delete delivery.finishedAt
        await rt.save()
      }
      if (!row.enabled || row.status === 'deleted') continue
      try { await reconcile(row) } catch (error) { row.error = error.message; await rt.save(); continue }
      for (const delivery of Object.values(row.deliveries).filter(item => item.status === 'queued')) {
        const actor = { memberId: row.createdBy }
        try {
          rt.requireProjectAccess(actor, row.projectId, 'configure')
          await rt.projectDelegations?.background(actor.memberId)
          delivery.status = 'running'; delivery.startedAt = Date.now(); delivery.generation = (delivery.generation ?? 0) + 1; const generation = delivery.generation; await rt.save()
          void Promise.resolve(handler(row.target).run({ row: structuredClone(row), delivery: structuredClone(delivery), actor })).then(async reference => {
            if (delivery.generation !== generation || delivery.status !== 'running') return
            if (reference?.runId && handler(row.target).status) {
              delivery.runId = reference.runId
              const outcome = handler(row.target).status({ row, delivery })
              if (outcome) Object.assign(delivery, outcome)
              if (delivery.status !== 'running') delivery.finishedAt = Date.now()
            } else { delivery.status = 'completed'; delivery.finishedAt = Date.now() }
            await rt.save()
          }, async error => {
            if (delivery.generation !== generation || delivery.status !== 'running') return
            delivery.status = 'failed'; delivery.error = String(error.message).slice(0, 1000); delivery.finishedAt = Date.now(); await rt.save()
          }).catch(error => rt.warn('Scheduled-task result save failed: %s', error.message))
        } catch (error) { delivery.status = 'failed'; delivery.error = String(error.message).slice(0, 1000); delivery.finishedAt = Date.now() }
        await rt.save()
      }
    }
  }
  async function endpoint(body, actor) {
    rt.requireProjectAccess(actor, body.projectId, 'configure')
    if (body.operation === 'save') return save(body, actor)
    if (body.operation === 'delete') {
      const row = ownEntry(rows(), body.id)
      if (!row || row.projectId !== body.projectId) throw refuse('Unknown Project scheduled task')
      if (row.scheduleId) await backend().delete({ sessionId: row.sessionId, id: row.scheduleId })
      row.enabled = false; row.status = 'deleted'; await rt.save()
    }
    return { tasks: Object.values(rows()).filter(row => row.projectId === body.projectId && row.status !== 'deleted').map(row => structuredClone(row)) }
  }
  function recover() {
    let changed = false
    for (const row of Object.values(rows())) for (const delivery of Object.values(row.deliveries)) if (delivery.status === 'running') { delivery.status = 'interrupted'; delivery.error = 'Host restarted during logical scheduled-task execution'; changed = true }
    return changed
  }
  return { register(kind, value) { handlers.set(kind, value) }, endpoint: (body, actor) => serial(() => endpoint(body, actor)), save: (body, actor) => serial(() => save(body, actor)),
    accept: (id, entries) => serial(() => accept(id, entries)), pump: () => serial(pump), recover,
    ownsSession: (sessionId, actor) => Object.values(rows()).some(row => { if (!row.knownSessions?.includes(sessionId)) return false; try { rt.requireProjectAccess(actor, row.projectId, 'configure'); return true } catch { return false } }) }
}
export function install(rt) {
  rt.projectScheduledTasks = createProjectScheduledTasks(rt)
  rt.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const kept = []; let intercepted = false
    for (const message of decision.messages) {
      const entries = message.source?.kind === 'schedule' ? reminderEntries(textOf(message.content)) : []
      if (!entries.length) { kept.push(message); continue }
      const remaining = await rt.projectScheduledTasks.accept(payload.agent.id, entries)
      if (remaining.length === entries.length) kept.push(message)
      else { intercepted = true }
      if (remaining.length && remaining.length !== entries.length) kept.push(createUserMessage({ content: [{ type: 'text', text: `[SCHEDULE REMINDER BATCH]\nreminders_json: ${JSON.stringify(remaining)}` }], source: message.source }))
    }
    if (intercepted && !kept.some(message => !CLOCK_KINDS.includes(message.source?.kind))) return { kind: 'reject' }
    return { ...decision, messages: kept }
  })
}
