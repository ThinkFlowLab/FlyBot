// The panel (client.js): geometry as pure functions, then the components through a small
// hook-capable renderer (state, effects with cleanup, re-render on set) so open/close, tabs and
// the poller's hold are exercised, plus negative tests that hostile names never become markup.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildWindow } from '../src/window.js'
import { at, bots, NOW, records, rooms } from './fixture.js'

// ---- a small renderer ------------------------------------------------------------------
const live = { inst: null, idx: 0 }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState(init) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
    const slot = inst.hooks[i]
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (!Object.is(value, slot.value)) { slot.value = value; inst.root.schedule() }
    }]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.idx++
    const prev = inst.hooks[i]
    const changed = !prev || !deps || deps.length !== prev.deps?.length || deps.some((dep, k) => !Object.is(dep, prev.deps[k]))
    if (!prev) inst.hooks[i] = { deps }
    if (changed) { inst.hooks[i].deps = deps; inst.root.pending.push({ slot: inst.hooks[i], fn }) }
  },
  useCallback(fn, deps) {
    const { inst } = live
    const i = live.idx++
    const prev = inst.hooks[i]
    if (prev && deps && deps.every((dep, k) => Object.is(dep, prev.deps[k]))) return prev.fn
    inst.hooks[i] = { fn, deps }
    return fn
  },
}

function mount(Component, props = {}) {
  const root = { instances: new Map(), pending: [], rendering: false, dirty: false, tree: undefined }
  const expand = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean') return undefined
    if (typeof node !== 'object') return String(node)
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}.${i}`))
    if (typeof node.type === 'function') {
      let inst = root.instances.get(path)
      if (!inst) { inst = { hooks: [], root }; root.instances.set(path, inst) }
      inst.used = true
      live.inst = inst
      live.idx = 0
      return expand(node.type({ ...node.props, children: node.children }), `${path}/c`)
    }
    return { type: node.type, props: node.props, children: node.children.map((child, i) => expand(child, `${path}.${i}`)).flat(Infinity).filter(child => child !== undefined) }
  }
  const render = () => {
    root.rendering = true
    for (const inst of root.instances.values()) inst.used = false
    root.tree = expand({ type: Component, props, children: [] }, 'r')
    for (const [path, inst] of [...root.instances]) {
      if (!inst.used) { for (const slot of inst.hooks) slot?.cleanup?.(); root.instances.delete(path) }
    }
    const run = root.pending.splice(0)
    for (const { slot, fn } of run) { slot.cleanup?.(); const out = fn(); slot.cleanup = typeof out === 'function' ? out : undefined }
    root.rendering = false
    if (root.dirty || root.pending.length) { root.dirty = false; render() }
  }
  root.schedule = () => { if (root.rendering) root.dirty = true; else render() }
  render()
  return {
    get tree() { return root.tree },
    unmount() { for (const inst of root.instances.values()) for (const slot of inst.hooks) slot?.cleanup?.(); root.instances.clear() },
  }
}
const findAll = (node, pred, out = []) => {
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const child of node.children) findAll(child, pred, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : node ? node.children.map(textOf).join('') : '')
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const htmlOf = (node) => {
  if (Array.isArray(node)) return node.map(htmlOf).join('')
  if (typeof node === 'string') return esc(node)
  const attrs = Object.entries(node.props).filter(([k, v]) => v !== undefined && v !== false && typeof v !== 'function' && k !== 'key').map(([k, v]) => ` ${k}="${esc(typeof v === 'object' ? JSON.stringify(v) : v)}"`).join('')
  return `<${node.type}${attrs}>${node.children.map(htmlOf).join('')}</${node.type}>`
}
const button = (tree, label) => findAll(tree, node => node.type === 'button' && textOf(node) === label)[0]

// ---- the client under test ---------------------------------------------------------------
const documentStub = { listeners: new Map(), createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, addEventListener(name, fn) { this.listeners.set(name, fn) }, removeEventListener(name) { this.listeners.delete(name) } }
globalThis.document = documentStub
function loadClient() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? react : {}))) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/timeline')
}
const client = loadClient()
const win = (extra = {}, recs = records()) => buildWindow(recs, { now: NOW, bots, rooms, ...extra })

test('fmtDur and fmtClock', () => {
  const { fmtDur, fmtClock } = client
  assert.deepEqual([420, 4500, 12_400, 185_000, 3_900_000].map(fmtDur), ['420 ms', '4.5 s', '12 s', '3m 05s', '1h 05m'])
  assert.deepEqual([-1, NaN, undefined].map(fmtDur), ['–', '–', '–'])
  const local = new Date(2026, 9, 18, 9, 5, 7).getTime()
  assert.equal(fmtClock(local), '09:05:07')
  assert.equal(fmtClock(local, false), '09:05')
  assert.equal(fmtClock(NaN), '–')
})

test('swimlanes: lanes stack in order and turns, tools, brackets and arrows land in their lanes', () => {
  const g = client.layoutSwimlanes(win({ windowMs: 60_000 }), {})
  assert.deepEqual(g.lanes.map(lane => lane.name), ['You', 'Chief', 'Writer', 'Team Room'])
  assert.ok(g.lanes.every((lane, i) => i === 0 || lane.y === g.lanes[i - 1].y + g.lanes[i - 1].h))
  assert.equal(g.lanes[1].main, true)
  const chief = g.lanes[1]
  const bar = id => g.bars.find(item => item.id === id)
  assert.ok(g.bars.every(item => item.x >= g.plotLeft - 0.001 && item.x + item.w <= g.plotRight + 0.001))
  assert.ok(g.bars.filter(item => item.lane === 'a').every(item => item.y >= chief.y && item.y + item.h <= chief.y + chief.h))
  // a#1's tool call sits inside its bar; the failed call on Writer is marked
  const a1 = bar('a#1')
  assert.equal(a1.tools.length, 1)
  assert.ok(a1.tools[0].x >= a1.x && a1.tools[0].x + a1.tools[0].w <= a1.x + a1.w + 0.001)
  assert.equal(bar('b#1').tools[0].ok, false)
  // the running Chief turn runs to the right edge; group member turns are flagged and name their group
  const running = bar('a#3')
  assert.equal(running.running, true)
  assert.ok(Math.abs(running.x + running.w - g.plotRight) < 0.001)
  assert.equal(bar('rb#1').group, true)
  assert.equal(bar('rb#1').room, 'Team Room')
  assert.match(bar('a#3').title, /running/)
  // the round is a bracket on the group lane that counts its member turns
  assert.equal(g.brackets.length, 1)
  assert.equal(g.brackets[0].calls, 2)
  assert.ok(g.brackets[0].x1 > g.brackets[0].x0)
  assert.match(g.brackets[0].title, /round of 2 member turns/)
  // arrows: Chief → Writer request has a wait line labelled with the latency; the reply is solid
  const arrow = id => g.arrows.find(item => item.id === id)
  assert.equal(arrow('x1').wait.label, 'reply 4.5 s')
  assert.equal(arrow('x1').role, 'request')
  assert.equal(arrow('x2').role, 'reply')
  assert.equal(arrow('x2').wait, undefined)
  assert.equal(arrow('x3').wait.label, 'waiting 4.0 s')
  assert.equal(arrow('x3').wait.open, true)
  assert.equal(arrow('xu').wait.label, 'answer 4.8 s')
  assert.ok(arrow('x1').x > arrow('xu').x)
  assert.ok(arrow('x1').y1 > chief.y && arrow('x1').y1 < chief.y + chief.h)
  assert.ok(g.axis.ticks.length > 1)
  assert.equal(g.axis.compressed, false)
})

test('swimlanes: "skip quiet time" shrinks the long quiet stretches and keeps the order', () => {
  const data = win({ windowMs: 15 * 60_000 })
  const real = client.layoutSwimlanes(data, { compress: false })
  const squeezed = client.layoutSwimlanes(data, { compress: true })
  assert.equal(squeezed.axis.compressed, true)
  assert.ok(squeezed.axis.breaks.length >= 1)
  const ids = ['a#1', 'a#2', 'a#3']
  const xs = ids.map(id => squeezed.bars.find(item => item.id === id).x)
  assert.deepEqual([...xs].sort((p, q) => p - q), xs)
  const wide = id => squeezed.bars.find(item => item.id === id).w
  assert.ok(wide('a#1') > 5 * real.bars.find(item => item.id === 'a#1').w)
  assert.ok(squeezed.bars.every(item => item.x >= squeezed.plotLeft - 0.001 && item.x + item.w <= squeezed.plotRight + 0.001))
  // nothing quiet to skip: same geometry as real time
  const busy = client.makeScale({ from: 0, to: 1000, spans: [[0, 1000]], width: 500, compress: true })
  assert.equal(busy.compressed, false)
  assert.equal(busy.x(500), 250)
})

test('communication map: nodes, curved edges with labels, and the wait table', () => {
  const data = win()
  const map = client.layoutMap(data)
  assert.deepEqual(map.nodes.map(node => node.name).sort(), ['Chief', 'Team Room', 'Writer', 'You'])
  const edge = (from, to) => map.edges.find(item => item.from === from && item.to === to)
  assert.equal(edge('b', 'a').label, '1×')
  assert.equal(edge('a', 'b').waiting, true) // x3 is not answered
  assert.equal(edge('a', 'b').label, '1 waiting')
  assert.match(edge('a', 'b').title, /2 requests/)
  assert.ok(edge('a', 'b').d.startsWith('M '))
  assert.ok(map.nodes.every(node => node.x > 0 && node.x < map.size && node.y > 0 && node.y < map.size))
  const rows = client.waitRows(data)
  assert.deepEqual(rows.map(row => `${row.waiter}>${row.on}`), ['You>Chief', 'Chief>Writer']) // longest total wait first
  assert.deepEqual(rows[1], { waiter: 'Chief', on: 'Writer', requests: 2, answered: 1, waiting: 1, medianMs: 4500, maxMs: 4500, totalMs: 4500 })
  assert.ok(rows.every((row, i) => i === 0 || rows[i - 1].totalMs >= row.totalMs))
})

test('utilization rows add up and carry the running flag', () => {
  const rows = client.utilizationRows(win())
  assert.deepEqual(rows.map(row => row.name), ['Chief', 'Writer'])
  const [chief, writer] = rows
  assert.equal(chief.running, true)
  assert.equal(writer.running, false)
  assert.ok(Math.abs(chief.model + chief.tools + chief.idle - 100) < 0.2)
  assert.equal(chief.busyMs, 14_500)
  assert.equal(chief.toolMs, 3000)
  assert.ok(chief.tools > 0 && chief.model > chief.tools)
})

test('the views render to markup with the lane names, labels and the honesty footnote', () => {
  const data = win({ windowMs: 60_000 })
  const lanes = mount(client.Swimlanes, { win: data, compress: false })
  const html = htmlOf(lanes.tree)
  for (const needle of ['Chief', 'Writer', 'Team Room', 'group', 'reply 4.5 s', 'waiting 4.0 s', 'answer 4.8 s']) assert.ok(html.includes(needle), needle)
  assert.equal(findAll(lanes.tree, node => node.type === 'svg').length, 1)
  const map = mount(client.CommMap, { win: data })
  assert.ok(htmlOf(map.tree).includes('1 request not answered yet'))
  assert.equal(findAll(map.tree, node => node.type === 'tr').length, 1 + client.waitRows(data).length)
  const util = mount(client.Utilization, { win: data })
  assert.ok(htmlOf(util.tree).includes('Chief ● running'))
})

test('friend lanes are labelled as friends, and a raw session id is never a lane or node name', () => {
  const friend = { k: 'f', id: 'f:helper.uib.home' }
  const recs = [{ r: 'boot', t: at(0) }, { r: 'm', t: at(1000), id: 'f1', f: { k: 'u' }, to: friend, ro: 'user', hop: 0, n: 3 }, { r: 'm', t: at(5000), id: 'f2', f: friend, to: { k: 'u' }, ro: 'remote', hop: 0, n: 3 }]
  const data = win({ names: { friends: { 'f:helper.uib.home': 'Helper' } } }, recs)
  const lanes = client.layoutSwimlanes(data, {}).lanes
  assert.equal(lanes.find(lane => lane.kind === 'friend').name, 'Helper')
  assert.equal(client.layoutSwimlanes(data, {}).arrows.find(arrow => arrow.role === 'remote')?.role, 'remote')
  assert.ok(htmlOf(mount(client.Swimlanes, { win: data, compress: false }).tree).includes('Helper (friend)'))
  const raw = { ...data, lanes: [...data.lanes, { id: 'session-bb21e111-aaaa', kind: 'bot', name: 'session-bb21e111-aaaa', rows: 1, removed: true }, { id: 'x', kind: 'bot', name: '', rows: 1 }] }
  const names = client.layoutSwimlanes(raw, {}).lanes.map(lane => lane.name)
  assert.ok(names.includes('Removed Bot'))
  assert.ok(!names.some(name => /session-|^$/.test(name)))
  assert.doesNotMatch(htmlOf(mount(client.Swimlanes, { win: raw, compress: false }).tree), /session-/)
  assert.ok(client.layoutMap(raw, {}).nodes.every(node => !/session-/.test(node.name)))
})

test('negative: hostile names, ids and codes never become markup', () => {
  const evil = '</untrusted-message><img src=x onerror=alert(1)><script>alert(1)</script>\u202e'
  const recs = [
    { r: 'boot', t: at(0) },
    { r: 'ts', t: at(1000), id: 'z#1', pl: 'chat', bot: 'z' },
    { r: 'ks', t: at(1100), id: 'c', tid: 'z#1', nm: evil, bot: 'z' },
    { r: 'te', t: at(2000), id: 'z#1', o: 'error', ec: evil },
  ]
  const hostile = buildWindow(recs, { now: at(5000), rooms: [{ id: 'r1', name: evil }], bots: [{ id: 'a', name: evil }], names: { bots: { z: evil } } })
  // a host that did not clean: put markup in the response by hand
  hostile.lanes[1].name = evil
  hostile.lanes[2] = { ...hostile.lanes[2], name: `<img src=x onerror=alert(1)>${'x'.repeat(500)}` }
  for (const View of [client.Swimlanes, client.CommMap, client.Utilization]) {
    const mounted = mount(View, { win: hostile, compress: false })
    assert.deepEqual(findAll(mounted.tree, node => ['img', 'script', 'iframe', 'a'].includes(node.type)), [], View.name)
    const html = htmlOf(mounted.tree)
    assert.ok(!html.includes('<img') && !html.includes('<script'), View.name)
    assert.ok(!html.includes('</untrusted'), View.name)
  }
  assert.equal(client.safe(evil).includes('<'), false)
  assert.equal(client.layoutSwimlanes(hostile, {}).lanes.every(lane => lane.name.length <= 60), true)
  assert.equal(client.layoutMap(hostile).nodes.every(node => node.name.length <= 60), true)
})

test('negative: the host answering with odd numbers does not break the geometry', () => {
  const odd = win()
  odd.turns = odd.turns.map(turn => ({ ...turn, row: 'x', t0: Number.NaN }))
  odd.exchanges = odd.exchanges.map(item => ({ ...item, t: Number.NaN, hop: 'x' }))
  assert.doesNotThrow(() => client.layoutSwimlanes(odd, {}))
  assert.doesNotThrow(() => client.layoutSwimlanes(odd, { compress: true }))
  assert.doesNotThrow(() => client.layoutMap({ ...odd, edges: [{ from: 'nope', to: 'a', requests: 1, replies: 0, other: 0, answered: 0, unanswered: 1 }] }))
})

// ---- the panel with a fake data layer ---------------------------------------------------
function fakeApi(state) {
  const calls = { open: 0, close: 0, setWindow: [] }
  const listeners = new Set()
  const panel = client.createPanelState()
  const api = {
    panel, calls, state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    open: () => { calls.open += 1; return () => { calls.close += 1 } },
    setWindow: options => calls.setWindow.push(options),
    set(next) { api.state = { ...api.state, ...next }; for (const fn of listeners) fn(api.state) },
  }
  return api
}
const okState = (extra = {}) => ({ status: 'ok', window: win(), error: undefined, updatedAt: NOW, windowMs: 900_000, to: undefined, failures: 0, ...extra })

test('panel: holds the poll while mounted, switches views, picks a window, closes on Esc, Close and backdrop', () => {
  const api = fakeApi(okState())
  let closed = 0
  const view = mount(client.TimelinePanel, { api, onClose: () => { closed += 1 } })
  assert.equal(api.calls.open, 1)
  assert.equal(findAll(view.tree, node => node.type === 'svg').length, 1) // swimlanes first
  button(view.tree, 'Who waits on whom').props.onClick()
  assert.equal(findAll(view.tree, node => node.type === 'table').length, 1)
  assert.equal(findAll(view.tree, node => node.props['aria-selected'] === true).length, 1)
  button(view.tree, 'Utilization').props.onClick()
  assert.equal(findAll(view.tree, node => node.props.className === 'tl-util').length, 2)
  button(view.tree, 'Swimlanes').props.onClick()
  button(view.tree, 'Skip quiet time').props.onClick()
  assert.ok(button(view.tree, 'Real time'))
  const select = findAll(view.tree, node => node.type === 'select')[0]
  select.props.onChange({ target: { value: '3600000' } })
  assert.deepEqual(api.calls.setWindow.at(-1), { windowMs: 3_600_000 })
  button(view.tree, 'Earlier').props.onClick()
  assert.equal(api.calls.setWindow.at(-1).to, api.state.window.to - 450_000)
  documentStub.listeners.get('keydown')({ key: 'Escape' })
  documentStub.listeners.get('keydown')({ key: 'a' })
  assert.equal(closed, 1)
  button(view.tree, '✕').props.onClick()
  assert.equal(closed, 2)
  const overlay = view.tree
  overlay.props.onClick({ target: {}, currentTarget: {} })
  assert.equal(closed, 2) // a click inside the dialog is not a backdrop click
  const same = {}
  overlay.props.onClick({ target: same, currentTarget: same })
  assert.equal(closed, 3)
  view.unmount()
  assert.equal(api.calls.close, 1) // the poll is released
  assert.equal(documentStub.listeners.size, 0)
})

test('panel: loading, the empty window, an error with and without data, and the notes', () => {
  const api = fakeApi({ status: 'loading', window: undefined, windowMs: 900_000, failures: 0 })
  const view = mount(client.TimelinePanel, { api, onClose() {} })
  assert.equal(textOf(findAll(view.tree, node => node.props.className === 'tl-body')[0]).includes('Loading…'), true)
  api.set({ status: 'error', error: 'host down' })
  const body = () => textOf(findAll(view.tree, node => node.props.className === 'tl-body')[0])
  assert.match(body(), /Could not load the timeline: host down/)
  api.set({ status: 'ok', error: undefined, window: win({}, [{ r: 'boot', t: at(0) }]) })
  assert.match(body(), /No Bot activity in this window/)
  api.set({ window: win(), status: 'error', error: 'host down', updatedAt: NOW })
  assert.match(body(), /Could not refresh: host down\. Showing the data from/)
  assert.equal(findAll(view.tree, node => node.props.role === 'alert').length, 1)
  assert.equal(findAll(view.tree, node => node.type === 'svg').length, 1) // the last good data still draws
  assert.equal(button(view.tree, 'Live').props['aria-pressed'], true) // always there; pressed while following
  api.set({ status: 'ok', error: undefined, window: win({ windowMs: 30_000, to: at(20_000) }), to: at(20_000) })
  assert.match(body(), /Looking back: window ends at/)
  assert.equal(button(view.tree, 'Live').props['aria-pressed'], false)
  button(view.tree, 'Live').props.onClick()
  assert.deepEqual(api.calls.setWindow.at(-1), { windowMs: 900_000 })
  view.unmount()
  const notes = client.notesOf({ status: 'ok', window: { ...win(), truncated: true, trace: { persisting: false } } }).map(note => note.text).join(' | ')
  assert.match(notes, /Trace starts at/)
  assert.match(notes, /newest turns/)
  assert.match(notes, /in memory only/)
  assert.deepEqual(client.notesOf({ status: 'loading' }), [])
})

test('sidebar row: opens the panel on click, shows it while open, releases the poll when it closes', () => {
  const api = fakeApi(okState())
  const Section = client.makeSection(api)
  const view = mount(Section)
  assert.equal(findAll(view.tree, node => node.props.role === 'dialog').length, 0)
  assert.equal(api.calls.open, 0) // a closed panel does not poll
  button(view.tree, '⏱Timeline').props.onClick()
  assert.equal(findAll(view.tree, node => node.props.role === 'dialog').length, 1)
  assert.equal(api.calls.open, 1)
  button(view.tree, '✕').props.onClick()
  assert.equal(findAll(view.tree, node => node.props.role === 'dialog').length, 0)
  assert.equal(api.calls.close, 1)
  view.unmount()
})

test('apply registers the sidebar row only when sidebarSection: true (off by default, #281; no + menu entry, #269), opens through it, and removes it', () => {
  const registered = []
  const flybot = {
    call: async () => ({}),
    slots: { register: (slot, entry) => { registered.push([slot, entry]); return () => registered.splice(registered.findIndex(item => item[1] === entry), 1) } },
  }
  globalThis.__flybot__ = {}
  try {
    // Default: nothing is drawn; the panel is still reachable through ctx.flybot.timeline.
    const plain = client.apply({ flybot })
    assert.deepEqual(registered, [])
    assert.equal(typeof flybot.timeline.panel.show, 'function')
    plain()
    assert.equal(flybot.timeline, undefined)
    const off = client.apply({ flybot }, { sidebarSection: true })
    assert.deepEqual(registered.map(([slot, entry]) => [slot, entry.id]), [['flybot.sidebar.section', 'timeline']])
    assert.equal(registered.some(([slot]) => slot === 'flybot.new-chat.action'), false)
    flybot.timeline.panel.show()
    assert.equal(flybot.timeline.panel.open, true)
    off()
    assert.equal(registered.length, 0)
    assert.equal(flybot.timeline, undefined)
    // sidebarSection: false (the old way to hide it) stays quiet too.
    const quiet = client.apply({ flybot }, { sidebarSection: false })
    assert.deepEqual(registered, [])
    quiet()
  } finally {
    delete globalThis.__flybot__
  }
})

test('polish (#249): no "( )" prefix, a short footer, labels that fit, and a dialog that keeps one height', () => {
  const data = win({ windowMs: 60_000 })
  const html = htmlOf(mount(client.Swimlanes, { win: data, compress: false }).tree)
  assert.ok(!html.includes('( )'))
  const long = { ...data, lanes: data.lanes.map(lane => (lane.id === 'a' ? { ...lane, name: 'A Bot with a really quite long name indeed' } : lane)) }
  assert.ok(client.layoutSwimlanes(long, {}).lanes.every(lane => lane.name.length <= 60))
  assert.ok(!htmlOf(mount(client.Swimlanes, { win: long, compress: false }).tree).includes('A Bot with a really quite long name indeed</text>'))
  const view = mount(client.TimelinePanel, { api: fakeApi(okState()), onClose() {} })
  const foot = textOf(findAll(view.tree, node => node.props.className === 'tl-foot')[0])
  assert.ok(foot.length < 100, `footer is ${foot.length} characters`)
  assert.match(foot, /not read/)
  // #279: two short items, each its own span, not one long run-on line.
  const items = findAll(view.tree, node => node.props.className === 'tl-foot')[0].children.filter(Boolean)
  assert.equal(items.length, 2)
  assert.ok(items.every(item => textOf(item).length < 50 && /^[A-Z][^.]*: .*\.$/.test(textOf(item))), items.map(textOf).join(' | '))
  assert.match(client.CSS.match(/\.tl-foot \{[^}]*\}/)[0], /line-height:1\.5/)
  // The dialog shrinks to its content and hangs from the top, so switching tabs moves nothing above the body.
  assert.doesNotMatch(client.CSS.match(/\.tl-dialog \{[^}]*\}/)[0], /[^-]height:/)
  assert.match(client.CSS.match(/\.tl-overlay \{[^}]*\}/)[0], /align-items:flex-start/)
  // Map nodes: inside the drawing with room for the name beside or under them, one name per node.
  const map = client.layoutMap({ ...data, lanes: [...data.lanes, { id: 'c', kind: 'bot', name: 'Third', rows: 1 }, { id: 'd', kind: 'bot', name: 'Fourth', rows: 1 }] })
  for (const node of map.nodes) {
    assert.ok(node.x > 20 && node.x < map.width - 20 && node.y > 20 && node.y < map.height - 20, node.name)
    const room = node.anchor === 'middle' ? 60 : 8 + node.label.length * 8
    const edgeX = node.anchor === 'start' ? node.lx + room : node.anchor === 'end' ? node.lx - room : node.lx
    assert.ok(edgeX > 0 && edgeX < map.width, node.name)
  }
  const spots = map.nodes.map(node => `${Math.round(node.lx)},${Math.round(node.ly)}`)
  assert.equal(new Set(spots).size, spots.length)
  assert.ok(client.layoutMap(win()).height < client.layoutMap({ ...data, lanes: [...data.lanes, { id: 'c', kind: 'bot', name: 'T', rows: 1 }, { id: 'd', kind: 'bot', name: 'F', rows: 1 }, { id: 'e', kind: 'bot', name: 'E', rows: 1 }] }).height)
})

test('#255: wait labels stay inside the plot and never sit on each other; friend lane and node names are readable and distinct', () => {
  const friend = { k: 'f', id: 'f:helper.uib.home' }
  const recs = [{ r: 'boot', t: at(0) },
    { r: 'm', t: at(1000), id: 'f1', f: { k: 'u' }, to: friend, ro: 'user', hop: 0, n: 3 },
    { r: 'm', t: at(1500), id: 'f2', f: { k: 'u' }, to: friend, ro: 'user', hop: 0, n: 3 },
    { r: 'm', t: at(44_000), id: 'f3', f: { k: 'u' }, to: friend, ro: 'user', hop: 0, n: 3 },
    { r: 'm', t: at(44_300), id: 'x9', f: { k: 'b', id: 'a' }, to: { k: 'b', id: 'b' }, ro: 'request', hop: 0, n: 3 },
    ...records().slice(1)]
  const data = win({ windowMs: 60_000, names: { friends: { 'f:helper.uib.home': "Helper · UiB1415's Bot" } } }, recs)
  const g = client.layoutSwimlanes(data, {})
  const waits = g.arrows.filter(arrow => arrow.wait)
  assert.ok(waits.length >= 3)
  const byStrip = new Map()
  for (const { wait } of waits) {
    if (wait.hideLabel) continue
    const room = wait.label.length * 7 + 6
    const lo = wait.anchor === 'start' ? wait.lx : wait.lx - room
    assert.ok(lo >= g.plotLeft - 1 && lo + room <= g.plotRight + 1, `${wait.label} inside the plot`)
    for (const [a, b] of byStrip.get(wait.y) ?? []) assert.ok(lo + room <= a || lo >= b, `${wait.label} does not overlap another label`)
    byStrip.set(wait.y, [...(byStrip.get(wait.y) ?? []), [lo, lo + room]])
  }
  // #271: a label sits well inside its lane's top strip: clear of the lane edge above, text and line both.
  for (const arrow of waits) {
    const lane = g.lanes.find(item => item.y <= arrow.wait.y && arrow.wait.y < item.y + item.h)
    assert.ok(arrow.wait.y - 14 - lane.y >= 6, `${arrow.wait.label} is clear of the lane's top edge`)
    assert.ok(lane.y + 30 - arrow.wait.y >= 4, `${arrow.wait.label}'s line is above the bars`)
  }
  assert.ok(waits.some(({ wait }) => wait.open && !wait.hideLabel), 'the open wait keeps its label')
  assert.ok(waits.some(({ wait }) => wait.hideLabel), 'a label with no room is left to the tooltip')
  const lane = g.lanes.find(item => item.kind === 'friend')
  assert.deepEqual([lane.label, lane.sub], ['Helper', "UiB1415's Bot"])
  const chief = client.layoutSwimlanes(win({ names: { friends: { 'f:helper.uib.home': "UiA1415's Chief" } } }, recs), {}).lanes.find(item => item.kind === 'friend')
  assert.deepEqual([chief.label, chief.sub], ["UiA1415's Chief", 'friend'])
  // Two Bots called Helper: mine and the friend's. The map labels them apart.
  const two = client.layoutMap({ ...data, lanes: [...data.lanes, { id: 'h', kind: 'bot', name: 'Helper', rows: 1 }] })
  const helpers = two.nodes.filter(node => node.lines[0] === 'Helper')
  assert.equal(helpers.length, 2)
  assert.notDeepEqual(helpers[0].lines, helpers[1].lines)
  assert.ok(helpers.some(node => node.lines[1] === "UiB1415's Bot"))
  // The drawing is as tall as its lanes: three Bot lanes are shorter than seven.
  const few = client.layoutSwimlanes(win({}, [{ r: 'boot', t: at(0) }]), {}).height
  assert.ok(few < g.height)
})

test('#279: the window\'s time range is shown in plain view, with the date, its length, and whether it is live', () => {
  const at0 = new Date(2026, 9, 18, 13, 20, 5).getTime()
  assert.equal(client.fmtRange(at0, at0 + 900_000), 'Oct 18 · 13:20:05 – 13:35:05 (15 min)'.replace('(15 min)', `(${client.fmtDur(900_000)})`))
  // Across midnight both ends carry their date.
  const late = new Date(2026, 9, 18, 23, 50, 0).getTime()
  assert.equal(client.fmtRange(late, late + 1_200_000), `Oct 18 23:50:00 – Oct 19 00:10:00 (${client.fmtDur(1_200_000)})`)
  assert.equal(client.fmtRange(NaN, 1), '')
  const live = mount(client.TimelinePanel, { api: fakeApi(okState()), onClose() {} })
  const range = findAll(live.tree, node => node.props.className === 'tl-range')[0]
  assert.ok(range, 'the range row is drawn')
  const data = okState().window
  assert.match(textOf(range), new RegExp(client.fmtRange(data.from, data.to).replace(/[()·–]/g, '\\$&').replace(/ /g, '\\s')))
  assert.match(textOf(range), /live, up to the latest activity/)
  const back = mount(client.TimelinePanel, { api: fakeApi({ ...okState(), window: { ...data, live: false } }), onClose() {} })
  assert.match(textOf(findAll(back.tree, node => node.props.className === 'tl-range')[0]), /earlier window, not live/)
  assert.equal(findAll(mount(client.TimelinePanel, { api: fakeApi({ status: 'loading' }), onClose() {} }).tree, node => node.props.className === 'tl-range').length, 0, 'nothing before the first answer')
})
