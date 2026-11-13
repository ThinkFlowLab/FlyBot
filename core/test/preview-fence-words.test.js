// A preview is still the line someone said (#1347): the fence is data, but so are the words on
// either side of it. Four readers show a stored line to a person — the Bot chat's row
// (`readableLine`/`previewOf`), a sidebar row, the exchange sheet under ⌘K, and the host's room
// preview on the /api/bot state answer — and every one of them must keep the words around a
// complete wrap, not only the quoted half.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install } from '../src/host/channel.js'
import { previewOf, readableLine } from '../src/client/text.js'

const MIXED = 'He said <untrusted-message from="Coder">quoted</untrusted-message> and I answered done.'
const KEPT = 'He said quoted and I answered done.'

const root = fileURLToPath(new URL('..', import.meta.url))
const h = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity) } })
class Component { constructor(props) { this.props = props } setState() {} }
const react = {
  createElement: h, Fragment: Symbol('Fragment'), Component, PureComponent: Component,
  createRef: () => ({ current: null }), useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect() {}, useLayoutEffect() {}, useRef: value => ({ current: value }), useCallback: fn => fn,
  useMemo: fn => fn(), useReducer: (fn, initial) => [initial, () => {}],
}
const slots = { entries: () => [], subscribe: () => () => {}, version: () => 0 }

// A client module is bundled and loaded the way the client tests load one (sidebar-readonly.test.js):
// esbuild for the browser half, a stub react in the context, so the module's own code runs here.
async function clientModule(contents) {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: root },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module: mod, exports: mod.exports, console, Date, JSON, Promise, Symbol, setTimeout, clearTimeout,
    __flybot__: { slots, call: () => {} },
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  })
  return mod.exports
}

// Elements stay data; a function component is called so a row's own code runs, and the strings it
// draws are collected in order.
function drawnText(node, seen = []) {
  if (node === null || node === undefined) return seen
  if (typeof node === 'string') { seen.push(node); return seen }
  if (typeof node !== 'object') return seen
  if (Array.isArray(node)) { for (const child of node) drawnText(child, seen); return seen }
  if (typeof node.type === 'function') { drawnText(node.type(node.props), seen); return seen }
  for (const child of node.props?.children ?? []) drawnText(child, seen)
  return seen
}

test('the Bot chat row keeps the words before and after a complete wrap', () => {
  assert.equal(readableLine(MIXED), KEPT)
  const list = { projectionsBySession: { s1: { values: { turnOutline: [{ turn: 1, response: MIXED }] } } }, byId: {} }
  assert.equal(previewOf(list, 's1'), KEPT)
  assert.equal(readableLine('a <untrusted-message from="C">one</untrusted-message> b <untrusted-message from="D">two</untrusted-message> c'), 'a one b two c')
})

test('the sidebar row of a room keeps them too', async () => {
  const { TeamSidebar } = await clientModule("export { TeamSidebar } from './src/client/sidebar.js'")
  const room = { id: 'r1', name: 'Team room', kind: 'group', createdAt: 1, preview: MIXED }
  const list = { ids: ['r1'], byId: { r1: { updatedAt: 1 } } }
  const useSessions = selector => selector(list)
  const useUi = selector => selector({ unread: {} })
  const tree = TeamSidebar({
    wide: true,
    useRoster: selector => selector({ bots: [], byId: {}, rooms: [room], mainBotId: 'm', agents: [] }),
    useUi,
    useSessions,
    useRegistry: useUi,
    useWork: selector => selector({}),
    useSessionStatus: selector => selector(new Map()),
    useSessionRetainInfo: (id, selector) => selector({}),
    useActivity: selector => selector({}),
    useUpdate: selector => selector({}),
    actions: {},
  })
  const words = drawnText(tree)
  assert.ok(words.includes(KEPT), `the row drew ${JSON.stringify(words.filter(word => /quoted|He said|answered/.test(word)))}`)
})

test('the host room preview on the state answer keeps them too', async () => {
  const state = {
    revision: 3, workspaceId: null, mainBotIds: ['main'],
    bots: { main: { id: 'main', name: 'Main' } },
    rooms: { r1: { id: 'r1', name: 'Team room', createdAt: 1, log: [{ text: MIXED, who: 'User', authorKind: 'human' }] } },
    humans: {}, agents: {}, questions: {}, prefs: {}, secretRequests: {},
  }
  let route
  const rt = {
    state,
    ctx: { effect: (fn) => { fn(); return () => {} }, connection: { fetch: { register: (r) => { route = r; return () => {} } } } },
    warn: () => {}, noteFailure: () => {},
    readOnly: () => undefined, authenticate: async () => null, authorize: () => ({ ok: true }),
    bootstrap: async () => {}, catalog: async () => [], loadSecrets: async () => {},
    cachedCatalog: () => [], cachedDefault: () => null,
    chatOf: id => `chat-${id}`, ownedLive: full => full, ownedView: full => full, load: async () => {}, refresh: async () => {},
    pluginToolNames: () => [], publicHumans: () => [], presentRoom: room => room,
    secretsView: () => [], capabilityLibraryView: () => ({}), flybotRemoteMembers: () => [],
    permissionCatalog: () => null, browserEnabled: false, memoryEnabled: true, authzEnforced: () => false,
    listRoomApprovals: () => [], roomBusyAcksView: () => ({}),
    activityView: () => [], busyAcksView: () => ({}), workView: () => ({}), roomWorkView: () => ({}),
    approvalsView: () => ({}), endedView: () => [], memoryNews: () => [], memoryReviews: () => [],
    connectorsView: () => [], capabilityStatusesView: () => [], stateLinkReplaced: () => ({ gen: 'g', count: 0 }),
  }
  install(rt)
  const answer = await route.fetch(new Request('http://host/api/bot', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state' }),
  }))
  const body = await answer.json()
  assert.equal(body.ok, true, JSON.stringify(body.error))
  assert.equal(body.value.rooms[0].preview, KEPT)
})

test('the exchange sheet under the palette already kept them (control, unchanged by this fix)', async () => {
  const { exchangeText } = await clientModule("export { exchangeText } from './src/client/exchange.js'")
  assert.equal(exchangeText(MIXED), KEPT)
  assert.equal(exchangeText('<untrusted-message from="C">\nhello there\n</untrusted-message>'), 'hello there')
})
