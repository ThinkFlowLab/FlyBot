// P-393: the messages a Bot's own chat loads above its current part are bubbles like any other, and the
// toolbar on them was dead — no reaction button, because the bubble was drawn without the identity a
// reaction is stored under, and no reply button, because it was drawn without a session to quote into.
// Each case clicks the toolbar the page really draws: the earlier panel is mounted, its page is loaded
// through the effect that loads it, and the two buttons are pressed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// A hook runtime: one slot set per component, an effect re-runs only when its deps change, and a setter
// marks the tree dirty so the caller renders again. The earlier panel loads its first page in an effect
// and draws the rows on the next render, so a no-op `useEffect` could not observe it at all.
const runtime = { instances: new Map(), key: 'root', index: 0, dirty: false }
function instance(key) {
  let inst = runtime.instances.get(key)
  if (!inst) {
    inst = { slots: [], refs: [], pending: [], deps: new Map(), cleanups: new Map() }
    runtime.instances.set(key, inst)
  }
  return inst
}
function withInstance(key, run) {
  const previousKey = runtime.key
  const previousIndex = runtime.index
  runtime.key = key
  runtime.index = 0
  try { return run() } finally { runtime.key = previousKey; runtime.index = previousIndex }
}
function recordEffect(run, deps) {
  instance(runtime.key).pending.push({ index: runtime.index++, run, deps })
}
function commitEffects() {
  for (const inst of runtime.instances.values()) {
    const pending = inst.pending
    inst.pending = []
    for (const { index, run, deps } of pending) {
      const previous = inst.deps.get(index)
      const changed = !deps || !previous || deps.length !== previous.length || deps.some((dep, at) => !Object.is(dep, previous[at]))
      if (!changed) continue
      const cleanup = inst.cleanups.get(index)
      if (typeof cleanup === 'function') cleanup()
      inst.cleanups.delete(index)
      inst.deps.set(index, deps ? [...deps] : null)
      const next = run()
      if (typeof next === 'function') inst.cleanups.set(index, next)
    }
  }
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('F'),
  useEffect: (run, deps) => recordEffect(run, deps),
  useLayoutEffect: (run, deps) => recordEffect(run, deps),
  useMemo: (make) => make(),
  useCallback: (fn) => fn(),
  useRef: (current) => {
    const inst = instance(runtime.key)
    const index = runtime.index++
    if (!(index in inst.refs)) inst.refs[index] = { current }
    return inst.refs[index]
  },
  useSyncExternalStore: (_subscribe, get) => get(),
  useState: (initial) => {
    const inst = instance(runtime.key)
    const index = runtime.index++
    if (!(index in inst.slots)) inst.slots[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(inst.slots[index]) : next
      if (Object.is(value, inst.slots[index])) return
      inst.slots[index] = value
      runtime.dirty = true
    }
    return [inst.slots[index], set]
  },
}

// The bubble's words are what the toolbar belongs to; the real MarkdownText is a platform module, so it
// is stubbed as the one span a case can read, and a toolbar is found through the bubble that holds it.
function markdown(props) {
  return { type: 'span', props: { className: 'bt-md', text: props.text, children: [] } }
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const env = {
  module: { exports: {} },
  document: { body: {}, hidden: false, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: { innerHeight: 800, innerWidth: 1400, addEventListener() {}, removeEventListener() {} },
  setTimeout, clearTimeout,
}
env.module.exports = env.module.exports
env.require = (name) => {
  if (name === 'react') return react
  if (name === 'react-dom') return { createPortal: (node) => node }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: markdown }
  throw new Error(`Unexpected platform module ${name}`)
}
runInNewContext(bundle.outputFiles[0].text, env)
const { TriggerCell, Bubbles } = env.module.exports

// Expanding a tree runs the function components it meets, keeping their hook slots under their path, so
// a second render passes through the instances the first one built.
const expand = (node, path = 'r') => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map((child, at) => expand(child, `${path}.${at}`))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return withInstance(path, () => expand(node.type(node.props), path))
  return { ...node, props: { ...node.props, children: expand(node.props.children, path) } }
}
// One render pass: the effects recorded by this render run after it, and a setter they fire marks the
// tree dirty for the next pass.
function render(node) {
  runtime.dirty = false
  for (const inst of runtime.instances.values()) inst.pending = []
  const tree = expand(node)
  commitEffects()
  return tree
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const find = (node, match, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) find(child, match, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (match(node)) out.push(node)
  find(node.props?.children, match, out)
  return out
}
const classes = (node) => String(node.props?.className ?? '').split(/\s+/).filter(Boolean)
const labelled = (node, label) => node.type === 'button' && node.props?.['aria-label'] === label
const button = (root, label) => find(root, (node) => labelled(node, label))[0]
const press = (node) => node.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 20, bottom: 30 }) } })

const roster = {
  bots: [{ id: 'chief', name: 'Chief', color: 'green' }],
  byId: { chief: { id: 'chief', name: 'Chief', color: 'green' } },
  rooms: [], roomsById: {}, exchangeTurns: {}, questions: {}, secretRequests: {}, secrets: [],
}

// A page of an earlier part as the host hands it over: each bot line carries the part it was said in
// and its place there, which is the identity a reaction is stored under.
const PAGE = {
  items: [
    { kind: 'bot', text: 'older answer one', time: 10, turn: 2, seq: 7, sessionId: 'part-1' },
    { kind: 'user', text: 'an older question', time: 11 },
    { kind: 'bot', text: 'older answer two', time: 12, turn: 4, seq: 9, sessionId: 'part-1' },
  ],
  cursor: null,
  startedAt: 20,
}

// The chat mounts the cell that opens a part; a part opened by a handoff draws the earlier parts right
// above it, so that cell is the one a person's scroll-up actually renders.
function earlier() {
  const calls = { reactions: [], quotes: [] }
  const ui = { reactions: {}, visits: {} }
  const actions = {
    earlier: async () => PAGE,
    toggleReaction: (key, index, emoji) => { calls.reactions.push([key, index, emoji]) },
    quote: (sessionId, text) => { calls.quotes.push([sessionId, text]) },
    noteTurnPeer() {}, openExchange() {}, openSession() {},
  }
  const props = {
    node: { data: { source: { kind: 'bot', handoff: true }, turn: 1, content: [] } },
    sessionId: 'chief',
    actions,
    useRoster: (selector) => selector(roster),
    useSessions: (selector) => selector({ projectionsBySession: {}, byId: {} }),
    useTurnClock: (selector) => selector({}),
    useUi: (selector) => selector(ui),
  }
  const draw = () => render(react.createElement(TriggerCell, props))
  let tree = draw()
  const settle = async () => {
    // The page arrives from a promise the effect started, so the first wait is for that microtask and
    // the render that follows it; a pass with nothing dirty means the panel has stopped moving.
    for (let pass = 0; pass < 8; pass += 1) {
      await tick()
      if (!runtime.dirty) break
      tree = draw()
    }
    return tree
  }
  const again = () => { tree = draw(); return tree }
  return { calls, ui, props, settle, again, get tree() { return tree } }
}

// The row that holds one line of the page: its bubble, and the toolbar beside it.
function rowOf(tree, text) {
  return find(tree, (node) => classes(node).includes('bt-msg'))
    .find((row) => find(row, (node) => classes(node).includes('bt-md') && node.props?.text === text).length > 0)
}

test('P-393: a reaction picked on a message loaded from an earlier part is stored under that message', async () => {
  const panel = earlier()
  const tree = await panel.settle()
  const row = rowOf(tree, 'older answer one')
  assert.ok(row, 'the earlier part drew its first line')
  const reactButton = button(row, 'Add reaction')
  assert.ok(reactButton, 'a history bubble offers a reaction, exactly like a current one')
  press(reactButton)
  const strip = find(panel.again(), (node) => labelled(node, '👍'))[0]
  assert.ok(strip, 'the reaction strip opens on the history bubble')
  press(strip)
  assert.deepEqual(panel.calls.reactions, [['part-1:2:7', 0, '👍']],
    'the reaction is stored under the part, the turn and the place the line was said — not under a key a reload moves')

  // And the stored reaction is drawn again on that bubble, not on a neighbour.
  panel.ui.reactions['part-1:2:7'] = { 0: ['👍'] }
  const drawn = find(panel.again(), (node) => classes(node).includes('bt-react'))
  assert.deepEqual(drawn.map((node) => [].concat(node.props.children).join('')), ['👍'])
  assert.ok(rowOf(panel.tree, 'older answer one'), 'the bubble that owns the reaction is still there')
})

test('P-393: the reply button on a message from an earlier part quotes it into the open chat', async () => {
  const panel = earlier()
  const tree = await panel.settle()
  const row = rowOf(tree, 'older answer two')
  assert.ok(row, 'the earlier part drew its second line')
  const reply = button(row, 'Reply')
  assert.ok(reply, 'a history bubble offers a reply, exactly like a current one')
  press(reply)
  assert.deepEqual(panel.calls.quotes, [['chief', 'older answer two']],
    'the quote names the chat that is open, so the composer shows it — not the part the line was said in')
})

test('P-393: a bubble in the current part keeps its own key and its own reply target', () => {
  const calls = { reactions: [], quotes: [] }
  const ui = { reactions: {} }
  const actions = {
    toggleReaction: (key, index, emoji) => { calls.reactions.push([key, index, emoji]) },
    quote: (sessionId, text) => { calls.quotes.push([sessionId, text]) },
    openSession() {},
  }
  const props = { texts: ['a current answer'], roster, selfId: 'chief', actions, sessionId: 'chief', msgKey: 'chief:5:2', useUi: (selector) => selector(ui) }
  let tree = render(react.createElement(Bubbles, props))
  press(button(tree, 'Add reaction'))
  tree = render(react.createElement(Bubbles, props))
  press(find(tree, (node) => labelled(node, '❤️'))[0])
  const reply = button(tree, 'Reply')
  press(reply)
  assert.deepEqual(calls.reactions, [['chief:5:2', 0, '❤️']], 'the live key is unchanged')
  assert.deepEqual(calls.quotes, [['chief', 'a current answer']], 'the live reply target is unchanged')
})
