// #2360: the Feedback page said `Cleared the error log.` whatever the host answered, because the
// endpoint answered a constant. The host now reports what a Clear did, and the sentence follows it:
// the unchanged one when the leaf was truncated and no rotated copy is left, one partial sentence
// when the copy could not be removed, and one that does not claim the log is empty when the leaf
// was left alone (refused by the guard, or plain but not writable). This runs the real hooks: a
// click is the button's own `onClick`, and the note is read from the tree after the page settles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { FeedbackPage } from './src/client/feedback.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) all(child, out); return out }
  if (node && typeof node === 'object') {
    out.push(node)
    for (const child of [node.props?.children].flat(Infinity)) all(child, out)
  }
  return out
}

// A tiny hooks runtime: state slots survive re-renders, setters mark the tree dirty, and effects
// run after the tree is committed (and only when their deps change).
function hooks() {
  const states = []
  const effectSlots = []
  let cursor = 0
  let dirty = false
  let pending = []
  const sameDeps = (a, b) => (a?.length === b?.length && (a ?? []).every((value, index) => value === b?.[index]))
  return {
    react: {
      createElement: h,
      Fragment: Symbol('Fragment'),
      Component: class {},
      useState: (initial) => {
        const slot = cursor++
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
        const set = (value) => {
          const next = typeof value === 'function' ? value(states[slot]) : value
          if (next !== states[slot]) { states[slot] = next; dirty = true }
        }
        return [states[slot], set]
      },
      useEffect: (fn, deps) => {
        const slot = cursor++
        if (!effectSlots[slot] || !sameDeps(effectSlots[slot].deps, deps)) pending.push({ slot, fn, deps })
      },
      useLayoutEffect: (fn, deps) => { const slot = cursor++; if (!effectSlots[slot] || !sameDeps(effectSlots[slot].deps, deps)) pending.push({ slot, fn, deps }) },
      useMemo: (make) => make(),
      useCallback: (fn) => fn,
      useRef: (value) => ({ current: value }),
    },
    begin() { cursor = 0; pending = [] },
    end() {
      for (const { slot, fn, deps } of pending) {
        effectSlots[slot]?.cleanup?.()
        const cleanup = fn()
        effectSlots[slot] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
      }
      pending = []
    },
    get dirty() { return dirty },
    clear() { dirty = false },
  }
}

const Section = ({ title, children }) => h('section', { className: 'bt-set-section' }, h('h3', null, title), h('div', { className: 'bt-set-card' }, children))
const Row = ({ label, hint, children }) => h('div', { className: 'bt-set-row' },
  h('div', { className: 'bt-set-copy' }, h('span', null, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
  children ? h('div', { className: 'bt-set-control' }, children) : null)

const T0 = Date.UTC(2026, 10, 3, 4, 0, 0)

// One error, so the page draws Clear enabled, and the answer the endpoint would give.
async function mount(clearResult) {
  const runtime = hooks()
  const report = {
    entries: [{ time: T0, level: 'error', text: 'failure', source: 'host' }],
    total: 1,
    markdown: '# diagnostics',
    issuesUrl: 'https://github.com/ThinkFlowLab/FlyBot/issues/new',
  }
  const sent = []
  const actions = {
    diagnostics: () => Promise.resolve(report),
    diagnosticsLog: () => Promise.resolve(''),
    diagnosticsClear: () => { sent.push(clearResult); return Promise.resolve(clearResult) },
  }
  const context = {
    module: { exports: {} }, exports: {},
    document: { addEventListener() {}, removeEventListener() {}, activeElement: null, querySelector: () => null },
    navigator: { language: 'en' },
    localStorage: { getItem: () => null, setItem() {} },
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    console, setTimeout, clearTimeout, Date, JSON, Promise, Symbol,
    __flybot__: { slots: { entries: () => [], subscribe: () => () => {}, version: () => 0 }, call: () => {} },
    require: (name) => {
      if (name === 'react') return runtime.react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`Unexpected platform module ${name}`)
    },
  }
  context.module.exports = context.exports
  runInNewContext(outputFiles[0].text, context)
  const { FeedbackPage } = context.module.exports

  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    const children = [node.props?.children].flat(Infinity).map(expand)
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children }))
    return { type: node.type, props: { ...node.props, children } }
  }
  let tree = null
  const render = () => {
    runtime.begin()
    tree = expand(FeedbackPage({ actions, run: fn => fn, Section, Row }))
    runtime.end()
  }
  const settle = async () => {
    for (let step = 0; step < 20; step += 1) {
      runtime.clear()
      render()
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!runtime.dirty) return
    }
    throw new Error('the page never settled')
  }

  await settle()
  const text = (node) => [node?.props?.children].flat(Infinity).filter(child => typeof child === 'string' || typeof child === 'number').join('')
  const find = predicate => all(tree).find(predicate)
  const clear = () => find(node => node.type === 'button' && text(node) === 'Clear')
  return {
    async click() { clear().props.onClick({}); await settle() },
    note: () => text(find(node => node.props?.className === 'bt-note bt-fb-note')),
    sent,
  }
}

test('#2360: a truncated leaf with the copy removed keeps the sentence it always had', async () => {
  const page = await mount({ leaf: 'truncated', rotated: 'removed' })
  await page.click()
  assert.equal(page.sent.length, 1, 'the click asks the host to clear the log')
  assert.equal(page.note(), 'Cleared the error log.')
})

test('#2360: the sentence names the rotated copy a Clear could not remove', async () => {
  const page = await mount({ leaf: 'truncated', rotated: 'kept' })
  await page.click()
  assert.equal(page.note(), 'Cleared the error log, but its rotated copy (logs/diagnostics.jsonl.1) could not be removed.')
})

// `kept` is one answer for two shapes: the guard refusing a leaf that is a link or a shared name,
// and a plain leaf the host could not write (0444, a read-only mount). The sentence names neither
// reason, so both shapes land on it; the shape lives in the test name, not in the words.
test('#2360: a leaf the guard refused is not reported as a cleared log', async () => {
  const page = await mount({ leaf: 'kept', rotated: 'none' })
  await page.click()
  assert.equal(page.note(), 'The error log was not cleared: the host could not truncate it.')
})

test('#2360: a plain leaf the host could not truncate is not reported as a cleared log either', async () => {
  const page = await mount({ leaf: 'kept', rotated: 'none' })
  await page.click()
  assert.equal(page.note(), 'The error log was not cleared: the host could not truncate it.')
})

test('#2360: an older host answer keeps the unchanged sentence', async () => {
  const page = await mount(true)
  await page.click()
  assert.equal(page.note(), 'Cleared the error log.')
})
