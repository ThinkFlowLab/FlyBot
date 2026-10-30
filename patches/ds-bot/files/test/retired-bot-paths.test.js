import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1709: retirement (#638) was final only for the tools that resolve a Bot through
// findTeamBot (#1700). Five host paths resolved a Bot by name without that check, so an
// archived Bot was still woken, still edited, still written to, and still kept a timer.
// Every path below is a behaviour red on the base: a delivery, a write, or an armed row.

const bot = (id, name, createdAt, fields) => ({
  id, sessionId: id, name, role: `${name} role`, model: 'deepseek/v4', instructions: `${name} instructions`, createdAt, capabilities: [],
  ...(fields ? { fields: { 'flybot-tree': fields } } : {}),
})
const team = () => ({
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: bot('m1', 'Chief', 1, { treeRole: 'root' }),
    b2: bot('b2', 'Writer', 2, { parent: 'm1' }),
    b3: bot('b3', 'Coder', 3, { parent: 'm1' }),
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['m1', 'b2', 'b3'], admin: 'm1', mode: 'everyone', notice: '', createdAt: 4,
      // Named group Sessions, so a delivery names the Bot it woke.
      sessions: { m1: 's-m1', b2: 's-b2', b3: 's-b3' },
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
})

// An in-memory stand-in for DSH's schedule service, the same shapes schedules.test.js
// fakes: catalog is what a Bot-wide read and the archive see.
function scheduleService() {
  const tasks = new Map()
  let next = 1
  const KINDS = {
    at: at => ({ kind: 'at', scheduledAt: at }),
    every_seconds: seconds => ({ kind: 'every', everySeconds: seconds, scheduledAt: new Date(Date.now() + seconds * 1000).toISOString() }),
    daily: ({ time, time_zone }) => ({ kind: 'daily', time, timeZone: time_zone, scheduledAt: '2030-01-01T01:00:00.000Z' }),
    weekly: ({ time, time_zone, weekdays }) => ({ kind: 'weekly', time, timeZone: time_zone, weekdays, scheduledAt: '2030-01-01T01:00:00.000Z' }),
    cron: ({ expression, time_zone }) => ({ kind: 'cron', expression, timeZone: time_zone, scheduledAt: '2030-01-01T01:00:00.000Z' }),
  }
  const service = {
    tasks,
    async create(sessionId, request) {
      const id = `schedule-${next++}`
      const kind = Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const record = { id, title: request.title, prompt: request.prompt, timing: request[kind], ...KINDS[kind](request[kind]) }
      tasks.set(id, { sessionId, record, status: 'active' })
      return record
    },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId && task.status === 'active').map(task => task.record) },
    async catalog() { return [...tasks.values()].map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status })) },
    async update(request) {
      const task = tasks.get(request.id)
      if (task?.sessionId !== request.sessionId) return { id: request.id, updated: false, code: 'schedule_not_found' }
      task.record = { ...task.record, title: request.title, prompt: request.prompt }
      return { id: request.id, updated: true, record: task.record }
    },
    async delete({ sessionId, id }) {
      if (tasks.get(id)?.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      tasks.delete(id)
      return { id, deleted: true }
    },
    async getDomain() {
      return { table: () => ({ entries: () => tasks.entries(), get: id => tasks.get(id), put: (id, task) => tasks.set(id, task) }) }
    },
    serialize: work => work(),
  }
  return service
}

// `existingHome` starts a second runtime on a home the first one left: the restart the
// resume path reads its notes from.
function start(existingHome, seedState, options = {}) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-retired-'))
  if (existingHome === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seedState ?? team()))
  const schedule = scheduleService()
  const ctx = fakeContext({ services: { schedule } })
  // A delivery lands on the target's Agent; what it records is the proof a retired Bot
  // was woken (or, after the fix, that nothing was delivered at all).
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) {
      const inbox = { nextStep: [], nextTurn: [], remove() {} }
      inboxes.set(sessionId, inbox)
    }
    return inboxes.get(sessionId)
  }
  let sessions = 0
  // Every model call, so a path that must spend none can be read as a count (#1786),
  // and a path that must still review can be read as one.
  const requests = []
  const agent = sessionId => ({
    session: { id: sessionId, seq: 1, requestHeader: () => undefined },
    id: sessionId,
    status: 'idle',
    followup(message) { sent.push({ sessionId, message, kind: 'followup' }) },
    steer(message) { sent.push({ sessionId, message, kind: 'steer' }) },
    inject(message) { sent.push({ sessionId, message, kind: 'inject' }) },
    cancel() {},
    async whenIdle() {},
    async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
    inbox: inboxOf(sessionId),
    hideBlockingQuestion() {},
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
      async* stream(request) {
        requests.push(request)
        yield { type: 'text-delta', index: 0, text: '{"changes": [{"op": "add", "text": "The user reads long threads"}]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      create: async () => ({ sessionId: `gs${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: agent(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ events: [], records: [], hasMore: false }),
      prompt: async () => ({ accepted: true }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, ...options })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const userMessage = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const relay = (roomId, callId) => ctx.registeredTools.get('group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal: new AbortController().signal })
  // The Bot's answer to its group turn: a delivery source plus the reply text, the way DSH
  // reports the events of one turn.
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const memoryFile = botId => join(home, 'memory', 'bots', botId, 'MEMORY.md')
  const activeRows = sessionId => [...schedule.tasks.values()].filter(task => task.sessionId === sessionId && task.status === 'active')
  const stop = async ({ keepHome = false } = {}) => {
    await ctx.dispose()
    if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, schedule, call, tool, emit, userMessage, relay, answer, saved, memoryFile, activeRows, sent, requests, home, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 25))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}

// 1. track_tasks assignee — a card for a retired Bot wakes it through task-drive.
test('#1709 (1): a retired Bot cannot be a task assignee, so no card and no delivery', async (t) => {
  const { tool, saved, sent, stop } = start()
  t.after(stop)
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  await tool('track_tasks', { tasks: [{ group: 'Launch', title: 'Ship it', overall: true }] }, 'm1')
  const refused = await tool('track_tasks', { tasks: [{ group: 'Launch', title: 'Write docs', parent: 'Ship it', assignee: 'Writer' }] }, 'm1')
  assert.match(String(refused), /No single Bot named "Writer"/)
  const cards = Object.values(saved().tasks ?? {})
  assert.equal(cards.filter(card => card.ownerBotId === 'b2').length, 0, 'no card was written for the retired Bot')
  assert.deepEqual(sent.filter(entry => entry.sessionId === 'b2'), [], 'the retired Bot was not woken')
  // The live Bot keeps its path: the same card for Coder is written and it is woken.
  const made = await tool('track_tasks', { tasks: [{ group: 'Launch', title: 'Code it', parent: 'Ship it', assignee: 'Coder' }] }, 'm1')
  assert.match(String(made), /Code it/)
  assert.equal(Object.values(saved().tasks).filter(card => card.ownerBotId === 'b3').length, 1)
})

// 2. A group @Name turn — a retired Bot seated in the room still took a turn.
test('#1709 (2): a group @Name does not call a retired Bot, while a live one still answers', async (t) => {
  const { emit, userMessage, relay, tool, sent, answer, stop } = start()
  t.after(stop)
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  await emit('r1', userMessage('@Writer ping, @Coder take a look'))
  // Every Bot the line called takes its turn; each answer lets the next slot run.
  const running = relay('r1', 'round-1')
  const woken = []
  for (let at = 0; at < 4; at += 1) {
    const entry = await waitFor(() => sent.find(item => !woken.includes(item)))
    if (entry === undefined) break
    woken.push(entry)
    await answer(entry.sessionId, entry.message.source.exchangeId, 'On it.', at + 1)
  }
  await running
  assert.deepEqual(woken.map(entry => entry.sessionId), ['s-b3'], 'the retired Bot takes no turn, while the live one still answers')
})

// 3. attach_capability — a retired Bot still gained capabilities.
test('#1709 (3): a retired Bot gains no capability, while a live Bot still does', async (t) => {
  const { call, tool, saved, stop } = start()
  t.after(stop)
  const made = await call('capability-save', { name: 'probe-skill', kind: 'skill', content: 'Do the probe.' })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  assert.match(String(await tool('attach_capability', { name: 'probe-skill', bot: 'Writer' }, 'm1')), /No Bot named Writer/)
  assert.deepEqual(saved().bots.b2.capabilities ?? [], [])
  assert.match(await tool('attach_capability', { name: 'probe-skill', bot: 'Coder' }, 'm1'), /Attached probe-skill to Coder/)
  assert.deepEqual(saved().bots.b3.capabilities, ['probe-skill'])
})

// 4. remember scope: — a retired Bot still received memory writes.
test('#1709 (4): a retired Bot receives no memory write, while a live Bot still saves one', async (t) => {
  const { tool, saved, memoryFile, stop } = start()
  t.after(stop)
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  assert.match(await tool('remember', { text: 'Writes in Chinese', scope: 'Writer' }, 'm1'), /^No Bot named Writer/)
  assert.equal(existsSync(memoryFile('b2')), false, 'nothing was written into the retired Bot\'s memory')
  assert.match(await tool('remember', { text: 'Writes in Chinese', scope: 'Coder' }, 'm1'), /^Saved to Coder's memory/)
  assert.match(readFileSync(memoryFile('b3'), 'utf8'), /Writes in Chinese/)
  assert.equal(saved().bots.b3.id, 'b3')
})

// 5a. schedule-create — a retired target still got a live row bound to its chat Session.
test('#1709 (5a): schedule-create refuses a retired target, while a live one is accepted', async (t) => {
  const { call, tool, schedule, activeRows, stop } = start()
  t.after(stop)
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  const refused = await call('schedule-create', { target: 'b2', title: 'Nightly writing', prompt: 'Write', when: { kind: 'daily', time: '09:00', timeZone: 'UTC' } })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(refused.error.message, /No such Bot or group chat/)
  assert.deepEqual(activeRows('b2'), [], 'no row was armed on the retired Bot\'s chat')
  assert.equal(schedule.tasks.size, 0)
  const accepted = await call('schedule-create', { target: 'b3', title: 'Nightly coding', prompt: 'Code', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  assert.equal(activeRows('b3').length, 1)
})

// 5b. schedule-update — the same door, reached through updateSchedule's contentOf.
test('#1709 (5b): schedule-update refuses to move a task onto a retired Bot', async (t) => {
  const { call, tool, activeRows, stop } = start()
  t.after(stop)
  const made = await call('schedule-create', { target: 'b3', title: 'Nightly coding', prompt: 'Code', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  const id = activeRows('b3')[0].record.id
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  const refused = await call('schedule-update', { sessionId: 'b3', id, target: 'b2', title: 'Moved', prompt: 'Moved', when: { kind: 'keep' } })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(refused.error.message, /No such Bot or group chat/)
  assert.deepEqual(activeRows('b2'), [], 'no row on the retired Bot')
  assert.equal(activeRows('b3').length, 1, 'the live Bot keeps its task')
})

// 5c. schedule-copy — the copy target resolves beside contentOf and had no door either.
test('#1709 (5c): schedule-copy refuses a retired target', async (t) => {
  const { call, tool, activeRows, stop } = start()
  t.after(stop)
  const made = await call('schedule-create', { target: 'b3', title: 'Nightly coding', prompt: 'Code', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  const id = activeRows('b3')[0].record.id
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  const refused = await call('schedule-create', { target: 'b2', title: 'Copied', prompt: 'Copied', copyFrom: { sessionId: 'b3', id } })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(refused.error.message, /No such Bot or group chat/)
  assert.deepEqual(activeRows('b2'), [], 'nothing was copied onto the retired Bot')
  assert.equal(activeRows('b3').length, 1)
})

// 5d. Part B: retiring disarms the rows already armed on the Bot's own chat Session.
test('#1709 (5d): archiving pauses the active rows of the Bot\'s own chat, and says so', async (t) => {
  const { call, tool, schedule, activeRows, saved, stop } = start()
  t.after(stop)
  for (const [title, time] of [['Morning', '08:00'], ['Evening', '18:00']]) {
    const made = await call('schedule-create', { target: 'b3', title, prompt: 'Write', when: { kind: 'daily', time, timeZone: 'UTC' } })
    assert.equal(made.ok, true, JSON.stringify(made))
  }
  const other = await call('schedule-create', { target: 'm1', title: 'Chief brief', prompt: 'Brief', when: { kind: 'daily', time: '09:00', timeZone: 'UTC' } })
  assert.equal(other.ok, true, JSON.stringify(other))
  assert.equal(activeRows('b3').length, 2)

  const answer = await tool('archive_bot', { bot: 'Coder' }, 'm1')
  assert.match(answer, /^Archived Coder\./)
  assert.match(answer, /Paused 2 task\(s\)/, `the result says what it disarmed: ${answer}`)
  assert.deepEqual(activeRows('b3'), [], 'no row is left armed on the archived Bot\'s chat')
  assert.equal(Object.keys(saved().pausedSchedules ?? {}).length, 2, 'the paused rows are in state.pausedSchedules')
  assert.equal(schedule.tasks.size, 1, 'the unrelated live Bot keeps its task')
  assert.equal(activeRows('m1').length, 1)
  // And the retired Bot cannot take a new one afterwards.
  const refused = await call('schedule-create', { target: 'b3', title: 'Back', prompt: 'Back', when: { kind: 'daily', time: '07:00', timeZone: 'UTC' } })
  assert.equal(refused.ok, false, JSON.stringify(refused))
})

// 5d (b). A part hand-off moves the Bot to a fresh Session and leaves the earlier one
// behind, tasks and all (#896, #1436). Retiring looked only at the current part, so an old
// row stayed armed and kept firing a retired Bot's turn every day (#1799).
test('#1799: archiving disarms a task armed in an earlier part of the Bot\'s own chat', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-retired-'))
  const seeded = team()
  seeded.bots.b3.segments = [{ sessionId: 'b3-old', endedAt: 5 }]
  writeFileSync(join(home, 'state.json'), JSON.stringify(seeded))
  const { call, tool, schedule, activeRows, saved, stop } = start(home)
  t.after(stop)
  const made = await call('schedule-create', { target: 'b3', title: 'Current part', prompt: 'Write', when: { kind: 'daily', time: '08:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  // The row the earlier part armed before the hand-off: bound to that Session, the way a
  // task stays where it was made when the chat moves on.
  await schedule.create('b3-old', { title: 'Earlier part', prompt: 'Write', daily: { time: '09:00', time_zone: 'UTC' } })
  assert.equal(activeRows('b3').length, 1)
  assert.equal(activeRows('b3-old').length, 1)

  const answer = await tool('archive_bot', { bot: 'Coder' }, 'm1')
  assert.match(answer, /^Archived Coder\./)
  assert.match(answer, /Paused 2 task\(s\)/, `the count covers every part: ${answer}`)
  assert.deepEqual(activeRows('b3'), [], 'no row is left armed on the current part')
  assert.deepEqual(activeRows('b3-old'), [], 'no row is left armed on the earlier part either')
  assert.equal(schedule.tasks.size, 0, 'DSH holds none of the retired Bot\'s rows')
  const held = Object.values(saved().pausedSchedules ?? {})
  assert.deepEqual(held.map(entry => entry.sessionId).sort(), ['b3', 'b3-old'], 'each paused row keeps the part it came from')
  // The held old-part row stays paused: resuming it would arm a retired Bot's Session again,
  // which needs the record to carry its own part, not the current one.
  const listed = await tool('bot_schedules', {}, 'b3-old')
  assert.match(listed, /"Earlier part".*paused, own chat, earlier part/, `the old part's row reads paused: ${listed}`)
  const old = held.find(entry => entry.sessionId === 'b3-old')
  const resumed = await call('schedule-resume', { sessionId: 'b3-old', id: old.id })
  assert.equal(resumed.ok, false, JSON.stringify(resumed))
  assert.match(resumed.error.message, /No such Bot or group chat/)
  assert.deepEqual(activeRows('b3-old'), [], 'no row is armed on the retired Bot\'s earlier part again')
})

// 5d (c). The Bot's group seat is a Session of its own too (#1816): a row armed on
// `room.sessions[botId]` was not in the set `pauseBotSchedules` built, so a retired Bot's
// standup kept firing in the room every day. The room's own task (`room.id`) and another
// member's seat are not the Bot's, and stay armed.
test('#1816: archiving disarms a task armed in the Bot\'s group Session, and only that', async (t) => {
  const { tool, schedule, activeRows, saved, stop } = start()
  t.after(stop)
  // One row on the Bot's own chat, one on its seat in `Launch`.
  await schedule.create('b3', { title: 'Morning', prompt: 'Write', daily: { time: '08:00', time_zone: 'UTC' } })
  await schedule.create('s-b3', { title: 'Group standup', prompt: 'Stand up', daily: { time: '09:00', time_zone: 'UTC' } })
  // Guards: the room's own task and another member's seat.
  await schedule.create('r1', { title: 'Room retro', prompt: 'Retro', daily: { time: '10:00', time_zone: 'UTC' } })
  await schedule.create('s-b2', { title: 'Writer brief', prompt: 'Brief', daily: { time: '11:00', time_zone: 'UTC' } })
  assert.equal(activeRows('s-b3').length, 1, 'the group standup is armed before the archive')

  const answer = await tool('archive_bot', { bot: 'Coder' }, 'm1')
  assert.match(answer, /^Archived Coder\./)
  assert.match(answer, /Paused 2 task\(s\) across its chats\./, `the count covers the group seat: ${answer}`)
  assert.deepEqual(activeRows('b3'), [], 'no row is left armed on the own chat')
  assert.deepEqual(activeRows('s-b3'), [], 'no row is left armed on the Bot\'s group seat')
  const held = Object.values(saved().pausedSchedules ?? {})
  assert.deepEqual(held.map(entry => entry.sessionId).sort(), ['b3', 's-b3'], 'the group seat\'s row keeps its Session')
  // Not the room's, and not another member's: retiring one Bot never disarms the room.
  assert.equal(activeRows('r1').length, 1, 'the room\'s own task stays armed')
  assert.equal(activeRows('s-b2').length, 1, 'another member\'s group Session keeps its row')
  const listed = await tool('bot_schedules', {}, 's-b3')
  assert.match(listed, /"Group standup".*paused, group chat "Launch", session s-b3/, `the Bot reads its seat's row as paused: ${listed}`)
})

// The earlier parts of that seat are its Sessions too (#1816): a hand-off in a group
// leaves the seat's old Session behind, exactly as an own-chat hand-off does (#1799).
test('#1816: an earlier part of the Bot\'s group seat is disarmed too', async (t) => {
  const seeded = team()
  seeded.rooms.r1.segments = { b3: [{ sessionId: 's-b3-old', endedAt: 5 }] }
  const { tool, schedule, activeRows, stop } = start(undefined, seeded)
  t.after(stop)
  await schedule.create('s-b3-old', { title: 'Old standup', prompt: 'Stand up', daily: { time: '09:00', time_zone: 'UTC' } })
  await schedule.create('b3', { title: 'Morning', prompt: 'Write', daily: { time: '08:00', time_zone: 'UTC' } })

  const answer = await tool('archive_bot', { bot: 'Coder' }, 'm1')
  assert.match(answer, /Paused 2 task\(s\) across its chats\./, `the count covers the seat's earlier part: ${answer}`)
  assert.deepEqual(activeRows('s-b3-old'), [], 'no row is left armed on the earlier part of the group seat')
  assert.deepEqual(activeRows('b3'), [])
})

// 5e. schedule-resume — pausing a task and then retiring its Bot put the same row back:
// Resume re-creates the held record on the retired Bot's chat Session, so the door Part A
// closes on create/copy/update stayed open one step later (#1709).
test('#1709 (5e): schedule-resume refuses a paused task of a retired Bot', async (t) => {
  const { call, tool, schedule, activeRows, saved, stop } = start()
  t.after(stop)
  const made = await call('schedule-create', { target: 'b2', title: 'Nightly writing', prompt: 'Write', when: { kind: 'daily', time: '09:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  const id = activeRows('b2')[0].record.id
  const held = await call('schedule-pause', { sessionId: 'b2', id })
  assert.equal(held.ok, true, JSON.stringify(held))
  assert.deepEqual(activeRows('b2'), [], 'paused here, before the Bot retires')
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)

  const refused = await call('schedule-resume', { sessionId: 'b2', id })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(refused.error.message, /No such Bot or group chat/)
  assert.deepEqual(activeRows('b2'), [], 'no row is armed on the retired Bot\'s chat again')
  assert.equal(Object.keys(saved().pausedSchedules ?? {}).length, 1, 'the paused record stays where it was')
  assert.equal(schedule.tasks.size, 0)
})

// 6. task-drive — a card that predates the retirement still woke its Bot on the next drive,
// because the driver resolved the owner without the retired check (#1709). The card is the
// one a host starts with: a board row somebody else left behind.
test('#1709 (6): a card that predates the retirement wakes nobody', async (t) => {
  const seeded = team()
  seeded.bots.b3.fields['flybot-tree'].retired = true
  seeded.bots.b3.hidden = true
  seeded.tasks = {
    'task-left-behind': {
      id: 'task-left-behind', status: 'open', createdAt: 1, updatedAt: 1, requesterId: 'owner-1',
      ownerBotId: 'b3', title: 'Write docs', source: 'conversation', origin: { roomId: 'r1' },
      actors: [{ status: 'open', at: 1 }],
    },
  }
  const { ctx, sent, saved, stop } = start(undefined, seeded)
  t.after(stop)
  await ctx.taskDrive.consider()
  await ctx.taskDrive.settled()
  assert.deepEqual(sent.filter(entry => entry.sessionId === 'b3'), [], 'the retired Bot is not woken')
  assert.equal(saved().tasks['task-left-behind'].status, 'open', 'the row is left as it was')
})

// 6b. Retiring means to the board what deleting means (#1709): the live cards a Bot holds
// fail instead of waiting for a Bot that will not run again.
test('#1709 (6b): archiving fails the live cards the Bot held', async (t) => {
  const { ctx, tool, saved, sent, stop } = start()
  t.after(stop)
  await tool('track_tasks', { tasks: [{ group: 'Launch', title: 'Ship it', overall: true }] }, 'm1')
  assert.match(String(await tool('track_tasks', { tasks: [{ group: 'Launch', title: 'Write docs', parent: 'Ship it', assignee: 'Coder' }] }, 'm1')), /Write docs/)
  await ctx.taskDrive.settled()
  const card = () => Object.values(saved().tasks ?? {}).find(task => task.ownerBotId === 'b3')
  assert.equal(card().status, 'claimed', JSON.stringify(card()))
  assert.match(await tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Archived Coder\./)
  const after = card()
  assert.equal(after.status, 'failed', `the card is failed like a deleted Bot's: ${JSON.stringify(after)}`)
  assert.equal(after.actors.at(-1).why, 'the responsible Bot was retired')
  const before = sent.filter(entry => entry.sessionId === 'b3').length
  await ctx.taskDrive.consider()
  await ctx.taskDrive.settled()
  assert.equal(sent.filter(entry => entry.sessionId === 'b3').length, before, 'nothing more is delivered')
})

// 7. task-create — the client's own way in (client/index.js calls it) accepted a retired
// owner and wrote a card that the drive then delivered.
test('#1709 (7): task-create refuses a retired Bot as the owner, while a live one is accepted', async (t) => {
  const { call, tool, saved, stop } = start()
  t.after(stop)
  assert.match(await tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Archived Coder\./)
  const refused = await call('task-create', { botId: 'b3', title: 'Write docs' })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.equal(Object.values(saved().tasks ?? {}).filter(task => task.ownerBotId === 'b3').length, 0, 'no card was written for the retired Bot')
  const accepted = await call('task-create', { botId: 'b2', title: 'Write docs' })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
})

// 8. routeOpenTask — a plugin's route could hand an open card to a retired Bot.
test('#1709 (8): a plugin route cannot put an open card on a retired Bot', async (t) => {
  const { rt, call, tool, saved, stop } = start()
  t.after(stop)
  assert.match(await tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Archived Coder\./)
  rt.onTaskWrite = async () => ({ ownerBotId: 'b3' })
  const made = await call('task-create', { botId: 'm1', title: 'Routed card' })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal(saved().tasks[made.value.id].ownerBotId, 'm1', 'the retired Bot does not take the card')
  // A live Bot still takes the same route.
  rt.onTaskWrite = async () => ({ ownerBotId: 'b2' })
  const second = await call('task-create', { botId: 'm1', title: 'Second card' })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(saved().tasks[second.value.id].ownerBotId, 'b2')
})

// 9. openRework — sending a result back opened a second card on the same retired owner.
test('#1709 (9): sending work back opens no rework card on a retired Bot', async (t) => {
  const { call, tool, saved, stop } = start()
  t.after(stop)
  const created = await call('task-create', { botId: 'b3', title: 'Write docs' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const id = created.value.id
  for (const endpoint of ['task-accept', 'task-start']) {
    const moved = await call(endpoint, { id })
    assert.equal(moved.ok, true, `${endpoint}: ${JSON.stringify(moved)}`)
  }
  const returned = await call('task-return', { id, summary: 'Draft is ready' })
  assert.equal(returned.ok, true, JSON.stringify(returned))
  assert.equal(returned.value.status, 'result-ready')
  // A returned result stays for the requester even after retirement: that is the card a
  // send-back would reopen work from.
  assert.match(await tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Archived Coder\./)
  assert.equal(Object.values(saved().tasks).find(task => task.id === id).status, 'result-ready')
  const refused = await call('task-send-back', { id, note: 'Please tighten it' })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.deepEqual(Object.values(saved().tasks).filter(task => task.reworkOf === id), [], 'no rework card was born on the retired Bot')
})

// 10. hooks — a held send still verified only that the target exists, so approving it
// delivered to a Bot that had been retired while it waited.
test('#1709 (10): a held send to a retired Bot goes stale instead of being delivered', async (t) => {
  const { rt, call, tool, sent, stop } = start()
  t.after(stop)
  const flybot = rt.flybot
  flybot.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
  const held = await flybot.bot.send({ from: 'm1', to: 'b3', text: 'please take this', meta: { hold: true } })
  assert.equal(held.action, 'hold', JSON.stringify(held))
  assert.match(await tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Archived Coder\./)
  const decided = await call('flybot/decide', { id: held.approvalId, decision: 'approve' })
  assert.equal(decided.ok, true, JSON.stringify(decided))
  assert.equal(decided.value.status, 'stale', `the hold is stale: ${JSON.stringify(decided.value)}`)
  assert.match(String(decided.value.error ?? ''), /retired/)
  assert.deepEqual(sent.filter(entry => entry.sessionId === 'b3'), [], 'nothing was delivered to the retired Bot')
})

// 11. resume — a restart picked the interrupted turn of a retired Bot up again, which is a
// delivery to a Bot that no longer runs.
test('#1709 (11b): a restart does not send again what was queued for a retired Bot', async (t) => {
  const first = start()
  const home = first.home
  assert.match(await first.tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Archived Coder\./)
  await first.stop({ keepHome: true })
  // A delivery noted before the Bot was retired: the note is what the next start would send.
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {},
    queued: { b3: [{ at: Date.now(), args: { fromId: 'm1', toId: 'b3', role: 'request', text: 'queued before retirement', exchangeId: 'exchange-retired' } }] },
  }))
  const second = start(home)
  t.after(second.stop)
  await new Promise(resolve => setTimeout(resolve, 3_600))
  assert.deepEqual(second.sent.filter(entry => entry.sessionId === 'b3'), [], 'nothing queued is delivered to the retired Bot')
})

test('#1709 (11): a restart does not pick up a retired Bot\'s turn', async (t) => {
  const first = start()
  const home = first.home
  assert.match(await first.tool('archive_bot', { bot: 'Coder' }, 'm1'), /^Archived Coder\./)
  await first.stop({ keepHome: true })
  // What the last run left behind: one turn noted for the retired Bot's Session.
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: { b3: { botId: 'b3', since: 1 } }, queued: {} }))
  const second = start(home)
  t.after(second.stop)
  await new Promise(resolve => setTimeout(resolve, 3_600))
  assert.deepEqual(second.sent.filter(entry => entry.sessionId === 'b3'), [], 'the retired Bot is not woken by a restart')
})

// #1786: the group review that brings a lagging member along (#582) asked every member,
// and `reviewSession` only refused a Bot that no longer existed. A Bot archived after a
// turn was still billed a model call and still had its archived MEMORY.md rewritten on
// the next member's turn. Product measured `model calls: ["b2","b3"]` on a clean tree.
test('#1786: a retired Bot is not brought along by a lagging review, while a live member is', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-retired-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'reviewed.json'), JSON.stringify({ 'group:r1:m1': 5, 'group:r1:b2': 5 }))
  const log = [
    { who: 'User', text: 'Call me Lu from now on', seq: 6 },
    ...Array.from({ length: 39 }, (_, at) => ({ who: 'Coder', botId: 'b3', text: `Step ${at + 1}`, seq: at + 7 })),
  ]
  const seeded = team()
  seeded.rooms.r1 = { ...seeded.rooms.r1, sessions: { m1: 'g1', b2: 'g2', b3: 'g3' }, seq: 45, log }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seeded))
  const { ctx, tool, memoryFile, requests, stop } = start(home, undefined, { memoryReviewDelayMs: 0 })
  t.after(stop)
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  // Coder's turn ends: it is the member that brings the others along.
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await waitFor(() => (existsSync(memoryFile('m1')) ? true : undefined))
  await settle()
  await settle()
  // Coder's own turn and the live lagging member are reviewed; the retired Bot is not.
  assert.deepEqual(requests.map(request => request.sessionId).sort(), ['b3', 'm1'],
    `only live members are reviewed: ${JSON.stringify(requests.map(request => request.sessionId))}`)
  assert.equal(existsSync(memoryFile('b2')), false, 'the retired Bot keeps no memory file')
  assert.match(readFileSync(memoryFile('m1'), 'utf8'), /The user reads long threads/)
})

// 12. reach — a grant left on a retired Bot still let the friend's Bot in from outside and
// wake it, invisibly to the owner: retirement cleared the tree entry, not the sharing (#1801).
test('#1801: a retired Bot keeps no outside reach, so the friend\'s line is not delivered', async (t) => {
  const seeded = team()
  seeded.grants = {
    b2: [{ id: 'b2:@bob.bot::0', grantee: '@bob.bot' }],
    b3: [{ id: 'b3:@carol.bot::0', grantee: '@carol.bot' }],
  }
  const { rt, tool, sent, saved, stop } = start(undefined, seeded)
  t.after(stop)
  const friend = { kind: 'remote', handle: '@bob.bot', name: 'Bob' }
  const before = await rt.flybot.bot.send({ from: friend, to: 'b2', text: 'before the retirement' })
  assert.equal(before.action, 'allow', JSON.stringify(before))
  assert.equal(sent.filter(entry => entry.sessionId === 'b2').length, 1, 'the shared Bot takes the friend\'s line')
  assert.match(await tool('archive_bot', { bot: 'Writer' }, 'm1'), /^Archived Writer\./)
  const after = await rt.flybot.bot.send({ from: friend, to: 'b2', text: 'hello after' })
  assert.equal(after.action, 'deny', 'the retired Bot is not reachable from outside')
  assert.equal(sent.filter(entry => entry.sessionId === 'b2').length, 1, 'nothing was delivered after retirement')
  assert.deepEqual(saved().grants?.b2 ?? [], [], 'the grant went with the retirement')
  assert.deepEqual(saved().grants?.b3 ?? [], seeded.grants.b3, 'a live Bot keeps its own sharing')
})
