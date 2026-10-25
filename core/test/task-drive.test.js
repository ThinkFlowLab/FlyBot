// Unfinished conversation tasks wake the owning Bot (#1109). A wake is a follow-up
// in that Bot's own chat, or in its group Session for a subtask. A task waiting on
// an answer, a turn already open, and a wake that did not move the board do not
// start another one. An overall group card is the plan, not a turn.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { TASK_DRIVE_BACKOFF_MS } from '../src/host/task-drive.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'ChiefA', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    s: { id: 's', name: 'Writer', role: 'Write', sessionId: 's', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
    b: { id: 'b', name: 'BobBot', role: 'Help', sessionId: 'b', createdAt: 4, ownerId: 'owner-1' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 's', 'b'], admin: 'a', mode: 'everyone', named: true,
      sessions: { s: 's-war' }, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'member', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'ChiefA', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 's', role: 'member', displayName: 'Writer', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'b', role: 'member', displayName: 'BobBot', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-drive-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const inbox = {
        nextStep: [],
        nextTurn: [],
        remove(id) {
          const keep = message => message.id !== id
          const before = this.nextTurn.length + this.nextStep.length
          this.nextTurn = this.nextTurn.filter(keep)
          this.nextStep = this.nextStep.filter(keep)
          return this.nextTurn.length + this.nextStep.length !== before
        },
      }
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle', inbox,
        followup(message) { this.calls.push(message); this.inbox.nextTurn.push(message) },
        steer() {}, inject() {}, cancel() {}, async whenIdle() {},
      })
    }
    return agents.get(sessionId)
  }
  let created = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `made-${++created}` }),
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const track = (sessionId, args) => ctx.registeredTools.get('track_tasks').execute(args ?? {}, { agent: { id: sessionId } })
  const text = (sessionId) => (agents.get(sessionId)?.calls ?? []).map(message => message.content.map(block => block.text ?? '').join('\n')).join('\n')
  const calls = (sessionId) => agents.get(sessionId)?.calls ?? []
  const emit = (sessionId, type, data) => ctx.emitArgs('session/event', { id: sessionId }, { type, data, time: Date.now() })
  const idOf = (body, title) => {
    const line = body.split('\n').find(item => item.startsWith('- ') && item.includes(title))
    const id = line?.match(/task-[0-9a-f]+/)?.[0]
    assert.ok(id, body)
    return id
  }
  // DSH claims the queued follow-up when the turn starts, so the fake inbox drops it too.
  const beginWake = (sessionId) => {
    const message = calls(sessionId).at(-1)
    assert.ok(message, `${sessionId} has a continue turn`)
    agents.get(sessionId).inbox.remove(message.id)
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    emit(sessionId, 'turn/start', { turn: 1 })
    return message
  }
  const finishWake = async (sessionId) => {
    beginWake(sessionId)
    emit(sessionId, 'turn/end', { reason: { kind: 'completed' } })
    await ctx.taskDrive.settled()
  }
  return { ctx, rt, track, text, calls, emit, idOf, beginWake, finishWake, home }
}

test('an unfinished conversation task wakes the own chat with the next task', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [{ title: 'Draft the note', priority: 'high', column: 'not-started' }] })
  const id = app.idOf(body, 'Draft the note')
  assert.equal(app.calls('s').length, 1)
  assert.match(app.text('s'), /\[Continue task\]/)
  assert.match(app.text('s'), new RegExp(`Continue ${id} \\[high\\] Draft the note`))
  assert.equal(app.calls('s')[0].source.role, 'task')
})

test('a task waiting on an answer does not wake', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [{ title: 'Need a name', ask: 'Which name?' }] })
  assert.match(body, /Which name\?/)
  assert.equal(app.calls('s').length, 0)
})

test('an open turn is not woken twice, and the idle moment after it continues the task', async (t) => {
  const app = await start(t)
  app.emit('s', 'turn/start', { turn: 1 })
  await app.track('s', { tasks: [{ title: 'Draft the note', column: 'in-progress', progress: 10 }] })
  assert.equal(app.calls('s').length, 0, 'the turn that recorded the task is still open')
  app.emit('s', 'turn/end', { reason: { kind: 'completed' } })
  await app.ctx.taskDrive.settled()
  assert.equal(app.calls('s').length, 1)
  assert.match(app.text('s'), /\[Continue task\]/)
})

test('a second update while the wake is queued does not queue another', async (t) => {
  const app = await start(t)
  await app.track('s', { tasks: [{ title: 'Draft the note', column: 'not-started' }] })
  await app.track('s', { tasks: [{ title: 'Draft the note', note: 'Still drafting' }] })
  assert.equal(app.calls('s').length, 1)
})

test('finishing the task during its wake does not start another', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [{ title: 'Draft the note', column: 'not-started' }] })
  const id = app.idOf(body, 'Draft the note')
  app.beginWake('s')
  const done = await app.track('s', { tasks: [{ id, column: 'done' }] })
  assert.match(done, /done/)
  assert.equal(app.calls('s').length, 1, 'the wake turn is still open')
  app.emit('s', 'turn/end', { reason: { kind: 'completed' } })
  await app.ctx.taskDrive.settled()
  assert.equal(app.calls('s').length, 1)
})

test('marking the task done before the wake starts drops the queued turn', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [{ title: 'Draft the note', column: 'not-started' }] })
  const id = app.idOf(body, 'Draft the note')
  assert.equal(app.calls('s')[0] && app.calls('s').length, 1)
  await app.track('s', { tasks: [{ id, column: 'done' }] })
  assert.equal(app.calls('s').length, 1)
  const agent = await app.rt.resolveAgent('s')
  assert.equal(agent.inbox.nextTurn.length, 0)
})

test('remaining unfinished work wakes again after the board moves', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [
    { title: 'Draft the note', priority: 'urgent', column: 'not-started' },
    { title: 'File the note', priority: 'low', column: 'not-started' },
  ] })
  const urgent = app.idOf(body, 'Draft the note')
  const low = app.idOf(body, 'File the note')
  assert.equal(app.calls('s').length, 1)
  assert.match(app.text('s'), new RegExp(urgent))
  assert.doesNotMatch(app.text('s'), new RegExp(low))
  app.beginWake('s')
  await app.track('s', { tasks: [{ id: urgent, column: 'done' }] })
  app.emit('s', 'turn/end', { reason: { kind: 'completed' } })
  await app.ctx.taskDrive.settled()
  assert.equal(app.calls('s').length, 2)
  assert.match(app.calls('s')[1].content.map(block => block.text).join('\n'), new RegExp(`Continue ${low} \\[low\\] File the note`))
})

test('a wake that does not move the board waits, and a later change runs again', async (t) => {
  const app = await start(t)
  let now = 5_000_000
  app.ctx.taskDrive.now = () => now
  await app.track('s', { tasks: [{ title: 'Draft the note', column: 'not-started' }] })
  await app.finishWake('s')
  assert.equal(app.calls('s').length, 1, 'no progress, so no immediate second wake')
  await app.ctx.taskDrive.consider()
  assert.equal(app.calls('s').length, 1)
  now += TASK_DRIVE_BACKOFF_MS[0]
  await app.ctx.taskDrive.consider()
  assert.equal(app.calls('s').length, 2)
})

test('the higher priority task is the one named, and in-progress beats not-started', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [
    { title: 'Older draft', priority: 'high', column: 'in-progress', progress: 20 },
    { title: 'Fresh draft', priority: 'high', column: 'not-started' },
    { title: 'Someday', priority: 'low', column: 'in-progress', progress: 5 },
  ] })
  const older = app.idOf(body, 'Older draft')
  assert.match(app.text('s'), new RegExp(`Continue ${older} \\[high\\] Older draft`))
  assert.equal(app.calls('s').length, 1)
})

test('finishing the named task before its wake starts continues the next one', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [
    { title: 'Draft the note', priority: 'urgent', column: 'not-started' },
    { title: 'File the note', priority: 'low', column: 'not-started' },
  ] })
  const urgent = app.idOf(body, 'Draft the note')
  const low = app.idOf(body, 'File the note')
  await app.track('s', { tasks: [{ id: urgent, column: 'done' }] })
  assert.equal(app.calls('s').length, 2)
  assert.match(app.calls('s')[1].content.map(block => block.text).join('\n'), new RegExp(`Continue ${low} \\[low\\] File the note`))
  const agent = await app.rt.resolveAgent('s')
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.match(agent.inbox.nextTurn[0].content.map(block => block.text).join('\n'), new RegExp(low))
})

test('a group subtask wakes that group session and not the room or another Bot', async (t) => {
  const app = await start(t)
  const body = await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War', priority: 'urgent' },
    { title: 'Write the draft', parent: 'Ship the note', assignee: 'Writer', group: 'War', priority: 'high' },
  ] })
  app.idOf(body, 'Write the draft')
  assert.match(app.text('s-war'), /\[Continue task\]/)
  assert.match(app.text('s-war'), /Write the draft/)
  assert.equal(app.calls('s').length, 0, 'the subtask runs in the group session')
  assert.equal(app.calls('a').length, 0, 'the overall card does not wake its owner')
  assert.equal(app.calls('war').length, 0, 'the driver does not post into the room')
  assert.equal(app.calls('b').length, 0)
})

test('an overall task on its own does not wake anyone', async (t) => {
  const app = await start(t)
  const body = await app.track('a', { tasks: [{ title: 'Ship the note', overall: true, group: 'War' }] })
  assert.match(body, /overall/)
  assert.equal(app.calls('a').length, 0)
  assert.equal(app.calls('s').length, 0)
  assert.equal(app.calls('s-war').length, 0)
  assert.equal(app.calls('war').length, 0)
})

test('a subtask opens the member session when the Bot has not spoken in the group', async (t) => {
  const app = await start(t)
  await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Bob writes', parent: 'Ship the note', assignee: 'BobBot', group: 'War', priority: 'urgent' },
  ] })
  const sessionId = app.rt.state.rooms.war.sessions.b
  assert.equal(typeof sessionId, 'string')
  assert.notEqual(sessionId, 'b')
  assert.match(app.text(sessionId), /\[Continue task\]/)
  assert.match(app.text(sessionId), /Bob writes/)
  assert.equal(app.calls('b').length, 0)
  assert.equal(app.calls('war').length, 0)
})

test('group members advance their own subtasks in the same drive', async (t) => {
  const app = await start(t)
  const body = await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Write the draft', parent: 'Ship the note', assignee: 'Writer', group: 'War', priority: 'high' },
    { title: 'Check the facts', parent: 'Ship the note', assignee: 'Writer', group: 'War', priority: 'low' },
    { title: 'Bob writes', parent: 'Ship the note', assignee: 'BobBot', group: 'War', priority: 'urgent' },
  ] })
  const write = app.idOf(body, 'Write the draft')
  const check = app.idOf(body, 'Check the facts')
  const bob = app.idOf(body, 'Bob writes')
  const bobSession = app.rt.state.rooms.war.sessions.b
  assert.equal(typeof bobSession, 'string')
  assert.equal(app.calls('s-war').length, 1)
  assert.match(app.text('s-war'), new RegExp(`Continue ${write} \\[high\\] Write the draft`))
  assert.doesNotMatch(app.text('s-war'), new RegExp(check))
  assert.equal(app.calls(bobSession).length, 1)
  assert.match(app.text(bobSession), new RegExp(`Continue ${bob} \\[urgent\\] Bob writes`))
  assert.equal(app.calls('s').length, 0)
  assert.equal(app.calls('b').length, 0)
  assert.equal(app.calls('a').length, 0)
  assert.equal(app.calls('war').length, 0)
  await app.ctx.taskDrive.consider()
  assert.equal(app.calls('s-war').length, 1, 'a queued wake is not duplicated')
  assert.equal(app.calls(bobSession).length, 1)
})

test('one member already in a turn does not hold the other member back', async (t) => {
  const app = await start(t)
  app.emit('s-war', 'turn/start', { turn: 1 })
  const body = await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Write the draft', parent: 'Ship the note', assignee: 'Writer', group: 'War', priority: 'high' },
    { title: 'Bob writes', parent: 'Ship the note', assignee: 'BobBot', group: 'War', priority: 'urgent' },
  ] })
  const write = app.idOf(body, 'Write the draft')
  const bobSession = app.rt.state.rooms.war.sessions.b
  assert.equal(app.calls('s-war').length, 0, 'Writer is mid-turn, so that Session is not woken again')
  assert.equal(app.calls(bobSession).length, 1)
  app.emit('s-war', 'turn/end', { reason: { kind: 'completed' } })
  await app.ctx.taskDrive.settled()
  assert.equal(app.calls('s-war').length, 1)
  assert.match(app.text('s-war'), new RegExp(`Continue ${write} \\[high\\] Write the draft`))
  assert.equal(app.calls(bobSession).length, 1)
})

test('a member waiting on an answer stays quiet while another member is woken', async (t) => {
  const app = await start(t)
  const planned = await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Write the draft', parent: 'Ship the note', assignee: 'Writer', group: 'War', priority: 'high' },
  ] })
  const write = app.idOf(planned, 'Write the draft')
  assert.equal(app.calls('s-war').length, 1)
  app.beginWake('s-war')
  const asked = await app.track('s-war', { tasks: [{ id: write, ask: 'Which tone?' }] })
  assert.match(asked, /Which tone\?/)
  app.emit('s-war', 'turn/end', { reason: { kind: 'completed' } })
  await app.ctx.taskDrive.settled()
  const body = await app.track('a', { tasks: [
    { title: 'Bob writes', parent: 'Ship the note', assignee: 'BobBot', group: 'War', priority: 'urgent' },
  ] })
  app.idOf(body, 'Bob writes')
  const bobSession = app.rt.state.rooms.war.sessions.b
  assert.equal(app.calls('s-war').length, 1, 'a task waiting on an answer does not wake again')
  assert.equal(app.calls(bobSession).length, 1)
  await app.ctx.taskDrive.consider()
  assert.equal(app.calls('s-war').length, 1)
  assert.equal(app.calls(bobSession).length, 1)
})

test('a live group round defers the member wake until the round is over', async (t) => {
  const app = await start(t)
  app.rt.roomProgress.set('round-1', { roomId: 'war' })
  await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Write the draft', parent: 'Ship the note', assignee: 'Writer', group: 'War', priority: 'urgent' },
  ] })
  assert.equal(app.calls('s-war').length, 0)
  app.rt.roomProgress.delete('round-1')
  await app.ctx.taskDrive.consider()
  assert.equal(app.calls('s-war').length, 1)
  assert.equal(app.calls('war').length, 0)
})

test('a board card that is not a conversation task does not wake', async (t) => {
  const app = await start(t)
  const created = await app.rt.taskEndpoint('task-create', { botId: 's', title: 'Check the figures' }, null)
  assert.equal(created.source, undefined)
  assert.equal(app.calls('s').length, 0)
})

test('a Cordis context provides taskDrive instead of assigning it', async (t) => {
  // Live dsh applies this plugin on a Cordis 4 context whose fiber is already
  // active, and that proxy throws `cannot set property "taskDrive" without
  // provide` on a bare write (#1120). The fake context used above allows the
  // write, so this case is the host that actually starts.
  const { Context } = await import('@deepseek-ai/cordis')
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-drive-cordis-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, revision: 1, mainBotIds: [], members: {}, bots: {}, rooms: {}, grants: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {} }))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const fake = fakeContext()
  Object.assign(fake, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), stream: async function* () {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'made-1' }),
      resolveAgent: async id => ({ agent: { id, session: { id } } }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const root = new Context()
  for (const name of ['tools', 'systemPrompt', 'connection', 'llm', 'workspaceRegistry', 'sessionController', 'sessions', 'sessionTitle']) {
    root.provide(name, fake[name])
  }
  let pluginCtx
  const fiber = root.plugin({
    name: 'ds-bot',
    apply(ctx) {
      pluginCtx = ctx
      createRuntime(ctx, { home })
    },
  })
  t.after(() => fiber.dispose())
  await fiber
  const drive = pluginCtx.taskDrive
  assert.equal(typeof drive.settled, 'function')
  assert.equal(typeof drive.consider, 'function')
  let now = 42
  drive.now = () => now
  assert.equal(drive.now(), 42)
  await drive.settled()
  await drive.consider()
})

test('asking during the wake does not schedule another wake', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [{ title: 'Draft the note', column: 'in-progress', progress: 10 }] })
  const id = app.idOf(body, 'Draft the note')
  app.beginWake('s')
  const asked = await app.track('s', { tasks: [{ id, ask: 'Which tone?' }] })
  assert.match(asked, /Which tone\?/)
  app.emit('s', 'turn/end', { reason: { kind: 'completed' } })
  await app.ctx.taskDrive.settled()
  await app.ctx.taskDrive.consider()
  assert.equal(app.calls('s').length, 1)
})

// #1154: once a decision names an issue or PR, posting that comment is the Bot's work — the Bot
// holds the connector. So a task that is already decided still wakes it, and the cue says where.
test('a decision waiting to be posted wakes the Bot even after the task is decided (#1154)', async (t) => {
  const app = await start(t)
  const body = await app.track('s', { tasks: [{ title: 'Ship the fix', priority: 'high' }] })
  const id = app.idOf(body, 'Ship the fix')
  await app.finishWake('s')
  assert.equal(app.calls('s').length, 1)

  const href = 'https://github.com/ThinkFlowLab/FlyBot/issues/1154'
  const task = app.rt.state.tasks[id]
  task.status = 'accepted'
  task.writeBack = { target: href, at: Date.now(), state: 'pending', body: 'Accepted: Ship the fix' }
  writeFileSync(join(app.home, 'state.json'), JSON.stringify(app.rt.state))

  await app.ctx.taskDrive.consider()
  assert.equal(app.calls('s').length, 2, 'a decided task with a comment to post is still work')
  assert.match(app.text('s'), /Then post the decision comment on https:\/\/github\.com\/ThinkFlowLab\/FlyBot\/issues\/1154/)
  assert.match(app.text('s'), /postResult \{task: 'task-[0-9a-f]+', ok: true\}/)
})
