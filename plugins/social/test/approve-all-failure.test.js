// #3093: a batch's failures were reported only in the dock's one error line. For a Bot Social hold
// the card keeps the reason itself (#3075), but a local hold was left out of that record on the
// ground that the host describes its own sends — and the host does not describe a decision it
// refused. So a batch in a Bot's chat said "Eve: the hold is stale Bob: the hold is stale" in a line
// the next click clears and a chat switch drops, while both cards still read "Waiting for approval".
// A local hold whose dispatch failed is the same shape from the other side: the host answers
// normally with the approval it saved as failed, so the batch counted it as a send and told the
// person "Sent to Eve, Bob" for messages that never left.
// This file drives the dock the way the app does — the real effects, the real module-level record —
// because both halves are only visible after the click, in what the cards say next.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const live = { inst: null, idx: 0, rIdx: 0, eIdx: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'F',
  Component: class {},
  useState(init) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
    const slot = inst.hooks[i]
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; inst.dirty = true }]
  },
  useRef(init) {
    const { inst } = live
    const i = live.rIdx++
    if (!(i in inst.refs)) inst.refs[i] = { current: init }
    return inst.refs[i]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.eIdx++
    inst.effects.push([i, fn, deps])
  },
}
for (const name of ['useMemo', 'useCallback', 'useLayoutEffect', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'memo', 'forwardRef', 'createContext', 'createPortal', 'cloneElement', 'isValidElement', 'startTransition']) reactStub[name] = (value) => value

globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

// The browser bundle registers its factory once; one load is one module, so two mounts of it share
// the dock's module-level record — the way a chat switch keeps it in the app.
function loadDock() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? reactStub : {}))) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/social')
}

const fresh = () => ({ hooks: {}, refs: {}, effects: [], dirty: false })
function render(Component, inst, props = inst.props) {
  live.inst = inst
  live.idx = 0
  live.rIdx = 0
  live.eIdx = 0
  inst.effects = []
  inst.props = props
  inst.dirty = false
  const out = Component(props)
  inst.rendered = true
  return out
}
// A child component element is a function in `type`: it is called to see the card it draws, with its
// own hook slots, the way React gives it its own.
function mount(element) {
  const outer = { inst: live.inst, idx: live.idx, rIdx: live.rIdx, eIdx: live.eIdx }
  live.inst = fresh()
  live.idx = 0
  live.rIdx = 0
  live.eIdx = 0
  const out = element.type(element.props ?? {})
  live.inst = outer.inst
  live.idx = outer.idx
  live.rIdx = outer.rIdx
  live.eIdx = outer.eIdx
  return out
}
function drawn(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(drawn).join(' ')
  if (typeof node.type === 'function') return drawn(mount(node))
  return (node.children ?? []).map(drawn).join(' ')
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
// A frame is drawn and then every effect runs, as React does on mount.
async function frame(app, inst, props) {
  render(app.ChatApprovalDock, inst, props)
  for (const [, fn] of inst.effects) fn()
  await tick()
  return render(app.ChatApprovalDock, inst, props)
}
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  if (typeof node.type === 'function') return find(mount(node), predicate)
  return find(node.children, predicate)
}
function findAll(node, predicate, out = []) {
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  if (typeof node.type === 'function') { findAll(mount(node), predicate, out); return out }
  findAll(node.children, predicate, out)
  return out
}
const byFlybot = id => node => node.props?.['data-flybot'] === id

// A local hold as the host's own `approvals` list returns it (core's held send): the person it is
// for, the Bot that wrote it, and the chat it belongs to. Two of them are the batch.
const localHold = (id, handle, name) => ({
  id,
  status: 'pending',
  senderName: 'Chief',
  targetName: name,
  request: { from: 'mine', to: { handle }, text: `${name}'s draft`, meta: { sessionId: 's1' } },
})
const holds = () => [localHold('l1', '@eve.home', 'Eve'), localHold('l2', '@bob.home', 'Bob')]

function harness({ decide, holdList = holds() }) {
  const state = { calls: [], notes: [], decide }
  globalThis.__flybot__ = {
    call: (endpoint, payload) => {
      state.calls.push([endpoint, payload])
      if (endpoint === 'social/status') return Promise.resolve({ approvals: [] })
      if (endpoint === 'approvals') return Promise.resolve(holdList)
      if (endpoint === 'decide') {
        const answer = state.decide(payload)
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
      }
      return Promise.resolve({})
    },
  }
  state.props = { sessionId: 's1', roster: { bots: [] }, bot: { id: 'mine', name: 'Chief' }, claim: () => {}, actions: { notify: text => state.notes.push(text) } }
  return state
}
async function openChat(app, state) {
  const inst = { ...fresh(), props: state.props }
  const tree = await frame(app, inst, state.props)
  return { inst, tree }
}

test('#3093: a batch whose sends fail keeps each reason on its own card', async () => {
  const app = loadDock()
  const state = harness({ decide: () => new Error('the hold is stale') })
  try {
    const first = await openChat(app, state)
    const all = find(first.tree, byFlybot('approve-all'))
    assert.ok(all, 'two waiting holds offer Approve all')
    assert.deepEqual(all.children, ['Approve all (2)'], `the label carries the count, saw ${JSON.stringify(all.children)}`)
    await all.props.onClick()

    const after = render(app.ChatApprovalDock, first.inst, state.props)
    const cards = findAll(after, byFlybot('chat-approval'))
    assert.equal(cards.length, 2, 'both holds are still there to read')
    for (const card of cards) {
      assert.equal(card.props['data-state'], 'failed', `a refused send is drawn as failed, saw ${JSON.stringify(drawn(card))}`)
      assert.match(drawn(card), /Not sent/, 'the card says the send did not go')
      assert.match(drawn(card), /the hold is stale/, 'and carries the reason the line carried')
    }
    assert.ok(find(after, byFlybot('hold-retry')), 'a refused send offers Retry')

    // The line is cleared by the next click and dies with the chat; the reason has to live on the
    // card, which is what a chat switch reads.
    const second = await openChat(app, state)
    const again = findAll(second.tree, byFlybot('chat-approval'))
    assert.equal(again.length, 2, 'the way back draws both holds')
    for (const card of again) {
      assert.equal(card.props['data-state'], 'failed', `the way back still draws the refused card as failed, saw ${JSON.stringify(drawn(card))}`)
      assert.match(drawn(card), /the hold is stale/, 'the reason survives the chat switch')
    }
    assert.doesNotMatch(drawn(second.tree), /Waiting for approval/, 'a card whose send was refused is never a fresh wait again')
  } finally { delete globalThis.__flybot__ }
})

test('#3093: a batch never reports a local hold whose send failed as sent', async () => {
  const app = loadDock()
  // Core's `decide` answers normally with the approval its own `release` saved as failed: the send
  // did not go, and the reason is on the answer, not in a thrown error.
  const state = harness({ decide: payload => ({ id: payload.id, status: 'failed', error: 'Bot Social is unreachable' }) })
  try {
    const first = await openChat(app, state)
    await find(first.tree, byFlybot('approve-all')).props.onClick()
    assert.deepEqual(state.notes, [], 'no receipt claims a send that never went out')

    const after = render(app.ChatApprovalDock, first.inst, state.props)
    const cards = findAll(after, byFlybot('chat-approval'))
    assert.equal(cards.length, 2, 'both holds stay drawn: neither went out')
    for (const card of cards) {
      assert.equal(card.props['data-state'], 'failed', `the unsent card is drawn as failed, saw ${JSON.stringify(drawn(card))}`)
      assert.match(drawn(card), /Bot Social is unreachable/, 'and says why it did not go')
    }
  } finally { delete globalThis.__flybot__ }
})

test('#3093: a local reject is a decision, not a failed send', async () => {
  const app = loadDock()
  // Core's `decide('reject')` also answers normally, with the approval it saved as rejected; that is
  // the person's decision landing, not a send that did not go, so the card leaves and nothing is
  // receipted or offered for retry.
  const state = harness({ decide: payload => ({ id: payload.id, status: 'rejected' }) })
  try {
    const first = await openChat(app, state)
    const card = findAll(first.tree, byFlybot('chat-approval'))[0]
    const reject = findAll(card, node => node.type === 'button' && drawn(node) === 'Reject')[0]
    assert.ok(reject, 'a local pending hold offers Reject')
    await reject.props.onClick()
    const after = render(app.ChatApprovalDock, first.inst, state.props)
    const cards = findAll(after, byFlybot('chat-approval'))
    assert.equal(cards.length, 1, 'the rejected card leaves; the other hold stays')
    assert.doesNotMatch(drawn(after), /Eve's draft/, 'the rejected card is the one that went')
    assert.match(drawn(after), /Bob's draft/, 'the other hold is untouched')
    assert.doesNotMatch(drawn(after), /Not sent/, 'a decision that landed is not a failed send')
    assert.equal(find(after, byFlybot('hold-retry')), undefined, 'and it offers no Retry')
    assert.deepEqual(state.notes, [], 'a rejected card is not receipted as sent')
  } finally { delete globalThis.__flybot__ }
})

// The batch's own line, read where the person reads it: one alert under the button (#3071 keeps it out
// of the cards, whose own reason is #3093's record).
function errorLine(tree) {
  const node = find(tree, byFlybot('chat-approval-error'))
  return node ? drawn(node) : undefined
}

test('a batch that fails two holds for one person names that person once', async () => {
  const app = loadDock()
  // The same reason twice is one thing that happened, not two: a line that says it twice reads as a
  // stutter, and the person cannot tell it from a second, different failure.
  const state = harness({
    holdList: [localHold('l1', '@eve.home', 'Eve'), localHold('l2', '@eve.home', 'Eve')],
    decide: () => new Error('the hold is stale'),
  })
  try {
    const first = await openChat(app, state)
    await find(first.tree, byFlybot('approve-all')).props.onClick()
    const after = render(app.ChatApprovalDock, first.inst, state.props)
    assert.equal(errorLine(after), 'Eve: the hold is stale', `one entry per person and reason, saw ${JSON.stringify(errorLine(after))}`)
    assert.equal(findAll(after, byFlybot('chat-approval')).length, 2, 'both cards are still there to read')
  } finally { delete globalThis.__flybot__ }
})

test('a batch that fails two people separates their reasons and keeps each name', async () => {
  const app = loadDock()
  // Two different failures no longer run together as "Eve: the hold is stale Bob: …", where the second
  // person's name looked like part of the first person's reason.
  const state = harness({
    holdList: [localHold('l1', '@eve.home', 'Eve'), localHold('l2', '@bob.home', 'Bob')],
    decide: payload => new Error(payload.id === 'l1' ? 'the hold is stale' : 'Bot Social is unreachable'),
  })
  try {
    const first = await openChat(app, state)
    await find(first.tree, byFlybot('approve-all')).props.onClick()
    const after = render(app.ChatApprovalDock, first.inst, state.props)
    assert.equal(errorLine(after), 'Eve: the hold is stale · Bob: Bot Social is unreachable', `each failure is its own entry, saw ${JSON.stringify(errorLine(after))}`)
  } finally { delete globalThis.__flybot__ }
})

// P-812 residual: the line above is one click's whole report, so its shape is bounded too. A batch
// can fail for many people at once and a host reason can be a whole paragraph; an alert read at a
// glance must not become a wall of text. The rows are capped, the rest is counted in the window's
// own words, and a single reason is cut.
test('a batch that fails many people caps the rows and counts the rest', async () => {
  const app = loadDock()
  const people = ['Eve', 'Bob', 'Ada', 'Cy', 'Dee']
  const holdList = people.map((name, index) => localHold(`l${index + 1}`, `@${name.toLowerCase()}.home`, name))
  const state = harness({ holdList, decide: payload => new Error(`reason-${payload.id}`) })
  try {
    const first = await openChat(app, state)
    const all = find(first.tree, byFlybot('approve-all'))
    assert.ok(all, 'five waiting holds offer Approve all')
    await all.props.onClick()
    const after = render(app.ChatApprovalDock, first.inst, state.props)
    const line = errorLine(after)
    assert.equal(line, 'Eve: reason-l1 · Bob: reason-l2 · Ada: reason-l3 · 2 more not shown', `three rows and the count of the rest, saw ${JSON.stringify(line)}`)
    assert.doesNotMatch(line, /Cy: reason-l4|Dee: reason-l5/, 'the line does not grow with the batch')
    assert.equal(findAll(after, byFlybot('chat-approval')).length, 5, 'every card stays drawn, with its own reason')
  } finally { delete globalThis.__flybot__ }
})

test('the count of the rows the line leaves out follows the window language', async () => {
  const { DICTIONARY } = await import('../../../core/src/client/i18n.js')
  const translate = (text, params) => String(DICTIONARY.zh[text] ?? text).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
  const people = ['Eve', 'Bob', 'Ada', 'Cy', 'Dee']
  const holdList = people.map((name, index) => localHold(`l${index + 1}`, `@${name.toLowerCase()}.home`, name))
  const state = harness({ holdList, decide: payload => new Error(`reason-${payload.id}`) })
  state.props = { ...state.props, t: translate }
  const app = loadDock()
  try {
    const first = await openChat(app, state)
    await find(first.tree, byFlybot('approve-all')).props.onClick()
    const line = errorLine(render(app.ChatApprovalDock, first.inst, state.props))
    assert.match(line, /还有 2 条未显示$/, `the tail is the dictionary sentence, saw ${JSON.stringify(line)}`)
  } finally { delete globalThis.__flybot__ }
})

test('a reason longer than a paragraph is cut inside the line', async () => {
  const app = loadDock()
  // Two holds of one person are one row, so the row cap cannot hide the length of a single reason.
  const long = '🚀'.repeat(600)
  const state = harness({
    holdList: [localHold('l1', '@eve.home', 'Eve'), localHold('l2', '@eve.home', 'Eve')],
    decide: () => new Error(long),
  })
  try {
    const first = await openChat(app, state)
    await find(first.tree, byFlybot('approve-all')).props.onClick()
    const line = errorLine(render(app.ChatApprovalDock, first.inst, state.props))
    assert.ok(line.length < 500, `one reason does not own the whole line, saw ${line.length} characters`)
    assert.match(line, /…$/, `the cut is marked, saw ${JSON.stringify(line.slice(-6))}`)
    assert.ok(line.isWellFormed(), 'the cut lands on a code point, never inside an emoji')
    assert.ok(!/\p{Surrogate}/u.test(line), 'no lone surrogate survives the cut')
  } finally { delete globalThis.__flybot__ }
})

// #3192: the row was a bare `div` carrying a class no stylesheet ever wrote — so a role="alert"
// sentence about a failed batch read exactly like ordinary dock text, in no error colour and none of
// the plugin's own line height. It is drawn as the plugin's status line in its error tone instead;
// the alert role and the data-flybot hook stay, and #3158's cap and cut are untouched.
test('#3192: the failure row is drawn in the dock\'s own error tone, not as bare text', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const css = /const CSS = `([\s\S]*?)`\n/.exec(source)?.[1] ?? ''
  assert.ok(css.includes('.fs-status{padding:0;font-size:12px;line-height:17px;'),
    'the shared status line still carries the type the row leans on')
  assert.ok(css.includes('.fs-status[data-tone=error]{color:#e5484d}'),
    'and the plugin\'s own error colour is the tone this row takes')

  const app = loadDock()
  const state = harness({ decide: () => new Error('the hold is stale') })
  try {
    const first = await openChat(app, state)
    await find(first.tree, byFlybot('approve-all')).props.onClick()
    const row = find(render(app.ChatApprovalDock, first.inst, state.props), byFlybot('chat-approval-error'))
    assert.ok(row, 'the batch draws its one failure row')
    assert.equal(row.props.role, 'alert', 'the row still announces itself to the reader')
    assert.match(String(row.props.className), /\bfs-status\b/, `the row takes the status line, saw ${JSON.stringify(row.props.className)}`)
    assert.equal(row.props['data-tone'], 'error', 'in the error tone, so it does not read as ordinary dock text')
    assert.match(drawn(row), /the hold is stale/, 'and still says what failed')
  } finally { delete globalThis.__flybot__ }
})
