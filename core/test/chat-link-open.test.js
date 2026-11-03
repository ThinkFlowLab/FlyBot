// #2201: a link in a chat message was left to the host, which opens it in its own right sidebar — a
// browser tab FlyBot's fixed panel covers, so the content area looked blank and no error appeared.
// The link now opens a tab in FlyBot's own panel, the browser view the globe button already uses, and
// carries the URL there. Each case clicks the anchor MarkdownText draws and reads the action the page
// really calls; without the Desktop bridge there is no panel, so the page opens in the window itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) all(child, out); return out }
  if (node && typeof node === 'object') { out.push(node); for (const child of [node.props?.children].flat(Infinity)) all(child, out) }
  return out
}

// The platform's Markdown scope: the nearest provider hands the link handler down, and the anchor
// MarkdownText draws calls it exactly as the real one does on a plain HTTP(S) click.
const delegate = { openExternalLink: undefined }
function MarkdownDelegateProvider({ openExternalLink, children }) {
  delegate.openExternalLink = openExternalLink
  return children
}
const LINK = /\]\((https?:\/\/[^)\s]+)\)/
function MarkdownText({ text }) {
  const href = String(text ?? '').match(LINK)?.[1]
  if (!href) return h('span', { className: 'bt-md', text })
  return h('a', {
    className: 'bt-md-link',
    href,
    onClick: (event) => { event?.preventDefault?.(); delegate.openExternalLink?.(href) },
  })
}

// One state slot set per component path, effects only when their deps change, setters mark the tree
// dirty so the caller renders again: enough to run the components this file builds.
const runtime = { instances: new Map(), key: 'root', index: 0 }
function instance(key) {
  let inst = runtime.instances.get(key)
  if (!inst) { inst = { slots: [], refs: [], pending: [], deps: new Map() }; runtime.instances.set(key, inst) }
  return inst
}
function withInstance(key, run) {
  const previousKey = runtime.key
  const previousIndex = runtime.index
  runtime.key = key
  runtime.index = 0
  try { return run() } finally { runtime.key = previousKey; runtime.index = previousIndex }
}
const react = {
  createElement: h,
  Fragment: Symbol('Fragment'),
  useEffect: (run, deps) => instance(runtime.key).pending.push({ index: runtime.index++, run, deps }),
  useLayoutEffect: (run, deps) => instance(runtime.key).pending.push({ index: runtime.index++, run, deps }),
  useMemo: (make) => make(),
  useCallback: (fn) => fn,
  useRef: (current) => {
    const inst = instance(runtime.key)
    const index = runtime.index++
    if (!(index in inst.refs)) inst.refs[index] = { current }
    return inst.refs[index]
  },
  useState: (initial) => {
    const inst = instance(runtime.key)
    const index = runtime.index++
    if (!(index in inst.slots)) inst.slots[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => { inst.slots[index] = typeof next === 'function' ? next(inst.slots[index]) : next }
    return [inst.slots[index], set]
  },
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const opened = []
const env = {
  module: { exports: {} },
  document: { body: {}, hidden: false, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: { innerHeight: 800, innerWidth: 1400, addEventListener() {}, removeEventListener() {}, open: (...args) => opened.push(args) },
  setTimeout, clearTimeout,
}
env.require = (name) => {
  if (name === 'react') return react
  if (name === 'react-dom') return { createPortal: (node) => node }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText, MarkdownDelegateProvider }
  throw new Error(`Unexpected platform module ${name}`)
}
runInNewContext(bundle.outputFiles[0].text, env)
const { Bubbles } = env.module.exports

// Function components run the way React runs them, so the provider and the bubble see their props.
const expand = (node, path = 'r') => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map((child, at) => expand(child, `${path}.${at}`))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return withInstance(path, () => expand(node.type(node.props), path))
  return { ...node, props: { ...node.props, children: expand(node.props.children, path) } }
}
const clickLink = (tree) => {
  const anchor = all(tree).find(node => node.type === 'a')
  assert.ok(anchor, 'the bubble draws the link as an anchor')
  anchor.props.onClick({ preventDefault() {} })
  return anchor.props.href
}

// The panel the way index.js drives it: browserNewTab puts a tab in the Bot's strip and moves the
// panel to the browser view (null when the Bot is not in the roster), browserNavigate loads the tab.
const panelHarness = () => {
  const panel = { details: null, view: 'details', renaming: false, tab: null }
  const tabs = new Map()
  const calls = []
  let next = 0
  return {
    panel, tabs, calls,
    useUi: (read) => read(panel),
    browserNewTab: (id) => {
      calls.push(['tab', id])
      if (!ROSTER.byId[id]) return null
      const tabId = `t${++next}`
      tabs.set(tabId, null)
      Object.assign(panel, { details: id, view: 'browser', renaming: false, tab: null })
      return tabId
    },
    browserNavigate: (tabId, url) => {
      calls.push(['navigate', tabId, url])
      if (!tabs.has(tabId)) throw new Error(`browserNavigate called with no tab: ${String(tabId)}`)
      tabs.set(tabId, url)
      return Promise.resolve(true)
    },
  }
}

const ROSTER = { bots: [], byId: { b1: { id: 'b1', name: 'FlyBot', color: 'blue' } }, roomsById: {} }

test('#2201: a link in an assistant bubble opens FlyBot\'s own panel with the URL', () => {
  const p = panelHarness()
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate, toggleReaction() {} }
  const tree = expand(h(Bubbles, { texts: ['see [the issue](https://github.com/o/r/issues/2) for detail'], roster: ROSTER, selfId: 'b1', actions, sessionId: 'b1', useUi: p.useUi }))
  const href = clickLink(tree)
  assert.deepEqual(p.calls, [['tab', 'b1'], ['navigate', 't1', href]], 'the link opens a tab in FlyBot\'s panel and carries the URL there')
  assert.equal(p.tabs.get('t1'), href, 'the tab shows the URL the link pointed at')
  assert.equal(p.panel.view, 'browser', 'the panel is on the browser view, not the details panel that covered the page')
  assert.equal(p.panel.details, 'b1', 'the panel is showing the Bot whose chat the link was in')
})

test('#2201: the click does not depend on the details panel being open or closed', () => {
  const url = 'https://github.com/o/r/issues/2'
  for (const details of ['b1', null]) {
    const p = panelHarness()
    Object.assign(p.panel, { details, view: 'details' })
    const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
    const tree = expand(h(Bubbles, { texts: [`[x](${url})`], roster: ROSTER, selfId: 'b1', actions, sessionId: 'b1', useUi: p.useUi }))
    clickLink(tree)
    assert.deepEqual(p.calls, [['tab', 'b1'], ['navigate', 't1', url]], `the panel opens the same way with details ${details ? 'open' : 'closed'}`)
    assert.equal(p.panel.view, 'browser', 'the view the person lands on is the browser view either way')
    assert.equal(p.tabs.get('t1'), url)
  }
})

test('#2201: a Bot outside the roster gets no tab and the click does not throw', () => {
  const p = panelHarness()
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
  const tree = expand(h(Bubbles, { texts: ['[x](https://example.com/b)'], roster: ROSTER, selfId: 'ghost', actions, sessionId: 'ghost', useUi: p.useUi }))
  assert.doesNotThrow(() => clickLink(tree), 'a missing tab is skipped, not navigated')
  assert.deepEqual(p.calls, [['tab', 'ghost']], 'no navigation is attempted when browserNewTab answers null')
  assert.equal(p.panel.view, 'details', 'the panel is left where it was')
})

test('#2201: without the Desktop bridge the page opens in the window itself', () => {
  opened.length = 0
  const actions = {}
  const tree = expand(h(Bubbles, { texts: ['[x](https://example.com/a)'], roster: ROSTER, selfId: 'b1', actions, sessionId: 'b1', useUi: (read) => read({ details: null, view: 'details' }) }))
  const href = clickLink(tree)
  assert.deepEqual(opened, [[href, '_blank', 'noopener']], 'the link opens in the window when there is no panel')
})
