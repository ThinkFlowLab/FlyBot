import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { SOURCE_KIND } from '../src/host/constants.js'
import { install as installTurns } from '../src/host/turns.js'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/approval-notices.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
})

// One window: the platform's Notification, whether the page shows, and the work source.
function windowWith({ permission = 'granted', visibility = 'visible', prefs = {} } = {}) {
  const shown = []
  const opened = []
  function Notification(title, options) {
    const note = { title, ...options, closed: false, close() { note.closed = true } }
    shown.push(note)
    return note
  }
  Notification.permission = permission
  const listeners = new Set()
  let snapshot = { bots: {}, approvals: [] }
  const work = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (next) => { snapshot = next; for (const listener of listeners) listener() },
  }
  const roster = { prefs, getSnapshot: () => ({ byId: { b: { id: 'b', name: 'Writer' } }, roomsById: { r1: { id: 'r1', name: 'Ops' } }, prefs: roster.prefs }) }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, Notification,
    document: { visibilityState: visibility },
    window: { focus() {} },
  })
  return { ...module.exports, shown, opened, work, roster, openSession: id => opened.push(id) }
}

test('an approval that starts waiting while another conversation shows gets one notification', () => {
  const page = windowWith()
  page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => 'a', openSession: page.openSession, since: 100 })
  page.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', sessionId: 'gb', tool: 'pwsh', at: 200 }] })
  page.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', sessionId: 'gb', tool: 'pwsh', at: 200 }] })
  assert.deepEqual(page.shown.map(note => [note.title, note.body, note.tag]), [['Writer is waiting for your approval', 'Ops · pwsh', 'ds-bot-approval-x1']])
  page.shown[0].onclick()
  assert.deepEqual([page.opened, page.shown[0].closed], [['r1'], true])
})

test('no notification for the conversation on screen, for approvals older than the window, or without permission', () => {
  const onScreen = windowWith()
  onScreen.noticeApprovals({ work: onScreen.work, roster: onScreen.roster, shownSession: () => 'r1', openSession: onScreen.openSession, since: 100 })
  onScreen.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }, { id: 'x2', botId: 'b', sessionId: 'b', tool: 'pwsh', at: 50 }] })
  assert.equal(onScreen.shown.length, 0)

  const hidden = windowWith({ visibility: 'hidden' })
  hidden.noticeApprovals({ work: hidden.work, roster: hidden.roster, shownSession: () => 'r1', openSession: hidden.openSession, since: 100 })
  hidden.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }] })
  assert.equal(hidden.shown.length, 1)

  const denied = windowWith({ permission: 'default' })
  denied.noticeApprovals({ work: denied.work, roster: denied.roster, shownSession: () => 'a', openSession: denied.openSession, since: 100 })
  denied.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }] })
  assert.equal(denied.shown.length, 0)
})

const ended = (entries) => ({ bots: {}, approvals: [], ended: entries })

test('a turn of my own Bot that finishes or fails elsewhere gets one notification that says why and opens its chat (#353)', () => {
  const page = windowWith()
  page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => 'a', openSession: page.openSession, since: 100 })
  const done = { id: 'chat-b:1:200', botId: 'b', sessionId: 'chat-b', at: 200 }
  const broke = { id: 'g:2:300', botId: 'b', roomId: 'r1', at: 300, failed: 'upstream busy' }
  page.work.set(ended([done]))
  page.work.set(ended([done, broke]))
  page.work.set(ended([done, broke]))
  assert.deepEqual(page.shown.map(note => [note.title, note.body, note.tag]), [
    ['Writer finished', '', 'ds-bot-turn-chat-b:1:200'],
    ['Writer failed: upstream busy', 'Ops', 'ds-bot-turn-g:2:300'],
  ])
  page.shown[0].onclick()
  page.shown[1].onclick()
  assert.deepEqual([page.opened, page.shown.map(note => note.closed)], [['b', 'r1'], [true, true]])
  // A notification carries nothing to act on: no buttons, no reply.
  assert.equal(page.shown.some(note => 'actions' in note), false)
})

test('no turn notification for the chat on screen, for turns that ended before the window opened, or without permission', () => {
  const onScreen = windowWith()
  onScreen.noticeApprovals({ work: onScreen.work, roster: onScreen.roster, shownSession: () => 'chat-b', openSession: onScreen.openSession, since: 100 })
  onScreen.work.set(ended([{ id: 'e1', botId: 'b', sessionId: 'chat-b', at: 200 }, { id: 'e2', botId: 'b', sessionId: 'other', at: 50 }]))
  assert.equal(onScreen.shown.length, 0)

  const hidden = windowWith({ visibility: 'hidden' })
  hidden.noticeApprovals({ work: hidden.work, roster: hidden.roster, shownSession: () => 'chat-b', openSession: hidden.openSession, since: 100 })
  hidden.work.set(ended([{ id: 'e1', botId: 'b', sessionId: 'chat-b', at: 200 }]))
  assert.equal(hidden.shown.length, 1)

  const denied = windowWith({ permission: 'denied' })
  denied.noticeApprovals({ work: denied.work, roster: denied.roster, shownSession: () => 'a', openSession: denied.openSession, since: 100 })
  denied.work.set(ended([{ id: 'e1', botId: 'b', sessionId: 'chat-b', at: 200 }]))
  assert.equal(denied.shown.length, 0)
})

test('the Notifications switch turns off every kind, and switching it back on brings no old ones', () => {
  const page = windowWith({ prefs: { notifications: false } })
  page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => 'a', openSession: page.openSession, since: 100 })
  const approval = { id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }
  page.work.set({ bots: {}, approvals: [approval], ended: [{ id: 'e1', botId: 'b', sessionId: 'chat-b', at: 200 }] })
  assert.equal(page.shown.length, 0)
  page.roster.prefs = {}
  page.work.set({ bots: {}, approvals: [approval], ended: [{ id: 'e1', botId: 'b', sessionId: 'chat-b', at: 200 }, { id: 'e2', botId: 'b', sessionId: 'chat-b', at: 300 }] })
  assert.deepEqual(page.shown.map(note => note.tag), ['ds-bot-turn-e2'])
})

// The host side: which ended turns the window hears of.
function turnsHost({ bots, rooms = {}, groupOwners = new Map() } = {}) {
  let listener
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    isBotSession: () => true,
    roomOf: id => rooms[id],
    groupOwners,
    chatOwners: new Map(),
    botOf: id => bots[id],
    selfOf: id => groupOwners.get(id)?.botId ?? id,
    save: async () => {},
    deliver: async () => {},
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
    dropKickoff() {},
    flybotReplyRemote: async () => ({}),
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  const turn = (id, n, reason, source) => {
    emit(id, 'turn/start', { turn: n })
    if (source) emit(id, 'user/message', { content: [{ type: 'text', text: 'hi' }], source })
    emit(id, 'turn/end', { turn: n, reason })
  }
  return { rt, turn }
}

const completed = { kind: 'completed' }
const failed = { kind: 'error', error: { code: 'SERVER', message: 'upstream busy', status: 503 } }

test('the host lists finished and failed turns of my own Bots, not stopped, asked-by-a-Bot, friend or shared-room turns', () => {
  const { rt, turn } = turnsHost({
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Coder' }, f: { id: 'f', name: 'Pal', remote: { handle: '@pal' } } },
    rooms: { r1: { id: 'r1' }, face: { id: 'face', origin: 'face-to-face' } },
    groupOwners: new Map([['g1', { botId: 'b', roomId: 'r1' }], ['g2', { botId: 'b', roomId: 'face' }]]),
  })
  turn('b', 1, completed)
  turn('b', 2, failed)
  turn('b', 3, { kind: 'aborted', reason: { kind: 'user' } })
  turn('b', 4, completed, { kind: SOURCE_KIND, role: 'request', senderSessionId: 'a', exchangeId: 'x1', hop: 1 })
  turn('b', 5, completed, { kind: SOURCE_KIND, role: 'request', remote: { handle: '@pal' }, exchangeId: 'x2', hop: 1 })
  turn('f', 1, completed)
  turn('g1', 1, failed, { kind: SOURCE_KIND, role: 'room', exchangeId: 'r1x' })
  turn('g2', 1, completed, { kind: SOURCE_KIND, role: 'room', exchangeId: 'r2x' })
  assert.deepEqual(rt.endedView().map(({ id, at, ...entry }) => [id.split(':').slice(0, 2).join(':'), entry]), [
    ['b:1', { botId: 'b', sessionId: 'b' }],
    ['b:2', { botId: 'b', sessionId: 'b', failed: 'upstream busy' }],
    ['g1:1', { botId: 'b', roomId: 'r1', failed: 'upstream busy' }],
  ])
  for (let n = 10; n < 40; n++) turn('b', n, completed)
  // Past the last 20, the failure in r1 stays: it is still the latest turn there (#471).
  assert.deepEqual(rt.endedView().map(entry => entry.id.split(':').slice(0, 2).join(':')), ['g1:1', ...Array.from({ length: 20 }, (_, i) => `b:${20 + i}`)])
  turn('g1', 2, completed, { kind: SOURCE_KIND, role: 'room', exchangeId: 'r1y' })
  for (let n = 40; n < 60; n++) turn('b', n, completed)
  assert.equal(rt.endedView().length, 20)
  assert.ok(rt.endedView().every(entry => entry.failed === undefined))
})
