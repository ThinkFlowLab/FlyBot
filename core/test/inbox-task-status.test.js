import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { columnOf } from '../src/shared/task-board.js'

// #1739: the Inbox and the Board must read one task row the same way. The row's status is the
// only source; neither view derives a state from session or turn recency, and a card's age is
// the row's own started-at, never its creation — a row that never started has no age.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/inbox.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, Date, Promise,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { inboxModel } = module.exports

const NOW = Date.UTC(2026, 10, 29, 23, 0, 0)
const HOUR = 3_600_000
const roster = {
  self: { memberId: 'm1' },
  bots: [{ id: 'b1', name: 'Chief', ownerId: 'm1', sessionId: 's1' }],
  rooms: [],
}
roster.byId = Object.fromEntries(roster.bots.map(bot => [bot.id, bot]))
roster.roomsById = {}
const row = (id, status, extra = {}) => ({
  id, status, title: `Task ${id}`, ownerBotId: 'b1', requesterId: 'm1', origin: {},
  createdAt: NOW - 63 * HOUR, updatedAt: NOW - 63 * HOUR, actors: [], ...extra,
})
// The reported set: five rows that were never claimed. The board paints them Not started (0/5).
const neverStarted = ['t1', 't2', 't3', 't4', 't5'].map(id => row(id, 'open'))
const claimed = row('t6', 'claimed', { actors: [{ status: 'claimed', at: NOW - 63 * HOUR }] })
const working = row('t7', 'working', {
  createdAt: NOW - 70 * HOUR,
  updatedAt: NOW - 2 * HOUR,
  actors: [{ status: 'claimed', at: NOW - 70 * HOUR }, { status: 'working', at: NOW - 63 * HOUR }],
})
const workingNoLog = row('t8', 'working', { createdAt: NOW - 70 * HOUR, updatedAt: NOW - 3 * HOUR })
const accepted = row('t9', 'accepted', { updatedAt: NOW - HOUR })
const tasks = [...neverStarted, claimed, working, workingNoLog, accepted]
const model = inboxModel({ roster, work: {}, tasks, sessions: { byId: {} }, now: NOW })
const ids = list => Array.from(list, card => String(card.id))

test('a row the board paints Not started is not an In progress card in the Inbox (#1739)', () => {
  // The reported defect: Board 0/5 Not started while the Inbox showed the same five rows as
  // In progress for 63h.
  assert.deepEqual(ids(model.progress), ['task:t7', 'task:t8'])
  for (const task of [...neverStarted, claimed, accepted]) {
    assert.ok(!ids(model.progress).includes(`task:${task.id}`), `${task.id} (${task.status}) must not be In progress`)
  }
})

test('both views read the same row the same way: In progress is exactly the board in-progress column', () => {
  const boardInProgress = tasks.filter(task => columnOf(task) === 'in-progress').map(task => `task:${task.id}`)
  assert.deepEqual(ids(model.progress), boardInProgress)
  const boardNotStarted = tasks.filter(task => columnOf(task) === 'not-started')
  assert.equal(boardNotStarted.length, 6)
  // The Inbox shows no card at all for those rows, so it can show no age for them either.
  assert.deepEqual(ids(model.progress).filter(id => boardNotStarted.some(task => `task:${task.id}` === id)), [])
})

test('a card age comes from the row clock: the moment it started, never its creation', () => {
  const card = model.progress.find(entry => entry.id === 'task:t7')
  assert.equal(card.since, NOW - 63 * HOUR)
  const fallback = model.progress.find(entry => entry.id === 'task:t8')
  assert.equal(fallback.since, NOW - 3 * HOUR, 'a working row with no transition log ages from its own updatedAt')
  for (const entry of model.progress) assert.ok(typeof entry.since === 'number' && entry.since <= NOW)
})
