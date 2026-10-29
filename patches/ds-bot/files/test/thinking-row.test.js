import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The thinking row, rendered through AssistantCell: bundled once and rendered with a minimal
// React whose components run as plain functions, as in tool-cells.test.js.
const { outputFiles } = await build({
  stdin: {
    contents: "export { AssistantCell } from './src/client/cells.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let effects = []
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } })
const react = {
  createElement: h, Fragment,
  useEffect: effect => { effects.push(effect) },
  useLayoutEffect: effect => { effects.push(effect) },
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'cell-id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: true },
  setTimeout: () => ({ fn: () => {} }), clearTimeout: () => {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { AssistantCell } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props.children) : String(node)
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return match(node) ? node : find(node.props.children, match)
}

const bot = { id: 'bot', name: 'Bot', color: 'blue' }
const roster = { bots: [bot], byId: { bot }, roomsById: {}, exchangeTurns: {} }
const step = (n, blocks, status = 'settled') => ({ turn: 7, step: n, status, blocks })
const think = (text) => ({ kind: 'reasoning', text })

// One assistant-step seat of a turn, as DSH hands it to the cell.
const render = (data, steps, groupPart = 'reasoning') => expand(AssistantCell({
  node: { key: `${data.turn}:${data.step}`, data },
  groupPart,
  sessionId: 'bot',
  openFile: () => {}, fileMentions: () => {},
  useTurnData: () => undefined,
  useRoster: pick => pick(roster),
  useUi: pick => pick({}),
  useTurnSteps: () => steps,
  useTurnContext: () => undefined,
  actions: { noteLive: () => {}, openExchange: () => {}, quote: () => {} },
}))
const thinkingRow = (tree) => find(tree, node => node.props?.className === 'bt-think')
const classed = (node, className) => find(node, child => child.props?.className === className)

test('#1624: a settled step shows a line of its reasoning in the closed row, not a bare 思考过程 strip', () => {
  const blocks = [think('Looking   at the store first\nThen the second line'), { kind: 'text', text: 'Here is the answer' }]
  const steps = [step(1, blocks)]
  const tree = render(step(1, blocks), steps)
  const details = thinkingRow(tree)
  assert.ok(details, 'the settled reasoning has its row')
  // Folded by default: the caret still says there is more inside.
  assert.equal(details.props.open, undefined)
  const summary = find(details, node => node.type === 'summary')
  assert.ok(summary, 'the row has its summary')
  // The visible strip carries a line of what it names, so it never reads as an empty frame.
  const peek = classed(summary, 'bt-think-peek')
  assert.ok(peek, 'the closed row carries a line of the reasoning')
  assert.equal(text(peek), 'Looking at the store first')
  assert.doesNotMatch(text(peek), /Then the second line/)
})

test('#1624: the peek line is capped, so one long line cannot fill the row', () => {
  const blocks = [think('x'.repeat(400))]
  const peek = classed(thinkingRow(render(step(1, blocks), [step(1, blocks)])), 'bt-think-peek')
  assert.ok(peek, 'the closed row carries its line')
  assert.equal(text(peek).length, 160)
})

test('#1624: the row still holds the whole reasoning once opened', () => {
  const blocks = [think('Looking at the store first\nThen the second line')]
  const details = thinkingRow(render(step(1, blocks), [step(1, blocks)]))
  const body = classed(details, 'bt-think-text')
  assert.ok(body, 'the row has a body')
  assert.equal(text(body), 'Looking at the store first\nThen the second line')
})

test('#1624: a step that is still thinking draws no row at all', () => {
  const blocks = [think('Half a thought')]
  const live = step(1, blocks, 'running')
  const tree = render(live, [live])
  assert.equal(thinkingRow(tree), undefined)
})

test('#1624: reasoning that is only whitespace draws no row at all', () => {
  const blocks = [think('  \n\t '), { kind: 'text', text: 'Answer' }]
  assert.equal(thinkingRow(render(step(1, blocks), [step(1, blocks)])), undefined)
})
