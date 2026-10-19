import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #229: in a face-to-face room people come first. Another person's line is their own
// received bubble (name + person mark), and the members list names every member the same way.

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

const { GroupReplies } = await load('cells.js')
const { faceSeats, faceSeatLabel, roomSubtitle } = await load('group-settings.js')
const { UserMessageCell, USER_MESSAGE_CSS } = await load('user-message.js')

test('another person\'s face-room line is their own received bubble with name and person mark', () => {
  const roster = { bots: [], byId: {}, roomsById: { g1: { id: 'g1', origin: 'face-to-face', members: [], participants: [] } } }
  const content = [{ type: 'text', text: JSON.stringify({ replies: [{ kind: 'user', other: true, name: 'SelfA0333', authorId: '@chief.selfa0333.home', text: 'hello from A' }] }) }]
  const drawn = expand(GroupReplies({ sessionId: 'g1', callId: 'c1', done: true, content, roster, actions: {}, useUi: () => null }), ['PersonMessage', 'PersonMark', 'Bubbles'])
  const [person] = find(drawn, node => node.props?.['data-person'] !== undefined)
  assert.ok(person, 'drawn as a person')
  assert.equal(person.props['data-person'], 'SelfA0333')
  assert.equal(find(person, node => node.props?.className === 'bt-person-mark').length, 1, 'with an avatar')
  assert.equal(find(person, node => node.props?.className === 'bt-group-name' && node.children.includes('SelfA0333')).length, 1)
  assert.equal(find(person, node => node.props?.className === 'bt-bubble').length, 1, 'a received bubble')
  assert.equal(find(drawn, node => node.props?.className === 'bt-ubody').length, 0, 'not the sent-bubble style')
})

test('a face room lists people, each with the Bot they brought, named one way', () => {
  const roster = {
    self: { memberId: 'm1', displayName: 'SelfB0333' },
    byId: { chief: { id: 'chief', name: 'Chief' } },
  }
  const room = {
    origin: 'face-to-face',
    members: ['chief'],
    presentedParticipants: [
      { kind: 'bot', id: 'chief', handle: '@chief.selfb0333.home', displayName: 'Chief', label: "SelfB0333's Chief" },
      { kind: 'bot', remote: true, id: '@chief.selfa0333.home', handle: '@chief.selfa0333.home', displayName: 'Chief', ownerName: 'SelfA0333', label: "SelfA0333's Chief" },
      { kind: 'bot', remote: true, id: '@coder.gone.home', handle: '@coder.gone.home', displayName: 'Coder', ownerName: 'Gone', leftSeq: 3 },
    ],
  }
  const seats = faceSeats(room, roster)
  assert.deepEqual(seats.map(faceSeatLabel), ['Chief (you)', 'Chief (SelfA0333)'])
  assert.deepEqual(seats.map(seat => seat.mine), [true, false])
})

test('#306: a face room counts people and Bots, not an ambiguous "members"', () => {
  const roster = { self: { memberId: 'm1', displayName: 'Me' }, byId: { chief: { id: 'chief', name: 'Chief' }, coder: { id: 'coder', name: 'Coder' } } }
  const bot = (id, owner, extra = {}) => ({ kind: 'bot', remote: true, id, handle: id, displayName: 'Chief', ownerName: owner, ...extra })
  const room = participants => ({ origin: 'face-to-face', members: [], presentedParticipants: participants })
  const mine = { kind: 'bot', id: 'chief', handle: '@chief.me.home', displayName: 'Chief' }
  assert.equal(roomSubtitle(room([mine, bot('@chief.ann.home', 'Ann')]), roster), '2 people · 2 Bots')
  assert.equal(roomSubtitle(room([mine]), roster), '1 person · 1 Bot')
  // Two Bots of mine and two of Ann's: still two people; a human seat and a left Bot are not counted.
  const coder = { kind: 'bot', id: 'coder', handle: '@coder.me.home', displayName: 'Coder' }
  assert.equal(roomSubtitle(room([
    mine, coder, bot('@chief.ann.home', 'Ann'), bot('@coder.ann.home', 'Ann'),
    { kind: 'human', id: 'h1', ownerName: 'Ann' }, bot('@x.gone.home', 'Gone', { leftSeq: 2 }),
  ]), roster), '2 people · 4 Bots')
  // Two owners who both call themselves Alex are two people (told apart by home).
  assert.equal(roomSubtitle(room([mine, bot('@chief.alex1.home', 'Alex'), bot('@chief.alex2.home', 'Alex')]), roster), '3 people · 3 Bots')
})

test('another home member\'s line shows their person mark and a received surface', () => {
  const roster = { self: { memberId: 'm1' }, bots: [], byId: {}, roomsById: { g1: { id: 'g1', members: [], participants: [] } } }
  const node = { kind: 'user', data: { content: [{ type: 'text', text: 'hi' }], source: { authorId: 'm2', authorKind: 'human', authorName: 'Ann' } } }
  const cell = UserMessageCell({ node, sessionId: 'g1', useRoster: select => select(roster), actions: {} })
  const drawn = expand(cell, ['PersonMark'])
  assert.match(drawn.props.className, /bt-umsg-other/)
  assert.equal(find(drawn, n => n.props?.className === 'bt-person-mark').length, 1)
  const mine = UserMessageCell({ node: { ...node, data: { ...node.data, source: { ...node.data.source, authorId: 'm1' } } }, sessionId: 'g1', useRoster: select => select(roster), actions: {} })
  assert.equal(find(expand(mine, ['PersonMark']), n => n.props?.className === 'bt-person-mark').length, 0, 'my own line has no mark')
  assert.match(USER_MESSAGE_CSS, /\.bt-umsg-other \.bt-ubody\{background:var\(--bt-bubble\);color:var\(--bt-ink\)\}/)
  // The bundle carries the same rule.
  assert.match(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), /\.bt-umsg-other \.bt-ubody\{background:var\(--bt-bubble\)/)
})
