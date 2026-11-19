// Manual "Mark as Unread" clears when the conversation is opened again, not in the pass
// that marks the conversation already on screen (#3114).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: "export { TeamSidebar } from './src/client/sidebar.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
const same = (a, b) => Boolean(a && b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
let slots = []
let effects = []
let pending = []
let index = 0
const react = {
  createElement: h, Component: class {}, Fragment: Symbol('F'),
  useMemo: (fn, deps) => { const at = index++; if (!(at in slots) || !same(slots[at].deps, deps)) slots[at] = { deps, value: fn() }; return slots[at].value },
  useState: (initial) => { const at = index++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }] },
  useCallback: (fn) => fn,
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  // Effects whose deps changed are recorded here and run after the draw, the way React runs
  // them after a commit; refs and memos keep their value from one draw to the next.
  useEffect: (fn, deps) => { const at = index++; if (!(at in effects) || !same(effects[at].deps, deps)) { effects[at] = { deps, cleanup: effects[at]?.cleanup }; pending.push([at, fn]) } },
  useLayoutEffect: () => {},
  useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { location: { hash: '' }, innerHeight: 800, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, setImmediate, queueMicrotask,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  Date, JSON, Promise, Symbol, Map, Set,
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, body: {}, querySelector: () => null },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  __flybot__: { slots: { entries: () => [], subscribe: () => () => {}, version: () => 0 }, call: () => {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { TeamSidebar } = module.exports
const chief = { id: 'chief', name: 'Chief' }
const writer = { id: 'writer', name: 'Writer' }
const roster = { ready: true, bots: [chief, writer], rooms: [], agents: [], byId: { chief, writer }, roomsById: {}, exchangeTurns: {}, mainBotId: 'chief' }
const sessions = { ids: ['chief', 'writer'], byId: { chief: { updatedAt: 2 }, writer: { updatedAt: 1 } } }
// The rows this file measures, without the parts each row draws below itself.
const rows = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) rows(item, out); return out }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function') { if (node.type.name === 'BotRow') out.push([node.type, node.props]); return out }
  rows(node.props?.children, out)
  return out
}

// What the two readers say this draw: the manual marks, and which conversation the main
// view holds (`retainedBy.mainView` is what each row reads as "active").
const live = { unread: {}, retain: {} }
let calls = []
const mount = () => {
  slots = []; effects = []; pending = []; calls = []; live.unread = {}; live.retain = {}
  return () => {
    index = 0
    pending = []
    for (const [row, props] of rows(TeamSidebar({
      wide: true,
      useRoster: select => select(roster),
      useUi: select => select({ unread: live.unread }),
      useSessions: select => select(sessions),
      useRegistry: () => {},
      useUpdate: select => select({}),
      useWork: select => select({}),
      useSessionStatus: select => select(new Map()),
      useSessionRetainInfo: (key, select) => select(live.retain[key]),
      useActivity: select => select({}),
      actions: {
        openInbox() {}, openBoard() {}, openPalette() {}, openNewChat() {}, landOn() {},
        clearUnread: id => calls.push(id), isAgentSession: () => false,
      },
    }))) row(props)
    for (const [at, fn] of pending) {
      if (effects[at].cleanup) effects[at].cleanup()
      const cleanup = fn(); effects[at].cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    pending = []
  }
}
const OPEN = { writer: { retainedBy: { mainView: 1 } } }

test('#3114: a mark made on the chat already on screen stays while it stays open', () => {
  const draw = mount()
  live.retain = OPEN
  draw()                                  // the chat is open, not yet marked
  live.unread = { writer: true }
  draw()                                  // Mark as Unread pressed on that chat
  draw()                                  // it stays open
  assert.deepEqual(calls, [], 'the open chat mark was cleared while it stayed open')
})

test('#3114: opening a chat that was already marked unread clears the mark once', () => {
  const draw = mount()
  live.unread = { writer: true }
  draw()                                  // marked while another chat is on screen
  live.retain = OPEN
  draw()                                  // opened
  draw()                                  // and stays open
  assert.deepEqual(calls, ['writer'])
})

test('#3114: leaving and coming back clears the mark that was made while the chat was open', () => {
  const draw = mount()
  live.retain = OPEN
  draw()                                  // the chat is open, not yet marked
  live.unread = { writer: true }
  draw()                                  // marked while it stays open
  live.retain = {}
  draw()                                  // leave: nothing is cleared on the way out
  live.retain = OPEN
  draw()                                  // back in: cleared once
  assert.deepEqual(calls, ['writer'], 'the mark is cleared on the way back in, not while open')
})
