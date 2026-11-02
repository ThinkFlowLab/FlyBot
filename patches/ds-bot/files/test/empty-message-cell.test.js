import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #2123: a message with no text — or only whitespace — painted a row carrying the avatar and a bubble
// with nothing in it, under the trace row of the turn that produced it. The draw is checked where a
// person reads it: the bubbles of one message (a Bot's own chat) and a group chat's reply rows.
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
const count = (node, cls) => find(node, item => String(item.props?.className ?? '').split(/\s+/).includes(cls)).length

const { Bubbles, GroupReplies, RemoteMessage } = await load('cells.js')

const chief = { id: 'chief', name: 'Chief', color: 'green' }
const writer = { id: 'writer', name: 'Writer', color: 'blue' }
const roster = { bots: [chief, writer], byId: { chief, writer }, rooms: [], roomsById: {}, exchangeTurns: {}, questions: {}, secretRequests: {}, secrets: [] }
const actions = { quote: () => {}, toggleReaction: () => {}, openSession: () => {} }
const bubbles = texts => Bubbles({ texts, roster, selfId: chief.id, actions, sessionId: 'chat', msgKey: 'chat:turn:1' })
const groupChat = replies => expand(GroupReplies({
  sessionId: 'g1', callId: 'c1', done: true, roster, actions, useUi: () => null,
  content: [{ type: 'text', text: JSON.stringify({ replies }) }],
}), ['GroupMessage', 'Bubbles'])

test('#2123: a message with no text paints no row at all — no avatar, no bubble', () => {
  // The turn ended with tool calls only, or its reply was held/replaced by a card elsewhere: nothing is
  // left to show, so the message must not draw. An empty string and a whitespace-only one are the same.
  for (const texts of [[''], ['   \n']]) {
    assert.equal(bubbles(texts), null, `no row for ${JSON.stringify(texts)}`)
  }
  assert.equal(bubbles(['', '   \n']), null, 'several blank blocks are no row either')
  // The same feed with text still draws exactly one row: one bubble, and the avatar beside it.
  const drawn = bubbles(['Covered — merge it.'])
  assert.equal(count(drawn, 'bt-msg'), 1)
  assert.equal(count(drawn, 'bt-bubble'), 1)
})

test('#2123: a group chat draws no row for an empty Bot line, and one for the same line with text', () => {
  for (const text of ['', '   \n']) {
    const drawn = groupChat([{ botId: writer.id, name: writer.name, kind: 'reply', text }])
    assert.equal(count(drawn, 'bt-group-msg'), 0, `no row for ${JSON.stringify(text)}`)
    assert.equal(count(drawn, 'bt-msg'), 0, 'and no bubble under it')
    assert.equal(count(drawn, 'bt-bubble'), 0)
  }
  const withText = groupChat([{ botId: writer.id, name: writer.name, kind: 'reply', text: 'Covered — merge it.' }])
  assert.equal(count(withText, 'bt-group-msg'), 1)
  assert.equal(count(withText, 'bt-bubble'), 1)
})

test("#2123: a friend's line with no text keeps its files and draws no empty bubble", () => {
  const source = { remote: { handle: '@coder.bob.home', senderName: 'Bob’s Coder' }, senderName: 'Bob’s Coder' }
  const empty = RemoteMessage({ source, text: '   \n', roster, actions, sessionId: 'chat', msgKey: 'chat:turn:2' })
  assert.equal(empty, null, 'nothing to read and nothing attached is no row')
  const attached = RemoteMessage({ source: { ...source, attachments: [{ name: 'log.txt', size: 12 }] }, text: '', roster, actions, sessionId: 'chat', msgKey: 'chat:turn:2' })
  assert.equal(count(attached, 'bt-bubble'), 0, 'the attachment stays, the empty bubble does not')
  assert.equal(count(attached, 'bt-remote-msg'), 1)
})
