// Message hover toolbar, overflow, and right-click only offer actions FlyBot can run:
// reaction, reply/quote, copy, and download. Locked windows hide Reply. User bubbles
// share the same menu. Unimplemented items (Artifacts, translate, forward, report) are absent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

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
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
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

const io = { clipboard: 'ok', download: 'ok', writes: [], downloads: [], keys: null }
class TestElement { closest(selector) { return selector === '[data-composer-card]' ? this.card : this } }
async function load(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const env = {
    module: { exports: {} }, Element: TestElement, Event: class Event { constructor(type) { this.type = type } },
    document: { body: {}, hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ click() { if (io.download === 'fail') throw new Error('download failed'); io.downloads.push(true) } }) },
    Blob: class Blob {}, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    navigator: { language: 'en', clipboard: { writeText: async text => { if (io.clipboard === 'fail') throw new Error('denied'); io.writes.push(text) } } },
    window: { innerHeight: 800, innerWidth: 1400, addEventListener(name, handler) { if (name === 'keydown') io.keys = handler }, removeEventListener() {} },
    setTimeout, clearTimeout,
  }
  env.require = (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: props => ({ type: 'span', props: { className: 'bt-md', text: props.text, children: [] } }), projectUserText: text => text }
    throw new Error(`Unexpected platform module ${name}`)
  }
  runInNewContext(bundle.outputFiles[0].text, env)
  return env.module.exports
}

const cells = await load('cells.js')
const userMod = await load('user-message.js')
const composerMod = await load('composer.js')

const expand = (node, path = 'r') => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map((child, at) => expand(child, `${path}.${at}`))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return withInstance(path, () => expand(node.type(node.props), path))
  return { ...node, props: { ...node.props, children: expand(node.props.children, path) } }
}
function render(node) {
  runtime.dirty = false
  for (const inst of runtime.instances.values()) inst.pending = []
  const tree = expand(node)
  commitEffects()
  return tree
}
function flush(draw) {
  let tree = render(draw())
  for (let i = 0; i < 8 && runtime.dirty; i++) tree = render(draw())
  return tree
}
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
const labelled = (node, label) => node.type === 'button' && (node.props?.['aria-label'] === label || (node.props?.children ?? []).includes(label))
const button = (root, label) => find(root, node => labelled(node, label))[0]
const press = (node) => node.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 20, bottom: 30, right: 50 }) } })
const labels = (root) => find(root, node => node.type === 'button').map(node => node.props?.['aria-label'] ?? (Array.isArray(node.props?.children) ? node.props.children.find(child => typeof child === 'string') : null)).filter(Boolean)
const forbidden = (root) => labels(root).filter(label => /artifact|translate|forward|report|studio|template|select multiple|ask ai/i.test(String(label)))

const chief = { id: 'chief', name: 'Chief', color: 'green' }
const roster = { bots: [chief], byId: { chief }, rooms: [], roomsById: {}, exchangeTurns: {}, questions: {}, secretRequests: {}, secrets: [] }

function mountBubbles({ text = 'weekly note', locked = false, quotes = [], reactions = [], prefs, streaming = false } = {}) {
  runtime.instances.clear()
  const actions = {
    quote: (sessionId, value) => { quotes.push([sessionId, value]) },
    toggleReaction: (key, index, emoji) => { reactions.push([key, index, emoji]) },
    openSession() {},
  }
  const team = { ...roster, prefs, ...(locked ? { readOnly: 'This window is read-only.' } : {}) }
  const draw = () => react.createElement(cells.Bubbles, {
    texts: [text], roster: team, streaming, selfId: chief.id, actions, sessionId: 'chief', msgKey: 'chief:1:2',
    useUi: () => null,
  })
  return { draw, actions, quotes, reactions, tree: flush(draw) }
}

test('a reply bubble offers reaction, reply, and more; the overflow has copy and download only from real actions', () => {
  const { draw, quotes, reactions, tree: first } = mountBubbles()
  assert.ok(button(first, 'Add reaction'))
  assert.ok(button(first, 'Reply'))
  assert.ok(button(first, 'More message actions'))
  press(button(first, 'More message actions'))
  const tree = flush(draw)
  const menu = find(tree, node => node.props?.['aria-label'] === 'Message actions')[0]
  assert.ok(menu, 'the overflow menu opens')
  const shown = labels(menu)
  assert.ok(shown.includes('Reply'))
  assert.ok(shown.includes('Copy'))
  assert.ok(shown.includes('Download'))
  assert.ok(shown.includes('👍'))
  assert.deepEqual(forbidden(menu), [], 'unimplemented items stay off the menu')
  press(button(menu, 'Reply'))
  assert.deepEqual(quotes, [['chief', 'weekly note']])
  runtime.instances.clear()
  const again = mountBubbles({ reactions })
  press(button(again.tree, 'Add reaction'))
  const strip = find(flush(again.draw), node => node.props?.['aria-label'] === 'Reactions')[0]
  press(button(strip, '👍'))
  assert.deepEqual(reactions, [['chief:1:2', 0, '👍']])
})

test('right-clicking a bubble opens the same message menu at the cursor', () => {
  const { draw, tree: first } = mountBubbles()
  const row = find(first, node => String(node.props?.className ?? '').split(/\s+/).includes('bt-msg'))[0]
  assert.ok(row.props.onContextMenu)
  row.props.onContextMenu({
    preventDefault() {}, stopPropagation() {}, clientX: 120, clientY: 80, target: { closest: () => null },
  })
  const menu = find(flush(draw), node => node.props?.['aria-label'] === 'Message actions')[0]
  assert.ok(menu)
  const shown = labels(menu)
  assert.ok(shown.includes('Copy') && shown.includes('Download') && shown.includes('Reply'))
  assert.deepEqual(forbidden(menu), [])
})

test('a locked window keeps copy and download, and hides reply', () => {
  const { tree } = mountBubbles({ locked: true })
  assert.equal(button(tree, 'Reply'), undefined)
  assert.ok(button(tree, 'Add reaction'))
  assert.ok(button(tree, 'More message actions'))
  press(button(tree, 'More message actions'))
  // Remount after press needs the same runtime instances — press already set state on this tree's
  // instance. Re-flush the same draw.
})

test('a locked window overflow lists copy and download, not reply', () => {
  const { draw, tree: first } = mountBubbles({ locked: true })
  press(button(first, 'More message actions'))
  const menu = find(flush(draw), node => node.props?.['aria-label'] === 'Message actions')[0]
  const shown = labels(menu)
  assert.ok(!shown.includes('Reply'))
  assert.ok(shown.includes('Copy'))
  assert.ok(shown.includes('Download'))
})

function mountUser({ locked = false, quotes = [], withTurn = true } = {}) {
  runtime.instances.clear()
  const actions = { quote: (sessionId, value) => { quotes.push([sessionId, value]) }, toggleReaction() {}, openSession() {} }
  const team = locked ? { ...roster, readOnly: 'This window is read-only.' } : roster
  const node = {
    kind: 'user',
    location: withTurn ? { kind: 'turn', turn: 3 } : undefined,
    data: { content: [{ type: 'text', text: 'Draft the weekly note' }] },
  }
  const draw = () => react.createElement(userMod.UserMessageCell, {
    node, sessionId: 'chief', useRoster: select => select(team), useUi: () => ({ reactions: {} }), actions,
  })
  return { draw, quotes, tree: flush(draw) }
}

test('a user bubble offers reply, copy, and download, and has no unimplemented items', () => {
  const { draw, quotes, tree: first } = mountUser()
  assert.ok(button(first, 'Reply'))
  assert.ok(button(first, 'More message actions'))
  assert.ok(button(first, 'Add reaction'), 'a stable turn identity lets the user bubble react')
  press(button(first, 'More message actions'))
  const menu = find(flush(draw), node => node.props?.['aria-label'] === 'Message actions')[0]
  const shown = labels(menu)
  assert.ok(shown.includes('Reply') && shown.includes('Copy') && shown.includes('Download'))
  assert.deepEqual(forbidden(menu), [])
  press(button(first, 'Reply'))
  assert.deepEqual(quotes, [['chief', 'Draft the weekly note']])
})

test('a user bubble without a turn identity has no reaction control, and a locked one has no reply', () => {
  const plain = mountUser({ withTurn: false })
  assert.equal(button(plain.tree, 'Add reaction'), undefined)
  assert.ok(button(plain.tree, 'Reply'))
  const locked = mountUser({ locked: true })
  assert.equal(button(locked.tree, 'Reply'), undefined)
  assert.ok(button(locked.tree, 'More message actions'))
})


test('clipboard and download failures are handled with visible status; right-click menu closes and can reopen', async () => {
  const { draw, tree: first } = mountBubbles()
  press(button(first, 'More message actions'))
  io.clipboard = 'fail'
  press(button(flush(draw), 'Copy'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(find(flush(draw), n => n.props?.role === 'status').length)
  io.clipboard = 'ok'
  press(button(flush(draw), 'Copy'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(io.writes.includes('weekly note'))
  io.download = 'fail'
  press(button(flush(draw), 'Download'))
  assert.ok(find(flush(draw), n => n.props?.role === 'status').length)
  io.download = 'ok'
  press(button(flush(draw), 'Download'))
  assert.ok(io.downloads.length > 0)
  assert.equal(find(flush(draw), n => n.props?.['aria-label'] === 'Message actions').length, 0)
  let tree = flush(draw)
  const rightClick = () => find(tree, n => n.props?.className === 'bt-msg')[0].props.onContextMenu({
    clientX: 80, clientY: 80, target: { closest: () => null }, preventDefault() {}, stopPropagation() {},
  })
  rightClick(); tree = flush(draw)
  press(button(find(tree, n => n.props?.['aria-label'] === 'Message actions')[0], 'Reply'))
  tree = flush(draw)
  assert.equal(find(tree, n => n.props?.['aria-label'] === 'Message actions').length, 0, 'context menu closes after reply')
  rightClick(); tree = flush(draw)
  assert.equal(find(tree, n => n.props?.['aria-label'] === 'Message actions').length, 1, 'can reopen immediately')
})


test('folding, document cards, quoting, no-fold and streaming compose without hiding access to text', () => {
  const text = '# Full report\n' + 'A long paragraph. '.repeat(60) + '\n## Next steps\nFinish review.'
  let mounted = mountBubbles({ text, prefs: { folding: { mode: 'standard', documentCards: true } } })
  assert.ok(button(mounted.tree, 'Show message text'), 'a document card keeps an inline full-text control')
  press(button(mounted.tree, 'Show message text'))
  let tree = flush(mounted.draw)
  assert.ok(find(tree, n => n.props?.text === text).length, 'inline expansion renders the complete text')
  press(button(tree, 'More message actions'))
  tree = flush(mounted.draw)
  press(button(find(tree, n => n.props?.['aria-label'] === 'Message actions')[0], 'Reply'))
  assert.deepEqual(mounted.quotes, [['chief', text]], 'reply quotes full raw text, not the preview')
  mounted = mountBubbles({ text, prefs: { folding: { mode: 'none', documentCards: true } } })
  assert.equal(button(mounted.tree, 'Show message text'), undefined, 'no-fold also bypasses card conversion')
  assert.ok(find(mounted.tree, n => n.props?.text === text).length)
  mounted = mountBubbles({ text, streaming: true, prefs: { folding: { mode: 'compact', documentCards: true } } })
  assert.equal(button(mounted.tree, 'More message actions'), undefined)
  assert.equal(button(mounted.tree, 'Show message text'), undefined)
  assert.ok(find(mounted.tree, n => n.props?.text === text).length, 'streaming renders full text without premature folding')
})

test('installed Shift+Enter shortcut respects IME, multiline, disabled send and read-only roster', () => {
  const field = new TestElement()
  let clicks = 0; let inputEvents = 0
  const sendButton = { disabled: false, getAttribute() { return null }, click() { clicks++ } }
  field.card = { querySelector() { return sendButton } }
  field.value = 'abc'; field.selectionStart = 1; field.selectionEnd = 1
  field.dispatchEvent = () => inputEvents++
  const snapshot = { prefs: { sendKey: 'shift-enter' } }
  composerMod.installSendShortcut({ getSnapshot: () => snapshot })
  const key = io.keys
  const event = (more = {}) => ({ key: 'Enter', target: field, preventDefault() {}, stopPropagation() {}, ...more })
  key(event({ keyCode: 229, shiftKey: true })); assert.equal(clicks, 0)
  key(event()); assert.equal(field.value, 'a\nbc'); assert.equal(inputEvents, 1)
  key(event({ shiftKey: true })); assert.equal(clicks, 1)
  sendButton.disabled = true
  key(event({ shiftKey: true })); assert.equal(clicks, 1)
  snapshot.readOnly = 'This window is read-only.'
  key(event()); assert.equal(inputEvents, 1)
})
