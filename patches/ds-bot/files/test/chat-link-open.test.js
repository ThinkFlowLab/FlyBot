// #2201 / #2319: what a pick inside a chat bubble does, and what the bubble must leave alone.
//
// #2201: a link left to the host opens in the host's right sidebar — a browser tab FlyBot's fixed panel
// covers, so the content area looked blank. The panel's own browser view carries the URL now, and a
// window without the Desktop bridge opens the page itself.
//
// #2319: the first fix wrapped every bubble in a Markdown delegate of its own, and a nested
// MarkdownDelegateProvider REPLACES the enclosing capabilities: the host's file opener and image
// resolver stopped reaching the bubble, so `![shot](screenshots/a.png)` drew the alt text `shot`, and a
// local `[x](path#L12)` link lost its chip. The harness below models that replacement semantics and
// renders an image through the resolver, which the earlier stub could not see.
//
// The click cases drive the capture handler the containers install, the way a browser dispatches one:
// capture on the way down, then the anchor's own handler when nothing stopped the event.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })

// ---------------------------------------------------------------------------
// The platform's Markdown scope
//
// `MarkdownDelegateProvider` starts a context from exactly its own props: "Nested providers replace
// the enclosing capabilities" (dsh-client-ui-primitives). `scope` is that context; a provider element
// swaps it wholesale — never merges — so an inner provider that lacks `fileImages` hides the outer one,
// which is what #2313 did to every bubble.
const scope = { current: null }
function MarkdownDelegateProvider({ children }) { return children }
MarkdownDelegateProvider.__replacesScope = true

// A DOM node is only needed for `event.target.closest(...)`; `mentionTarget` checks `instanceof Element`.
class Element {}
const anchorTarget = (href) => Object.assign(new Element(), {
  href,
  getAttribute: (name) => (name === 'href' ? href : null),
  closest(selector) {
    if (selector === 'a[href]') return this
    const prefix = /^a\[href\^="(.*)"\]$/.exec(selector)
    if (prefix && href.startsWith(prefix[1])) return this
    return null
  },
})
const plainTarget = () => Object.assign(new Element(), { closest: () => null })

// MarkdownText as the host renders it: an image resolves through the nearest `fileImages` (otherwise it
// falls back to the alt span), an http(s) destination becomes an anchor whose own handler is the host's
// `openExternalLink`, and anything else is a file link that needs `openFile` to become a chip.
function MarkdownImage({ destination, alt }) {
  const fileImages = scope.current?.fileImages
  const resolved = fileImages?.resolve?.(destination)
  if (typeof resolved !== 'string') return h('span', { className: 'imageAlt' }, alt)
  return h('img', { className: 'bt-md-image', src: resolved, alt, preview: fileImages })
}
function MarkdownFileLink({ destination, children }) {
  // The opener is read while the bubble renders, the way React hands a context value to a handler.
  const openFile = scope.current?.openFile
  if (typeof openFile !== 'function') return h('span', { className: 'bt-md-file-plain' }, children)
  return h('span', { className: 'bt-md-file', onClick: (event) => { event?.preventDefault?.(); openFile(destination) } }, children)
}
function MarkdownText({ text }) {
  const source = String(text ?? '')
  const token = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)/g
  const parts = []
  let last = 0
  for (let match = token.exec(source); match; match = token.exec(source)) {
    if (match.index > last) parts.push(source.slice(last, match.index))
    if (match[1] !== undefined) parts.push(h(MarkdownImage, { destination: match[2], alt: match[1] }))
    else {
      const destination = match[4]
      const openExternalLink = scope.current?.openExternalLink
      // MarkdownAnchor: a modified or middle click is the browser's (new tab, new window), so the
      // host delegate is not called and nothing is prevented.
      parts.push(/^https?:/i.test(destination)
        ? h('a', { className: 'bt-md-link', href: destination, onClick: (event) => { if (event?.button !== 0 || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) return; event?.preventDefault?.(); openExternalLink?.(destination) } })
        : h(MarkdownFileLink, { destination }, match[3]))
    }
    last = token.lastIndex
  }
  if (last < source.length) parts.push(source.slice(last))
  return h('span', { className: 'bt-md' }, ...parts)
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
  Element,
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
const { Bubbles, GroupReplies, TriggerCell } = env.module.exports

// Function components run the way React runs them, so the provider and the bubble see their props. A
// provider element replaces the scope for the children it renders and restores it afterwards.
const expand = (node, path = 'r') => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map((child, at) => expand(child, `${path}.${at}`))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    if (node.type.__replacesScope) {
      const outer = scope.current
      scope.current = { openExternalLink: node.props.openExternalLink, openFile: node.props.openFile, fileImages: node.props.fileImages }
      try { return expand(node.props.children, `${path}.scope`) } finally { scope.current = outer }
    }
    return withInstance(`${path}:${node.type.name || 'anon'}`, () => expand(node.type(node.props), path))
  }
  return { ...node, props: { ...node.props, children: expand(node.props.children, path) } }
}

const runQueuedEffects = () => {
  for (const inst of runtime.instances.values()) {
    for (const entry of inst.pending.splice(0)) {
      const previous = inst.deps.get(entry.index)
      const deps = entry.deps
      const changed = !previous || !deps || previous.length !== deps.length || deps.some((value, at) => value !== previous[at])
      if (!changed) continue
      inst.deps.set(entry.index, deps)
      entry.run()
    }
  }
}

// Render, let the effects of that render run, wait for the page they ask for, render again: what a
// mounted component does over two paints, without a DOM.
const settle = async (node, delegate, rounds = 6) => {
  let tree = withHost(node, delegate)
  for (let round = 0; round < rounds; round++) {
    runQueuedEffects()
    await new Promise((resolve) => setImmediate(resolve))
    tree = withHost(node, delegate)
  }
  return tree
}

// The host wraps the node list in its own provider: that is where `openFile` and `fileImages` live,
// and the host never hands `fileImages` to the node itself (#2319).
const withHost = (node, delegate) => {
  const outer = scope.current
  scope.current = delegate
  try { return expand(node) } finally { scope.current = outer }
}

const find = (node, match, parents = []) => {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, match, parents); if (found) return found }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (match(node)) return { node, parents }
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, match, [...parents, node])
    if (found) return found
  }
  return null
}
// A browser dispatches a click down the tree (capture) and then to the target, unless a capture
// handler stopped it. Only the left button without modifiers reaches the target's own handler.
const clickOn = (tree, targetNode, { button = 0, metaKey = false, ctrlKey = false, shiftKey = false, altKey = false } = {}) => {
  const found = find(tree, (node) => node === targetNode)
  assert.ok(found, 'the clicked node is in the rendered tree')
  const event = {
    target: targetNode.type === 'a' && typeof targetNode.props?.href === 'string' ? anchorTarget(targetNode.props.href) : plainTarget(),
    button, metaKey, ctrlKey, shiftKey, altKey,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  }
  for (const parent of found.parents) {
    const handler = parent.props?.onClickCapture
    if (typeof handler !== 'function') continue
    handler(event)
    if (event.stopped) return event
  }
  const onClick = targetNode.props?.onClick
  if (button === 0 && typeof onClick === 'function') onClick(event)
  return event
}
const anchorIn = (tree) => {
  const found = find(tree, (node) => node.type === 'a')
  assert.ok(found, 'the bubble draws the link as an anchor')
  return found.node
}

// The panel the way index.js drives it: browserNewTab puts a tab in the Bot's strip and moves the
// panel to the browser view (null when the Bot is not in the roster), browserNavigate loads the tab.
const panelHarness = (roster = ROSTER) => {
  const panel = { details: null, view: 'details', renaming: false, tab: null }
  const tabs = new Map()
  const calls = []
  let next = 0
  return {
    panel, tabs, calls,
    useUi: (read) => read(panel),
    browserNewTab: (id) => {
      calls.push(['tab', id])
      if (!roster.byId[id]) return null
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
// The host's own delegate: what the outer provider carried before #2313 and carries again after #2319.
const hostScope = ({ openFile, fileImages } = {}) => {
  const external = []
  return { external, openFile, fileImages, delegate: { openExternalLink: (href) => external.push(href), openFile, fileImages } }
}

// ---------------------------------------------------------------------------
// #2201: the page opens in FlyBot's own panel

test('#2201: a link in an assistant bubble opens FlyBot\'s own panel with the URL', () => {
  const p = panelHarness()
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate, toggleReaction() {} }
  const host = hostScope({})
  const tree = withHost(h(Bubbles, { texts: ['see [the issue](https://github.com/o/r/issues/2) for detail'], roster: ROSTER, selfId: 'b1', actions, sessionId: 'b1', useUi: p.useUi }), host.delegate)
  const anchor = anchorIn(tree)
  const href = anchor.props.href
  clickOn(tree, anchor)
  assert.deepEqual(p.calls, [['tab', 'b1'], ['navigate', 't1', href]], 'the link opens a tab in FlyBot\'s panel and carries the URL there')
  assert.equal(p.tabs.get('t1'), href, 'the tab shows the URL the link pointed at')
  assert.equal(p.panel.view, 'browser', 'the panel is on the browser view, not the details panel that covered the page')
  assert.equal(p.panel.details, 'b1', 'the panel is showing the Bot whose chat the link was in')
  assert.deepEqual(host.external, [], 'the host never sees a page link that FlyBot opened')
})

test('#2201: the click does not depend on the details panel being open or closed', () => {
  const url = 'https://github.com/o/r/issues/2'
  for (const details of ['b1', null]) {
    const p = panelHarness()
    Object.assign(p.panel, { details, view: 'details' })
    const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
    const tree = withHost(h(Bubbles, { texts: [`[x](${url})`], roster: ROSTER, selfId: 'b1', actions, sessionId: 'b1', useUi: p.useUi }), hostScope({}).delegate)
    clickOn(tree, anchorIn(tree))
    assert.deepEqual(p.calls, [['tab', 'b1'], ['navigate', 't1', url]], `the panel opens the same way with details ${details ? 'open' : 'closed'}`)
    assert.equal(p.panel.view, 'browser', 'the view the person lands on is the browser view either way')
    assert.equal(p.tabs.get('t1'), url)
  }
})

test('#2201: a Bot outside the roster gets no tab and the page opens in the window once', () => {
  opened.length = 0
  const p = panelHarness()
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
  const host = hostScope({})
  const tree = withHost(h(Bubbles, { texts: ['[x](https://example.com/b)'], roster: ROSTER, selfId: 'ghost', actions, sessionId: 'ghost', useUi: p.useUi }), host.delegate)
  let href
  assert.doesNotThrow(() => { href = anchorIn(tree).props.href; clickOn(tree, anchorIn(tree)) }, 'a missing tab falls back instead of throwing')
  assert.deepEqual(p.calls, [['tab', 'ghost']], 'no navigation is attempted when browserNewTab answers null')
  assert.equal(p.panel.view, 'details', 'the panel is left where it was')
  // Exactly one window: a fallback here and another in the host would open the page twice.
  assert.deepEqual(opened, [[href, '_blank', 'noopener,noreferrer']], 'the page opens in the window exactly once')
  assert.deepEqual(host.external, [], 'the host does not open a second copy')
})

test('#2201: a room bubble targets the Bot that spoke, not the room id', () => {
  // GroupMessage renders Bubbles with the room as sessionId and the speaking Bot as selfId; the
  // room id is not a Bot, so browserNewTab(room) answers null and the click would go nowhere.
  opened.length = 0
  const p = panelHarness()
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
  const tree = withHost(h(Bubbles, { texts: ['[x](https://example.com/room)'], roster: ROSTER, selfId: 'b1', actions, sessionId: 'room-1', useUi: p.useUi }), hostScope({}).delegate)
  const anchor = anchorIn(tree)
  const href = anchor.props.href
  clickOn(tree, anchor)
  assert.deepEqual(p.calls, [['tab', 'b1'], ['navigate', 't1', href]], 'the tab opens for the Bot whose message carried the link')
  assert.equal(p.tabs.get('t1'), href, 'the tab carries the URL')
  assert.deepEqual(opened, [], 'nothing falls back to the window when the panel opened the link')
})

test('#2201: without the Desktop bridge the page opens in the window itself', () => {
  opened.length = 0
  const tree = withHost(h(Bubbles, { texts: ['[x](https://example.com/a)'], roster: ROSTER, selfId: 'b1', actions: {}, sessionId: 'b1', useUi: (read) => read({ details: null, view: 'details' }) }), hostScope({}).delegate)
  const anchor = anchorIn(tree)
  const href = anchor.props.href
  clickOn(tree, anchor)
  assert.deepEqual(opened, [[href, '_blank', 'noopener,noreferrer']], 'the link opens in the window, exactly once')
})

// ---------------------------------------------------------------------------
// #2319: the bubble keeps the host's file resolver and opener

test('#2319: a bubble image resolves through the host and is not drawn as its alt text', () => {
  // The host gives `fileImages` to its own provider, never to the node (#2319 root cause). A bubble
  // that starts a delegate without it replaces the resolver with `undefined` and MarkdownImage falls
  // back to <span class="imageAlt">. This case is red on e40cecf6 and green once the bubble is bare.
  const fileImages = { resolve: (path) => `/media/${path}`, labels: { open: 'Open', close: 'Close' } }
  const host = hostScope({ fileImages })
  const tree = withHost(h(Bubbles, { texts: ['![shot](screenshots/a.png)'], roster: ROSTER, selfId: 'b1', actions: {}, sessionId: 'b1', useUi: (read) => read({}) }), host.delegate)
  const image = find(tree, (node) => node.type === 'img')?.node
  assert.ok(image, 'the image renders as an image, not as the alt span')
  assert.equal(image.props.src, '/media/screenshots/a.png', 'the source comes from the host resolver')
  assert.equal(image.props.preview, fileImages, 'the lightbox opens through the same host resolver')
  assert.equal(find(tree, (node) => node.type === 'span' && node.props?.className === 'imageAlt'), null, 'nothing was drawn as alt text')
})

test('#2319: a local file link keeps the host\'s chip and its opener', () => {
  opened.length = 0
  const openedFiles = []
  const host = hostScope({ openFile: (path) => openedFiles.push(path) })
  const p = panelHarness()
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
  const tree = withHost(h(Bubbles, { texts: ['[cells](core/src/client/cells.js#L12)'], roster: ROSTER, selfId: 'b1', actions, sessionId: 'b1', useUi: p.useUi }), host.delegate)
  const chip = find(tree, (node) => node.type === 'span' && node.props?.className === 'bt-md-file')?.node
  assert.ok(chip, 'the host openFile draws the file chip; without it the link is plain text')
  clickOn(tree, chip)
  assert.deepEqual(openedFiles, ['core/src/client/cells.js#L12'], 'the click reaches the host file opener')
  assert.deepEqual(p.calls, [], 'a file is not a page: FlyBot\'s panel is not touched')
  assert.deepEqual(opened, [], 'and nothing opens in the window')
})

// ---------------------------------------------------------------------------
// #2319: clicks the bubble must leave alone

test('#2319: a modifier or middle click is left to the host', () => {
  const cases = [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]
  for (const options of cases) {
    opened.length = 0
    const p = panelHarness()
    const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
    const host = hostScope({})
    const tree = withHost(h(Bubbles, { texts: ['[x](https://example.com/a)'], roster: ROSTER, selfId: 'b1', actions, sessionId: 'b1', useUi: p.useUi }), host.delegate)
    const event = clickOn(tree, anchorIn(tree), options)
    const label = Object.keys(options).join('+')
    assert.deepEqual(p.calls, [], `${label}: FlyBot's panel is not involved`)
    assert.deepEqual(opened, [], `${label}: FlyBot opens no window`)
    // The click is the browser's: the bubble neither prevents it nor hands it to the host delegate
    // (MarkdownAnchor ignores a modified or middle click itself, like the platform round it models).
    assert.equal(event.defaultPrevented, false, `${label}: the bubble does not claim the click`)
    assert.deepEqual(host.external, [], `${label}: the host delegate is not asked to open it`)
  }
})

test('#2319: a mention still opens the Bot part and is not taken for a page', () => {
  // A mention is an https link to the origin the plugin rewrites names into, so the page rule must not
  // swallow it: the capture handler opens the part, as it did before the link fix.
  const roster = { bots: [{ id: 'b2', name: 'Chief', color: 'blue' }], byId: { b1: { id: 'b1', name: 'FlyBot', color: 'blue' }, b2: { id: 'b2', name: 'Chief', color: 'blue' } }, roomsById: {} }
  opened.length = 0
  const sessions = []
  const actions = { openSession: (id) => sessions.push(id) }
  const host = hostScope({})
  const tree = withHost(h(Bubbles, { texts: ['ask @Chief'], roster, selfId: 'b1', actions, sessionId: 'b1', useUi: (read) => read({}) }), host.delegate)
  const mention = find(tree, (node) => node.type === 'a' && String(node.props?.href ?? '').startsWith('https://bots.local/'))?.node
  assert.ok(mention, 'a mention is drawn as an anchor')
  clickOn(tree, mention)
  assert.deepEqual(sessions, ['b2'], 'the mention opens the Bot part')
  assert.deepEqual(host.external, [], 'the host delegate never sees a mention')
  assert.deepEqual(opened, [], 'a mention is not a page')
})

test('#2319: the group replies card keeps its own button clickable', () => {
  // GroupReplies gains a capture handler for links; its own controls must still receive a click that
  // has no anchor in it (the Lead's guard against swallowing button presses).
  opened.length = 0
  const details = []
  const actions = { showDetails: (id) => details.push(id), roomProgress: async () => [] }
  const content = [{ type: 'text', text: JSON.stringify({ replies: [{ kind: 'working', botId: 'b1', name: 'FlyBot', text: 'working' }] }) }]
  const tree = withHost(h(GroupReplies, { sessionId: 'b1', callId: 'c1', done: true, content, roster: ROSTER, actions, useUi: (read) => read({}) }), hostScope({}).delegate)
  const button = find(tree, (node) => node.type === 'button')?.node
  assert.ok(button, 'the reply card draws its button')
  clickOn(tree, button)
  assert.deepEqual(details, ['b1'], 'the capture handler leaves a button press alone')
  assert.deepEqual(opened, [], 'and opens nothing')
})

// ---------------------------------------------------------------------------
// #2319 review: the click belongs to the line the person clicked

test('#2319: a link in another Bot\'s reply opens that Bot\'s tab, not the room', () => {
  // GroupReplies puts one capture handler on the card in the first cut of the fix; it claimed every
  // anchor with the room as the subject, so a reply's own link fell to the window instead of opening
  // the tab of the Bot that spoke. The Bot's own bubble carries the handler now.
  opened.length = 0
  const roster = { bots: [{ id: 'b2', name: 'Chief', color: 'blue' }], byId: { b1: { id: 'b1', name: 'FlyBot', color: 'blue' }, b2: { id: 'b2', name: 'Chief', color: 'blue' } }, roomsById: {} }
  const p = panelHarness(roster)
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
  const url = 'https://example.com/reply'
  const content = [{ type: 'text', text: JSON.stringify({ replies: [{ kind: 'bot', botId: 'b2', name: 'Chief', text: `see [the page](${url})` }] }) }]
  const host = hostScope({})
  const tree = withHost(h(GroupReplies, { sessionId: 'room-1', callId: 'c1', done: true, content, roster, actions, useUi: p.useUi }), host.delegate)
  clickOn(tree, anchorIn(tree))
  assert.deepEqual(p.calls, [['tab', 'b2'], ['navigate', 't1', url]], 'the tab belongs to the Bot whose reply carried the link')
  assert.equal(p.tabs.get('t1'), url, 'the tab carries the URL')
  assert.deepEqual(opened, [], 'the page does not fall back to a bare window')
  assert.deepEqual(host.external, [], 'the host delegate never sees it')
})

test('#2319: a link on the person\'s own line in a group card is still claimed', () => {
  // The capture handler moved from the card onto this row; a row with no handler would leave the link
  // to the host, which opens it in the sidebar the panel covers (#2201).
  opened.length = 0
  const roster = { bots: [], byId: { b1: { id: 'b1', name: 'FlyBot', color: 'blue' } }, roomsById: {} }
  const p = panelHarness(roster)
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate }
  const url = 'https://example.com/mine'
  const content = [{ type: 'text', text: JSON.stringify({ replies: [{ kind: 'user', authorId: 'u1', name: 'Ann', text: `[mine](${url})` }] }) }]
  const host = hostScope({})
  const tree = withHost(h(GroupReplies, { sessionId: 'room-1', callId: 'c1', done: true, content, roster, actions, useUi: p.useUi }), host.delegate)
  const row = find(tree, (node) => node.type === 'div' && node.props?.className === 'bt-urow')?.node
  assert.ok(row, 'the card draws the person\'s own line')
  const event = clickOn(tree, find(row, (node) => node.type === 'a')?.node)
  assert.equal(event.defaultPrevented, true, 'the row claims the click, as the card did before')
  assert.equal(event.stopped, true, 'and nothing else sees it')
  assert.deepEqual(opened, [[url, '_blank', 'noopener,noreferrer']], 'the page opens once, in the window')
  assert.deepEqual(host.external, [], 'the host never sees it')
})

test('#2319: an earlier part claims its own lines and leaves a Bot line to that Bot', async () => {
  // EarlierParts is not exported; a handoff line mounts it through TriggerCell. Both kinds of row use
  // the same subject here, so the point is that a link on either one is still claimed by this page and
  // never falls to the host (the handler moved from the page container onto the person's row).
  opened.length = 0
  const roster = { bots: [{ id: 'b1', name: 'FlyBot', color: 'blue' }], byId: { b1: { id: 'b1', name: 'FlyBot', color: 'blue' } }, roomsById: {}, exchangeTurns: {} }
  const p = panelHarness(roster)
  const mine = 'https://example.com/earlier-u'
  const bot = 'https://example.com/earlier-b'
  const page = {
    items: [
      { kind: 'user', text: `[mine](${mine})`, sessionId: 'b1', turn: 1, seq: 1, time: 1 },
      { kind: 'bot', text: `[bot](${bot})`, sessionId: 'b1', turn: 1, seq: 2, time: 2 },
    ],
    cursor: undefined,
    startedAt: 1,
  }
  const actions = { browserNewTab: p.browserNewTab, browserNavigate: p.browserNavigate, earlier: () => Promise.resolve(page), noteTurnPeer() {} }
  const node = h(TriggerCell, {
    node: { data: { source: { kind: 'bot', handoff: true }, turn: 4, content: [] } },
    sessionId: 'b1',
    useRoster: (read) => read(roster),
    useSessions: (read) => read({ projectionsBySession: {}, byId: {} }),
    useTurnClock: (read) => read({}),
    useUi: p.useUi,
    actions,
  })
  const host = hostScope({})
  const tree = await settle(node, host.delegate)
  const userRow = find(tree, (candidate) => candidate.type === 'div' && candidate.props?.className === 'bt-urow')?.node
  assert.ok(userRow, 'the earlier part draws the person\'s own line')
  const mineEvent = clickOn(tree, find(userRow, (candidate) => candidate.type === 'a')?.node)
  assert.equal(mineEvent.defaultPrevented, true, 'a link on the person\'s line is claimed')
  const botAnchor = find(tree, (candidate) => candidate.type === 'a' && candidate.props?.href === bot)?.node
  assert.ok(botAnchor, 'the earlier part draws the Bot\'s line as a link')
  const botEvent = clickOn(tree, botAnchor)
  assert.equal(botEvent.defaultPrevented, true, 'a link in the Bot\'s line is claimed by its bubble')
  assert.deepEqual(p.calls, [['tab', 'b1'], ['navigate', 't1', mine], ['tab', 'b1'], ['navigate', 't2', bot]], 'each link opens the part\'s own tab')
  assert.deepEqual(host.external, [], 'the host delegate never sees either link')
  assert.deepEqual(opened, [], 'nothing falls back to a bare window')
})
