// P-689: rooms opened once per member before #2797 already carry one row per member in an existing
// state file. `#2801` only stops a *new* install from opening the second row: `sync()` reads a chat
// as "still here" whenever its room key is in this publish (`remote-chat.js:304-305`), and every one
// of the duplicate rows carries that same room key, so none is marked gone and nothing merges —
// eight rows stay, each with its own history, and `open()`/`deliver()` keep the handle-first route
// (`:254`, `:334`) so every member's line lands in its own duplicate row.
//
// This file is the red-first reading for that existing state. The store is the light one the other
// `remote-chat` tests use (a `state` object and the calls `sync`/`deliver` make), so the history is
// the part a real host keeps in the Session (`ctx.sessionController.page` reads it, `agent.followup`
// /`inject` + `ctx.sessions.flush` write it — the same pair `parts.js:835-846` uses to carry
// messages into a session). A merge that moves history any other way has to keep those two hooks,
// or this reading cannot see it.
//
// Readings, all on the base:
//   1. after one sync the room is one row, not eight;
//   2. the survivor's history holds every duplicate's line, in order, and none is lost;
//   3. a line from another member of the room lands in the survivor, not in that member's old row;
//   4. every readable line of all eight Sessions is still there afterwards, word for word, as the
//      same kind of line (an assistant reply is still an assistant reply), and the merge wrote no
//      message into any Session (`followups` empty) — the acceptance rule for #2804;
//   5. a duplicate row that already had earlier parts keeps them, in order;
//   6. each part starts where the next row was created, so the thread reads in creation order;
//   7. who has spoken in the room moves with it, and no contact record is left on a dead row;
//   8. the Session that becomes the chat is rebound to the survivor's route, or the next line typed
//      here is sent for a handle that no longer has a row;
//   9. an open question card on a duplicate row stays answerable (it moves to the chat's Session);
//  10. a room with more than one open card is not merged this round — nothing is written and both
//      cards stay — and the next sync after one answer joins the room with the card still waiting;
//  11. a caller that arrives during the merge's one `await` (the route select) finds one row and
//      writes nothing, so no Session becomes a part twice and no line shows twice.
//
// Reading 2 reads the history the way `partsOf` (parts.js:299-308) composes it: the chat's earlier
// parts, oldest first, then the Session that is current. The sketch keeps every duplicate Session
// and hangs it off the survivor as an earlier part (`bot.segments`), so nothing is copied and an
// assistant reply inside a duplicate is not re-inserted as a user line.

// Controls (must stay true): a fresh install opens one row per room; two names at one home and one
// name at two homes stay separate rows; a room that is already one row is not rewritten at all.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, REMOTE_PROVIDER } from '../src/host/remote-chat.js'
import { cut } from '../src/host/text.js'

// The publisher names a room once per member: same title, same home, one handle per member (#2797).
const ROOM = '123456 · 刘红升 2, flybot682b8a43, FlyBot'
const HOME = '@flybot682b8a43.home'
const HOME_NAME = 'FlyBot 682b8a43'
const member = (n, name = ROOM, home = HOME) => ({
  handle: `@member${n}.flybot682b8a43.home`, name, home, homeName: HOME_NAME,
})
const line = n => `line from member${n}`
const reply = n => `reply from member${n}`
const event = (text, seq) => ({ type: 'user/message', seq, time: seq + 1, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const answer = (text, seq) => ({ type: 'assistant/message', seq, time: seq + 1, data: { message: { content: [{ type: 'text', text }] } } })
const textOf = content => (Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : String(content ?? ''))
const members = () => [1, 2, 3, 4, 5, 6, 7, 8].map(n => member(n))

const emptyState = () => ({ version: 2, revision: 1, mainBotIds: [], members: {}, bots: {}, rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {}, tasks: {} })

// The existing state: one duplicate row per member, each with a line of its own history, all
// carrying the same room key (`home` + name) and a different handle.
const duplicates = ({ count = 8, withReplies = false } = {}) => {
  const bots = {}
  const sessions = new Map()
  for (let n = 1; n <= count; n += 1) {
    const id = `d${n}`
    bots[id] = {
      id,
      name: ROOM,
      createdAt: n,
      sessionId: `s${n}`,
      model: `${REMOTE_PROVIDER}/${member(n).handle}`,
      remote: { handle: member(n).handle, home: HOME, homeName: HOME_NAME, plugin: 'social' },
    }
    const events = [event(line(n), 0)]
    if (withReplies) events.push(answer(reply(n), 1))
    sessions.set(`s${n}`, events)
  }
  return { state: { ...emptyState(), bots }, sessions }
}

// A host of the shape `remote-chat.js` uses: the bot table, the Session read (`page`), the Session
// write (`agent.followup` / `inject`, then `flush`) and the route select the merge has to rebind.
// `followups` records every write so a reading can tell which session a line went to.
function host({ state, sessions }) {
  const followups = []
  const routes = []
  const nextSeq = id => {
    const events = sessions.get(id) ?? []
    const seq = events.reduce((max, event) => Math.max(max, Number(event.seq) + 1), 0)
    return { events, seq }
  }
  const append = (sessionId, message) => {
    const { events, seq } = nextSeq(sessionId)
    events.push({ type: 'user/message', seq, time: Date.now(), data: { content: message.content, source: message.source } })
    sessions.set(sessionId, events)
    followups.push({ sessionId, text: textOf(message.content), source: message.source })
  }
  let created = 0
  const rt = {
    state,
    ctx: {
      sessions: { flush: async () => {} },
      // The read side: a Session's events, oldest page last, as `chat-index.js:87-103` asks for them.
      sessionController: {
        page: async ({ address, throughSeq, beforeSeq, maxMessages }) => {
          const events = [...(sessions.get(address.sessionId) ?? [])].sort((a, b) => a.seq - b.seq)
          const upto = events.filter(event => event.seq <= throughSeq && (beforeSeq === undefined || event.seq < beforeSeq))
          const take = upto.slice(-(maxMessages ?? 100))
          return { records: take.map(event => ({ event })), hasMore: take.length < upto.length }
        },
      },
    },
    load: async () => {},
    save: async () => {},
    warn() {},
    // The maps `earlierPage` and `chat-index` resolve a Session through (store.js:1147-1170, exposed
    // at store.js:1201-1211), seeded the way `indexSessions` would seed them for this state.
    chatOwners: new Map(Object.values(state.bots).map(bot => [bot.sessionId, bot.id])),
    pastOwners: new Map(),
    // models.js:151 — the only way the chat's own Session changes the route a turn runs on.
    selectSessionModel: async (sessionId, route) => { routes.push({ sessionId, ...route }); return { selected: route } },
    botOf: id => state.bots[id],
    chatOf: id => state.bots[id]?.sessionId ?? id,
    resolveAgent: async sessionId => ({
      session: { id: sessionId, seq: (sessions.get(sessionId) ?? []).length },
      followup: message => append(sessionId, message),
      inject: message => append(sessionId, message),
    }),
    // roster.createBot's own bound (roster.js:65), so the name kept is the one the app would keep.
    createBot: async ({ name, model, remote }) => {
      const bot = { id: `b${++created}`, name: cut(String(name ?? '').trim(), 40).text, createdAt: 100 + created, sessionId: `sb${created}`, model, remote }
      state.bots[bot.id] = bot
      sessions.set(bot.sessionId, [])
      return bot
    },
  }
  install(rt)
  return { rt, followups, routes }
}

// A host whose route select does not answer until the reading lets it go: that select is the one
// `await` inside the merge, so it is where a second caller can arrive. `enteredGate` resolves the
// first time one gets there; every caller waits for `release()`.
function gatedHost({ state, sessions }) {
  const { rt, followups } = host({ state, sessions })
  let release
  let entered
  const gate = new Promise(resolve => { release = resolve })
  const enteredGate = new Promise(resolve => { entered = resolve })
  rt.selectSessionModel = async (sessionId, route) => {
    entered()
    await gate
    return { selected: route }
  }
  return { rt, followups, release, enteredGate }
}

// The survivor's chat, read the way the app composes it (parts.js:299-308): earlier parts oldest
// first, then the current Session. Every line in these Sessions is what the chat shows.
const partSessions = bot => [...(bot.segments ?? []).map(segment => segment.sessionId), bot.sessionId]
async function historyOfChat(rt, bot) {
  const out = []
  for (const sessionId of partSessions(bot)) out.push(...await historyOf(rt, sessionId))
  return out
}

// One Session's events, in order, as `{ type, text }` — what the thread renders, kind included, so
// an assistant reply that came back as a user line would show.
async function linesOfSession(rt, sessionId) {
  const page = await rt.ctx.sessionController.page({ address: { kind: 'session', sessionId }, throughSeq: 1_000_000, maxMessages: 1000 })
  return page.records
    .map(record => record.event)
    .filter(event => event.type === 'user/message' || event.type === 'assistant/message')
    .map(event => ({ type: event.type, text: textOf(event.data?.message?.content ?? event.data?.content) }))
}
async function linesOfChat(rt, bot) {
  const out = []
  for (const sessionId of partSessions(bot)) out.push(...await linesOfSession(rt, sessionId))
  return out
}

// One Session's user lines, in order.
async function historyOf(rt, sessionId) {
  return (await linesOfSession(rt, sessionId)).filter(entry => entry.type === 'user/message').map(entry => entry.text)
}

test('P-689: an existing state with eight rows for one room is one row after the first sync', async () => {
  const { state, sessions } = duplicates()
  const { rt } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  const rows = rt.remoteChats.list()
  assert.deepEqual(rows.map(row => row.id), ['d1'], `the room is one row, not ${rows.length}: ${JSON.stringify(rows.map(row => row.id))}`)
  assert.equal(rows[0].name, ROOM, 'and the row is the room, named the way the publisher names it')
})

test('P-689: the survivor holds every duplicate\'s line, in order, and nothing is lost', async () => {
  const { state, sessions } = duplicates()
  const { rt } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  // The row the list shows first is the one the chat would open: it has to hold every duplicate's
  // line. Reading the count here as well would hide which half is broken, so only the history is read.
  const rows = rt.remoteChats.list()
  const shown = state.bots[rows[0].id]
  const texts = await historyOfChat(rt, shown)
  assert.deepEqual(texts, [1, 2, 3, 4, 5, 6, 7, 8].map(line), `the survivor's history lost or reordered a duplicate's line: ${JSON.stringify(texts)}`)
})

test('P-689: a line from another member of the room lands in the survivor, not in its old duplicate row', async () => {
  const { state, sessions } = duplicates()
  const { rt, followups } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  const survivor = rt.remoteChats.list()[0]?.id
  assert.equal(survivor, 'd1', 'the oldest published row survives')
  const landed = await rt.remoteChats.deliver({ ...member(2), plugin: 'social', text: 'hello room' })
  assert.equal(landed, survivor, `member2's line went to ${landed}, not the room's one row (${survivor})`)
  const arrived = followups.filter(entry => entry.text.includes('hello room'))
  const current = state.bots[survivor].sessionId
  assert.deepEqual(arrived.map(entry => entry.sessionId), [current], `the line was written into ${JSON.stringify(arrived.map(entry => entry.sessionId))}, not the survivor's chat (${current})`)
  assert.equal(followups.length, 1, 'the merge wrote no message of its own into a Session')
  assert.deepEqual(rt.remoteChats.list().map(row => row.id), ['d1'], 'and no row came back for the duplicate handle')
})

// #2804's acceptance rule: after the merge every line the user can read is still there, word for
// word, as the same kind of line, and no Session was rewritten or written to.
test('P-689: every readable line survives the merge word for word, and no message is copied', async () => {
  const { state, sessions } = duplicates({ withReplies: true })
  const before = new Map([...sessions].map(([id, events]) => [id, structuredClone(events)]))
  const { rt, followups } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  const rows = rt.remoteChats.list()
  assert.deepEqual(rows.map(row => row.id), ['d1'], `the room is one row, not ${rows.length}`)
  const shown = state.bots[rows[0].id]
  const expected = [1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => [
    { type: 'user/message', text: line(n) },
    { type: 'assistant/message', text: reply(n) },
  ])
  // A part is opened by resolving its Session to the chat first, so every one of them has to still
  // belong to the survivor, the oldest one included.
  for (const sessionId of partSessions(shown)) {
    const owner = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
    assert.equal(owner, shown.id, `part ${sessionId} no longer belongs to the merged chat: ${owner}`)
  }
  const after = await linesOfChat(rt, shown)
  assert.deepEqual(after, expected, `a readable line is missing, reordered or changed kind: ${JSON.stringify(after)}`)
  for (const [id, events] of before) assert.deepEqual(sessions.get(id), events, `Session ${id} was rewritten`)
  assert.deepEqual(followups, [], 'the merge carried no message into a Session')
})

test('P-689: a duplicate row that already had earlier parts keeps them, in order', async () => {
  const { state, sessions } = duplicates()
  state.bots.d3.segments = [{ sessionId: 's3a', endedAt: 3.5 }, { sessionId: 's3b', endedAt: 3.7 }]
  sessions.set('s3a', [event('line from member3, earlier part 1', 0)])
  sessions.set('s3b', [event('line from member3, earlier part 2', 0)])
  const { rt } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  const shown = state.bots[rt.remoteChats.list()[0].id]
  assert.deepEqual((shown.segments ?? []).map(segment => segment.sessionId),
    ['s1', 's2', 's3a', 's3b', 's3', 's4', 's5', 's6', 's7'],
    `the earlier parts of a duplicate row were lost or reordered: ${JSON.stringify((shown.segments ?? []).map(segment => segment.sessionId))}`)
  assert.deepEqual([shown.segments[2].endedAt, shown.segments[3].endedAt], [3.5, 3.7], 'and keep their own boundaries')
  assert.deepEqual(await historyOfChat(rt, shown),
    ['line from member1', 'line from member2', 'line from member3, earlier part 1', 'line from member3, earlier part 2', 'line from member3', 'line from member4', 'line from member5', 'line from member6', 'line from member7', 'line from member8'],
    'every part is still readable, in creation order')
})

// `partsOf` (parts.js:299-308) reads a part's `startedAt` from the `endedAt` before it, and the first
// part's from `bot.createdAt`: an `endedAt` taken from its own row shifts every later part.
test('P-689: each part starts where the next row was created, so the thread reads in creation order', async () => {
  const { state, sessions } = duplicates()
  const { rt } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  const shown = state.bots[rt.remoteChats.list()[0].id]
  const earlier = shown.segments ?? []
  assert.deepEqual(earlier.map(segment => segment.endedAt), [2, 3, 4, 5, 6, 7, 8], `a part ends at the wrong row: ${JSON.stringify(earlier.map(segment => segment.endedAt))}`)
  const started = earlier.map((segment, index) => earlier[index - 1]?.endedAt ?? shown.createdAt)
  started.push(earlier.at(-1)?.endedAt ?? shown.createdAt)
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8], `a part starts at the wrong row: ${JSON.stringify(started)}`)
})

// Who has spoken here (#420) hangs off the Bot id, and a dead row would take it along.
test('P-689: who has spoken in the room moves to the survivor, and no contact record is orphaned', async () => {
  const { state, sessions } = duplicates()
  state.remoteContacts = { d2: { '@a': 100, '@b': 40 }, d5: { '@a': 50 } }
  state.bots.d2.friendLineAt = 200
  state.bots.d5.friendLineAt = 150
  state.bots.d1.friendLineAt = 120
  const { rt } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  assert.deepEqual(state.remoteContacts, { d1: { '@a': 50, '@b': 40 } }, `the senders seen in this room were lost: ${JSON.stringify(state.remoteContacts)}`)
  assert.equal(state.bots.d1.friendLineAt, 200, 'and the latest line that arrived still marks the row')
})

// A turn runs on the Session's own route (`parts.js:965-968`), and this file sends a line to the
// handle in it (`forward`), so the Session that becomes the chat has to speak for the survivor.
test('P-689: the Session that becomes the chat is rebound to the survivor\'s route', async () => {
  const { state, sessions } = duplicates()
  const { rt, routes } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  const shown = state.bots[rt.remoteChats.list()[0].id]
  assert.deepEqual(routes, [{ sessionId: shown.sessionId, provider: REMOTE_PROVIDER, model: member(1).handle }],
    `the chat's Session still runs the route of a deleted row: ${JSON.stringify(routes)}`)
})

// A question card is answered on the chat's current Session (channel.js:568-593 resolves an earlier
// part to it), so a card left open in one of these rows has to move up, the way a rotation moves it
// (parts.js:1005-1015): the call stays in the old part, the card does not.
test('P-689: a question left open on a duplicate row stays answerable after the merge', async () => {
  const { state, sessions } = duplicates()
  state.questions = { s2: { id: 'q1', callId: 'call-1', botId: 'd2', question: 'Which room?', options: [] } }
  const { rt } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  const shown = state.bots[rt.remoteChats.list()[0].id]
  assert.equal(state.questions[shown.sessionId]?.id, 'q1', 'the open card is gone from the chat')
  assert.equal(state.questions.s2, undefined, 'and the old part still claims it')
  assert.equal(state.questions[shown.sessionId].callId, undefined, 'the card keeps no call that belongs to the old part')
})

// A card is answered on the chat's current Session, and the merge carries at most one card up to it,
// so two rows waiting on two answers cannot both survive: `state.questions` is keyed by session id,
// and deleting the second row would take its card with it and leave that wait hanging. #2804
// acceptance 10: more than one open card holds the merge for this round, with nothing written, and
// the next sync after an answer joins the room and carries the card still waiting.
test('P-689: a room with two open question cards is not merged this round', async () => {
  const { state, sessions } = duplicates({ count: 2 })
  state.questions = {
    s1: { id: 'q1', callId: 'call-1', botId: 'd1', question: 'Which room?', options: [] },
    s2: { id: 'q2', callId: 'call-2', botId: 'd2', question: 'Which name?', options: [] },
  }
  const waiting = structuredClone(state.questions)
  const { rt, followups, routes } = host({ state, sessions })
  await rt.remoteChats.sync('social', members())
  const rows = rt.remoteChats.list().map(row => row.id)
  assert.deepEqual([...rows].sort(), ['d1', 'd2'], `the room was merged with two answers still open: ${JSON.stringify(rows)}`)
  assert.deepEqual(state.questions, waiting, `an open card was dropped or rewritten: ${JSON.stringify(state.questions)}`)
  assert.deepEqual([state.bots.d1.segments, state.bots.d2.segments, followups, routes], [undefined, undefined, [], []],
    'and the round wrote nothing at all')
  // One answer comes back: the next sync joins the room, and the card still waiting stays answerable.
  delete state.questions.s2
  await rt.remoteChats.sync('social', members())
  const after = rt.remoteChats.list().map(row => row.id)
  assert.deepEqual(after, ['d1'], `the room did not join after one answer came back: ${JSON.stringify(after)}`)
  const shown = state.bots.d1
  assert.equal(shown.sessionId, 's2', `the chat is not the newest row's Session: ${shown.sessionId}`)
  assert.equal(state.questions.s2?.id, 'q1', `the card still waiting is not on the chat's Session: ${JSON.stringify(state.questions)}`)
  assert.equal(state.questions.s1, undefined, 'and no earlier part still claims it')
  assert.equal(state.questions.s2.callId, undefined, 'the card keeps no call that belongs to the old part')
})

// `sync` and `deliver` do not serialise each other (`hooks.js` publishes `remoteChats.sync` without
// awaiting it while the inbox loop delivers), and the merge has one `await` in the middle of its
// writes. A caller that arrives in that await must find one row and write nothing: otherwise the
// boundaries and Sessions are appended a second time and the copy that reaches the state file is a
// line shown twice after a restart — #2804's "no line is copied" read backwards.
test('P-689: a caller that arrives during the route select does not merge the room a second time', async () => {
  const mergedOnce = async (rt, state, added, what) => {
    const rows = rt.remoteChats.list().map(row => row.id)
    assert.deepEqual(rows, ['d1'], `${what}: the room is not one row: ${JSON.stringify(rows)}`)
    const shown = state.bots.d1
    const parts = partSessions(shown)
    const twice = parts.filter((sessionId, index) => parts.indexOf(sessionId) !== index)
    assert.deepEqual(twice, [], `${what}: a Session is a part more than once, so its lines show twice: ${JSON.stringify(parts)}`)
    const texts = (await linesOfChat(rt, shown)).map(entry => entry.text)
    const seen = needle => texts.filter(text => text.includes(needle)).length
    for (const text of [line(1), line(2), line(3), ...added]) {
      assert.equal(seen(text), 1, `${what}: ${JSON.stringify(text)} shows ${seen(text)} times: ${JSON.stringify(texts)}`)
    }
    assert.equal(texts.length, 3 + added.length, `${what}: ${texts.length} lines for ${3 + added.length} written: ${JSON.stringify(texts)}`)
  }

  // Two deliveries that overlap on the one await in the merge.
  {
    const { state, sessions } = duplicates({ count: 3 })
    const { rt, release, enteredGate } = gatedHost({ state, sessions })
    const first = rt.remoteChats.deliver({ ...member(2), plugin: 'social', text: 'first new line' })
    await enteredGate
    const second = rt.remoteChats.deliver({ ...member(3), plugin: 'social', text: 'second new line' })
    release()
    await Promise.all([first, second])
    await mergedOnce(rt, state, ['first new line', 'second new line'], 'two overlapping deliveries')
  }

  // A sync and a delivery, the pair `hooks.js` produces without awaiting the sync.
  {
    const { state, sessions } = duplicates({ count: 3 })
    const { rt, release, enteredGate } = gatedHost({ state, sessions })
    const syncing = rt.remoteChats.sync('social', members())
    await enteredGate
    const delivered = rt.remoteChats.deliver({ ...member(2), plugin: 'social', text: 'a line while syncing' })
    release()
    await Promise.all([syncing, delivered])
    await mergedOnce(rt, state, ['a line while syncing'], 'a sync and a delivery')
  }
})

// Controls: #2797's one-row rule for a fresh install, and its two-row controls, stay exactly as
// they are. A merge that folds different names or different homes together would turn these red.
test('P-689 control: a fresh install still opens one row per room (#2797)', async () => {
  const sessions = new Map()
  const { rt, routes } = host({ state: emptyState(), sessions })
  await rt.remoteChats.sync('social', [member(1), member(2), member(3), member(4)])
  assert.equal(rt.remoteChats.list().length, 1, 'one room is still one row on a fresh install')
  await rt.remoteChats.sync('social', [member(1), member(2)])
  assert.equal(rt.remoteChats.list().length, 1, 'and a repeated sync adds nothing')
  assert.deepEqual(routes, [], 'a room that was never several rows is never rebound')
})

test('P-689 control: two names at one home, and one name at two homes, stay separate (#2797)', async () => {
  const sessions = new Map()
  const { rt } = host({ state: emptyState(), sessions })
  await rt.remoteChats.sync('social', [member(1, 'Helper'), member(2, 'Coder'), member(3, ROOM, '@flybot98b.home')])
  assert.equal(rt.remoteChats.list().length, 3, 'different names, and the same name at another home, are their own chats')
})

// A single row is not a merge: its history stays where it is and nothing is written to it.
test('P-689 control: one row for a room keeps its own history untouched', async () => {
  const sessions = new Map([['s1', [event('only line', 0)]]])
  const state = {
    ...emptyState(),
    bots: { d1: { id: 'd1', name: ROOM, createdAt: 1, sessionId: 's1', remote: { handle: member(1).handle, home: HOME, homeName: HOME_NAME, plugin: 'social' } } },
  }
  const { rt, followups, routes } = host({ state, sessions })
  await rt.remoteChats.sync('social', [member(1), member(2)])
  assert.equal(rt.remoteChats.list().length, 1, 'still one row')
  assert.deepEqual(await historyOf(rt, 's1'), ['only line'], 'a lone row is never rewritten')
  assert.deepEqual(followups, [], 'and no message was carried anywhere')
  assert.deepEqual(routes, [], 'and no route was touched')
})
