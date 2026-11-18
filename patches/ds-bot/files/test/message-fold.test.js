// #3114: a long reply is drawn as a whole-line preview under one Show more control,
// and a streaming reply or a short one is never folded. The draw is checked in a
// bubble, where a person reads it, with the same React mock as the other cell
// tests: a component runs as a plain function and a fold is one hook slot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { Bubbles } from './src/client/cells.js'",
      "export { FOLD_THRESHOLDS, DocumentPane, foldingOf, previewOf, shouldFold } from './src/client/message-fold.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// One slot per hook call, started over by each draw: the bubble's context menu is
// slot 0, the fold comes after it, and pressing the control draws the bubble again.
const slots = []
let slot = 0
const react = {
  createElement: h, Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }),
  useState: (initial) => {
    const at = slot++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }]
  },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: false }, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { Bubbles, FOLD_THRESHOLDS, DocumentPane, foldingOf, previewOf, shouldFold } = module.exports

// The tool cells' generic expander hands a component its props and nothing else,
// so every element runs as a function of its properties here too.
const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const walk = (node, match) => {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => walk(child, match))
  return [...(match(node) ? [node] : []), ...walk(node.props.children, match)]
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props.children) : String(node)
}
const classed = (node, cls) => walk(node, item => String(item.props?.className ?? '').split(/\s+/).includes(cls))

const chief = { id: 'chief', name: 'Chief', color: 'green' }
const roster = { bots: [chief], byId: { chief }, rooms: [], roomsById: {}, exchangeTurns: {}, questions: {}, secretRequests: {}, secrets: [] }
const actions = { quote: () => {}, toggleReaction: () => {}, openSession: () => {} }

const lines = (count, width = 'This is a line of a longer reply.') => Array.from({ length: count }, () => width).join('\n')
const numbered = (count) => Array.from({ length: count }, (_, index) => `Line ${index + 1} of the reply`).join('\n')

// One draw of one bubble: a fold left in its slot survives the next draw, so the control works.
const bubble = (over = {}) => {
  slot = 0
  return expand(Bubbles({ texts: [over.text ?? numbered(20)], roster, selfId: chief.id, actions, sessionId: 'chat', msgKey: 'chat:turn:1', ...over }))
}
const fresh = (over = {}) => { slots.length = 0; return bubble(over) }
const toggles = (drawn) => classed(drawn, 'bt-fold-toggle')
const press = (drawn) => toggles(drawn)[0].props.onClick({ preventDefault() {}, stopPropagation() {} })

test('#3114: a message over the cap folds, one at the cap stays open', () => {
  const { compact, standard } = FOLD_THRESHOLDS
  assert.equal(compact.lines, 4)
  assert.equal(standard.lines, 12)
  assert.equal(foldingOf(undefined).mode, 'standard')
  assert.equal(foldingOf(undefined).documentCards, true, 'the document card is on by default')
  assert.equal(foldingOf({ folding: { mode: 'compact' } }).documentCards, true, 'a folding mode alone keeps the card on')
  assert.equal(shouldFold(lines(standard.lines), 'standard'), false, '12 lines stay open')
  assert.equal(shouldFold(lines(standard.lines + 1), 'standard'), true, '13 lines fold')
  assert.equal(shouldFold('x'.repeat(compact.chars), 'compact'), false, '240 characters stay open')
  assert.equal(shouldFold('x'.repeat(standard.chars), 'standard'), false, '800 characters stay open')
  assert.equal(shouldFold('x'.repeat(standard.chars + 1), 'standard'), true, '801 characters fold')
  assert.equal(shouldFold(lines(20), 'none'), false, "mode:'none' never folds")
})

test('#3114: the preview is whole lines, and no code block is left open', () => {
  const reply = lines(20)
  const preview = previewOf(reply, 'standard')
  assert.equal(preview.split('\n').length, 12, 'the preview is exactly 12 whole lines')
  assert.ok(reply.startsWith(preview), 'the preview is a prefix of the reply')
  const code = '```js\n' + 'const n = 1\n'.repeat(40) + '```'
  const cut = previewOf(code, 'standard')
  const markers = cut.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? []
  assert.equal(markers.length % 2, 0, 'the preview closes the code block it opens')
  assert.equal(previewOf('a short line', 'standard'), 'a short line', 'nothing is cut below the cap')
  assert.equal(previewOf('intro line\n\n' + code, 'standard'), 'intro line', 'prose before an open block keeps the preview short')
})

// The bubble carries the control and only the preview: no second fold mark, and
// no line past the twelfth.
test('#3114: a long reply draws its preview and one Show more control', () => {
  const drawn = fresh({ text: numbered(20) })
  const found = toggles(drawn)
  assert.equal(found.length, 1, 'the bubble carries a fold control')
  assert.equal(classed(drawn, 'bt-fold').length, 1)
  assert.equal(found[0].props['aria-expanded'], false)
  assert.equal(text(found[0]), 'Show more')
  assert.ok(text(drawn).includes('Line 12 of the reply'), 'the preview reaches line 12')
  assert.ok(!text(drawn).includes('Line 20 of the reply'), 'the reply stops at the preview')
})

test('#3114: Show more draws the whole reply, and Show less folds it back', () => {
  press(fresh({ text: numbered(20) }))
  const opened = bubble({ text: numbered(20) })
  const open = toggles(opened)[0]
  assert.equal(open.props['aria-expanded'], true)
  assert.equal(text(open), 'Show less')
  assert.ok(text(opened).includes('Line 20 of the reply'), 'the whole reply is drawn')
  press(opened)
  const folded = bubble({ text: numbered(20) })
  assert.equal(toggles(folded)[0].props['aria-expanded'], false)
  assert.ok(!text(folded).includes('Line 20 of the reply'), 'the preview is drawn again')
})

test('#3114: a streaming reply and a short one are never folded', () => {
  const streaming = fresh({ text: numbered(20), streaming: true })
  assert.equal(toggles(streaming).length, 0, 'a streaming reply has no fold control')
  assert.ok(text(streaming).includes('Line 20 of the reply'), 'and every line is drawn')
  const short = fresh({ text: 'A short reply.' })
  assert.equal(text(short), 'A short reply.', 'the short reply is drawn whole')
  assert.equal(toggles(short).length, 0, 'a short message has no fold control')
  assert.ok(text(short).includes('A short reply.'))
})

// A runbook: two headings and more than the standard cap, with a line deep inside
// it that only the whole draw can reach.
const runbook = (steps = 10) => [
  '# Runbook',
  '',
  'Keep this beside you while the service comes up.',
  '',
  ...Array.from({ length: steps }, (_, index) => `Step ${index + 1}: check the service and write down what you saw.`),
  '',
  '## Step 2',
  '',
  'Close the runbook when the last line passes.',
].join('\n')

test('#3114: a long document draws a card with its title and section count', () => {
  const drawn = fresh({ text: runbook() })
  const cards = classed(drawn, 'bt-doc-card')
  assert.equal(cards.length, 1, 'the bubble carries a document card')
  assert.equal(text(classed(drawn, 'bt-doc-card-title')[0]), 'Runbook')
  assert.equal(text(classed(drawn, 'bt-doc-card-meta')[0]), '2 sections')
  assert.ok(text(drawn).includes('Open beside the conversation'))
  assert.ok(!text(drawn).includes('Step 10'), 'the card does not draw the body')
})

test('#3114: the card hands the whole text to the pane', () => {
  const body = runbook()
  const handed = []
  const drawn = fresh({ text: body, actions: { ...actions, openDocument: payload => handed.push(payload) } })
  const cards = classed(drawn, 'bt-doc-card')
  assert.equal(cards.length, 1, 'there is a card to open')
  cards[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.equal(handed.length, 1)
  assert.equal(handed[0].title, 'Runbook')
  assert.equal(handed[0].text, body)
  assert.equal(handed[0].sessionId, 'chat')
})

test('#3114: a document card keeps the whole text one press away', () => {
  const body = runbook()
  const drawn = fresh({ text: body })
  const controls = toggles(drawn)
  assert.equal(controls.length, 1)
  assert.equal(text(controls[0]), 'Show message text')
  press(drawn)
  const open = bubble({ text: body })
  assert.equal(text(toggles(open)[0]), 'Hide message text')
  assert.ok(text(open).includes('Step 10'), 'the whole text is drawn in place')
  const plain = fresh({ text: numbered(20) })
  assert.equal(toggles(plain).length, 1)
  assert.equal(text(toggles(plain)[0]), 'Show more', 'a long reply with no sections still folds')
  const none = fresh({ text: body, roster: { ...roster, prefs: { folding: { mode: 'none' } } } })
  assert.equal(classed(none, 'bt-doc-card').length, 0, "mode:'none' draws no card")
  assert.ok(text(none).includes('Step 10'), "mode:'none' draws the whole text")
  const streaming = fresh({ text: body, streaming: true })
  assert.equal(classed(streaming, 'bt-doc-card').length, 0, 'a streaming document draws no card')
  assert.ok(text(streaming).includes('Step 10'), 'a streaming document is drawn whole')
})

test('#3114: the document pane draws the whole text and closes', () => {
  const body = runbook()
  let closed = 0
  const pane = expand(DocumentPane({ document: { title: 'Runbook', text: body }, onClose: () => { closed += 1 } }))
  assert.equal(classed(pane, 'bt-doc-pane').length, 1)
  assert.equal(text(classed(pane, 'bt-doc-pane-title')[0]), 'Runbook')
  assert.ok(text(pane).includes('Step 10'), 'the pane draws the whole text')
  const close = walk(pane, item => item.props?.['aria-label'] === 'Close document')[0]
  close.props.onClick()
  assert.equal(closed, 1, 'the pane closes once')
})

// General → Document cards (#3114). Off takes away the card and its Show message text at every
// folding mode and leaves the reply folded by the same cap as any other; on is what the bubble
// drew before the switch existed.
test('#3114: with document cards off a long document folds like any other reply', () => {
  const body = runbook()
  const seen = (mode, documentCards) => fresh({ text: body, roster: { ...roster, prefs: { folding: { mode }, documentCards } } })
  for (const mode of ['compact', 'standard']) {
    const off = seen(mode, false)
    assert.equal(classed(off, 'bt-doc-card').length, 0, `no card when the switch is off and ${mode}`)
    assert.ok(!text(off).includes('Show message text'), `no Show message text when the switch is off and ${mode}`)
    assert.equal(toggles(off).length, 1, `${mode} folds the document like any other reply`)
    assert.equal(text(toggles(off)[0]), 'Show more', 'and offers Show more')
    assert.ok(!text(off).includes('Step 10'), 'the preview stops before the end')
  }
  const none = seen('none', false)
  assert.equal(classed(none, 'bt-doc-card').length, 0, 'no card when the switch is off and nothing folds')
  assert.ok(text(none).includes('Step 10'), 'and the whole text is drawn')
  // On is today: the card, or the whole text when folding itself is off.
  for (const mode of ['standard', 'compact']) {
    const on = seen(mode, true)
    assert.equal(classed(on, 'bt-doc-card').length, 1, `the card is drawn when the switch is on and ${mode}`)
    assert.equal(text(toggles(on)[0]), 'Show message text', 'and the text stays one press away')
  }
  const open = seen('none', true)
  assert.equal(classed(open, 'bt-doc-card').length, 0, 'no card when folding is off')
  assert.ok(text(open).includes('Step 10'), 'and the whole text is drawn')
  // A streaming reply is whole and cardless whatever the switch says.
  for (const documentCards of [true, false]) {
    const streaming = fresh({ text: body, streaming: true, roster: { ...roster, prefs: { documentCards } } })
    assert.equal(classed(streaming, 'bt-doc-card').length, 0, 'a streaming reply draws no card')
    assert.ok(text(streaming).includes('Step 10'), 'and is drawn whole')
  }
  // A long reply with no headings or sections is not a document: the switch changes nothing.
  const plain = fresh({ text: numbered(20), roster: { ...roster, prefs: { documentCards: false } } })
  assert.equal(classed(plain, 'bt-doc-card').length, 0, 'a long reply draws no card either way')
  assert.equal(toggles(plain).length, 1, 'and folds the same')
  assert.equal(text(toggles(plain)[0]), 'Show more', 'with Show more')
})
