import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #418: a Bot's reply to a friend, held for its owner, is drawn on the turn it answers: held
// style and the decision on the bubble, then Sent or Not sent in the same place.

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
function MarkdownText() { return null }
const sandbox = { module: { exports: {} } }
sandbox.exports = sandbox.module.exports
sandbox.globalThis = sandbox
runInNewContext(bundle.outputFiles[0].text, {
  ...sandbox,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), Fragment: 'fragment', Component: class {},
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell } = sandbox.module.exports

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
const strings = node => (Array.isArray(node) ? node.flatMap(strings) : typeof node === 'string' ? [node] : node && typeof node === 'object' ? strings(node.children ?? []) : [])
const text = node => strings(node).join('')

const chief = (heldReplies, bots = []) => {
  const bot = { id: 'chief', name: 'Chief', sessionId: 'chief', ...(heldReplies ? { heldReplies } : {}) }
  return { bots: [bot, ...bots], byId: { chief: bot }, roomsById: {}, exchangeTurns: {}, remoteTypedTurns: {} }
}
const draw = (roster, { seq = 10, closing = 10 } = {}) => expand(AssistantCell({
  node: { key: `n${seq}`, location: { kind: 'step', turn: { turn: 3, status: 'closed' } }, data: { turn: 3, step: 1, seq, status: 'done', finalNode: { seq }, blocks: [{ kind: 'text', text: '4.' }] } },
  sessionId: 'chief',
  useTurnData: key => (key === 'turn-tail' ? { closing: { finalNode: { seq: closing } } } : undefined),
  useRoster: select => select(roster),
  useUi: () => null,
  useTurnSteps: () => [],
  useTurnContext: () => [],
  actions: { noteLive() {} },
}), ['HeldReply', 'HeldReplyActions', 'Bubbles'])
const held = (status, extra = {}) => ({ id: 'apr-1', by: 'social', status, sessionId: 'chief', turn: 3, to: '@chief.selfb1238.home', toOwner: 'SelfB1238', ...extra })
const wrapper = drawn => find(drawn, n => n.props?.className === 'bt-held-reply')[0]

test('a waiting reply is drawn held, with the decision on it, naming the person who gets it', () => {
  const drawn = draw(chief([held('pending')]))
  const box = wrapper(drawn)
  assert.ok(box, 'the reply is wrapped as held')
  assert.equal(box.props['data-state'], 'pending')
  assert.equal(box.props['data-held'], '')
  assert.ok(find(box, n => n.props?.className === 'bt-bubble').length >= 1, 'the bubble is still there, once')
  const buttons = find(box, n => n.type === 'button').map(text)
  assert.deepEqual(buttons, ['Reject', 'Approve'], 'plain buttons when no policy card is registered')
  assert.ok(strings(box).includes('Chief → SelfB1238'))
  // An earlier text of the same turn is marked but carries no buttons.
  const earlier = wrapper(draw(chief([held('pending')]), { seq: 8, closing: 10 }))
  assert.equal(find(earlier, n => n.type === 'button').length, 0)
})

test('after the decision the reply says Sent or Not sent in place, and they differ', () => {
  const sent = wrapper(draw(chief([held('approved')])))
  const rejected = wrapper(draw(chief([held('rejected')])))
  const failed = wrapper(draw(chief([held('failed', { error: 'HTTP 500' })])))
  assert.equal(sent.props['data-state'], 'approved')
  assert.equal(rejected.props['data-state'], 'rejected')
  assert.ok(strings(sent).includes('Sent to {to}'.replace('{to}', 'SelfB1238')))
  assert.ok(strings(rejected).includes('Not sent'))
  assert.deepEqual(find(failed, n => n.type === 'button').map(text), ['Retry'])
  assert.equal(find(sent, n => n.type === 'button').length + find(rejected, n => n.type === 'button').length, 0)
})

test('a friend\'s Bot with a listed chat is named as the chat list names it; no held reply, no wrapper', () => {
  const friend = { id: 'f1', name: 'Chief', remote: { handle: '@chief.selfb1238.home', owner: 'SelfB1238' } }
  const drawn = draw(chief([held('pending', { toOwner: undefined })], [friend]))
  assert.ok(strings(wrapper(drawn)).includes('Chief → Chief (SelfB1238)'))
  assert.equal(wrapper(draw(chief())), undefined)
  assert.equal(wrapper(draw(chief([held('pending', { turn: 4 })]))), undefined, 'another turn')
})

test('the list preview shows the friend\'s line, not a reply that was not sent; the host tags the turn', async () => {
  const text = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/text.js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', write: false,
  })
  const { previewOf, unsentReplyTurns } = await import(`data:text/javascript;base64,${Buffer.from(text.outputFiles[0].text).toString('base64')}`)
  const list = { byId: { chief: { projectionValues: { turnOutline: [{ turn: 3, prompt: 'What is 2+2?', response: '4.' }] } } } }
  const bot = { heldReplies: [held('rejected')] }
  assert.deepEqual(unsentReplyTurns(bot, 'chief'), [3])
  assert.equal(previewOf(list, 'chief', [], unsentReplyTurns(bot, 'chief')), 'What is 2+2?')
  assert.equal(previewOf(list, 'chief', [], unsentReplyTurns({ heldReplies: [held('approved')] }, 'chief')), '4.')
  const turns = readFileSync(new URL('../src/host/turns.js', import.meta.url), 'utf8')
  assert.match(turns, /replyIn: \{ sessionId: id, turn: answeredTurn \}/)
})
