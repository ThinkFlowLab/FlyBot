// #3318: a home that has not connected Bot Social still sees "+" → Join by number or link, and that
// dialog drew "Loading your Bots…" for ever. The empty list was never a loading state: `social/status`
// answers `connected: false` on purpose (`social.js` `connected: Boolean(home)`, `bots: home ? … : []`),
// and the dialog's read took only `bots`. This pins the two halves of the answer — the sentence that
// says Bot Social is not connected with a way into Settings → Bot Social, and the absence of the
// loading hint — and keeps the connected window drawing the picker it always drew.
//
// React is not loaded (no jsdom in this repo): a small hook runtime below gives every component in the
// tree its own frame keyed by its position, so a state the status read sets redraws the dialog exactly
// as the browser would. The component source is the shipped `plugins/social/client.js`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const BOT = { id: 'b1', name: 'Chief', handle: '@chief.home', isMain: true }

// The dialog reads `document` for its Escape listener and `useStyles` for its sheet; no jsdom here,
// the other client tests stub the same three calls.
globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

// One node of the drawn tree: a host element with its props, or a run of text.
function draw({ status, props, onCall } = {}) {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)

  let current = null
  let dirty = false
  const frames = new Map()
  const calls = []
  const frameFor = key => {
    if (!frames.has(key)) frames.set(key, { hooks: {}, effects: [], idx: 0 })
    return frames.get(key)
  }
  const react = {
    createElement: (type, attrs, ...children) => ({ type, props: attrs ?? {}, children: children.flat(Infinity) }),
    Fragment: 'F',
    useState(init) {
      const frame = current
      const at = frame.idx++
      if (!(at in frame.hooks)) frame.hooks[at] = { value: typeof init === 'function' ? init() : init }
      const slot = frame.hooks[at]
      return [slot.value, next => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (value === slot.value) return
        slot.value = value
        dirty = true
      }]
    },
    useEffect(fn, deps) {
      const frame = current
      frame.effects.push([frame.idx++, fn, deps])
    },
    useRef: value => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: fn => fn,
  }
  globalThis.__flybot__ = {
    call: (endpoint, payload) => {
      calls.push([endpoint, payload])
      return onCall ? onCall(endpoint, payload) : Promise.resolve({})
    },
    canRetry: () => true,
  }
  const social = modules.get('@flybot/social')(name => (name === 'react' ? react : {}))

  const nodes = []
  const walk = (node, key) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') { nodes.push({ text: String(node) }); return }
    if (Array.isArray(node)) { node.forEach((child, at) => walk(child, `${key}.${at}`)); return }
    if (typeof node.type === 'function') {
      const frame = frameFor(key)
      frame.idx = 0
      frame.effects = []
      const outer = current
      current = frame
      let drawn
      try { drawn = node.type(node.props ?? {}) } finally { current = outer }
      walk(drawn, `${key}(`)
      return
    }
    nodes.push({ type: node.type, props: node.props ?? {} })
    node.children.forEach((child, at) => walk(child, `${key}.${at}`))
  }
  const paint = () => {
    nodes.length = 0
    dirty = false
    walk(react.createElement(social.FaceToFaceGroup, props), 'root')
    for (const [, frame] of frames) {
      for (const [at, fn, deps] of frame.effects) {
        const slot = (frame.hooks[at] ??= {})
        const same = Array.isArray(deps) && Array.isArray(slot.deps) && deps.length === slot.deps.length && deps.every((value, i) => value === slot.deps[i])
        if (same) continue
        slot.deps = deps ? [...deps] : undefined
        fn()
      }
    }
  }
  return { nodes, calls, paint, settle: async () => { for (let round = 0; round < 6 && (dirty || round < 3); round++) { paint(); await new Promise(done => setTimeout(done, 0)) } } }
}

const byId = (nodes, id) => nodes.find(node => node.props?.['data-flybot'] === id)
const textsOf = nodes => nodes.filter(node => typeof node.text === 'string').map(node => node.text)
const props = () => ({ actions: { openSettings: () => {} }, roster: { byId: {}, readOnly: '' }, remoteChats: [], mode: 'join', onClose: () => {} })

// The status read succeeds and says this home has no Bot Social identity: that is the state the user
// is stuck in, not a read still on its way.
const disconnected = () => Promise.resolve({ connected: false, home: undefined, bots: [] })

test('#3318: a home without Bot Social is told so, not shown a loading hint', async () => {
  const opened = []
  const ui = draw({ props: { ...props(), actions: { openSettings: (...args) => opened.push(args) } }, onCall: disconnected })
  await ui.settle()
  const texts = textsOf(ui.nodes).join(' | ')
  assert.ok(!texts.includes('Loading your Bots…'), `the dialog still claims the list is loading: ${texts}`)
  assert.match(texts, /Bot Social is not connected/, `nothing says Bot Social is not connected: ${texts}`)
  assert.match(texts, /Settings → Bot Social/, `the sentence does not name where to connect it: ${texts}`)
  const go = byId(ui.nodes, 'face-join-settings')
  assert.ok(go, 'no control leads to Settings → Bot Social')
  assert.equal(go.props.disabled, false, 'the way into Settings is drawn disabled')
  go.props.onClick({})
  assert.deepEqual(opened, [['social']], 'the control does not open Settings → Bot Social')
})

test('#3318: a connected home still draws the Bot picker', async () => {
  const ui = draw({ props: props(), onCall: () => Promise.resolve({ connected: true, home: 'self.home', bots: [BOT] }) })
  await ui.settle()
  const texts = textsOf(ui.nodes).join(' | ')
  assert.ok(!texts.includes('Bot Social is not connected'), `a connected home is told it is not connected: ${texts}`)
  assert.equal(byId(ui.nodes, 'face-pick')?.props['aria-label'], 'Your Bots', 'the Bot picker is gone from a connected dialog')
  assert.ok(texts.includes('Chief'), 'the Bot list is not drawn')
  assert.equal(byId(ui.nodes, 'face-join-settings'), undefined, 'a connected home is offered the Settings way out')
})
