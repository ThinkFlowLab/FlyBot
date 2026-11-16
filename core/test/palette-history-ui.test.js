// Empty state, no-match state, and type filters for the command palette.
// View-only seam for history state; real asynchronous hook is covered separately.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: "export { CommandPalette } from './src/client/palette.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  plugins: [{name:'history-view-state',setup(b){b.onLoad({filter:/history-search\.js$/},()=>({contents:"export const useHistorySearch = search => { globalThis.__capture(typeof search === 'function'); return globalThis.__history() }",loader:'js'}))}}],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
let historyState = {items:[],status:'ready',cursor:null}
let historyEnabled, opened
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
  __history:()=>historyState, __capture:value=>{historyEnabled=value},
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
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
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
      actions: { closePalette() {}, searchMessages: async()=>{}, openSession(id) {opened=id}, openNewChat() {}, openSettings() {}, setFlags: async () => {}, openAgent() {} },
      useSessions: select => select(sessions),
    })))
  }
  return draw
}

test('history results open a read-only context view instead of navigating the current chat; four tags still gate history',()=>{
 historyState={items:[{botId:'chief',sessionId:'chief-old',seq:7,snippet:'未加载的中文历史',earlier:true,hitToken:'opaque-hit'}],status:'ready',cursor:null}
 const draw=mount('中文');let nodes=draw()
 assert.ok(nodes.some(node=>ownText(node)==='Local Bot chat history'))
 assert.ok(nodes.some(node=>ownText(node)==='Earlier part; view read-only history'))
 for(const label of ['Chats','Commands','Messages','All']){
  nodes.find(node=>hasClass(node,'bt-palette-filter')&&ownText(node)===label).props.onClick();nodes=draw()
  assert.equal(historyEnabled,['Messages','All'].includes(label))
  assert.equal(nodes.some(node=>node.props?.role==='option'&&ownText(node).includes('未加载的中文历史')),['Messages','All'].includes(label))
 }
 nodes.find(node=>node.props?.role==='option'&&ownText(node).includes('未加载的中文历史')).props.onClick()
 nodes=draw()
 assert.equal(opened,undefined)
 assert.ok(nodes.some(node=>node.props?.role==='dialog'&&node.props['aria-label']==='Read-only history match'))
 assert.ok(nodes.some(node=>ownText(node)==='This is segment history, not the current chat. No Bot is activated.'))
 assert.equal(nodes.some(node=>node.type==='pre'&&ownText(node).includes('未加载的中文历史')),false,'search snippets cannot masquerade as authorized context')
})
test('loading, continuation and incomplete states never claim an exhaustive no-results search',()=>{
 for(const state of [{status:'loading'}, {status:'ready',cursor:'opaque'}, {status:'ready',incomplete:true}, {status:'ready',limited:true}]){
  historyState={items:[],cursor:null,...state};const nodes=mount('zzzz')()
  assert.equal(nodes.some(node=>hasClass(node,'bt-palette-empty-label')&&ownText(node)==='No results'),false)
 }
 let more=0;historyState={items:[],status:'ready',cursor:'opaque',more:()=>more++}
 const nodes=mount('zzzz')();nodes.find(node=>ownText(node)==='Search more history').props.onClick();assert.equal(more,1)
})
test('backend error explicitly falls back to loaded outlines; no global/files tag or all-history claim',()=>{
 historyState={items:[],status:'error',cursor:null}
 const nodes=mount('Chief')()
 assert.ok(nodes.some(node=>ownText(node)==='History query failed; showing loaded messages only.'))
 assert.ok(nodes.some(node=>node.props?.role==='option'&&ownText(node).includes('Weekly note')))
 assert.deepEqual(nodes.filter(node=>hasClass(node,'bt-palette-filter')).map(ownText),['All','Chats','Messages','Commands'])
 assert.equal(nodes.some(node=>ownText(node)==='Search all chats'),false)
})
