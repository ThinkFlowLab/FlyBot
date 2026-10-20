import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { reminderText } from '../src/host/schedules.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: { g1: { id: 'g1', name: 'Launch', named: true, members: ['m1', 'w1'], admin: 'm1', mode: 'admin', notice: '', createdAt: 4 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// The record fields DSH stores for each create selector (see dsh-schedule's README).
const KINDS = {
  at: at => ({ kind: 'at', scheduledAt: at }),
  every_seconds: seconds => ({ kind: 'every', everySeconds: seconds, scheduledAt: '2030-01-01T01:00:00.000Z' }),
  daily: ({ time, time_zone }) => ({ kind: 'daily', time, timeZone: time_zone, scheduledAt: '2030-01-01T01:00:00.000Z' }),
  weekly: ({ time, time_zone, weekdays }) => ({ kind: 'weekly', time, timeZone: time_zone, weekdays, scheduledAt: '2030-01-01T01:00:00.000Z' }),
  cron: ({ expression, time_zone }) => ({ kind: 'cron', expression, timeZone: time_zone, scheduledAt: '2030-01-01T01:00:00.000Z' }),
}
const CHANGE = { at: 'at', every: 'every_seconds', daily: 'daily', weekly: 'weekly', cron: 'cron' }

// An in-memory stand-in for DSH's schedule service.
function scheduleService() {
  const tasks = new Map()
  const updates = []
  let next = 1
  return {
    tasks,
    updates,
    failCreate: false,
    failDelete: false,
    async create(sessionId, request) {
      if (this.failCreate) throw new Error('create failed')
      const id = `schedule-${next++}`
      const kind = Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const record = { id, title: request.title, prompt: request.prompt, timing: request[kind], ...KINDS[kind](request[kind]) }
      tasks.set(id, { sessionId, record, status: 'active' })
      return record
    },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId && task.status === 'active').map(task => task.record) },
    async catalog() { return [...tasks.values()].map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status })) },
    async update(request) {
      updates.push(request)
      const task = tasks.get(request.id)
      if (task?.sessionId !== request.sessionId) return { id: request.id, updated: false, code: 'schedule_not_found' }
      if (task.status !== 'active') return { id: request.id, updated: false, code: 'schedule_ended' }
      assert.deepEqual(request.expected, task.record, 'update compares the exact listed record')
      const timing = request.change === undefined ? {} : { timing: request.change[CHANGE[request.change.kind]], ...KINDS[CHANGE[request.change.kind]](request.change[CHANGE[request.change.kind]]) }
      task.record = { ...task.record, title: request.title ?? task.record.title, prompt: request.prompt ?? task.record.prompt, ...timing }
      return { id: request.id, updated: true, record: task.record }
    },
    async delete({ sessionId, id }) {
      if (this.failDelete) throw new Error('delete failed')
      if (tasks.get(id)?.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      tasks.delete(id)
      return { id, deleted: true }
    },
  }
}

function setup(services = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-schedules-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { ctx, home, call }
}

test('without the schedule service the page says so and creating is refused', async (t) => {
  const { ctx, home, call } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call('schedules', {})).value, { available: false, tasks: [] })
  const refused = await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Automation tasks are off/)
})

test('tasks are created on the Bot’s current part, listed by Bot, and deleted', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const daily = await call('schedule-create', { target: 'w1', title: ' Briefing ', prompt: 'Sum up the day', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(daily.ok, true, JSON.stringify(daily))
  const [created] = [...schedule.tasks.values()]
  assert.equal(created.sessionId, 'w2')
  assert.deepEqual(created.record.timing, { time: '09:00:00', time_zone: 'Asia/Shanghai' })
  assert.equal(created.record.title, 'Briefing')

  await schedule.create('w1', { title: 'Old part', prompt: 'x', every_seconds: 3600 })
  await schedule.create('outside', { title: 'Not ours', prompt: 'x', every_seconds: 3600 })
  const listed = (await call('schedules', {})).value
  assert.equal(listed.available, true)
  assert.deepEqual(listed.tasks.map(task => [task.title, task.botId]), [['Briefing', 'w1'], ['Old part', 'w1']])

  const weekly = await call('schedule-create', { target: 'm1', title: 'Week', prompt: 'Plan', when: { kind: 'weekly', time: '18:30', timeZone: 'UTC', weekdays: [5, 1, 1, 9] } })
  assert.equal(weekly.ok, true)
  assert.deepEqual([...schedule.tasks.values()].at(-1).record.timing, { time: '18:30:00', time_zone: 'UTC', weekdays: [1, 5] })
  const every = await call('schedule-create', { target: 'm1', title: 'Ping', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  assert.equal([...schedule.tasks.values()].at(-1).record.timing, 1800, JSON.stringify(every))

  for (const [when, message] of [
    [{ kind: 'at', at: '2000-01-01T00:00:00Z' }, /future/],
    [{ kind: 'weekly', time: '09:00', weekdays: [] }, /at least one day/],
    [{ kind: 'daily', time: '9am' }, /time of day/],
    [{ kind: 'every', minutes: 0 }, /1 minute to 7 days/],
  ]) {
    const refused = await call('schedule-create', { target: 'm1', title: 'x', prompt: 'y', when })
    assert.match(refused.error.message, message)
  }
  assert.match((await call('schedule-create', { target: 'm1', title: '', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /name/)

  const removed = await call('schedule-delete', { sessionId: 'w2', id: created.record.id })
  assert.deepEqual(removed.value.tasks.map(task => task.title), ['Old part', 'Week', 'Ping'])
  assert.match((await call('schedule-delete', { sessionId: 'outside', id: 'schedule-3' })).error.message, /No such task/)
})

test('a group chat task lives on the group Session and lists under the group', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'g1', title: 'Standup', prompt: 'Where are we?', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal([...schedule.tasks.values()][0].sessionId, 'g1')
  assert.deepEqual(made.value.tasks.map(task => [task.title, task.roomId, task.botId]), [['Standup', 'g1', undefined]])
  assert.match((await call('schedule-create', { target: 'nobody', title: 'x', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /No such Bot or group chat/)
})

test('a due reminder reaches a group as its prompts', () => {
  const one = ['[SCHEDULE REMINDER]', 'framing', 'schedule_id_json: "s1"', 'occurrence_at: 2030-01-01T00:00:00Z', 'reminder_prompt_json: "Where are we?"'].join('\n')
  assert.equal(reminderText(one), '[Scheduled task] Where are we?')
  const batch = ['[SCHEDULE REMINDER BATCH]', 'framing', `reminders_json: ${JSON.stringify([{ schedule_id: 'a', reminder_prompt: 'One' }, { schedule_id: 'b', reminder_prompt: 'Two' }])}`].join('\n')
  assert.equal(reminderText(batch), '[Scheduled task] One\n[Scheduled task] Two')
  assert.equal(reminderText('plain text'), 'plain text')
})

const DAILY = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }

test('editing a task on the same chat updates it in place and keeps its id', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: DAILY })
  const [id] = schedule.tasks.keys()

  // Same timing: only the name and instruction change, so DSH keeps the next run.
  const renamed = await call('schedule-update', { sessionId: 'm1', id, target: 'm1', title: ' Morning ', prompt: 'Sum up the night', when: DAILY })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  assert.equal(schedule.updates.at(-1).change, undefined)
  assert.deepEqual(renamed.value.tasks.map(task => [task.id, task.title, task.prompt]), [[id, 'Morning', 'Sum up the night']])

  const moved = await call('schedule-update', { sessionId: 'm1', id, target: 'm1', title: 'Morning', prompt: 'Sum up the night', when: { kind: 'weekly', time: '08:30', timeZone: 'UTC', weekdays: [1, 3] } })
  assert.equal(moved.ok, true, JSON.stringify(moved))
  assert.deepEqual(schedule.updates.at(-1).change, { kind: 'weekly', weekly: { time: '08:30:00', time_zone: 'UTC', weekdays: [1, 3] } })
  assert.deepEqual(moved.value.tasks.map(task => [task.id, task.kind, task.weekdays]), [[id, 'weekly', [1, 3]]])

  // Keep: a cron rule the form cannot show keeps its timing.
  await schedule.create('m1', { title: 'Cron', prompt: 'x', cron: { expression: '*/15 9-17 * * 1-5', time_zone: 'UTC' } })
  const cronId = [...schedule.tasks.keys()].at(-1)
  const kept = await call('schedule-update', { sessionId: 'm1', id: cronId, target: 'm1', title: 'Cron 2', prompt: 'y', when: { kind: 'keep' } })
  assert.equal(kept.ok, true, JSON.stringify(kept))
  assert.equal(schedule.updates.at(-1).change, undefined)
  assert.equal(schedule.tasks.get(cronId).record.title, 'Cron 2')

  for (const [body, message] of [
    [{ sessionId: 'm1', id, target: 'm1', title: '', prompt: 'y', when: DAILY }, /name/],
    [{ sessionId: 'm1', id, target: 'm1', title: 'x', prompt: 'y', when: { kind: 'daily', time: '9am' } }, /time of day/],
    [{ sessionId: 'm1', id: 'schedule-99', target: 'm1', title: 'x', prompt: 'y', when: DAILY }, /No such task/],
    [{ sessionId: 'outside', id, target: 'm1', title: 'x', prompt: 'y', when: DAILY }, /No such task/],
    [{ sessionId: 'm1', id, target: 'nobody', title: 'x', prompt: 'y', when: DAILY }, /No such Bot or group chat/],
  ]) assert.match((await call('schedule-update', body)).error.message, message)
  assert.equal(schedule.tasks.get(id).record.title, 'Morning')
})

test('editing a task onto another chat creates the new one before deleting the old', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: DAILY })
  const [id] = schedule.tasks.keys()

  schedule.failCreate = true
  const failed = await call('schedule-update', { sessionId: 'm1', id, target: 'g1', title: 'Briefing', prompt: 'Sum up', when: DAILY })
  assert.equal(failed.ok, false)
  assert.deepEqual([...schedule.tasks.values()].map(task => [task.sessionId, task.record.id]), [['m1', id]], 'a failed create keeps the old task')

  schedule.failCreate = false
  const moved = await call('schedule-update', { sessionId: 'm1', id, target: 'g1', title: 'Standup', prompt: 'Where are we?', when: DAILY })
  assert.equal(moved.ok, true, JSON.stringify(moved))
  assert.deepEqual(moved.value.tasks.map(task => [task.title, task.roomId, task.botId]), [['Standup', 'g1', undefined]])
  assert.equal(schedule.tasks.has(id), false)

  // A finished one-shot cannot be updated in DSH, so its edit is a new task too.
  const [groupId] = schedule.tasks.keys()
  schedule.tasks.get(groupId).status = 'inactive'
  const again = await call('schedule-update', { sessionId: 'g1', id: groupId, target: 'g1', title: 'Standup', prompt: 'Again', when: DAILY })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.deepEqual(again.value.tasks.map(task => [task.prompt, task.status]), [['Again', 'active']])
})

test('pause keeps the task in FlyBot and removes it from DSH; resume brings it back', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'w1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [1, 5] } })
  const [id] = schedule.tasks.keys()

  // A failed delete leaves the task running and nothing paused.
  schedule.failDelete = true
  assert.equal((await call('schedule-pause', { sessionId: 'w2', id })).ok, false)
  assert.equal(schedule.tasks.size, 1)
  assert.deepEqual((await call('schedules', {})).value.tasks.map(task => task.status), ['active'])
  schedule.failDelete = false

  const paused = await call('schedule-pause', { sessionId: 'w2', id })
  assert.equal(paused.ok, true, JSON.stringify(paused))
  assert.equal(schedule.tasks.size, 0, 'DSH no longer runs it')
  assert.deepEqual(paused.value.tasks.map(task => [task.id, task.status, task.botId, task.kind, task.time, task.weekdays]), [[id, 'paused', 'w1', 'weekly', '09:00:00', [1, 5]]])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.pausedSchedules[id].record.title, 'Briefing', 'the paused task survives a restart')
  // Pausing twice is harmless; a finished or unknown task cannot be paused.
  assert.equal((await call('schedule-pause', { sessionId: 'w2', id })).ok, true)
  assert.match((await call('schedule-pause', { sessionId: 'w2', id: 'nope' })).error.message, /No such task/)

  // Editing a paused task keeps it paused.
  const edited = await call('schedule-update', { sessionId: 'w2', id, target: 'w1', title: 'Weekly', prompt: 'Plan', when: { kind: 'every', minutes: 90 } })
  assert.equal(edited.ok, true, JSON.stringify(edited))
  assert.equal(schedule.tasks.size, 0)
  assert.deepEqual(edited.value.tasks.map(task => [task.title, task.status, task.kind, task.everySeconds]), [['Weekly', 'paused', 'every', 5400]])

  // Resume creates it again on the Bot's current part.
  schedule.failCreate = true
  assert.equal((await call('schedule-resume', { sessionId: 'w2', id })).ok, false)
  assert.equal((await call('schedules', {})).value.tasks[0].status, 'paused', 'a failed resume keeps it paused')
  schedule.failCreate = false
  const resumed = await call('schedule-resume', { sessionId: 'w2', id })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.deepEqual([...schedule.tasks.values()].map(task => [task.sessionId, task.record.title, task.record.everySeconds]), [['w2', 'Weekly', 5400]])
  assert.deepEqual(resumed.value.tasks.map(task => task.status), ['active'])
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).pausedSchedules, {})
  assert.match((await call('schedule-resume', { sessionId: 'w2', id })).error.message, /No such task/)
})

test('a paused task can be deleted, and a passed one-time task waits for an edit', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const soon = new Date(Date.now() + 60_000).toISOString()
  await call('schedule-create', { target: 'm1', title: 'Once', prompt: 'Ping', when: { kind: 'at', at: soon } })
  const [id] = schedule.tasks.keys()
  assert.equal((await call('schedule-pause', { sessionId: 'm1', id })).ok, true)
  t.mock.method(Date, 'now', () => Date.parse(soon) + 1000)
  assert.match((await call('schedule-resume', { sessionId: 'm1', id })).error.message, /time has passed/)
  t.mock.restoreAll()
  const removed = await call('schedule-delete', { sessionId: 'm1', id })
  assert.deepEqual(removed.value.tasks, [])
  assert.equal(schedule.tasks.size, 0)
})

// What DSH does with runs missed while the app was closed (docs/subsystems/core-host.md):
// a recurring task runs once, for its latest missed time, and then waits for its next
// time; it never runs once per missed time. A one-time task is one record, so it runs
// once when the app starts again.
test('a recurring task missed while the app was closed runs once, for its latest time', async () => {
  const dsh = await import('@deepseek-ai/dsh-schedule')
  const created = Date.parse('2030-01-01T00:00:00.000Z')
  const daily = dsh.createDailyScheduleRecord(dsh.ScheduleId('d1'), 'Sum up', { time: '09:00:00', time_zone: 'UTC' }, created, 'Briefing')
  assert.equal(daily.scheduledAt, '2030-01-01T09:00:00.000Z')
  // Closed for three days: opened on Jan 4 at 12:00.
  const reopened = Date.parse('2030-01-04T12:00:00.000Z')
  const due = dsh.resolveRecurringOccurrence(daily, reopened)
  assert.equal(due.occurrenceAt, '2030-01-04T09:00:00.000Z', 'only the latest missed time is delivered')
  assert.equal(due.nextScheduledAt, '2030-01-05T09:00:00.000Z', 'the next run is in the future, so no second catch-up')
  const every = dsh.createEveryScheduleRecord(dsh.ScheduleId('e1'), 'Check', 3600, created, 'Hourly')
  const hourly = dsh.resolveRecurringOccurrence(every, created + 50 * 3600_000 + 60_000)
  assert.ok(Date.parse(hourly.nextScheduledAt) > created + 50 * 3600_000 + 60_000)
  assert.ok(Date.parse(hourly.occurrenceAt) > created + 49 * 3600_000, 'fifty missed hours give one run')
})
