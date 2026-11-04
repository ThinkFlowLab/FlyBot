import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectScheduledTasks, reminderEntries } from '../src/host/project-scheduled-tasks.js'
function setup() {
  const native = new Map(), calls = [], runs = []
  let sequence = 0, carrier = 'chief-old'
  const rt = { state: { pausedSchedules: {} }, save: async () => {}, chatOf: id => id, warn() {}, projectCan: actor => actor.memberId === 'owner', requireProjectAccess(actor, id) { if (actor.memberId !== 'owner' || id !== 'p') throw new Error('Project denied') } }
  rt.logicalScheduleBackend = {
    catalog: async () => [...native.values()],
    create: async body => { const row = { id: 'native-' + ++sequence, sessionId: body.target, title: body.title, prompt: body.prompt, status: 'active', kind: 'every', everySeconds: body.when.seconds }; native.set(row.id, row); calls.push(['create', row.id]); return row },
    update: async body => { const row = native.get(body.id) ?? rt.state.pausedSchedules[body.id].record; Object.assign(row, { title: body.title, prompt: body.prompt, everySeconds: body.when.seconds }) },
    pause: async body => { rt.state.pausedSchedules[body.id] = { sessionId: body.sessionId, record: native.get(body.id) }; native.delete(body.id) },
    resume: async body => { const old = rt.state.pausedSchedules[body.id]; const row = { ...old.record, id: 'native-' + ++sequence, sessionId: body.sessionId, status: 'active' }; native.set(row.id, row); delete rt.state.pausedSchedules[body.id]; return row },
    retarget: async (id, sessionId) => { const held = rt.state.pausedSchedules[id]; if (held) held.sessionId = sessionId; else native.get(id).sessionId = sessionId },
    delete: async body => { native.delete(body.id); delete rt.state.pausedSchedules[body.id] },
  }
  const service = createProjectScheduledTasks(rt)
  service.register('role', { resolve: async () => ({ botId: carrier }), run: async work => runs.push(work) })
  return { rt, native, service, calls, runs, replace() { carrier = 'chief-new' }, save: body => service.save({ projectId: 'p', target: { kind: 'role', role: 'chief' }, title: 'Inspection', prompt: 'Inspect real evidence', when: { kind: 'every', seconds: 1800 }, ...body }, { memberId: 'owner' }) }
}
test('logical schedules reuse original records and editable cadence/content, pause/resume, and carrier replacement', async () => {
  const f = setup(), created = await f.save({})
  assert.equal(f.native.size, 1); assert.equal([...f.native.values()][0].everySeconds, 1800)
  await f.save({ id: created.id, when: { kind: 'every', seconds: 60 }, prompt: 'Check long execution' })
  assert.equal([...f.native.values()][0].everySeconds, 60)
  await f.save({ id: created.id, enabled: false, when: { kind: 'every', seconds: 60 }, prompt: 'Check long execution' })
  assert.equal(f.native.size, 0)
  f.replace()
  const resumed = await f.save({ id: created.id, enabled: true, when: { kind: 'every', seconds: 60 }, prompt: 'Check long execution' })
  assert.equal(f.native.size, 1); assert.notEqual(resumed.scheduleId, created.scheduleId)
  assert.equal([...f.native.values()][0].sessionId, 'chief-new')
  assert.equal(resumed.target.role, 'chief')
  assert.equal(resumed.id, created.id)
})
test('actual reminder envelopes queue one logical delivery and preserve unmanaged reminders', async () => {
  const f = setup(), row = await f.save({})
  const entries = reminderEntries('reminders_json: ' + JSON.stringify([{ schedule_id: row.scheduleId, occurrence_at: '2026-11-01T00:00:00Z', reminder_prompt: row.config.prompt }, { schedule_id: 'other', occurrence_at: '2026-11-01T00:00:00Z', reminder_prompt: 'Unmanaged' }]))
  assert.equal((await f.service.accept('chief-old', entries)).length, 1)
  await f.service.accept('chief-old', entries)
  await f.service.pump()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.runs.length, 1)
  assert.equal(Object.values(f.rt.state.projectScheduledTasks[row.id].deliveries)[0].status, 'completed')
  assert.equal((await f.service.accept('foreign-session', entries)).length, 1)
  await assert.rejects(f.service.endpoint({ projectId: 'p', operation: 'save' }, { memberId: 'other' }), /denied/)
})
test('restart preserves logical bindings and does not rerun an interrupted occurrence as successful', async () => {
  const f = setup(), row = await f.save({})
  f.rt.state.projectScheduledTasks[row.id].deliveries.old = { status: 'running' }
  const restored = createProjectScheduledTasks(f.rt)
  assert.equal(restored.recover(), true)
  assert.equal(f.rt.state.projectScheduledTasks[row.id].deliveries.old.status, 'interrupted')
  assert.equal(f.native.size, 1)
})

test('managed scheduled reminders do not fall through to a native model turn containing only a clock message', async () => {
  const { install } = await import('../src/host/project-scheduled-tasks.js')
  const f = setup(); let hook
  f.rt.ctx = { on: (_name, callback) => { hook = callback } }
  install(f.rt)
  f.rt.projectScheduledTasks.register('role', { resolve: async () => ({ botId: 'chief-old' }), run: async () => {} })
  const row = await f.rt.projectScheduledTasks.save({ projectId: 'p', target: { kind: 'role', role: 'chief' }, title: 'Inspection', prompt: 'Inspect real evidence', when: { kind: 'every', seconds: 1800 } }, { memberId: 'owner' })
  const scheduled = { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'reminders_json: ' + JSON.stringify([{ schedule_id: row.scheduleId, occurrence_at: '2026-11-01T01:00:00Z', reminder_prompt: row.config.prompt }]) }] }
  const clock = { source: { kind: 'ds-bot-time-context' }, content: [{ type: 'text', text: 'Current time' }] }
  const result = await hook({ agent: { id: 'chief-old' } }, async () => ({ kind: 'enter', messages: [scheduled, clock] }))
  assert.equal(result.kind, 'reject')
  assert.equal(Object.values(f.rt.state.projectScheduledTasks[row.id].deliveries).length, 1)
})

test('ordinary native tool continuation with no new inbox messages remains admitted', async () => {
  const { install } = await import('../src/host/project-scheduled-tasks.js')
  const f = setup(); let hook
  f.rt.ctx = { on: (_name, callback) => { hook = callback } }
  install(f.rt)
  const decision = { kind: 'enter', messages: [] }
  const result = await hook({ agent: { id: 'ordinary-worker' } }, async () => decision)
  assert.equal(result.kind, 'enter', 'No managed reminder was consumed, so the native continuation must run')
  assert.deepEqual(result.messages, [])
})

test('Chief deliveries reconcile persisted terminal/recovery states after restart without replaying the occurrence', async () => {
  const f = setup(), row = await f.save({})
  let outcome = { runId: 'durable-chief', status: 'running', error: null }, dispatched = 0
  f.service.register('role', { resolve: async () => ({ botId: 'chief-old' }), run: async () => { ++dispatched; return { runId: 'durable-chief' } }, status: () => outcome })
  await f.service.accept('chief-old', [{ schedule_id: row.scheduleId, occurrence_at: '2026-11-04T00:00:00Z', reminder_prompt: row.config.prompt }])
  await f.service.pump(); await new Promise(resolve => setImmediate(resolve))
  const delivery = Object.values(f.rt.state.projectScheduledTasks[row.id].deliveries)[0]
  assert.equal(delivery.status, 'running'); assert.equal(delivery.runId, 'durable-chief')
  f.service.recover(); outcome = { runId: 'durable-chief', status: 'failed', error: 'Interrupted, waiting for exit' }
  await f.service.pump(); assert.equal(delivery.status, 'failed')
  outcome = { runId: 'durable-chief', status: 'running', error: null }; await f.service.pump(); assert.equal(delivery.finishedAt, undefined)
  outcome = { runId: 'durable-chief', status: 'completed', error: null }; await f.service.pump()
  assert.equal(delivery.status, 'completed'); assert.equal(delivery.error, null); assert.equal(dispatched, 1)
})

test('an unavailable logical target cannot prevent another scheduled inspection from running', async () => {
  const f = setup(), valid = await f.save({})
  f.rt.state.projectScheduledTasks.missing = { id: 'missing', projectId: 'p', target: { kind: 'removed-plugin' }, status: 'active', enabled: true, deliveries: {} }
  await f.service.accept('chief-old', [{ schedule_id: valid.scheduleId, occurrence_at: '2026-11-04T01:00:00Z', reminder_prompt: valid.config.prompt }])
  await f.service.pump(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.runs.length, 1)
  assert.match(f.rt.state.projectScheduledTasks.missing.error, /unavailable/)
})
