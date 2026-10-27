// #1254: an admin's @ in a group is work, not a discussion. When the room's task lead names one
// member with an issue/PR id and an imperative ("@Dev1 #1234 rebase and push"), the line is a
// dispatch: the host writes the member's card and the drive wakes it in its own chat (#1205), and
// the member gets no group part. A question, a plain @, a line from a member who does not divide
// the board, and a face-to-face room (which has no board) all keep the group turn they had.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { workDispatch } from '../src/host/work-dispatch.js'
import { fakeContext } from './fake-ctx.js'

const team = (room = {}) => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    b: { id: 'b', name: 'Dev1', role: 'Dev', sessionId: 'b', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 'b', 'c'], admin: 'a', mode: 'admin', named: true,
      sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'member', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'b', role: 'member', displayName: 'Dev1', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'c', role: 'member', displayName: 'Tester', joinedSeq: 0, joinedAt: 1 },
      ],
      ...room,
    },
  },
  grants: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
})

async function start(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-dispatch-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team(overrides)))
  const ctx = fakeContext()
  const agents = new Map()
  const idleWaiters = []
  const idle = (sessionId) => {
    if (sessionId !== undefined) agentOf(sessionId).status = 'idle'
    for (const resolve of idleWaiters.splice(0)) resolve()
  }
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
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
        session: { id: sessionId }, id: sessionId, calls, status: 'idle', inbox,
        followup(message) { calls.push(message); this.inbox.nextTurn.push(message) },
        steer(message) { calls.push(message) },
        inject() {},
        cancel() {},
        whenIdle() { return new Promise(resolve => idleWaiters.push(resolve)) },
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
  // A Bot's post into the room, as the relay queues it: the room's Session has already taken it.
  const post = (text, from = 'a') => ({ text, botId: from, name: rt.botOf(from)?.name ?? from })
  let rounds = 0
  // One group_relay run over the queued lines. A dispatch run ends by itself; a round that calls
  // a member is stopped by the test once its assertions are done.
  const relay = (lines) => {
    rt.roomInbox.set('war', lines)
    const stop = new AbortController()
    t.after(() => stop.abort())
    let value
    const done = ctx.registeredTools.get('group_relay')
      .execute({}, { agent: { id: 'war' }, callId: `relay-${++rounds}`, signal: stop.signal })
      .then(body => { value = JSON.parse(body) }, () => {})
    return { done, value: () => value, stop }
  }
  const room = () => rt.state.rooms.war
  const cards = () => Object.values(rt.state.tasks ?? {}).filter(task => task.origin?.roomId === 'war')
  const groupParts = botId => (room().sessions?.[botId] === undefined ? 0 : agentOf(room().sessions[botId]).calls.length)
  const wakeOf = botId => agentOf(botId).calls.find(message => message.source?.role === 'task')
  return { ctx, rt, agentOf, room, cards, groupParts, wakeOf, relay, post, idle }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}

test('the dispatch shape is an issue id and an imperative, never any @ (#1254)', () => {
  const one = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(workDispatch('@Dev1 #1234 rebase and push', { callees: [one[0]] }), {
    botId: 'a', issue: '#1234', title: '#1234 rebase and push', note: '#1234 rebase and push',
  })
  assert.ok(workDispatch('@Dev1 please fix #1234', { callees: [one[0]] }), 'the verb may come first')
  assert.ok(workDispatch('@Dev1 https://github.com/o/r/pull/1234 land it', { callees: [one[0]] }), 'a pull link is an id too')
  assert.ok(workDispatch('@Dev1 请按 #1254 修一下 dispatch', { callees: [one[0]] }), 'Chinese imperatives count')
  assert.equal(workDispatch('@Dev1 #1234 looks good to me', { callees: [one[0]] }), undefined, 'a remark is not a dispatch')
  assert.equal(workDispatch('@Dev1 #1234 which file?', { callees: [one[0]] }), undefined, 'a question stays a question')
  assert.equal(workDispatch('@Dev1 #1234 fix this?', { callees: [one[0]] }), undefined, 'the question mark wins over the imperative near the id')
  assert.equal(workDispatch('@Dev1 rebase and push', { callees: [one[0]] }), undefined, 'no issue id, no card')
  assert.equal(workDispatch('@Dev1 #1234 rebase', { callees: one }), undefined, 'two members are not one assignee')
})

test('an admin @ on an issue writes the card and wakes the member instead of opening a round (#1254)', async (t) => {
  const app = await start(t)
  const run = app.relay([app.post('@Dev1 #1234 rebase and push')])
  await run.done
  assert.deepEqual(app.room().sessions, {}, 'no member Session was opened in the room')
  assert.equal(app.rt.roomProgress.size, 0)
  const card = app.cards().find(task => task.ownerBotId === 'b')
  assert.ok(card, 'the dispatch wrote a card for Dev1')
  assert.equal(card.title, '#1234 rebase and push')
  assert.equal(card.note, '#1234 rebase and push')
  assert.equal(card.status, 'open', 'the host assigns; the member claims on its own turn')
  assert.equal(card.source, 'conversation')
  const wake = app.wakeOf('b')
  assert.ok(wake, 'Dev1 is woken in its own chat')
  assert.match(wake.content.map(block => block.text ?? '').join('\n'), new RegExp(`Continue ${card.id} \\[normal\\] #1234 rebase and push`))
  assert.deepEqual(run.value(), { replies: [], passed: [] }, 'no group part, no pass either')
})

test('a dispatch on a card that exists updates that card instead of writing a second one (#1254)', async (t) => {
  const app = await start(t)
  await app.relay([app.post('@Dev1 #1234 rebase onto main')]).done
  const [first] = app.cards()
  assert.ok(first)
  const { id, note, updatedAt } = first
  await app.relay([app.post('@Dev1 #1234 then push the branch')]).done
  assert.equal(app.cards().length, 1, 'one card for one issue')
  const [again] = app.cards()
  assert.equal(again.id, id)
  assert.equal(again.note, '#1234 then push the branch')
  assert.notEqual(again.note, note)
  assert.ok(again.updatedAt > updatedAt, 'the update moves the card, so the drive wakes it')
})

test('a question to a member is still its group turn (#1254)', async (t) => {
  const app = await start(t)
  const run = app.relay([app.post('@Dev1 #1234 which file should I change?')])
  await settle(() => app.room().sessions.b !== undefined)
  assert.equal(app.cards().length, 0, 'a question writes no card')
  run.stop.abort()
  await run.done
})

test('a human naming the admin still gets the admin\'s group turn (#1254)', async (t) => {
  const app = await start(t)
  const run = app.relay([{ text: '@Chief 现在 token 是哪个？', authorId: 'owner-1', authorKind: 'human', authorName: 'Alice' }])
  await settle(() => app.room().sessions.a !== undefined)
  assert.equal(app.cards().length, 0, 'a person\'s line is not a board write')
  run.stop.abort()
  await run.done
})

test('a plain @ about an issue is not a dispatch (#1254)', async (t) => {
  const app = await start(t)
  const run = app.relay([app.post('@Dev1 #1234 looks good to me')])
  await settle(() => app.room().sessions.b !== undefined)
  assert.equal(app.cards().length, 0, 'a remark keeps the group turn it had')
  run.stop.abort()
  await run.done
})

test('a member who does not divide the board keeps the round (#1254)', async (t) => {
  const app = await start(t)
  const run = app.relay([app.post('@Dev1 #1234 rebase and push', 'c')])
  await settle(() => app.room().sessions.b !== undefined)
  assert.equal(app.cards().length, 0, 'only the task lead dispatches to the board')
  run.stop.abort()
  await run.done
})

test('a face-to-face room has no board, so a dispatch stays a turn (#1254)', async (t) => {
  const app = await start(t, { origin: 'face-to-face' })
  const run = app.relay([app.post('@Dev1 #1234 rebase and push')])
  await settle(() => app.room().sessions.b !== undefined)
  assert.equal(app.cards().length, 0)
  run.stop.abort()
  await run.done
})

test('the same dispatch inside a running round is a board assign, not a second call (#1254)', async (t) => {
  const app = await start(t)
  const run = app.relay([{ text: '@Dev1 say hello', authorId: 'owner-1', authorKind: 'human', authorName: 'Alice' }])
  await settle(() => app.room().sessions.b !== undefined)
  app.agentOf('war').status = 'running'
  await app.rt.postToRoom(app.room(), { id: 'a', name: 'Chief' }, '@Tester #1234 rebase and push', { hop: 0, origin: 'owner' })
  await settle(() => app.cards().some(task => task.ownerBotId === 'c'))
  assert.equal(app.room().sessions.c, undefined, 'Tester was not called inside the round')
  assert.equal(app.cards().find(task => task.ownerBotId === 'c').title, '#1234 rebase and push')
  await settle(() => app.wakeOf('c') !== undefined)
  app.idle('war')
  run.stop.abort()
  await run.done
})

// A card the member already holds for the issue, parked where the drive does not read it: the
// dispatch has to restart it through the one edge that exists, or the note moves and nobody wakes.
const parked = (status, extra = {}) => {
  const at = Date.now() - 1000
  return {
    id: `task-${status}`, status, createdAt: at, updatedAt: at,
    requesterId: 'owner-1', ownerBotId: 'b', title: '#1234 rebase and push', note: 'the first pass',
    source: 'conversation', origin: { roomId: 'war' }, actors: [{ status: 'open', at, by: 'dispatch' }],
    ...extra,
  }
}

test('a dispatch restarts a card that is result-ready, so the drive wakes the member (#1254)', async (t) => {
  const app = await start(t)
  app.rt.state.tasks['task-result-ready'] = parked('result-ready')
  await app.relay([app.post('@Dev1 #1234 then push the branch')]).done
  assert.equal(app.cards().length, 1, 'the parked card is reused, not duplicated')
  const card = app.cards()[0]
  assert.equal(card.status, 'working', 'result-ready → working is the edge the state machine already has')
  assert.equal(card.note, '#1234 then push the branch')
  assert.equal(card.actors.at(-1).by, 'dispatch')
  assert.ok(app.wakeOf('b'), 'working is driving, so the member is woken in its own chat')
})

test('a dispatch reuses a card blocked on an input and restarts it (#1254)', async (t) => {
  const app = await start(t)
  app.rt.state.tasks['task-blocked'] = parked('blocked', { waitingFor: 'input', inputRequest: { id: 'q1', question: 'which file?' } })
  await app.relay([app.post('@Dev1 #1234 rebase onto main')]).done
  assert.equal(app.cards().length, 1, 'one issue is one card, even while the old one waits on a person')
  const card = app.cards()[0]
  assert.equal(card.status, 'working')
  assert.equal(card.waitingFor, undefined, 'the dispatch answers the wait, so the card drives again')
  assert.ok(app.wakeOf('b'))
})

// #1331: a card is that issue's card only when its own fields name the issue. The card below is
// titled `#999` and mentions `#1234` in its note as a blocker; reusing it for the dispatch rewrote
// the #999 note, restarted it (waking Dev1 for #1234 on the wrong card) and left #1234 cardless.
// `title`/`target` decide first; the note is read only for a card that names no issue of its own,
// which is what keeps the `:161` case — its card names the issue in the title — resetting one card.
test('a dispatch does not reclaim a card that only mentions the issue in its note (#1331)', async (t) => {
  const app = await start(t)
  app.rt.state.tasks['task-999'] = parked('blocked', {
    id: 'task-999', title: '#999 fix the other thing', note: 'blocked on #1234 first',
    waitingFor: 'input', inputRequest: { id: 'q9', question: 'which file?' },
  })
  const before = { ...app.rt.state.tasks['task-999'] }
  await app.relay([app.post('@Dev1 #1234 rebase and push')]).done
  const other = app.rt.state.tasks['task-999']
  assert.equal(other.note, 'blocked on #1234 first', "a mention in the note is not the card's issue")
  assert.equal(other.status, 'blocked', 'the #999 card is not restarted for #1234')
  assert.equal(other.updatedAt, before.updatedAt, 'and nothing about it moved')
  assert.equal(other.actors.length, before.actors.length, 'no status entry was appended for #1234')
  const fresh = app.cards().find(task => task.id !== 'task-999')
  assert.ok(fresh, 'the dispatch wrote a card that names #1234')
  assert.equal(fresh.title, '#1234 rebase and push')
  assert.equal(app.cards().length, 2, 'two issues, two cards')
})

// The other half of #1331's narrowing: a card whose own fields name no issue is still that
// issue's card when the note names it. Without this fallback the title check would strand the cards
// written before a dispatch put the id in the title, and one issue would grow a second card.
test('a card that names the issue only in its note is still that issue\'s card (#1331)', async (t) => {
  const app = await start(t)
  app.rt.state.tasks['task-note-only'] = parked('working', {
    id: 'task-note-only', title: 'rebase and push', note: 'from #1234 please',
  })
  await app.relay([app.post('@Dev1 #1234 then push the branch')]).done
  assert.equal(app.cards().length, 1, 'the note-only card is reused, so no second card appears')
  const card = app.rt.state.tasks['task-note-only']
  assert.equal(card.note, '#1234 then push the branch', 'the dispatch still rewrites the note it read')
  assert.equal(card.status, 'working')
  assert.ok(app.wakeOf('b'), 'the update moves the card, so the drive wakes the member')
})

test('a stored card with no actors is updated, never half-written (#1254)', async (t) => {
  const app = await start(t)
  const { actors, ...bare } = parked('working')
  app.rt.state.tasks['task-bare'] = { ...bare, status: 'claimed' }
  await app.relay([app.post('@Dev1 #1234 finish the branch')]).done
  const card = app.cards()[0]
  assert.equal(card.note, '#1234 finish the branch')
  assert.ok(Array.isArray(card.actors), 'the append starts a list instead of throwing after the note moved')
  assert.deepEqual(card.actors.map(actor => actor.by), ['dispatch'])
  assert.ok(app.wakeOf('b'), 'the save ran, so the drive woke the member')
})

test('a dispatch restarts a result-ready card that has no actors, without throwing (#1254)', async (t) => {
  const app = await start(t)
  // A card stored before `actors` existed. The restart goes through `transition()` → `record()`,
  // which pushes onto `task.actors` with no guard, so a bare field throws after the note moved and
  // before the save: the member is never woken, and the card is left half-written.
  const { actors, ...bare } = parked('result-ready')
  app.rt.state.tasks['task-result-ready-bare'] = bare
  const card = await app.rt.assignFromDispatch({
    roomId: 'war', botId: 'b', issue: '#1234', note: '#1234 finish the branch', by: 'a',
  })
  assert.ok(card, 'the card write went through')
  assert.equal(card.status, 'working', 'the restart edge still applies to a card with no history')
  assert.ok(Array.isArray(card.actors), 'the restart starts the list instead of throwing into it')
  assert.equal(card.actors.length, 1, 'one entry for the restart, none invented')
  assert.equal(card.actors[0].by, 'dispatch')
  assert.equal(card.note, '#1234 finish the branch')
  assert.ok(app.wakeOf('b'), 'the save ran, so the drive woke the member')
})

test('a dispatch whose card write fails still calls the member inside the round (#1254)', async (t) => {
  const app = await start(t)
  const run = app.relay([{ text: '@Dev1 say hello', authorId: 'owner-1', authorKind: 'human', authorName: 'Alice' }])
  await settle(() => app.room().sessions.b !== undefined)
  app.agentOf('war').status = 'running'
  const live = () => [...app.rt.roomProgress.values()].find(round => round.roomId === 'war')
  const pending = () => (live()?.calls ?? []).filter(call => call.callees.some(bot => bot.id === 'c'))
  // The board refuses the write: the round's own call is the fallback, or the member is never told.
  app.rt.assignFromDispatch = async () => undefined
  await app.rt.postToRoom(app.room(), { id: 'a', name: 'Chief' }, '@Tester #1234 rebase and push', { hop: 0, origin: 'owner' })
  await settle(() => pending().length === 1)
  assert.equal(app.cards().length, 0, 'the write failed, so there is no card to trust')
  assert.equal(pending()[0].by, 'a')
  app.idle('war')
  run.stop.abort()
  await run.done
})

test('a dispatch whose card write fails still opens the member\'s turn (#1254)', async (t) => {
  const app = await start(t)
  app.rt.assignFromDispatch = async () => undefined
  const run = app.relay([app.post('@Dev1 #1234 rebase and push')])
  await settle(() => app.room().sessions.b !== undefined)
  assert.equal(app.cards().length, 0)
  run.stop.abort()
  await run.done
})
