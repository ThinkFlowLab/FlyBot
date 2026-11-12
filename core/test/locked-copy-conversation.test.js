// #2919: a locked window refuses writes, not reads. The details drawer's copy control writes to the
// local clipboard and reads only what the page already shows, so a read-only window still draws it
// and a press still copies — hiding it would take away the one way to keep the transcript while the
// same team is open in another window. `details-overview-readonly.test.js` pins that the locked
// overview drops every write control; nothing pinned that the copy control survives that cut, so a
// later "lock the drawer" change could remove the read without any red.
//
// The drawing harness is the one `details-overview-readonly.test.js` uses: the real bundle, React and
// the host replaced by stubs, hook slots that survive a re-render, and no jsdom. The clipboard is a
// recorder, so "the press copied these bytes" is answerable rather than asserted from the source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { DetailsDrawer } from './src/client/details-drawer.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
let slots = []
let index = 0
const react = {
  createElement: h, Component: class {}, Fragment: Symbol('F'),
  useMemo: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useState: (initial) => {
    const at = index++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
  useCallback: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn; return slots[at] },
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect: () => { index++ },
  useLayoutEffect() {},
  useSyncExternalStore: (_subscribe, get) => get(),
}
// The clipboard a real page has: `copiedToClipboard` answers whether the write landed, so a silent
// recorder is what tells "the press copied" from "the press said it copied".
let written = []
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en', clipboard: { writeText: text => { written.push(text); return Promise.resolve() } } },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { DetailsDrawer } = module.exports

const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'
const bot = { id: 'a', sessionId: 'a', name: 'Chief', pinned: false, hidden: false, model: '', instructions: '', workDir: '', parts: [] }
const base = { bots: [bot], rooms: [], byId: { a: bot }, roomsById: {}, prefs: {}, mainBotIds: ['a'], connectors: [], memory: false, exchangeTurns: {}, questions: {}, permissions: { defaultPreset: 'workspace-write', options: [] } }
const rosterWith = (readOnly) => (readOnly === undefined ? { ...base } : { ...base, readOnly })
// The stored conversation the drawer copies: two turns, so the bytes are a transcript and not one line.
const store = outline => ({ byId: {}, projectionsBySession: outline === undefined ? {} : { a: { values: { turnOutline: outline } } } })
const TURNS = [
  { turn: 1, prompt: 'keep these words', response: 'and these too' },
  { turn: 2, response: 'a second answer' },
]
const EXPECTED = '**You:** keep these words\n\n**Chief:** and these too\n\n**Chief:** a second answer'
const actions = {
  openSettings() {}, closeSettings() {}, closeOverlay() {}, openSession() {}, openBrowser() {},
  notify(message) { said.push(message) }, reportError() {}, setFlags: () => Promise.resolve(),
  updateBot: () => Promise.resolve(), updateRoom: () => Promise.resolve(),
  schedules: () => Promise.resolve({ available: true, tasks: [] }),
}
let said = []
const render = (roster, list, acts = actions) => {
  index = 0
  const map = () => new Map()
  return DetailsDrawer({
    sessionId: 'a', startTab: 'details', hasStrip: false, roster, actions: acts,
    useSessions: selector => selector(list), useSessionStatus: selector => selector(map()),
    useActivity: selector => selector(map()), useWork: selector => selector(map()),
    useBrowserTabs: selector => selector(map()), useBrowserPages: selector => selector(map()),
  })
}
// Real React draws a function component when it meets one; this expands the same way, with the hook
// slots above assigned in tree order, so a re-render after a press sees the state it just set.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const props = node.props ?? {}
  if (typeof node.type === 'function') return expand(node.type(props))
  return { ...node, props: { ...props, children: expand(props.children) } }
}
const nodes = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  nodes(node.props?.children, out)
  return out
}
const ownText = (node) => {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk).join('')
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (value && typeof value === 'object') return walk(value.props?.children)
    return ''
  }
  return walk(node?.props?.children)
}
const statusLine = (all) => all.filter(node => node.props?.role === 'status' && ownText(node).trim() === SENTENCE)
const copyButton = (all) => all.find(node => node.type === 'button'
  && ['Copy conversation', 'Copied conversation'].includes(node.props?.['aria-label']))
const tree = (roster, list = store(TURNS), acts = actions) => nodes(expand(render(roster, list, acts)))
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

test('#2919: a locked window still copies the conversation, and says what it copied', async () => {
  slots = []
  written = []
  said = []
  const roster = rosterWith(SENTENCE)
  const entries = tree(roster)
  // The control is the roster really being locked: the host's own sentence is drawn, so a green below
  // cannot come from a window that was never locked.
  assert.equal(statusLine(entries).length, 1, 'the locked window draws its sentence')
  const button = copyButton(entries)
  assert.ok(button, 'a locked window still draws the copy control')
  assert.equal(button.props['aria-label'], 'Copy conversation', 'the name still says the click is a copy')
  button.props.onClick()
  await settle()
  assert.deepEqual(written, [EXPECTED], 'the press writes the transcript to the clipboard')
  assert.deepEqual(said, ['Conversation copied as Markdown'], 'the press announces what landed, as on a writable window')
  // A re-render sees the confirmation state the press set, so the control answers the click.
  const after = copyButton(tree(roster))
  assert.equal(after.props['aria-label'], 'Copied conversation', 'the control says it copied')
})

// The same press on a window where nothing was said must write nothing: a control that always
// announced success would pass the test above without ever reading the transcript.
test('#2919: the same copy control on an empty conversation writes nothing and says so', async () => {
  slots = []
  written = []
  said = []
  const button = copyButton(tree(rosterWith(SENTENCE), store(undefined)))
  assert.ok(button, 'the control is drawn even when there is nothing yet to copy')
  button.props.onClick()
  await settle()
  assert.deepEqual(written, [], 'nothing reaches the clipboard')
  assert.deepEqual(said, ['Nothing to copy yet'], 'the press says why it did nothing')
})

// The lock neither draws nor hides the control: a writable window draws the same one, so the
// behaviour above is "reads stay available", not a second control only a locked window has.
test('#2919: a writable window draws the same copy control', async () => {
  slots = []
  written = []
  said = []
  const entries = tree(rosterWith(undefined))
  assert.deepEqual(statusLine(entries), [], 'a writable window is not locked')
  const button = copyButton(entries)
  assert.ok(button, 'the writable window draws the copy control too')
  button.props.onClick()
  await settle()
  assert.deepEqual(written, [EXPECTED], 'the same press copies the same bytes')
  assert.deepEqual(said, ['Conversation copied as Markdown'], 'and answers the same way')
})
