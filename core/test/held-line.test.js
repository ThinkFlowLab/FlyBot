import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #306 item 5, #456: a Bot line held for approval has its text in the approval card only; a Face-to-face
// room draws no bubble for it until Approve, and a rejected one is one grey "Not sent" line.

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

const { GroupReplies, ToolCell, isHeldLine, heldLineState } = await load('cells.js')

const chief = { id: 'chief', name: 'Chief', color: 'green' }
const held = (text, over = {}) => ({ id: 'ap1', kind: 'face_room_message', status: 'pending', from: 'Chief', roomId: 'frm_1', text, ...over })
const roomWith = (pendingApprovals, origin = 'face-to-face') => ({ id: 'g1', origin, members: ['chief'], participants: [], pendingApprovals })
const draw = (room, replies) => {
  const roster = { bots: [chief], byId: { chief }, roomsById: { g1: room } }
  const content = [{ type: 'text', text: JSON.stringify({ replies }) }]
  return expand(GroupReplies({ sessionId: 'g1', callId: 'c1', done: true, content, roster, actions: {}, useUi: () => null }), ['GroupMessage', 'Bubbles'])
}
const said = (text, seq) => ({ botId: 'chief', name: 'Chief', text, ...(seq !== undefined ? { seq } : {}) })
const shownText = drawn => find(drawn, node => node.type?.name === 'MarkdownText').map(node => node.props.text)
const notSent = drawn => find(drawn, node => node.props?.['data-flybot'] === 'held-not-sent')
const textOf = node => find(node, () => true).flatMap(item => (item.children ?? []).filter(child => typeof child === 'string')).join('')

test('a held Bot line is no bubble at all before Approve; its text stays in the approval card', () => {
  const drawn = draw(roomWith([held('Draft: ship it on Friday')]), [said('Draft: ship it on Friday')])
  assert.equal(shownText(drawn).length, 0, 'the line text is not drawn in the room')
  assert.equal(find(drawn, node => node.props?.className === 'bt-group-msg').length, 0, 'no bubble, no waiting stub')
  assert.equal(find(drawn, node => node.props?.className === 'bt-group-name').length, 0)
  assert.equal(notSent(drawn).length, 0)
})

test('only the held line is left out: other lines, and once the hold is decided, the line, are full bubbles', () => {
  const room = roomWith([held('Draft: ship it on Friday')])
  const drawn = draw(room, [said('Earlier note'), said('Draft: ship it on Friday')])
  assert.deepEqual(shownText(drawn), ['Earlier note'])
  const decided = draw(roomWith([]), [said('Draft: ship it on Friday')])
  assert.deepEqual(shownText(decided), ['Draft: ship it on Friday'])
})

// The host's own record of each held line on the room (#456), by log seq.
const withHeld = (heldLines, face = { status: 'open' }) => ({ ...roomWith([]), face, heldLines })
const entry = (status, over = {}) => ({ seq: 7, botId: 'chief', text: 'Line one: got it, noodles', status, at: Date.now(), ...over })

test('#456: a line the host is sending or Bot Social holds is not drawn; approved, it is a bubble', () => {
  for (const status of ['sending', 'pending']) {
    const drawn = draw(withHeld([entry(status, { approvalId: 'ap1' })]), [said('Line one: got it, noodles', 7)])
    assert.equal(shownText(drawn).length, 0, `${status}: no bubble`)
    assert.equal(notSent(drawn).length, 0, `${status}: no Not sent line`)
  }
  // Approve drops the record: the line is an ordinary bubble.
  assert.deepEqual(shownText(draw(withHeld([]), [said('Line one: got it, noodles', 7)])), ['Line one: got it, noodles'])
  // Another line of the same Bot (another seq) is drawn.
  assert.deepEqual(shownText(draw(withHeld([entry('pending')]), [said('Line one: got it, noodles', 8)])), ['Line one: got it, noodles'])
})

test('#456: a rejected line is one grey "Not sent" line, never its words, after a reload and in Past rooms', () => {
  const drawn = draw(withHeld([entry('rejected', { approvalId: 'ap1' })]), [said('Line one: got it, noodles', 7)])
  assert.equal(shownText(drawn).length, 0, 'the rejected words are not drawn')
  const [line] = notSent(drawn)
  assert.ok(line, 'a Not sent line')
  assert.match(line.props.className, /bt-event/)
  assert.equal(textOf(line), 'Chief · Not sent')
  assert.doesNotMatch(textOf(line), /noodles/)
  // Past rooms: the same record in a closed room still reads Not sent; a line still waiting when the room
  // ended never left, so it reads Not sent too.
  for (const status of ['rejected', 'pending']) {
    const past = draw(withHeld([entry(status)], { status: 'closed' }), [said('Line one: got it, noodles', 7)])
    assert.equal(shownText(past).length, 0)
    assert.equal(notSent(past).length, 1, `${status} in a closed room`)
  }
})

test('#456: a late post (no seq) is found by its Bot and its exact text; a stale send is drawn as before', () => {
  const room = withHeld([entry('rejected', { seq: 9 })])
  assert.equal(heldLineState(room, { botId: 'chief', text: 'Line one: got it, noodles' }), 'rejected')
  assert.equal(heldLineState(room, { botId: 'writer', text: 'Line one: got it, noodles' }), undefined, 'another Bot\'s words')
  assert.equal(heldLineState(room, { botId: 'chief', text: 'Something else' }), undefined)
  assert.equal(heldLineState(withHeld([entry('sending', { at: Date.now() - 120_000 })]), { seq: 7, botId: 'chief' }), undefined, 'a send cut off by a restart')
  assert.equal(heldLineState({ ...room, origin: 'group' }, { botId: 'chief', text: 'Line one: got it, noodles' }), undefined, 'only face rooms')
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
  assert.equal(find(drawn, node => node.props?.className === 'bt-group-msg').length, 1, 'only Chief\'s line is left out')
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

test('the Not sent copy has a Chinese string', () => {
  const zh = readFileSync(new URL('../src/client/i18n.js', import.meta.url), 'utf8')
  assert.match(zh, /'\{name\} · Not sent': '\{name\} · 未发出'/)
})

test('the Not sent line is a quiet grey event line', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /\.bt-event\.bt-not-sent\{[^}]*color:var\(--bt-ink-3\)/)
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
