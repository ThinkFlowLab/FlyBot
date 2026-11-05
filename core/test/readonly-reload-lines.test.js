// #2502: the host's sentence tells the reader to close the other window and reload. The sidebar
// (#2247) and the refusal toast (#2265) grew that entry; the Settings header, the drawer, the
// Inbox and the Memory panel kept the sentence with nothing to answer it — and inside the Inbox
// modal the sidebar's own button cannot be reached at all. Each of those four surfaces now draws
// one Reload beside the sentence, through one shared piece, so the copy is the host's own words
// and the control is one label rather than four copies. The button sits outside `role="status"`
// so the live region stays text, as in the sidebar, and a writable window draws neither.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { SettingsDialog } from './src/client/settings.js'",
      "export { DetailsDrawer } from './src/client/details-drawer.js'",
      "export { InboxDialog } from './src/client/inbox.js'",
      "export { MemoryDialog } from './src/client/memory-panel.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A hook runtime that survives a re-render: the memory dialog draws its skeleton first and its
// view after an effect, and the same dialog is drawn again in the writable cases.
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
  useEffect: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn },
  useLayoutEffect() {},
  useId: () => 'id',
  useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => ({}) }) },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { SettingsDialog, DetailsDrawer, InboxDialog, MemoryDialog } = module.exports

const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'

const chief = { id: 'chief', name: 'Chief', role: 'Researcher', model: 'mock/m1', workDir: '/work/chief', instructions: 'Run the team.', pinned: true }
const room = { id: 'r1', name: 'Ops', admin: 'chief', members: ['chief'], mode: 'admin', notice: '', named: true, workDir: '/work/ops', participants: [], presentedParticipants: [], viewerRole: 'owner' }
const base = {
  bots: [chief], byId: { chief }, rooms: [room], roomsById: { r1: room }, mainBotIds: ['chief'], mainBotId: 'chief',
  prefs: { theme: 'deepseek' }, models: [], connectors: [], capabilities: [], secrets: [], humans: [], remoteBots: [],
  memory: true, questions: {}, exchangeTurns: {},
}
const baseRoom = { ...base, self: { memberId: 'm1' } }
const locked = { ...base, readOnly: SENTENCE }
const lockedRoom = { ...baseRoom, readOnly: SENTENCE }

// A failed reload must reach the client's error channel; a write called here would be a defect.
const actions = (over = {}) => ({
  openSettings() {}, closeSettings() {}, closeOverlay() {}, openSession() {}, openBrowser() {}, openMemory() {},
  notify() {}, showDetails() {}, call: () => Promise.resolve({}), memoryView: () => Promise.resolve(null),
  schedules: () => Promise.resolve({ available: true, tasks: [] }),
  reloadTeam: () => Promise.resolve(), reportError() {},
  ...over,
})

// The dialog's own tree holds component elements; draw them the way the renderer would, with one
// hook index continuing through the tree, and stop at the widgets that only draw children.
const draw = (node, out = [], depth = 0) => {
  if (Array.isArray(node)) { for (const item of node) draw(item, out, depth); return out }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function' && depth < 8) {
    const saved = slots
    const savedIndex = index
    slots = []
    index = 0
    let rendered
    try { rendered = node.type({ ...node.props }) } catch { out.push(node); slots = saved; index = savedIndex; return out }
    slots = saved
    index = savedIndex
    return draw(rendered, out, depth + 1)
  }
  out.push(node)
  draw(node.props?.children, out, depth)
  return out
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node && typeof node === 'object') return text(node.props?.children)
  return ''
}
const byClass = (nodes, name) => nodes.filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name))
const sentenceNodes = nodes => byClass(nodes, 'bt-read-only')
const reloadButtons = nodes => byClass(nodes, 'bt-read-only-reload')

const mountSettings = (roster, page = 'general', id = null, acts = actions()) => {
  slots = []
  index = 0
  return draw(SettingsDialog({ page, id, roster, actions: acts, useUpdate: () => ({}) }))
}
const mountDrawer = (roster, startTab = 'details', sessionId = 'chief', acts = actions()) => {
  slots = []
  index = 0
  const empty = selector => selector(new Map())
  return draw(DetailsDrawer({
    sessionId, startTab, hasStrip: false, roster, actions: acts,
    useSessions: selector => selector({ byId: {}, projectionsBySession: {} }), useSessionStatus: empty,
    useActivity: empty, useWork: empty, useBrowserTabs: empty, useBrowserPages: empty,
  }))
}
const mountInbox = (roster, acts = actions()) => {
  slots = []
  index = 0
  return draw(InboxDialog({ roster, actions: acts, useWork: selector => selector({}), useSessions: selector => selector({ byId: {}, projectionsBySession: {} }) }))
}
const mountMemory = (roster, acts = actions()) => {
  slots = []
  index = 0
  return draw(MemoryDialog({ bot: chief, roster, actions: acts }))
}

const PAGES = ['general', 'bots', 'groups', 'projects', 'connectors', 'capabilities', 'schedules', 'workflows', 'usage', 'secrets', 'feedback', 'about']

// Every surface the issue names, with the mount that draws it.
const SURFACES = [
  { name: 'Settings header', mount: roster => mountSettings(roster) },
  { name: 'drawer: Bot overview', mount: roster => mountDrawer(roster) },
  { name: 'drawer: Bot settings', mount: roster => mountDrawer(roster, 'settings') },
  { name: 'drawer: group overview', mount: roster => mountDrawer(roster, 'details', 'r1') },
  { name: 'drawer: group settings', mount: roster => mountDrawer(roster, 'settings', 'r1') },
  { name: 'Inbox dialog', mount: roster => mountInbox(roster) },
  { name: 'Memory panel', mount: roster => mountMemory(roster) },
]

test('the Settings header offers one Reload beside the host sentence on every page', () => {
  for (const page of PAGES) {
    const nodes = mountSettings(locked, page)
    assert.equal(sentenceNodes(nodes).length, 1, `${page}: the host's sentence is still drawn once`)
    assert.equal(reloadButtons(nodes).length, 1, `${page}: the header offers one Reload entry`)
    assert.equal(reloadButtons(nodes)[0].type, 'button', `${page}: it is a button`)
    assert.equal(reloadButtons(nodes)[0].props.type, 'button', `${page}: it does not submit a form`)
    assert.equal(text(reloadButtons(nodes)[0]).trim(), 'Reload', `${page}: its label is the shared copy`)
  }
})

test('each drawer surface offers exactly one Reload, never two', () => {
  const surfaces = SURFACES.filter(surface => surface.name.startsWith('drawer'))
  for (const surface of surfaces) {
    const nodes = surface.mount(surface.name.includes('group') ? lockedRoom : locked)
    assert.equal(sentenceNodes(nodes).length, 1, `${surface.name}: one sentence`)
    assert.equal(reloadButtons(nodes).length, 1, `${surface.name}: one Reload, not two`)
  }
})

test('the Inbox and the Memory panel each offer one Reload — their own way out of the modal', () => {
  for (const surface of SURFACES.filter(entry => !entry.name.startsWith('drawer') && entry.name !== 'Settings header')) {
    const nodes = surface.mount(locked)
    assert.equal(sentenceNodes(nodes).length, 1, `${surface.name}: the sentence stays once`)
    assert.equal(reloadButtons(nodes).length, 1, `${surface.name}: one Reload entry`)
  }
})

test('one shared piece: the sentence is the host sentence, and the control sits outside the live region', () => {
  for (const surface of SURFACES) {
    const nodes = surface.mount(surface.name.includes('group') ? lockedRoom : locked)
    const [sentence] = sentenceNodes(nodes)
    const [button] = reloadButtons(nodes)
    assert.equal(sentence.props.role, 'status', `${surface.name}: the sentence keeps the status role`)
    assert.equal(text(sentence), SENTENCE, `${surface.name}: the words are the host's own, byte for byte`)
    assert.equal(draw(sentence).includes(button), false, `${surface.name}: the live region stays text-only`)
    assert.ok(draw(nodes).indexOf(sentence) < draw(nodes).indexOf(button), `${surface.name}: the sentence is read first`)
  }
})

test('a press runs the client\'s own team read, once, and sends no write', async () => {
  for (const surface of SURFACES) {
    let reads = 0
    const writes = []
    const acts = actions({
      reloadTeam: () => { reads += 1; return Promise.resolve() },
      updateBot: (...args) => { writes.push(['updateBot', ...args]); return Promise.resolve() },
      updateRoom: (...args) => { writes.push(['updateRoom', ...args]); return Promise.resolve() },
      setPrefs: (...args) => { writes.push(['setPrefs', ...args]); return Promise.resolve() },
    })
    const nodes = mountFor(surface, surface.name.includes('group') ? lockedRoom : locked, acts)
    const [button] = reloadButtons(nodes)
    assert.ok(button, `${surface.name}: the entry is drawn`)
    button.props.onClick()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(reads, 1, `${surface.name}: one press reads the team once`)
    assert.deepEqual(writes, [], `${surface.name}: the press sends no write`)
  }
})

const mountFor = (surface, roster, acts) => {
  if (surface.name === 'Settings header') return mountSettings(roster, 'general', null, acts)
  if (surface.name === 'Inbox dialog') return mountInbox(roster, acts)
  if (surface.name === 'Memory panel') return mountMemory(roster, acts)
  return mountDrawer(roster, surface.name.includes('settings') ? 'settings' : 'details', surface.name.includes('group') ? 'r1' : 'chief', acts)
}

test('a refused reload is reported through the client\'s error channel, not left unhandled', async () => {
  const failure = new Error('network error: Failed to fetch')
  const seen = []
  const nodes = mountSettings(locked, 'general', null, actions({ reloadTeam: () => Promise.reject(failure), reportError: (error, where) => seen.push([error, where]) }))
  const [button] = reloadButtons(nodes)
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(seen, [[failure, 'reload']])
})

test('a writable window, or a host sentence of only whitespace, draws neither sentence nor entry', () => {
  for (const surface of SURFACES) {
    for (const readOnly of [undefined, '', '   ', '\n\t ']) {
      const roster = { ...(surface.name.includes('group') ? baseRoom : base), ...(readOnly === undefined ? {} : { readOnly }) }
      const nodes = mountFor(surface, roster, actions())
      assert.equal(sentenceNodes(nodes).length, 0, `${surface.name}, ${JSON.stringify(readOnly)}: no sentence`)
      assert.equal(reloadButtons(nodes).length, 0, `${surface.name}, ${JSON.stringify(readOnly)}: no entry`)
    }
  }
})
