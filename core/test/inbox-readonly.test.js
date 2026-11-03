import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #2284: in a read-only window every Inbox action was a write the host refuses, and the window
// said nothing in place about why. The rows and their Open action stay; the four writes
// (answer a question, the task input, Accept, Send back) are not drawn, one sentence at the
// top of the dialog carries the host's own words, and an approval keeps Reject and Allow —
// `approval-answer` is one of the reads a read-only channel allows. A writable window draws
// exactly the tree it drew before this change: the hash below is taken from the unmodified
// tree, so the same fixture must keep its bytes.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/inbox.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
let hookState = []
let hookCursor = 0
const effects = []
const NOW = Date.UTC(2026, 10, 3, 9, 0, 0)
// The card's meta line is a relative time read from the wall clock; freeze it so the recorded
// tree below is the same picture on every run.
class FrozenDate extends Date { static now() { return NOW } }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, Date: FrozenDate, Promise,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => {
          const index = hookCursor++
          if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial
          return [hookState[index], value => { hookState[index] = typeof value === 'function' ? value(hookState[index]) : value }]
        },
        useEffect: fn => { effects.push(fn) }, useLayoutEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { InboxCard, InboxDialog } = module.exports

const OWN = new Set(['InboxCard', 'Status', 'AnswerFields', 'ResultActions'])
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (OWN.has(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(expand) }
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.children, out) }
  return out
}
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(textOf).join('') : '')
const byClass = (tree, name) => all(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name))
const buttons = tree => all(tree).filter(node => node.type === 'button')
const labels = tree => buttons(tree).map(textOf)
const fields = tree => all(tree).filter(node => node.type === 'input')

const LOCK = 'The Bot team is open in another dsh window.'
const bot = { id: 'b1', name: 'Anvil', ownerId: 'm1', sessionId: 's1' }
const writable = { self: { memberId: 'm1' }, bots: [bot], rooms: [], byId: { b1: bot }, roomsById: {}, readOnly: '' }
const locked = { ...writable, readOnly: LOCK }
const blank = { ...writable, readOnly: '   ' }
const missing = { ...writable }
delete missing.readOnly

const card = (extra) => ({ bot, at: NOW - 60_000, title: 'A card', chat: 'b1', ...extra })
const resultCard = card({ id: 'task:t4', kind: 'task', status: 'result', title: 'Draft is ready', task: { id: 't4', result: { summary: 'Draft is ready', links: [] } } })
const questionCard = card({ id: 'question:q1', kind: 'question', status: 'input', title: 'Which branch?', question: { id: 'q1', question: 'Which branch?', options: [{ label: 'A' }, { label: 'B' }], allowCustom: true } })
const inputCard = card({ id: 'task:t5', kind: 'task', status: 'input', title: 'Task five', task: { id: 't5', inputRequest: { id: 'i1', question: 'Which branch?' } } })
const approvalCard = card({ id: 'approval:a1', kind: 'approval', status: 'approval', title: 'pwsh', chat: 'r1', approval: { id: 'a1', tool: 'pwsh', answerable: true, roomId: 'r1' } })

const draw = (roster, drawn, extra = {}) => {
  hookState = []
  hookCursor = 0
  return expand(InboxCard({ card: drawn, roster, now: NOW, busy: false, error: '', onAnswer: () => {}, onOpen: () => {}, ...extra }))
}
const dialog = (roster) => {
  hookState = []
  hookCursor = 0
  return expand(InboxDialog({ roster, useWork: pick => pick({}), useSessions: pick => pick({ byId: {} }), actions: { tasks: () => Promise.resolve([]) } }))
}
// A normalised tree: element name, the props that decide what is drawn, and the text. Functions
// are not part of it, so the hash answers "same picture", not "same closures".
const shape = node => (typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(shape)
  : node && typeof node === 'object'
    ? [node.type?.name ?? String(node.type), node.props?.className ?? '', node.props?.role ?? '', node.props?.title ?? '', node.props?.['aria-label'] ?? '',
      ...(node.type === 'input' ? [node.props?.type ?? '', node.props?.disabled === true ? 'off' : 'on'] : []),
      ...node.children.map(shape)]
    : node)
const treeHash = (tree) => {
  const bytes = Buffer.from(JSON.stringify(shape(tree)), 'utf8')
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

// The writable picture, recorded on the unmodified tree. Both a blank and a missing `readOnly`
// stay on the writable path and draw exactly this.
const WRITABLE_SHA256 = 'b19823e6ca04389a3325e312aaf4807b84b55b882a255c3546d15c9c8ec23d41'
const WRITABLE_BYTES = 3088

test('a read-only result card keeps Open and draws no Accept and no Send back', () => {
  assert.deepEqual(labels(draw(locked, resultCard)), ['Open'])
})

test('a read-only question card draws no options, no answer field and no Submit, only Open', () => {
  const tree = draw(locked, questionCard)
  assert.deepEqual(labels(tree), ['Open'])
  assert.equal(fields(tree).length, 0)
})

test('a read-only task input draws no field and no Submit, only Open', () => {
  const tree = draw(locked, inputCard)
  assert.deepEqual(labels(tree), ['Open'])
  assert.equal(fields(tree).length, 0)
})

test('the read-only dialog carries the host sentence once, at the top, as a status', () => {
  const tree = dialog(locked)
  const hints = byClass(tree, 'bt-read-only')
  assert.equal(hints.length, 1)
  assert.equal(hints[0].props.role, 'status')
  assert.equal(textOf(hints[0]), LOCK)
  const order = all(tree)
  const hintAt = order.indexOf(hints[0])
  const firstGroup = order.findIndex(node => node.props?.className === 'bt-inbox-group')
  assert.ok(hintAt >= 0 && hintAt < firstGroup, `hint at ${hintAt}, first group at ${firstGroup}`)
  // The writable dialog says nothing it did not say before.
  assert.equal(byClass(dialog(writable), 'bt-read-only').length, 0)
})

test('an approval in a read-only window keeps Reject, Allow and its always-choices (#2284)', () => {
  assert.deepEqual(labels(draw(locked, approvalCard)), ['Reject', 'Allow once', 'Always allow for this Bot', 'Always allow for this group', 'Open'])
})

test('a writable window still draws the writes and keeps the recorded tree byte for byte', () => {
  assert.deepEqual(labels(draw(writable, resultCard)), ['Send back', 'Accept', 'Open'])
  assert.deepEqual(labels(draw(writable, questionCard)), ['A', 'B', 'Submit', 'Open'])
  assert.deepEqual(labels(draw(writable, inputCard)), ['Submit', 'Open'])
  // A blank or missing `readOnly` is the writable path, not the locked one.
  for (const roster of [writable, blank, missing]) {
    assert.deepEqual(labels(draw(roster, resultCard)), ['Send back', 'Accept', 'Open'])
    assert.equal(byClass(dialog(roster), 'bt-read-only').length, 0)
  }
  const hash = treeHash([resultCard, questionCard, inputCard, approvalCard].map(item => draw(writable, item)))
  assert.equal(hash.sha256, WRITABLE_SHA256)
  assert.equal(hash.bytes, WRITABLE_BYTES)
})
