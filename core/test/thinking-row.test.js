import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The thinking row, rendered through AssistantCell: bundled once and rendered with a minimal
// React whose components run as plain functions, as in tool-cells.test.js.
const { outputFiles } = await build({
  stdin: {
    contents: "export { AssistantCell } from './src/client/cells.js';\nexport { CONVERSATION_CSS } from './src/client/styles.js'",
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
const { AssistantCell, CONVERSATION_CSS } = module.exports

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

test('#1636: an opened row hides its preview, so its first line is not printed twice', () => {
  // The folded row names its reasoning inside the summary (#1624). Opened, the body prints that
  // same line again, so the open state drops the preview instead of repeating it.
  const openRules = [...CONVERSATION_CSS.matchAll(/\.bt-think\[open\][^{]*\{[^}]*\}/g)].map(match => match[0])
  assert.ok(
    openRules.some(rule => /\.bt-think-peek/.test(rule) && /display:\s*none/.test(rule)),
    `the opened row hides .bt-think-peek; open-state rules: ${openRules.join(' ') || 'none'}`,
  )
  // The app loads the committed bundle, not this source, so the bundle carries the rule too.
  assert.match(
    readFileSync(new URL('../client.js', import.meta.url), 'utf8'),
    /\.bt-think\[open\] \.bt-think-peek\{display:none\}/,
  )
})

test('#1642: a fence or a rule is not the peek line; the first prose line is', () => {
  const fenced = [think('```js\nconst x = 1\n```')]
  const peek = classed(thinkingRow(render(step(1, fenced), [step(1, fenced)])), 'bt-think-peek')
  assert.ok(peek, 'the closed row carries a line of the reasoning')
  assert.equal(text(peek), 'const x = 1', 'markup is not what the Bot was thinking')
  assert.doesNotMatch(text(peek), /```/)

  const ruled = [think('---\n***\nLet me read it\n___')]
  const second = classed(thinkingRow(render(step(1, ruled), [step(1, ruled)])), 'bt-think-peek')
  assert.ok(second)
  assert.equal(text(second), 'Let me read it', 'a horizontal rule is markup too')
})

test('#1642: a cut preview keeps whole characters and says it was cut', () => {
  const long = [think(`${'a'.repeat(150)}😀${'b'.repeat(100)}`)]
  const peek = classed(thinkingRow(render(step(1, long), [step(1, long)])), 'bt-think-peek')
  assert.ok(peek)
  const shown = text(peek)
  assert.equal(shown.length, 160, 'the cap still holds')
  assert.ok(shown.includes('😀'), 'an emoji inside the cap survives whole')
  assert.ok(shown.endsWith('…'), 'a clipped line says it was clipped')
  assert.doesNotMatch(shown, /[\uD800-\uDFFF]/u, 'no half a surrogate pair')

  // The reported input: a pair cut exactly at the cap used to render as U+FFFD.
  const edge = [think(`${'a'.repeat(159)}😀 tail`)]
  const cut = text(classed(thinkingRow(render(step(1, edge), [step(1, edge)])), 'bt-think-peek'))
  assert.equal(cut.length, 160)
  assert.ok(cut.endsWith('…'))
  assert.doesNotMatch(cut, /[\uD800-\uDFFF]/u, 'no half a surrogate pair at the cap either')
})

test('#1642: reasoning that is only markup gets a neutral summary, never a bare fence or an empty row', () => {
  const onlyMarkup = [think('```js\n```')]
  const details = thinkingRow(render(step(1, onlyMarkup), [step(1, onlyMarkup)]))
  assert.ok(details, 'the row stays')
  const peek = classed(details, 'bt-think-peek')
  assert.ok(peek, 'the folded row never reads as an empty frame')
  assert.equal(text(peek), '2 lines of reasoning')
})

// #1718: the folded row must stay inside the column it sits in. jsdom lays no boxes out (every
// element is 0×0), so the unit suite cannot read scrollWidth/clientWidth here; what it can read is
// the cascade the app ships, mounted around this row. The pixel evidence, taken from the same
// render in headless Chromium at 900 px and 400 px, is in the pull request: before the fix the
// summary was 1308 px wide inside a 560 px / 312 px box.
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')
const mountRow = (row, width) => {
  const { window } = new JSDOM(`<!doctype html><html><head><style>${CONVERSATION_CSS}</style></head><body><div class="column" style="width:${width}px"></div></body></html>`)
  const doc = window.document
  const build = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map(build)
    if (typeof node !== 'object') return doc.createTextNode(String(node))
    if (node.type === Fragment) return build(node.props?.children)
    const element = doc.createElement(node.type)
    for (const [name, value] of Object.entries(node.props ?? {})) {
      if (name === 'children' || name === 'key') continue
      if (typeof value === 'string' || typeof value === 'number') element.setAttribute(name === 'className' ? 'class' : name, value)
    }
    for (const child of [build(node.props?.children ?? [])].flat(Infinity)) if (child) element.append(child)
    return element
  }
  const rowEl = build(row)
  doc.querySelector('.column').append(rowEl)
  return { window, doc, style: (selector, property) => window.getComputedStyle(doc.querySelector(selector))[property] }
}
const LONG = 'x'.repeat(2000)
const longRow = () => {
  const blocks = [think(LONG)]
  return thinkingRow(render(step(1, blocks), [step(1, blocks)]))
}

test('#1718: a 2000-character line cannot widen the folded row past its box (900 px and 400 px)', () => {
  const row = longRow()
  assert.ok(row, 'the row renders for the long reasoning')
  for (const width of [900, 400]) {
    const { doc, style } = mountRow(row, width)
    // The ceiling is still the details box, not the whole column.
    assert.equal(style('.bt-think', 'maxWidth'), 'min(560px,78%)')
    // An inline-flex box sizes to its content unless it is bounded; the bound is its own box.
    assert.equal(style('.bt-think summary', 'maxWidth'), '100%', `summary is bounded by its box at ${width}px`)
    assert.equal(style('.bt-think summary', 'minWidth'), '0px')
    // One line: the label inside the summary must not wrap when the preview is squeezed.
    assert.equal(style('.bt-think summary', 'whiteSpace'), 'nowrap', `the row stays one line at ${width}px`)
    // The preview fills what is left and clips with an ellipsis, so the line cannot run wide.
    assert.equal(style('.bt-think-peek', 'maxWidth'), '100%')
    assert.equal(style('.bt-think-peek', 'minWidth'), '0px')
    assert.equal(style('.bt-think-peek', 'overflow'), 'hidden')
    assert.equal(style('.bt-think-peek', 'textOverflow'), 'ellipsis')
    assert.equal(style('.bt-think-peek', 'whiteSpace'), 'nowrap')
    // Opened, the same unbroken token wraps instead of running past the column.
    assert.equal(style('.bt-think-text', 'overflowWrap'), 'anywhere')
    assert.equal(style('.bt-think-text', 'whiteSpace'), 'pre-wrap')
    // Folded, with the caret and the label it always showed.
    const details = doc.querySelector('.bt-think')
    assert.equal(details.open, false)
    assert.equal(doc.querySelector('.bt-think-caret').textContent, '›')
    assert.match(doc.querySelector('summary').textContent, /Thought it through/)
  }
})

test('#1718: the fold stays the design — one line, no block summary, no hidden caret', () => {
  const rules = [...CONVERSATION_CSS.matchAll(/\.bt-think[^{]*\{[^}]*\}/g)].map(match => match[0])
  const summary = rules.find(rule => /^\.bt-think summary\{/.test(rule))
  assert.ok(summary, 'the row has its summary rule')
  assert.match(summary, /display:inline-flex/, 'the summary stays a one-line inline flex row')
  assert.match(summary, /white-space:nowrap/, 'the label cannot wrap into a stacked block')
  assert.doesNotMatch(summary, /display:(?:block|flex)/, 'the fold is not turned into a stacked block')
  assert.doesNotMatch(summary, /overflow:hidden/, 'nothing clips the caret away')
  // Opened, the body carries the whole 2000-character line and the preview steps aside (#1636).
  const { doc } = mountRow(longRow(), 900)
  doc.querySelector('details').open = true
  assert.equal(doc.querySelector('.bt-think-text').textContent, LONG)
  assert.equal(doc.querySelector('.bt-think-caret').textContent, '›')
})

test('#1718: the bundle the app loads carries the same containment rules', () => {
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('.bt-think summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;white-space:nowrap}'), 'summary bounded in client.js')
  assert.ok(bundle.includes('.bt-think-peek{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'), 'peek bounded in client.js')
  assert.ok(bundle.includes('.bt-think-text{white-space:pre-wrap;overflow-wrap:anywhere;'), 'body wraps in client.js')
})
