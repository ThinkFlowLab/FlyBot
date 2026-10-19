import assert from 'node:assert/strict'
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
const { AssistantCell, friendLead } = sandbox.module.exports

// #443: in a friend's 1:1 chat the replies carry the friend's Bot mark, and one thinking row stays
// up from my send until the reply lands (the host keeps remoteAwaiting across the two turns).

const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}
const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: (node.children ?? []).map(child => expand(child, names)) }
}
const friend = { id: 'r1', name: '测试', color: 'orange', remote: { handle: '@bot-1.danyang.home', home: '@danyang.home', homeName: 'Danyang', plugin: 'social' } }
const chief = { id: 'chief', name: 'Chief', color: 'blue' }
const roster = { bots: [friend, chief], byId: { r1: friend, chief }, roomsById: {}, exchangeTurns: {}, remoteTypedTurns: {} }
const draw = (sessionId, text) => expand(AssistantCell({
  node: { key: 'n1', location: { kind: 'step', turn: { turn: 2, status: 'closed' } }, data: { turn: 2, step: 1, seq: 4, status: 'done', finalNode: { seq: 4 }, blocks: [{ kind: 'text', text }] } },
  sessionId,
  useTurnData: () => undefined,
  useRoster: select => select(roster),
  useUi: () => null,
  useTurnSteps: () => [],
  useTurnContext: () => [],
  actions: { noteLive() {} },
}), ['Bubbles'])
const lead = drawn => find(drawn, n => n.props?.['data-flybot'] === 'friend-lead')[0]

test('a friend\'s Bot reply carries its mark beside the bubble, the look its sidebar row shows', () => {
  const box = lead(draw('r1', 'Hi again!'))
  assert.ok(box, 'the reply has a lead mark')
  assert.equal(box.props.className, 'bt-lead')
  assert.equal(box.children[0].props.bot, friend, 'the mark is drawn from the friend chat record, as in the sidebar')
  assert.equal(find(draw('r1', 'Hi again!'), n => n.props?.className === 'bt-astack')[0].props['data-lead'], '')
})

test('my own Bot\'s chat and a Not sent note have no friend mark', () => {
  assert.equal(lead(draw('chief', 'pong')), undefined)
  assert.equal(lead(draw('r1', 'Not sent: Bot Social did not answer. Try again.')), undefined)
  assert.equal(friendLead(friend, []), undefined)
  assert.equal(friendLead(undefined, ['x']), undefined)
})
