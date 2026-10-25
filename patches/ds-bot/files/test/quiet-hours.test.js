// Team quiet hours (#1166, the E half of #645). A window checked when a task is created or
// edited, never at delivery: nothing here may delete, re-create or update an existing task.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { clockIn, inQuietHours, quietHoursOf, readQuietHours } from '../src/shared/quiet-hours.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const RECORD = {
  at: at => ({ kind: 'at', scheduledAt: at }),
  every_seconds: seconds => ({ kind: 'every', everySeconds: seconds }),
  daily: ({ time, time_zone }) => ({ kind: 'daily', time, timeZone: time_zone }),
  weekly: ({ time, time_zone, weekdays }) => ({ kind: 'weekly', time, timeZone: time_zone, weekdays }),
  cron: ({ expression, time_zone }) => ({ kind: 'cron', expression, timeZone: time_zone }),
}

// An in-memory schedule service that counts every write, so "nothing was created or
// changed" is a fact rather than an inference from the list.
function scheduleService() {
  const tasks = new Map()
  const writes = []
  let next = 1
  return {
    tasks,
    writes,
    async create(sessionId, request) {
      writes.push(['create', request])
      const id = `schedule-${next++}`
      const kind = Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const record = { id, title: request.title, prompt: request.prompt, ...RECORD[kind](request[kind]) }
      tasks.set(id, { sessionId, record, status: 'active' })
      return record
    },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId && task.status === 'active').map(task => task.record) },
    async catalog() { return [...tasks.values()].map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status })) },
    async update(request) {
      writes.push(['update', request])
      return { id: request.id, updated: true, record: tasks.get(request.id).record }
    },
    async delete({ sessionId, id }) {
      writes.push(['delete', { sessionId, id }])
      tasks.delete(id)
      return { id, deleted: true }
    },
  }
}

function setup(service) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-quiet-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services: { schedule: service } })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { ctx, home, call }
}

const WINDOW = { on: true, from: '22:00', to: '07:00' }
const DAILY = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }

test('the window is half-open and crosses midnight', () => {
  assert.equal(inQuietHours({ on: true, from: '22:00', to: '07:00' }, '21:59'), false)
  assert.equal(inQuietHours({ on: true, from: '22:00', to: '07:00' }, '22:00'), true, 'the start minute is quiet')
  assert.equal(inQuietHours({ on: true, from: '22:00', to: '07:00' }, '23:59'), true)
  assert.equal(inQuietHours({ on: true, from: '22:00', to: '07:00' }, '00:00'), true)
  assert.equal(inQuietHours({ on: true, from: '22:00', to: '07:00' }, '06:59'), true)
  assert.equal(inQuietHours({ on: true, from: '22:00', to: '07:00' }, '07:00'), false, 'the end minute is free')
  assert.equal(inQuietHours({ on: true, from: '09:00', to: '17:00' }, '12:00'), true)
  assert.equal(inQuietHours({ on: true, from: '09:00', to: '17:00' }, '18:00'), false)
  assert.equal(inQuietHours({ on: false, from: '22:00', to: '07:00' }, '23:00'), false, 'off is off')
})

test('an instant reads as the wall clock of one zone, and a bad zone falls back', () => {
  assert.equal(clockIn('UTC', '2030-01-01T23:30:00Z'), '23:30')
  assert.equal(clockIn('Asia/Shanghai', '2030-01-01T23:30:00Z'), '07:30')
  assert.equal(clockIn('Not/AZone', '2030-01-01T23:30:00Z').length, 5)
})

test('an invalid window is refused on the settings write, never stored as always quiet', () => {
  for (const body of [{ on: true, from: '22:00', to: '22:00' }, { on: true, from: '22:00' }, { on: true, from: '9am', to: '07:00' }, { on: 'yes' }]) {
    assert.throws(() => readQuietHours(body, undefined), (error) => error.code === 'bot/quiet-hours')
  }
  assert.deepEqual(readQuietHours({ on: true, from: '22:00', to: '07:00' }, undefined), WINDOW)
  assert.equal(readQuietHours({ on: false }, WINDOW), undefined, 'off is the absence of the record')
  assert.deepEqual(quietHoursOf({ quietHours: WINDOW }), WINDOW)
  assert.deepEqual(quietHoursOf(undefined), { on: false })
  assert.deepEqual(quietHoursOf({ quietHours: { on: false, from: '22:00', to: '07:00' } }), { on: false })
})

test('with quiet hours off a task inside the window is created exactly as before', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup(schedule)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  // `from` and `to` are free minutes when the window is off.
  for (const time of ['22:00', '07:00', '03:00']) {
    const made = await call('schedule-create', { target: 'm1', title: `At ${time}`, prompt: 'Run', when: { kind: 'daily', time, timeZone: 'Asia/Shanghai' } })
    assert.equal(made.ok, true, JSON.stringify(made))
  }
  assert.equal(schedule.tasks.size, 3)
  assert.deepEqual((await call('schedules', {})).value.quietHours, { on: false })
})

test('with quiet hours on a one-shot inside the window is refused and nothing is created', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup(schedule)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.equal((await call('set-prefs', { quietHours: WINDOW })).ok, true)
  const refused = await call('schedule-create', { target: 'm1', title: 'Late', prompt: 'Run', when: { kind: 'at', at: '2030-01-01T23:30:00Z', timeZone: 'UTC' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/quiet-hours')
  assert.match(refused.error.message, /until 07:00/, 'the sentence names when the window ends')
  assert.match(refused.error.message, /22:00–07:00/)
  assert.equal(schedule.tasks.size, 0)
  assert.deepEqual(schedule.writes, [], 'no create reached the service')
})

test('daily and weekly are refused inside the window, the end minute is allowed, and an edit changes nothing', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup(schedule)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'm1', title: 'Morning', prompt: 'Sum up', when: DAILY })
  assert.equal(made.ok, true, JSON.stringify(made))
  const [id] = schedule.tasks.keys()
  schedule.writes.length = 0
  assert.equal((await call('set-prefs', { quietHours: WINDOW })).ok, true)

  for (const when of [
    { kind: 'daily', time: '23:00', timeZone: 'Asia/Shanghai' },
    { kind: 'weekly', time: '06:00', timeZone: 'Asia/Shanghai', weekdays: [1] },
  ]) {
    const refused = await call('schedule-create', { target: 'm1', title: 'Quiet', prompt: 'Run', when })
    assert.equal(refused.error?.code, 'bot/quiet-hours', JSON.stringify(refused))
  }
  // 07:00 is the window's end: half-open, so it is free.
  assert.equal((await call('schedule-create', { target: 'm1', title: 'Seven', prompt: 'Run', when: { kind: 'daily', time: '07:00', timeZone: 'UTC' } })).ok, true)

  const edited = await call('schedule-update', { sessionId: 'm1', id, target: 'm1', title: 'Morning', prompt: 'Sum up', when: { kind: 'daily', time: '23:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(edited.error?.code, 'bot/quiet-hours', JSON.stringify(edited))
  assert.equal(schedule.writes.filter(([kind]) => kind !== 'create').length, 0, 'a refused edit makes no update or delete call')
  const kept = [...schedule.tasks.values()].find(task => task.record.id === id).record
  assert.equal(kept.title, 'Morning')
  assert.equal(kept.time, '09:00:00', 'the refused edit left the task exactly as it was')
  assert.equal(kept.kind, 'daily')
})

test('every and cron are allowed, and the view says they are not checked', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup(schedule)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.equal((await call('set-prefs', { quietHours: WINDOW })).ok, true)
  const made = await call('schedule-create', { target: 'm1', title: 'Ping', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal(made.value.quietUnchecked, true, 'the view carries the marker the page renders')
  assert.deepEqual(made.value.quietHours, WINDOW)

  // A cron rule can only arrive from DSH itself, and the list says the same thing.
  await schedule.create('m1', { title: 'Cron', prompt: 'x', cron: { expression: '*/15 * * * *', time_zone: 'UTC' } })
  const view = (await call('schedules', {})).value
  assert.equal(view.quietUnchecked, true)
  assert.deepEqual(view.quietHours, WINDOW)
  assert.equal(Object.hasOwn(view, 'suppressed'), false, 'no suppression record: that half is DSH\'s')
})

test('a task that already fires inside the window keeps firing and is never moved', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup(schedule)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'm1', title: 'Nightly', prompt: 'Run', when: { kind: 'daily', time: '23:00', timeZone: 'Asia/Shanghai' } })
  schedule.writes.length = 0
  assert.equal((await call('set-prefs', { quietHours: WINDOW })).ok, true)
  const view = (await call('schedules', {})).value
  assert.deepEqual(view.tasks.map(task => [task.title, task.status, task.time]), [['Nightly', 'active', '23:00:00']])
  assert.deepEqual(schedule.writes, [], 'turning quiet hours on touches no task')
  assert.deepEqual((await call('schedules', {})).value.quietHours, WINDOW)
})

test('the settings write refuses an invalid window and keeps the old record', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup(schedule)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const refused = await call('set-prefs', { quietHours: { on: true, from: '22:00', to: '22:00' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/quiet-hours')
  assert.deepEqual((await call('state', {})).value?.prefs?.quietHours, undefined)

  assert.equal((await call('set-prefs', { quietHours: WINDOW })).ok, true)
  assert.deepEqual((await call('state', {})).value.prefs.quietHours, WINDOW)
  const off = await call('set-prefs', { quietHours: { on: false } })
  assert.equal(off.ok, true)
  assert.equal((await call('state', {})).value.prefs.quietHours, undefined)
})
