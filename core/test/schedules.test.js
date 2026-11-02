import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
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
// `every_seconds` is the one DSH anchors to the create instant (now + interval), so a
// move that went through create would re-anchor it; the others keep a fixed instant.
const KINDS = {
  at: at => ({ kind: 'at', scheduledAt: at }),
  every_seconds: seconds => ({ kind: 'every', everySeconds: seconds, scheduledAt: new Date(Date.now() + seconds * 1000).toISOString() }),
  daily: ({ time, time_zone }) => ({ kind: 'daily', time, timeZone: time_zone, scheduledAt: '2030-01-01T01:00:00.000Z' }),
  weekly: ({ time, time_zone, weekdays }) => ({ kind: 'weekly', time, timeZone: time_zone, weekdays, scheduledAt: '2030-01-01T01:00:00.000Z' }),
  cron: ({ expression, time_zone }) => ({ kind: 'cron', expression, timeZone: time_zone, scheduledAt: '2030-01-01T01:00:00.000Z' }),
}
const CHANGE = { at: 'at', every: 'every_seconds', daily: 'daily', weekly: 'weekly', cron: 'cron' }

// An in-memory stand-in for DSH's schedule service.
function scheduleService() {
  const tasks = new Map()
  const updates = []
  // Every create in order: the paused-copy branch is the one path that must land here (#1319).
  const created = []
  let next = 1
  // DSH runs management and delivery through one queue (`serialize`); the fake keeps one too.
  let chain = Promise.resolve()
  const service = {
    tasks,
    updates,
    created,
    failCreate: false,
    failDelete: false,
    failPut: false,
    async create(sessionId, request) {
      if (this.failCreate) throw new Error('create failed')
      created.push({ sessionId, request })
      const id = `schedule-${next++}`
      const kind = Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const record = { id, title: request.title, prompt: request.prompt, timing: request[kind], ...KINDS[kind](request[kind]) }
      tasks.set(id, { sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } })
      return record
    },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId && task.status === 'active').map(task => task.record) },
    async catalog() { return [...tasks.values()].map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status })) },
    // DSH's storage domain, as `getDomain()` exposes it: the row itself is what a move rewrites.
    async getDomain() {
      return {
        table(name) {
          assert.equal(name, 'tasks')
          return {
            entries: () => tasks.entries(),
            get: id => tasks.get(id),
            put(id, task) {
              if (service.failPut) throw new Error('write failed')
              tasks.set(id, task)
            },
          }
        },
      }
    },
    serialize(work) {
      const pending = chain.then(work)
      chain = pending.catch(() => undefined)
      return pending
    },
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
  return service
}

function setup(services = {}, team = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-schedules-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { ctx, home, call, rt }
}

test('without the schedule service the page says so and creating is refused', async (t) => {
  const { ctx, home, call } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call('schedules', {})).value, { available: false, tasks: [], quietHours: { on: false } })
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

// #1651 (P-132): DSH takes any interval of 60s or more, and the client now sends seconds,
// so a repeat of 90s survives a save that changed only the title.
test('a repeat keeps its seconds, and the every selector is the only one that changed (#1651 a, b, e)', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  for (const seconds of [90, 61, 100, 3601]) {
    const made = await call('schedule-create', { target: 'm1', title: `S${seconds}`, prompt: 'Ping', when: { kind: 'every', seconds } })
    assert.equal(made.ok, true, JSON.stringify(made))
    assert.equal(made.value.tasks.find(task => task.title === `S${seconds}`).everySeconds, seconds, `${seconds}s reaches the host`)
    assert.equal(schedule.created.at(-1).request.every_seconds, seconds, `${seconds}s is what DSH is asked for`)
  }

  // Only the title changes: the same whole interval comes back, so DSH gets no timing change.
  const [id] = schedule.tasks.keys()
  const renamed = await call('schedule-update', { sessionId: 'm1', id, target: 'm1', title: 'Renamed', prompt: 'Ping', when: { kind: 'every', seconds: 90 } })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  assert.equal(schedule.updates.at(-1).change, undefined, 'no timing change reaches DSH')
  assert.equal(schedule.tasks.get(id).record.everySeconds, 90)

  // Whole minutes still travel as minutes.
  const half = await call('schedule-create', { target: 'm1', title: 'Half hour', prompt: 'Ping', when: { kind: 'every', minutes: 30 } })
  assert.equal(half.ok, true, JSON.stringify(half))
  assert.equal(schedule.created.at(-1).request.every_seconds, 1800)

  for (const seconds of [59, 604801]) {
    const refused = await call('schedule-create', { target: 'm1', title: 'x', prompt: 'y', when: { kind: 'every', seconds } })
    assert.equal(refused.ok, false, `${seconds}s is refused`)
    assert.match(refused.error.message, /Repeat every 1 minute to 7 days/)
  }
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

// #1245: a handoff is not an edit. The earlier part's task moves to the fresh part with its
// id, its delivery history and the instant it was already due — not re-anchored to the
// handoff, which would slip its next run by up to a full interval and hide it.
test('#1245: a handoff moves an “every” task without re-anchoring it', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  // A handoff happens well after the task was created, so a create-based move would visibly
  // re-anchor it: the fake's create samples this clock (`now + every_seconds`).
  let clock = Date.parse('2030-01-01T00:00:00.000Z')
  t.mock.method(Date, 'now', () => clock)

  const record = await schedule.create('m1', { title: 'Watch', prompt: 'Check the board', every_seconds: 7200 })
  const row = schedule.tasks.get(record.id)
  row.deliveryHistory = { records: [{ scheduledAt: '2030-01-01T01:00:00.000Z', deliveredAt: '2030-01-01T01:00:01.000Z', messageId: 'msg-old' }], earlierRecordsUnavailable: false }
  const anchor = row.record.scheduledAt
  const history = structuredClone(row.deliveryHistory)

  clock += 45 * 60_000
  await rt.moveSchedules('m1', 'm1-fresh')

  const moved = [...schedule.tasks.values()].filter(task => task.sessionId === 'm1-fresh')
  assert.equal(moved.length, 1, 'the task moved to the fresh part')
  assert.equal(moved[0].record.scheduledAt, anchor, 'the instant it was already due is kept')
  assert.equal(moved[0].record.id, record.id, 'the task keeps its id')
  assert.deepEqual(moved[0].deliveryHistory, history, 'the delivery history is kept')
  assert.equal(moved[0].record.everySeconds, 7200)
  assert.equal(schedule.tasks.size, 1, 'the row was rewritten, not copied')

  // A failed write leaves the task where it was, with nothing half-deleted (#901).
  schedule.failPut = true
  await rt.moveSchedules('m1-fresh', 'm1-newer')
  schedule.failPut = false
  const [still] = [...schedule.tasks.values()]
  assert.equal(still.sessionId, 'm1-fresh', 'a failed move changes nothing')
  assert.equal(still.record.id, record.id)
  assert.equal(still.record.scheduledAt, anchor)

  // A one-shot whose time has already passed cannot run on the fresh part, so it stays.
  const once = await schedule.create('m1-fresh', { title: 'Once', prompt: 'Ping', at: '2030-01-01T00:00:00.000Z' })
  schedule.tasks.get(once.id).record = { ...schedule.tasks.get(once.id).record, scheduledAt: new Date(Date.now() - 1000).toISOString() }
  await rt.moveSchedules('m1-fresh', 'm1-newer')
  const byId = id => [...schedule.tasks.values()].find(task => task.record.id === id)
  assert.equal(byId(once.id).sessionId, 'm1-fresh', 'a passed one-shot stays where it is')
  assert.equal(byId(record.id).sessionId, 'm1-newer', 'the recurring task still moved')
})

// The move only takes active rows: a disabled task and an exhausted one-shot have no next run
// to follow the handoff, so they stay on the earlier part with their status untouched.
test('#1245: a handoff leaves a disabled and an exhausted row on the earlier part', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  t.mock.method(Date, 'now', () => Date.parse('2030-01-01T00:00:00.000Z'))

  const disabled = await schedule.create('m1', { title: 'Disabled watch', prompt: 'Switched off', every_seconds: 7200 })
  const exhausted = await schedule.create('m1', { title: 'Exhausted ping', prompt: 'Ran once', at: '2030-01-01T00:10:00.000Z' })
  // DSH's only ended state is `inactive`: a disabled task and a finished one-shot both keep it.
  schedule.tasks.get(disabled.id).status = 'inactive'
  schedule.tasks.get(exhausted.id).status = 'inactive'
  const active = await schedule.create('m1', { title: 'Live watch', prompt: 'Moves', every_seconds: 3600 })

  await rt.moveSchedules('m1', 'm1-fresh')

  const row = id => [...schedule.tasks.values()].find(task => task.record.id === id)
  assert.equal(row(disabled.id).sessionId, 'm1', 'a disabled task stays on the earlier part')
  assert.equal(row(disabled.id).status, 'inactive', 'its status is untouched')
  assert.equal(row(exhausted.id).sessionId, 'm1', 'an exhausted task stays on the earlier part')
  assert.equal(row(exhausted.id).status, 'inactive', 'its status is untouched')
  assert.equal(row(active.id).sessionId, 'm1-fresh', 'the active task still moves')
  assert.deepEqual([...schedule.tasks.values()].filter(task => task.sessionId === 'm1-fresh').map(task => task.record.id), [active.id], 'the fresh part gets neither inactive row')
})

// #1287: a task can be copied to another Bot or group chat. A copy is a second row with the
// source's title, prompt and timing, and it keeps the source's next run: going through DSH's
// create would anchor an `every` task to now + interval, which is #1245 again.
test('#1287: a copy lands on the target’s current part with the source’s next run, leaving the source alone', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  let clock = Date.parse('2030-01-01T12:00:00.000Z')
  t.mock.method(Date, 'now', () => clock)

  await call('schedule-create', { target: 'm1', title: 'Watch', prompt: 'Check the board', when: { kind: 'every', minutes: 120 } })
  const [sourceId] = schedule.tasks.keys()
  const source = schedule.tasks.get(sourceId)
  const due = '2030-01-01T12:30:00.000Z'
  const delivered = { scheduledAt: '2030-01-01T11:00:00.000Z', deliveredAt: '2030-01-01T11:00:02.000Z', messageId: 'msg-old' }
  source.record = { ...source.record, scheduledAt: due }
  source.deliveryHistory = { records: [delivered], earlierRecordsUnavailable: false }
  source.lastDelivery = delivered

  clock += 10 * 60_000
  const copied = await call('schedule-create', { target: 'w1', copyFrom: { sessionId: 'm1', id: sourceId } })
  assert.equal(copied.ok, true, JSON.stringify(copied))
  const copies = [...schedule.tasks.entries()].filter(([id]) => id !== sourceId)
  assert.equal(copies.length, 1, 'the copy is a second row, not a rewrite of the source')
  const [copyId, copy] = copies[0]
  assert.notEqual(copyId, sourceId, 'the copy gets its own id')
  assert.match(copyId, /^schedule-/, 'the id keeps DSH’s own shape')
  assert.equal(copy.sessionId, 'w2', 'it lands on the target Bot’s current part')
  assert.deepEqual([copy.record.title, copy.record.prompt, copy.record.everySeconds], ['Watch', 'Check the board', 7200])
  assert.equal(copy.record.id, copyId, 'the record carries the new id')
  assert.equal(copy.record.scheduledAt, due, 'the source’s next run is kept, not now + 7200')
  assert.equal(copy.status, 'active')
  assert.equal(copy.lastDelivery, undefined, 'a copy has never been delivered')
  assert.deepEqual(copy.deliveryHistory, { records: [], earlierRecordsUnavailable: false }, 'a copy carries no delivery history')

  // The source keeps its row, its next run and its delivery record.
  assert.equal(schedule.tasks.get(sourceId).sessionId, 'm1')
  assert.equal(source.record.scheduledAt, due)
  assert.equal(source.lastDelivery.messageId, 'msg-old')

  // FlyBot's run record is keyed on the DSH id, so the copy starts with none (#473).
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(Object.hasOwn(saved.scheduleRuns ?? {}, copyId), false)
  assert.deepEqual(copied.value.tasks.map(task => task.botId).sort(), ['m1', 'w1'], 'both rows are listed, each under its own Bot')
  assert.equal(new Set(copied.value.tasks.map(task => task.id)).size, 2, 'the view lists two distinct tasks')
})

test('#1287: an unknown source, an unknown target, the same chat and a passed one-time task are refused', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'm1', title: 'Watch', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  const [id] = schedule.tasks.keys()
  const from = { sessionId: 'm1', id }

  for (const [body, message] of [
    [{ target: 'w1', copyFrom: { sessionId: 'm1', id: 'schedule-404' } }, /No such task/],
    [{ target: 'w1', copyFrom: { sessionId: 'outside', id } }, /No such task/],
    [{ target: 'nobody', copyFrom: from }, /No such Bot or group chat/],
    [{ target: 'm1', copyFrom: from }, /different Bot or group chat/],
  ]) assert.match((await call('schedule-create', body)).error.message, message)
  assert.equal(schedule.tasks.size, 1, 'a refused copy writes nothing')

  // A passed one-time task cannot run again, so its copy is refused as an edit is.
  const once = await schedule.create('m1', { title: 'Once', prompt: 'Ping', at: '2030-01-01T00:00:00.000Z' })
  schedule.tasks.get(once.id).record = { ...schedule.tasks.get(once.id).record, scheduledAt: new Date(Date.now() - 1000).toISOString() }
  assert.match((await call('schedule-create', { target: 'w1', copyFrom: { sessionId: 'm1', id: once.id } })).error.message, /future/)
})

test('#1287: a copy keeps a daily rule’s time and zone, and an earlier part’s task goes to the current one', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'w1', title: 'Briefing', prompt: 'Sum up', when: DAILY })
  const [id] = schedule.tasks.keys()
  const anchor = schedule.tasks.get(id).record.scheduledAt

  const copied = await call('schedule-create', { target: 'm1', copyFrom: { sessionId: 'w2', id } })
  assert.equal(copied.ok, true, JSON.stringify(copied))
  const copy = [...schedule.tasks.values()].find(task => task.record.id !== id)
  assert.deepEqual([copy.record.kind, copy.record.time, copy.record.timeZone], ['daily', '09:00:00', 'Asia/Shanghai'])
  assert.equal(copy.record.scheduledAt, anchor, 'a daily copy keeps the instant it was already due')
  assert.equal(copy.sessionId, 'm1')

  // A task still on the Bot's earlier part: the copy goes to the target's current part.
  await schedule.create('w1', { title: 'Old part', prompt: 'x', every_seconds: 3600 })
  const oldId = [...schedule.tasks.keys()].at(-1)
  const again = await call('schedule-create', { target: 'g1', copyFrom: { sessionId: 'w1', id: oldId } })
  assert.equal(again.ok, true, JSON.stringify(again))
  const groupCopy = [...schedule.tasks.values()].find(task => task.record.title === 'Old part' && task.record.id !== oldId)
  assert.equal(groupCopy.sessionId, 'g1', 'a group copy lands on the group’s own Session')
  assert.equal(groupCopy.record.scheduledAt, schedule.tasks.get(oldId).record.scheduledAt, 'and keeps the next run')
})

// #1319: a paused source has no next run to keep, so its copy takes the other branch of
// `copySchedule` — DSH's `create`, as Resume does — and gets a fresh interval anchored to now.
test('#1319: a copy of a paused task goes through create and re-anchors its next run', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  let clock = Date.parse('2030-01-01T12:00:00.000Z')
  t.mock.method(Date, 'now', () => clock)

  await call('schedule-create', { target: 'm1', title: 'Watch', prompt: 'Check the board', when: { kind: 'every', minutes: 120 } })
  const [sourceId] = schedule.tasks.keys()
  assert.equal((await call('schedule-pause', { sessionId: 'm1', id: sourceId })).ok, true)
  assert.equal(schedule.tasks.size, 0, 'the source left DSH, so it has no next run to keep')
  schedule.created.length = 0

  // This branch shares the refusals of the active one, and they run before it.
  assert.match((await call('schedule-create', { target: 'm1', copyFrom: { sessionId: 'm1', id: sourceId } })).error.message, /different Bot or group chat/)
  assert.deepEqual(schedule.created, [], 'a refused copy creates nothing')

  clock += 10 * 60_000
  const copied = await call('schedule-create', { target: 'w1', copyFrom: { sessionId: 'm1', id: sourceId } })
  assert.equal(copied.ok, true, JSON.stringify(copied))
  assert.deepEqual(schedule.created.map(entry => [entry.sessionId, entry.request]), [['w2', { title: 'Watch', prompt: 'Check the board', every_seconds: 7200 }]], 'a paused copy is created, on the target’s current part, with the source’s request')
  const [copyId, copy] = [...schedule.tasks.entries()][0]
  assert.match(copyId, /^schedule-/, 'the copy gets DSH’s own id shape')
  assert.notEqual(copyId, sourceId, 'never the paused source’s id')
  assert.equal(copy.sessionId, 'w2')
  assert.equal(copy.record.scheduledAt, new Date(clock + 7200_000).toISOString(), 'its next run is anchored to now + interval, as Resume re-anchors one')
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).pausedSchedules[sourceId].record.title, 'Watch', 'the paused source stays paused')
})

// #1320: `copyRow` writes a row FlyBot builds itself, so the row is decoded against the
// pinned package's own task type: a required key that moves upstream fails here instead of
// leaving a copy DSH cannot read. Pinned at @deepseek-ai/dsh-schedule@0.2.0-rc.2.
test('#1320: the row a copy writes matches the pinned dsh-schedule task type', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const { scheduleDomain, createEveryScheduleRecord } = await import('@deepseek-ai/dsh-schedule')
  const clock = Date.parse('2030-01-01T12:00:00.000Z')
  t.mock.method(Date, 'now', () => clock)

  await call('schedule-create', { target: 'm1', title: 'Watch', prompt: 'Check the board', when: { kind: 'every', minutes: 120 } })
  const [sourceId] = schedule.tasks.keys()
  // The fake's own create keeps a `timing` field no stored record has; a record from the
  // pinned package is what a copy actually reads.
  schedule.tasks.get(sourceId).record = createEveryScheduleRecord(sourceId, 'Check the board', 7200, clock, 'Watch')

  const copied = await call('schedule-create', { target: 'w1', copyFrom: { sessionId: 'm1', id: sourceId } })
  assert.equal(copied.ok, true, JSON.stringify(copied))
  const copyId = [...schedule.tasks.keys()].find(id => id !== sourceId)
  const row = schedule.tasks.get(copyId)
  const parsed = scheduleDomain.tables.tasks.valueSchema.safeParse(row)
  assert.equal(parsed.success, true, `the copy row must decode as a stored task: ${JSON.stringify(parsed.error?.issues)}`)
  assert.deepEqual(Object.keys(row).sort(), ['deliveryHistory', 'record', 'sessionId', 'status'], 'a copy supplies the session, the record, the status and an empty history')
  assert.deepEqual({ ...row.record }, { ...schedule.tasks.get(sourceId).record, id: copyId }, 'the record keeps every key of the source’s, with only the id replaced')
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

// Last run and Retry (#473): FlyBot records how each run's turn went; DSH only says it delivered.
function withAgents(ctx) {
  const sent = []
  Object.assign(ctx, {
    sessionController: { resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup: message => sent.push([sessionId, message]), steer() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } } }) },
    sessions: { flush: async () => true },
  })
  return sent
}
const reminder = (id, prompt) => ['[SCHEDULE REMINDER]', 'This is a scheduled message from the user', `schedule_id_json: ${JSON.stringify(id)}`, 'occurrence_at: 2030-01-01T09:00:00.000Z', `reminder_prompt_json: ${JSON.stringify(prompt)}`].join('\n')
function runTurn(ctx, sessionId, turn, message, reason) {
  let seq = 0
  const emit = (type, data) => ctx.emitArgs('session/event', { id: sessionId }, { type, seq: ++seq, data })
  emit('turn/start', { turn })
  emit('user/message', message)
  emit('turn/end', { turn, reason })
}
const lastRuns = async call => (await call('schedules', {})).value.tasks.map(task => task.lastRun && [task.lastRun.result, task.lastRun.reason])

test('a run fails only when its turn errors; a turn without an answer has run, a stopped one says so', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: DAILY })
  const [id] = schedule.tasks.keys()
  assert.deepEqual(await lastRuns(call), [undefined], 'no run yet')

  const message = { id: 'msg-1', content: [{ type: 'text', text: reminder(id, 'Sum up') }], source: { kind: 'schedule' } }
  runTurn(ctx, 'm1', 1, message, { kind: 'error', error: { code: 'SERVER', status: 503, message: 'upstream busy' } })
  assert.deepEqual(await lastRuns(call), [['failed', 'SERVER 503: upstream busy']])
  runTurn(ctx, 'm1', 2, { ...message, id: 'msg-2' }, { kind: 'completed' })
  assert.deepEqual(await lastRuns(call), [['ran', undefined]], 'a finished turn is a run, answer or not')
  runTurn(ctx, 'm1', 3, { ...message, id: 'msg-3' }, { kind: 'aborted', reason: { kind: 'user' } })
  assert.deepEqual(await lastRuns(call), [['stopped', undefined]])
  // A turn that took in no reminder leaves the record alone.
  runTurn(ctx, 'm1', 4, { id: 'msg-4', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { kind: 'error', error: { code: 'SERVER' } })
  assert.deepEqual(await lastRuns(call), [['stopped', undefined]])
  // DSH delivered a newer reminder the Bot has not taken up yet.
  const [task] = schedule.tasks.values()
  task.record = { ...task.record, lastDelivery: { scheduledAt: '2030-01-01T09:00:00.000Z', deliveredAt: new Date(Date.now() + 5000).toISOString(), messageId: 'msg-5' } }
  assert.deepEqual(await lastRuns(call), [['delivered', undefined]])
  // The record is saved with the team, so it survives a restart.
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).scheduleRuns?.[id]?.result
  for (let tries = 0; tries < 50 && saved() !== 'stopped'; tries++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(saved(), 'stopped')
})

test('P-1993: a failed run\'s reason is cut on a code point at 200', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: DAILY })
  const [id] = schedule.tasks.keys()
  const message = { id: 'msg-1', content: [{ type: 'text', text: reminder(id, 'Sum up') }], source: { kind: 'schedule' } }
  const head = `SERVER 503: ${'a'.repeat(187)}`
  runTurn(ctx, 'm1', 1, message, { kind: 'error', error: { code: 'SERVER', status: 503, message: `${'a'.repeat(187)}😀tail` } })
  const [[result, reason]] = await lastRuns(call)
  assert.equal(result, 'failed')
  assert.ok(reason.isWellFormed(), `the stored reason is well formed: ${JSON.stringify(reason)}`)
  assert.equal(reason, head, 'the pair at the bound is dropped whole, not split')
  // Control: a reason under the bound is stored word for word.
  runTurn(ctx, 'm1', 2, { ...message, id: 'msg-2' }, { kind: 'error', error: { code: 'SERVER', status: 503, message: 'upstream busy' } })
  assert.deepEqual(await lastRuns(call), [['failed', 'SERVER 503: upstream busy']])
})

test('Retry runs the same prompt once now in the Bot’s current part, and its turn is the task’s run', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  const sent = withAgents(ctx)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'w1', title: 'Briefing', prompt: 'Sum up the day', when: DAILY })
  const [id] = schedule.tasks.keys()
  const retried = await call('schedule-retry', { sessionId: 'w2', id })
  assert.equal(retried.ok, true, JSON.stringify(retried))
  assert.deepEqual(retried.value.tasks.map(task => task.lastRun.result), ['running'])
  const [[sessionId, message]] = sent
  assert.equal(sessionId, 'w2')
  assert.equal(message.source.kind, 'schedule', 'it reads like the task’s own run')
  const text = message.content[0].text
  assert.equal(reminderText(text), '[Scheduled task] Sum up the day')
  assert.equal([...schedule.tasks.values()][0].record.scheduledAt, '2030-01-01T01:00:00.000Z', 'DSH’s next time is untouched')
  runTurn(ctx, 'w2', 1, message, { kind: 'completed' })
  assert.deepEqual(await lastRuns(call), [['ran', undefined]])

  // A group task is retried in the group's Session.
  await call('schedule-create', { target: 'g1', title: 'Standup', prompt: 'Where are we?', when: DAILY })
  const groupId = [...schedule.tasks.keys()].at(-1)
  assert.equal((await call('schedule-retry', { sessionId: 'g1', id: groupId })).ok, true)
  assert.equal(sent.at(-1)[0], 'g1')
  // Unknown, foreign and paused tasks are refused.
  assert.match((await call('schedule-retry', { sessionId: 'w2', id: 'nope' })).error.message, /No such task/)
  assert.match((await call('schedule-retry', { sessionId: 'outside', id })).error.message, /No such task/)
  await call('schedule-pause', { sessionId: 'w2', id })
  assert.match((await call('schedule-retry', { sessionId: 'w2', id })).error.message, /Resume the task first/)
  assert.equal(sent.length, 2)
})

test('a due task DSH does not deliver while the app runs is a failed run, told once like a failed turn', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { t.mock.restoreAll(); await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: DAILY })
  const [task] = schedule.tasks.values()
  const due = Date.now() - 60_000
  task.record = { ...task.record, scheduledAt: new Date(due).toISOString() }
  // First seen due: DSH may be delivering it right now (a time missed while the app was closed).
  assert.deepEqual(await lastRuns(call), [undefined])
  const start = Date.now()
  t.mock.method(Date, 'now', () => start + 150_000)
  assert.deepEqual(await lastRuns(call), [['failed', 'DSH could not deliver it']])
  assert.equal((await call('schedules', {})).value.tasks[0].lastRun.at, due)
  const ended = (await call('state', {})).value.work.ended
  assert.deepEqual(ended.map(entry => [entry.botId, entry.sessionId, entry.failed]), [['m1', 'm1', 'Scheduled task "Briefing" was not delivered']])
  await call('schedules', {})
  const again = (await call('state', {})).value.work.ended
  assert.equal(again.length, 1, 'told once per missed time')
  // Delivered after all: the next time is in the future again and the failure stays the last run.
  task.record = { ...task.record, scheduledAt: '2030-01-02T01:00:00.000Z' }
  assert.deepEqual(await lastRuns(call), [['failed', 'DSH could not deliver it']])
})

// #628: DSH's own `schedule_list` answers for one Session, so a task the owner sees in the
// UI is invisible from another Session of the same Bot, and its `[]` reads the same as
// "nothing scheduled". `bot_schedules` answers for the Bot.
test('#628: bot_schedules answers for the Bot, never for the Session the call runs in', async (t) => {
  const schedule = scheduleService()
  const team = JSON.parse(JSON.stringify(TEAM))
  team.rooms.g1.sessions = { w1: 'g1-w1', m1: 'g1-m1' }
  team.rooms.g1.segments = { w1: [{ sessionId: 'g1-w1-old', endedAt: 5 }] }
  team.pausedSchedules = { 's-paused': { id: 's-paused', sessionId: 'w1', record: { title: 'Paused brief', prompt: 'Sum up' }, pausedAt: 6 } }
  const { ctx, home } = setup({ schedule }, team)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const add = (sessionId, title, id, status = 'active') => schedule.tasks.set(id, { sessionId, status, record: { id, title, prompt: `${title} prompt`, scheduledAt: '2030-01-01T01:00:00.000Z' } })
  add('w2', 'Writer current part', 's-w2')
  add('w1', 'Writer earlier part', 's-w1')
  add('g1-w1', 'Writer group', 's-g1')
  add('g1-w1-old', 'Writer group earlier part', 's-g1-old')
  add('m1', 'Chief own chat', 's-m1')
  add('g1-m1', 'Chief group session', 's-g1m')
  // A task the owner set for the group chat itself lives on the group's own Session (#628).
  add('g1', 'Launch group task', 's-g1-own')
  const listed = (sessionId) => ctx.registeredTools.get('bot_schedules').execute({}, { agent: { id: sessionId } })
  const answer = await listed('w2')
  // Every Session of this Bot: its own chat, the earlier part of it, the group chats it speaks in.
  for (const name of ['Writer current part', 'Writer earlier part', 'Writer group', 'Writer group earlier part', 'Launch group task', 'Paused brief']) {
    assert.ok(answer.includes(name), `${name} is the Bot's schedule`)
  }
  assert.match(answer, /own chat, earlier part/)
  assert.match(answer, /group chat "Launch"/)
  assert.match(answer, /paused/)
  // The same answer whichever Session of the Bot asks — that is what "Bot-wide" means.
  assert.equal(await listed('w1'), answer, 'an earlier part gets the same answer')
  assert.equal(await listed('g1-w1'), answer, 'so does a group Session it speaks in')
  // Another Bot's tasks stay out, own chat and group alike.
  assert.ok(!answer.includes('Chief own chat'))
  assert.ok(!answer.includes('Chief group session'))
  // The answer names its scope, so an empty one cannot be read as "nothing is scheduled".
  assert.match(answer, /every Session of this Bot/)
  assert.match(answer, /schedule_list answers for one Session only/)
})

// A group chat keeps its own Session, and a task the owner sets for the group lives on it
// (#628): its id is the room id, so it belongs to every member of that group and to nobody
// else — including a Bot that only sees the group's members' Sessions.
test('#628: a task set for the group chat is listed for its members, not for a Bot outside it', async (t) => {
  const schedule = scheduleService()
  const team = JSON.parse(JSON.stringify(TEAM))
  team.bots.w3 = { id: 'w3', sessionId: 'w3', name: 'Outsider', role: '', instructions: '', createdAt: 7 }
  const { ctx, home, call } = setup({ schedule }, team)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'g1', title: 'Standup', prompt: 'Where are we?', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal([...schedule.tasks.values()][0].sessionId, 'g1', 'the task lives on the group Session')
  const listed = (sessionId) => ctx.registeredTools.get('bot_schedules').execute({}, { agent: { id: sessionId } })
  const writer = await listed('w2')
  assert.ok(writer.includes('Standup'), 'a member sees the group chat’s own task')
  assert.match(writer, /group chat "Launch"/)
  assert.ok((await listed('m1')).includes('Standup'), 'the admin is a member and sees it too')
  const outsider = await listed('w3')
  assert.ok(!outsider.includes('Standup'), 'a Bot outside the group is not told about it')
  assert.match(outsider, /none — no scheduled task in any of its Sessions/, 'and its answer says so plainly')
})

test('#628: a paused task on the group chat’s own Session is listed too', async (t) => {
  const schedule = scheduleService()
  const team = JSON.parse(JSON.stringify(TEAM))
  team.bots.w3 = { id: 'w3', sessionId: 'w3', name: 'Outsider', role: '', instructions: '', createdAt: 7 }
  team.pausedSchedules = { 's-gpaused': { id: 's-gpaused', sessionId: 'g1', record: { title: 'Paused group brief', prompt: 'Sum up' }, pausedAt: 6 } }
  const { ctx, home } = setup({ schedule }, team)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const listed = (sessionId) => ctx.registeredTools.get('bot_schedules').execute({}, { agent: { id: sessionId } })
  const answer = await listed('w2')
  assert.ok(answer.includes('Paused group brief'), 'a paused group task is still a task of the Bot')
  assert.match(answer, /paused/)
  assert.match(answer, /group chat "Launch"/)
  assert.ok(!(await listed('w3')).includes('Paused group brief'))
})

test('#628: without the schedule service the Bot-wide answer says why it is empty', async (t) => {
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const answer = await ctx.registeredTools.get('bot_schedules').execute({}, { agent: { id: 'w2' } })
  assert.match(answer, /Automation tasks are off in DSH/)
  assert.match(answer, /every Session of this Bot/)
})

test('#628: a Bot with no task in any Session gets an answer that is about the Bot', async (t) => {
  const { ctx, home } = setup({ schedule: scheduleService() })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const answer = await ctx.registeredTools.get('bot_schedules').execute({}, { agent: { id: 'w2' } })
  assert.match(answer, /none — no scheduled task in any of its Sessions, so this is the whole list for the Bot/)
})

// #1321: two owners on one host. `copyFrom` and `schedule-update` resolve a source Session the
// way the page does, and the host knowing that Session is not the caller being allowed to read
// its task: a copy or an edit may only touch a task of the caller's own user.
const TWO_OWNERS = {
  version: 2,
  mainBotIds: ['m1'],
  revision: 1,
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'm1' },
    'owner-2': { id: 'owner-2', createdAt: 2 },
  },
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1, ownerId: 'owner-1' },
    a1: { id: 'a1', sessionId: 'a1', name: 'A Bot', role: '', instructions: '', createdAt: 2, ownerId: 'owner-1' },
    b1: { id: 'b1', sessionId: 'b1', name: 'B Bot', role: '', instructions: '', createdAt: 3, ownerId: 'owner-2' },
  },
  rooms: {
    // One owner's room: every member Bot belongs to owner-1.
    g3: { id: 'g3', name: 'Own room', named: true, members: ['a1'], admin: 'a1', mode: 'admin', notice: '', createdAt: 5,
      participants: [{ kind: 'bot', id: 'a1', joinedSeq: 1 }, { kind: 'human', id: 'owner-1', joinedSeq: 1 }] },
    // A shared room: a Bot of each owner, and both humans seated. Membership is not ownership.
    g2: { id: 'g2', name: 'Shared room', named: true, members: ['a1', 'b1'], admin: 'a1', mode: 'admin', notice: '', createdAt: 6,
      participants: [{ kind: 'bot', id: 'a1', joinedSeq: 1 }, { kind: 'bot', id: 'b1', joinedSeq: 2 },
        { kind: 'human', id: 'owner-1', joinedSeq: 1 }, { kind: 'human', id: 'owner-2', joinedSeq: 2 }] },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// The channel route with a member signed in: the cookie the browser sends is the token below.
function signedIn(t, team = TWO_OWNERS) {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule }, team)
  rt.authenticate = async (token) => {
    if (token === 'tok-a') return { memberId: 'owner-1', displayName: 'A' }
    if (token === 'tok-b') return { memberId: 'owner-2', displayName: 'B' }
    return null
  }
  const callAs = async (endpoint, payload, token) => {
    const headers = { 'content-type': 'application/json' }
    if (token) headers['x-flybot-member-session'] = token
    return (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers, body: JSON.stringify({ endpoint, payload }) }))).json()
  }
  return { ctx, home, schedule, rt, callAs }
}

// One member signed in is what turns owner scoping on; the state file itself stays the team's.
const signedInNow = async (rt, callAs) => {
  await callAs('schedules', {}, 'tok-a')
  rt.state.authSessions = { 's-a': { memberId: 'owner-1', tokenHash: 'a' }, 's-b': { memberId: 'owner-2', tokenHash: 'b' } }
}

test('#1321: a copy reads only the caller’s own task; a peer’s task is refused as unknown', async (t) => {
  const { ctx, home, schedule, rt, callAs } = signedIn(t)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await signedInNow(rt, callAs)
  const made = await callAs('schedule-create', { target: 'a1', title: 'Private', prompt: 'Read my mail', when: DAILY }, 'tok-a')
  assert.equal(made.ok, true, JSON.stringify(made))
  const [id] = schedule.tasks.keys()

  // Another owner is refused, in the sentence an unknown source already gets: one sentence,
  // never a second wording that would tell the caller the task is real.
  const foreign = await callAs('schedule-create', { target: 'b1', copyFrom: { sessionId: 'a1', id } }, 'tok-b')
  assert.equal(foreign.ok, false, 'a foreign task is not copyable')
  assert.equal(foreign.error.message, 'No such task', 'the refusal is the existing sentence, verbatim')

  // Fail closed in the data layer: with owner scoping on, a request that reaches the endpoint
  // with no actor is refused, not let through. (The route refuses it earlier, "Sign in first".)
  await assert.rejects(() => rt.scheduleEndpoint('schedule-create', { target: 'm1', copyFrom: { sessionId: 'a1', id } }), /No such task/)
})

test('#1321: a refused copy writes nothing, and its refusal carries nothing of the source', async (t) => {
  const { ctx, home, schedule, rt, callAs } = signedIn(t)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await signedInNow(rt, callAs)
  const title = 'Board notes only the owner may read'
  const made = await callAs('schedule-create', { target: 'a1', title, prompt: 'Summarise the private board', when: DAILY }, 'tok-a')
  assert.equal(made.ok, true, JSON.stringify(made))
  const [id] = schedule.tasks.keys()
  const before = schedule.tasks.size

  const foreign = await callAs('schedule-create', { target: 'b1', copyFrom: { sessionId: 'a1', id } }, 'tok-b')
  assert.equal(foreign.ok, false, 'a foreign task is not copyable')
  // Nothing was written: no new row, and the source is untouched.
  assert.equal(schedule.tasks.size, before, 'the refused copy created nothing')
  assert.equal(schedule.tasks.get(id).record.title, title)
  assert.deepEqual([...schedule.tasks.values()].map(task => task.sessionId), ['a1'])
  // Nothing of the source came back in the refusal: not the title, not a word of the prompt.
  assert.equal(foreign.error.message, 'No such task')
  const wire = JSON.stringify(foreign)
  assert.ok(!wire.includes(title), 'the refusal does not echo the source title')
  assert.ok(!wire.includes('private board'), 'the refusal does not echo the source prompt')
  assert.ok(!wire.includes('a1'), 'the refusal does not name the source Session either')
})

test('#1321: with owner scoping on, the same user still copies their own task', async (t) => {
  const { ctx, home, schedule, rt, callAs } = signedIn(t)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await signedInNow(rt, callAs)
  assert.equal(rt.authzEnforced(), true, 'the guard is on in this case, or the assertion proves nothing')
  const made = await callAs('schedule-create', { target: 'a1', title: 'Private', prompt: 'Read my mail', when: DAILY }, 'tok-a')
  assert.equal(made.ok, true, JSON.stringify(made))
  const [id] = schedule.tasks.keys()

  const own = await callAs('schedule-create', { target: 'm1', copyFrom: { sessionId: 'a1', id } }, 'tok-a')
  assert.equal(own.ok, true, JSON.stringify(own))
  assert.deepEqual([...schedule.tasks.values()].map(task => [task.sessionId, task.record.title]), [['a1', 'Private'], ['m1', 'Private']], 'the copy landed and carries the source text')
})

test('#1321: an edit reads only the caller’s own user — being seated in the room is not owning it', async (t) => {
  const { ctx, home, schedule, rt, callAs } = signedIn(t)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await signedInNow(rt, callAs)

  // owner-1's own room: the task's Session is that room, and its member Bot is owner-1's.
  const ownMade = await callAs('schedule-create', { target: 'g3', title: 'Brief', prompt: 'Sum up', when: DAILY }, 'tok-a')
  assert.equal(ownMade.ok, true, JSON.stringify(ownMade))
  const ownId = [...schedule.tasks.values()].find(task => task.sessionId === 'g3').record.id
  const own = await callAs('schedule-update', { sessionId: 'g3', id: ownId, target: 'g3', title: 'Renamed', prompt: 'x', when: DAILY }, 'tok-a')
  assert.equal(own.ok, true, JSON.stringify(own))
  assert.equal(schedule.tasks.get(ownId).record.title, 'Renamed')

  // A shared room: owner-2 is a current human participant, so authz lets the request past.
  // The data layer still refuses, because the room's member Bots are not all owner-2's.
  const sharedMade = await callAs('schedule-create', { target: 'g2', title: 'Shared brief', prompt: 'Sum up the room', when: DAILY }, 'tok-a')
  assert.equal(sharedMade.ok, true, JSON.stringify(sharedMade))
  const sharedId = [...schedule.tasks.values()].find(task => task.sessionId === 'g2').record.id
  const foreign = await callAs('schedule-update', { sessionId: 'g2', id: sharedId, target: 'g2', title: 'Mine now', prompt: 'x', when: DAILY }, 'tok-b')
  assert.equal(foreign.ok, false, 'membership is not ownership')
  assert.match(foreign.error.message, /No such task/)
  assert.equal(schedule.tasks.get(sharedId).record.title, 'Shared brief', 'the task was not rewritten')
})

test('#1321: with nobody signed in the single-human path still copies across Bots', async (t) => {
  const { ctx, home, schedule, callAs } = signedIn(t)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await callAs('schedule-create', { target: 'a1', title: 'Private', prompt: 'Read my mail', when: DAILY }, 'tok-a')
  const [id] = schedule.tasks.keys()
  // Not signed in: `authzEnforced()` is false, so the legacy path is untouched — the same
  // behavior a one-person deployment had before #1321.
  const copied = await callAs('schedule-create', { target: 'b1', copyFrom: { sessionId: 'a1', id } })
  assert.equal(copied.ok, true, JSON.stringify(copied))
  assert.equal([...schedule.tasks.values()].at(-1).sessionId, 'b1')
})

// The page asks for the list with no payload at all (`actions.schedules()` → `call('schedules')`),
// and a host with a member signed in answered `bot/forbidden`: the empty answer left the page on
// "Loading…" for good. Listing tasks is a read — any signed-in member may ask, and the rows are
// narrowed to their own in the data layer, where the answer is built.
test('with a member signed in, the scheduled-task list answers without a sessionId', async (t) => {
  const { ctx, home, rt, callAs } = signedIn(t)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await signedInNow(rt, callAs)
  assert.equal(rt.authzEnforced(), true, 'the guard is on in this case, or the assertion proves nothing')
  const listed = await callAs('schedules', null, 'tok-a')
  assert.equal(listed.ok, true, JSON.stringify(listed))
  assert.equal(listed.value.available, true)
  assert.deepEqual(listed.value.tasks, [])
})

// #1321 draws the line at ownership for a task's text; the list crossed it: every known Bot's
// task came back to whoever asked, so a member read another owner's titles and prompts. The
// rows a member is handed are their own, on both sides.
test('the scheduled-task list carries only the caller’s own rows', async (t) => {
  const { ctx, home, rt, callAs } = signedIn(t)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await signedInNow(rt, callAs)
  const mine = await callAs('schedule-create', { target: 'a1', title: 'My reminder', prompt: 'My own words', when: DAILY }, 'tok-a')
  assert.equal(mine.ok, true, JSON.stringify(mine))
  const theirs = await callAs('schedule-create', { target: 'b1', title: 'Their reminder', prompt: 'Their own words', when: DAILY }, 'tok-b')
  assert.equal(theirs.ok, true, JSON.stringify(theirs))

  // The row set is built in the data layer, where the caller is known: that is the answer a
  // route hands back, so it is read there — the gate is what test ① above is about.
  const listedA = await rt.scheduleEndpoint('schedules', {}, { memberId: 'owner-1' })
  assert.deepEqual(listedA.tasks.map(task => task.title), ['My reminder'])
  const wire = JSON.stringify(listedA)
  assert.ok(!wire.includes('Their reminder'), 'the other owner’s task is not on the list')
  assert.ok(!wire.includes('Their own words'), 'nor a word of its prompt')
  assert.ok(!wire.includes('b1'), 'nor its Session')

  const listedB = await rt.scheduleEndpoint('schedules', {}, { memberId: 'owner-2' })
  assert.deepEqual(listedB.tasks.map(task => task.title), ['Their reminder'])

  // Fail closed: with scoping on, a call that arrives with no actor reads nobody's rows.
  const hostWide = await rt.scheduleEndpoint('schedules', {}, undefined)
  assert.deepEqual(hostWide.tasks, [])
})

// A one-person install never signed anyone in: `authzEnforced()` is false and the list answers
// what it always answered. The read is narrowed only where scoping is on — narrowing it when
// nobody is signed in would be the same "empty list" this change is about, under another cause.
test('with nobody signed in, the scheduled-task list still answers the host’s tasks', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.equal(rt.authzEnforced(), false, 'a one-person install has no member session')
  const made = await call('schedule-create', { target: 'w1', title: 'Standup', prompt: 'Sum up', when: DAILY })
  assert.equal(made.ok, true, JSON.stringify(made))
  const listed = await rt.scheduleEndpoint('schedules', {}, null)
  assert.deepEqual(listed.tasks.map(task => task.title), ['Standup'])
  assert.equal(listed.available, true)
})

// #1895: a task name's 120-character bound counts code points, so a name of emoji is
// measured the way a reader sees it instead of at double length.
test('a task name counts code points against its 120-character bound (#1895)', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const atCap = '😀'.repeat(120)
  const made = await call('schedule-create', { target: 'm1', title: atCap, prompt: 'Go', when: { kind: 'every', minutes: 5 } })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal([...schedule.tasks.values()].at(-1).record.title, atCap, 'the whole 120-emoji name reaches DSH')
  const over = '😀'.repeat(121)
  const refused = await call('schedule-create', { target: 'm1', title: over, prompt: 'Go', when: { kind: 'every', minutes: 5 } })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Keep the name under 120 characters/)
})
