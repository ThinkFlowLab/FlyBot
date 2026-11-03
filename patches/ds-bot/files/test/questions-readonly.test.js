import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// A read-only window draws the `ask_user` card in the dock and inline in the transcript. The card
// was live there: an option reached `answer-question`, whose refusal PendingQuestion swallowed
// (`.catch(() => setAnswered(null))`), so the card came back with nothing said; the × reached
// `dismiss-question` and hid the card until the next poll, which answered it back. Both are writes
// the host refuses (core/src/host/channel.js READS), so a read-only card offers neither.

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { PendingQuestion, QuestionDock } from './src/client/questions.js'",
      "export { ToolCell } from './src/client/cells.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const written = []
const react = {
  createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {},
  useState: initial => [typeof initial === 'function' ? initial() : initial, value => written.push(value)],
  useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }),
  useId: () => 'card-id', useSyncExternalStore: (_subscribe, get) => get(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console,
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null },
  navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame: run => run(),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { PendingQuestion, QuestionDock, ToolCell } = module.exports

const LOCK = 'Another FlyBot window has this home open; this window is read-only.'
const WRITABLE = { bots: [], byId: {}, rooms: [], roomsById: {}, readOnly: '', questions: {}, exchangeTurns: {} }
const LOCKED = { ...WRITABLE, readOnly: LOCK }
const single = { id: 'q1', callId: 'call-1', header: 'Draft', question: 'Which draft?', options: [{ label: 'Short' }, { label: 'Long' }], allowCustom: true }
const multi = { ...single, id: 'q2', multiSelect: true }

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const walk = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  walk(node.props.children, out)
  return out
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props.children) : String(node)
}
const controlName = (node) => {
  if (node.props['aria-label']) return node.props['aria-label']
  if (node.type === 'form') return 'form:submit'
  const named = walk(node.props.children).find(child => child.props.className === 'bt-q-label')
  return named ? text(named.props.children) : text(node.props.children)
}

// What the window can be pressed on: every button and field the card draws, and every handler.
const buttons = tree => walk(tree).filter(node => node.type === 'button')
const fields = tree => walk(tree).filter(node => node.type === 'textarea' || node.type === 'input')
const handlers = tree => walk(tree).filter(node => typeof node.props.onClick === 'function' || typeof node.props.onSubmit === 'function')

const actionsFor = (rejectAnswer) => {
  const log = []
  return {
    log,
    answerQuestion: (...args) => { log.push(['answer-question', ...args]); return rejectAnswer ? Promise.reject(new Error('bot/read-only')) : Promise.resolve({}) },
    dismissQuestion: (...args) => { log.push(['dismiss-question', ...args]); return Promise.resolve({}) },
  }
}
const pressAll = (tree) => {
  for (const node of handlers(tree)) {
    if (typeof node.props.onClick === 'function') node.props.onClick({ preventDefault() {}, stopPropagation() {} })
    else node.props.onSubmit({ preventDefault() {} })
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const dock = (roster, question, actions) => expand(QuestionDock({
  sessionId: 'chief', actions,
  useRoster: select => select({ ...roster, questions: { chief: question } }),
  useCards: select => select({ chief: {} }),
  useSession: select => select({ openState: 'open' }),
}))
const inline = (roster, question, actions) => expand(PendingQuestion({ sessionId: 'chief', question, roster, actions, inline: true }))

// The same tree the writable window draws, hashed: the fix must leave it byte-for-byte as it was.
const canonical = node => JSON.stringify(node, (_key, value) => (typeof value === 'function' ? `fn:${value.name || 'anon'}` : value))
const sha256 = node => createHash('sha256').update(canonical(node)).digest('hex')

test('a read-only window draws no answer, no skip and no dismissal on the question card', async () => {
  const actions = actionsFor(true)
  const tree = dock(LOCKED, multi, actions)
  const drawn = { buttons: buttons(tree).map(controlName), fields: fields(tree).length, handlers: handlers(tree).length }
  assert.deepEqual(drawn, { buttons: [], fields: 0, handlers: 0 }, `the read-only card still draws a write: ${JSON.stringify(drawn)}`)
  const shown = text(tree)
  assert.ok(!shown.includes('Submit') && !shown.includes('Skip'), `the read-only card still says: ${shown}`)
})

test('a read-only window neither sends an answer nor hides the card it cannot answer', async () => {
  const actions = actionsFor(true)
  const tree = dock(LOCKED, single, actions)
  written.length = 0
  pressAll(tree)
  await settle()
  const seen = { pressed: buttons(tree).map(controlName), writes: actions.log, states: [...written] }
  // Nothing was sent, so nothing was swallowed and nothing hid: the card a read-only window draws
  // is not a button that silently fails, it is the question with the host's sentence above it.
  assert.deepEqual(JSON.parse(JSON.stringify({ writes: seen.writes, states: seen.states })), { writes: [], states: [] }, `read-only card pressed: ${JSON.stringify(seen)}`)
  assert.match(text(tree), /Another FlyBot window has this home open; this window is read-only/)
})

test('a read-only window says why, in the host sentence, above the card it cannot answer', async () => {
  const actions = actionsFor(true)
  for (const tree of [dock(LOCKED, single, actions), inline(LOCKED, single, actions)]) {
    const hints = walk(tree).filter(node => node.props.className === 'bt-hint bt-read-only' && node.props.role === 'status')
    assert.equal(hints.length, 1, `the host sentence is drawn ${hints.length} times: ${text(tree)}`)
    assert.equal(text(hints[0]), LOCK)
    assert.match(text(tree), /Which draft\?.*Short.*Long/s, 'the question and its rows stay readable')
  }
})

test('the transcript card a Bot turn draws obeys the same window', async () => {
  const actions = actionsFor(true)
  const call = { kind: 'tool-result', name: 'ask_user', callId: 'call-1', call: { name: 'ask_user', argsRaw: '{}' }, content: [{ type: 'text', text: '' }], isError: false, subCalls: [] }
  const tree = expand(ToolCell({
    node: { key: 'node', data: { root: call }, location: { turn: { turn: 1 } } }, sessionId: 'chief',
    useRoster: select => select({ ...LOCKED, questions: { chief: single } }),
    useUi: select => select({ reactions: {}, visits: {} }), actions,
  }))
  const drawn = { buttons: buttons(tree).map(controlName), fields: fields(tree).length, handlers: handlers(tree).length }
  assert.deepEqual(drawn, { buttons: [], fields: 0, handlers: 0 }, `the inline read-only card still draws a write: ${JSON.stringify(drawn)}`)
})

test('a writable window keeps the answer, the own-answer field and the dismissal, all wired', async () => {
  const actions = actionsFor(false)
  const docked = dock(WRITABLE, single, actions)
  const dockedText = text(docked)
  assert.match(dockedText, /Which draft\?.*Short.*Long/s)
  assert.equal(fields(docked).length, 1, `custom answer field missing: ${dockedText}`)
  const optionRow = buttons(docked).find(node => node.props.className === 'bt-q-opt' && controlName(node) === 'Short')
  optionRow.props.onClick({ preventDefault() {}, stopPropagation() {} })
  const dismiss = buttons(docked).find(node => node.props['aria-label'] === 'Dismiss question')
  assert.ok(dismiss, `dismissal missing from the writable card: ${dockedText}`)
  dismiss.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(JSON.parse(JSON.stringify(actions.log)), [
    ['answer-question', 'chief', 'q1', { selected: ['Short'], custom: '' }],
    ['dismiss-question', 'chief'],
  ])
  assert.equal(walk(docked).filter(node => node.props.className === 'bt-hint bt-read-only').length, 0, 'a writable card draws no read-only hint')
  console.log(`writable-question-tree-sha256 ${sha256(docked)}`)
})

test('a writable window keeps Skip and Submit on the multi-select card', async () => {
  const actions = actionsFor(false)
  const tree = dock(WRITABLE, multi, actions)
  const drawn = buttons(tree).map(controlName)
  assert.ok(drawn.includes('Skip') && drawn.includes('Submit'), `writable multi card: ${JSON.stringify(drawn)}`)
})
