import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #306 item 5: a Bot line held for approval has its text in the approval card once; its bubble in a
// Face-to-face room says only that it waits.

async function load(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: (name) => {
      const platform = {
        react: {
          createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
          useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
          useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useSyncExternalStore: (sub, get) => get(), Fragment: 'fragment',
        },
        'react-dom': { createPortal: node => node },
        '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: function MarkdownText() { return null }, projectUserText: text => text },
      }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  return module.exports
}

const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: (node.children ?? []).map(child => expand(child, names)) }
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}

const { GroupReplies, ToolCell, isHeldLine } = await load('cells.js')

const chief = { id: 'chief', name: 'Chief', color: 'green' }
const held = (text, over = {}) => ({ id: 'ap1', kind: 'face_room_message', status: 'pending', from: 'Chief', roomId: 'frm_1', text, ...over })
const roomWith = (pendingApprovals, origin = 'face-to-face') => ({ id: 'g1', origin, members: ['chief'], participants: [], pendingApprovals })
const draw = (room, replies) => {
  const roster = { bots: [chief], byId: { chief }, roomsById: { g1: room } }
  const content = [{ type: 'text', text: JSON.stringify({ replies }) }]
  return expand(GroupReplies({ sessionId: 'g1', callId: 'c1', done: true, content, roster, actions: {}, useUi: () => null }), ['GroupMessage', 'Bubbles'])
}
const said = (text) => ({ botId: 'chief', name: 'Chief', text })
const shownText = drawn => find(drawn, node => node.type?.name === 'MarkdownText').map(node => node.props.text)

test('a held Bot line is one short waiting bubble; its text stays in the approval card', () => {
  const drawn = draw(roomWith([held('Draft: ship it on Friday')]), [said('Draft: ship it on Friday')])
  const [bubble] = find(drawn, node => node.props?.['data-flybot'] === 'held-line')
  assert.ok(bubble, 'a waiting bubble')
  assert.deepEqual(bubble.children, ['Waiting for approval'])
  assert.equal(shownText(drawn).length, 0, 'the line text is not drawn in the room')
  // The Bot's name and avatar stay, so the waiting state is still the Bot's.
  assert.equal(find(drawn, node => node.props?.className === 'bt-group-name' && node.children.includes('Chief')).length, 1)
  assert.equal(find(drawn, node => node.props?.className === 'bt-lead').length, 1)
})

test('only the held line waits: other lines, and once the hold is decided, the line, are full bubbles', () => {
  const room = roomWith([held('Draft: ship it on Friday')])
  const drawn = draw(room, [said('Earlier note'), said('Draft: ship it on Friday')])
  assert.equal(find(drawn, node => node.props?.['data-flybot'] === 'held-line').length, 1)
  assert.deepEqual(shownText(drawn), ['Earlier note'])
  const decided = draw(roomWith([]), [said('Draft: ship it on Friday')])
  assert.equal(find(decided, node => node.props?.['data-flybot'] === 'held-line').length, 0)
  assert.deepEqual(shownText(decided), ['Draft: ship it on Friday'])
})

test('the held text matches however the card cleaned it: spacing, the "To the room:" lead, the 800-character cap', () => {
  assert.equal(isHeldLine(roomWith([held('hello   there world')]), 'hello there\nworld'), true)
  assert.equal(isHeldLine(roomWith([held('hello there')]), 'To face room: hello there'), true)
  assert.equal(isHeldLine(roomWith([held('hello there')]), 'hello there!'), false)
  const long = 'word '.repeat(300)
  const capped = long.replace(/\s+/g, ' ').trim().slice(0, 800).trim()
  assert.equal(isHeldLine(roomWith([held(capped)]), long), true)
  assert.equal(isHeldLine(roomWith([held('')]), ''), false)
})

test('the held line waits only for the Bot that sent it: another Bot saying the same words stays a full bubble', () => {
  const writer = { id: 'writer', name: 'Writer', color: 'blue' }
  const room = { id: 'g1', origin: 'face-to-face', members: ['chief', 'writer'], participants: [], pendingApprovals: [held('Draft: ship it on Friday')] }
  const roster = { bots: [chief, writer], byId: { chief, writer }, roomsById: { g1: room } }
  const content = [{ type: 'text', text: JSON.stringify({ replies: [
    { botId: 'writer', name: 'Writer', text: 'Draft: ship it on Friday' },
    { botId: 'chief', name: 'Chief', text: 'Draft: ship it on Friday' },
  ] }) }]
  const drawn = expand(GroupReplies({ sessionId: 'g1', callId: 'c1', done: true, content, roster, actions: {}, useUi: () => null }), ['GroupMessage', 'Bubbles'])
  assert.equal(find(drawn, node => node.props?.['data-flybot'] === 'held-line').length, 1, 'only Chief\'s line waits')
  assert.deepEqual(shownText(drawn), ['Draft: ship it on Friday'], 'Writer\'s identical line is drawn')
  assert.equal(isHeldLine(room, 'Draft: ship it on Friday', writer), false)
  assert.equal(isHeldLine(room, 'Draft: ship it on Friday', chief), true)
  assert.equal(isHeldLine(room, 'Draft: ship it on Friday', { id: 'chief', name: '  chief ' }), true, 'names compare without case or spacing')
  // A card that names no sender still matches by text.
  const unnamed = { ...room, pendingApprovals: [held('Draft: ship it on Friday', { from: '' })] }
  assert.equal(isHeldLine(unnamed, 'Draft: ship it on Friday', writer), true)
})

test('only a Face-to-face room hides a held line, and only for a held room line', () => {
  assert.equal(isHeldLine(roomWith([held('hello')], 'group'), 'hello'), false)
  assert.equal(isHeldLine(roomWith([held('hello', { kind: 'outbound_message' })]), 'hello'), false)
  assert.equal(isHeldLine(undefined, 'hello'), false)
  assert.equal(isHeldLine({ origin: 'face-to-face' }, 'hello'), false)
})

test('the waiting copy has a Chinese string', () => {
  const zh = readFileSync(new URL('../src/client/i18n.js', import.meta.url), 'utf8')
  assert.match(zh, /'Waiting for approval': '等待批准'/)
})

test('the waiting bubble has a style of its own', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /\.bt-bubble-held\{[^}]*dashed/)
})

test('a held message to a friend is no bubble at all: the Bot\'s send is not drawn, the card is the one place', () => {
  const root = {
    kind: 'tool-result', name: 'message_friend_bot', callId: 'c9', isError: false, subCalls: [],
    call: { name: 'message_friend_bot', argsRaw: JSON.stringify({ to: '@coder.bob.home', message: 'Draft: ship it on Friday' }) },
    content: [{ type: 'text', text: "Waiting for the user's approval before it goes to @coder.bob.home. Do not resend." }],
  }
  const roster = { bots: [chief], byId: { chief }, rooms: [], roomsById: {}, exchangeTurns: {}, questions: {}, secretRequests: {}, secrets: [] }
  const drawn = ToolCell({
    node: { key: 'n', data: { root }, location: { turn: { turn: 1 } } }, sessionId: 'chief',
    useRoster: select => select(roster), useUi: select => select({ reactions: {}, visits: {} }),
    actions: { noteLive() {}, noteCards() {} },
  })
  assert.equal(drawn, null)
})
