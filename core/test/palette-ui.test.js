// Empty state, no-match state, and type filters for the command palette.
// Message search only reads turn outlines already loaded in the session list.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: "export { CommandPalette } from './src/client/palette.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
let slots = []
let index = 0
const react = {
  createElement: h, Fragment: Symbol('F'),
  useMemo: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useState: (initial) => {
    const at = index++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
  useCallback: (fn) => fn,
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect() {},
  useLayoutEffect() {},
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout,
  document: { hidden: false, querySelector: () => null },
  window: { addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: () => null, MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { CommandPalette } = module.exports

const chief = { id: 'chief', name: 'Chief', role: 'Coordinator', sessionId: 'chief' }
const roster = { bots: [chief], byId: { chief }, rooms: [], roomsById: {}, agents: [], exchangeTurns: {} }
const sessions = {
  projectionsBySession: { chief: { values: { turnOutline: [{ turn: 1, prompt: 'Weekly note for Chief', response: 'Here is the draft.' }] } } },
  byId: {},
}
const expand = (node) => {
  if (node == null) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props ?? {}))
  return { ...node, props: { ...(node.props ?? {}), children: expand(node.props?.children) } }
}
const all = (node, out = []) => {
  if (node == null) return out
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  all(node.props?.children, out)
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
const hasClass = (node, name) => String(node.props?.className ?? '').split(/\s+/).includes(name)

const mount = (start = '') => {
  slots = []
  const draw = () => {
    index = 0
    return all(expand(CommandPalette({
      start, token: 't', roster,
      actions: { closePalette() {}, openSession() {}, openNewChat() {}, openSettings() {}, setFlags: async () => {}, openAgent() {} },
      useSessions: select => select(sessions),
    })))
  }
  return draw
}

test('an empty query shows the empty state, type filters, and a close control; it does not prefill chats or messages', () => {
  const nodes = mount('')()
  assert.ok(nodes.some(node => hasClass(node, 'bt-palette-empty')))
  assert.ok(nodes.some(node => ownText(node) === 'Search chats and messages'))
  assert.ok(nodes.some(node => String(ownText(node)).includes('loaded message')))
  assert.equal(nodes.some(node => ownText(node) === 'Search all chats' || String(ownText(node)).includes('all content')), false)
  const tabs = nodes.filter(node => hasClass(node, 'bt-palette-filter'))
  assert.deepEqual(tabs.map(ownText), ['All', 'Chats', 'Messages', 'Commands'])
  assert.equal(tabs.some(node => ownText(node) === 'Artifacts' || ownText(node) === 'Files'), false)
  assert.ok(nodes.some(node => node.props?.['aria-label'] === 'Close'))
  assert.equal(nodes.filter(node => node.props?.role === 'option').length, 0)
})

test('a query with no matches shows the no-results state', () => {
  const nodes = mount('zzzz-no-such')()
  assert.ok(nodes.some(node => ownText(node) === 'No results'))
  assert.ok(nodes.some(node => String(ownText(node)).includes('loaded message')))
})

test('the Messages filter finds loaded outlines, and the Chats filter hides those hits', () => {
  const draw = mount('Chief')
  let nodes = draw()
  const titles = () => nodes.filter(node => hasClass(node, 'bt-palette-title')).map(ownText)
  assert.ok(titles().includes('Chief'))
  assert.ok(nodes.some(node => String(ownText(node)).includes('Weekly note') || String(ownText(node)).includes('draft')))
  const press = (label) => {
    const tab = nodes.find(node => hasClass(node, 'bt-palette-filter') && ownText(node) === label)
    assert.ok(tab, label)
    tab.props.onClick()
    nodes = draw()
  }
  press('Messages')
  assert.equal(titles().includes('Chief') && nodes.some(node => hasClass(node, 'bt-palette-section') && ownText(node) === 'Bots'), false)
  assert.ok(nodes.some(node => hasClass(node, 'bt-palette-section') && ownText(node) === 'Messages') || nodes.some(node => String(ownText(node)).includes('draft')))
  press('Chats')
  assert.ok(titles().includes('Chief'))
  assert.equal(nodes.some(node => hasClass(node, 'bt-palette-section') && ownText(node) === 'Messages'), false)
})
