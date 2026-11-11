// P-687: the Feedback page drew `No errors recorded.` whenever the host sent no rows, and the
// host's `unread` field (#2604) says when no rows is not the same as "nothing was recorded": the
// error log could not be opened, so the errors it holds are missing from the report. The page
// never read the field, so a refused log (EACCES) read as a clean one.
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
const errorEntries = count => Array.from({ length: count }, (_, index) => ({
  time: T0 - index * 1000,
  level: 'error',
  text: `failure number ${index + 1}`,
  source: 'host',
}))

async function mount({ entries = [], total = 0, unread } = {}) {
  const runtime = hooks()
  const report = {
    entries,
    total,
    ...(unread === undefined ? {} : { unread }),
    markdown: '# diagnostics',
    issuesUrl: 'https://github.com/ThinkFlowLab/FlyBot/issues/new',
  }
  const actions = {
    diagnostics: () => Promise.resolve(report),
    diagnosticsLog: () => Promise.resolve(''),
    diagnosticsClear: () => Promise.resolve(),
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
  const deepText = (node) => all(node).map(part => text(part)).filter(Boolean).join(' ')
  const heading = () => all(tree).find(node => node.type === 'h3' && text(node).startsWith('Recent errors'))
  const rows = () => all(tree).filter(node => node.props?.className === 'bt-set-row bt-fb-entry')
  const emptyRow = () => all(tree).find(node => node.props?.className === 'bt-set-row'
    && deepText(node).startsWith('No errors recorded.'))
  return {
    get tree() { return tree },
    get rows() { return rows() },
    emptyRow,
    title: () => text(heading()),
    deepText: (node = tree) => deepText(node),
  }
}

// RED today: the report says the log could not be read, and the page still says there is nothing to read.
test('P-687: an unread error log is named instead of reading as "No errors recorded."', async () => {
  const page = await mount({ entries: [], total: 0, unread: 'EACCES' })
  assert.equal(page.title(), 'Recent errors · 0', 'the title keeps the true count, not a guess')
  assert.doesNotMatch(page.deepText(), /No errors recorded\./, `the empty state claims a clean log: ${page.deepText()}`)
  assert.match(page.deepText(), /EACCES/, 'the reason the log could not be read is named')
  assert.match(page.deepText(), /not shown|missing/i, 'the sentence says the errors it holds are not in the list')
})

// GREEN today, must stay: no `unread` field, no change — an empty log still reads as an empty log.
test('P-687 guard: a readable empty log keeps its sentence', async () => {
  const page = await mount({ entries: [], total: 0 })
  assert.equal(page.title(), 'Recent errors · 0')
  assert.equal(page.deepText(page.emptyRow()), 'No errors recorded. Failed model calls and FlyBot problems show here, newest first.')
})

// GREEN today, must stay: rows the report does carry are drawn as before; `unread` changes only the
// empty state, so a report with browser errors and an unread host log does not hide its rows.
test('P-687 guard: an unread log does not replace rows that are there', async () => {
  const page = await mount({ entries: errorEntries(3), total: 3, unread: 'EACCES' })
  assert.equal(page.rows.length, 3)
  assert.doesNotMatch(page.deepText(), /EACCES/, 'the notice belongs to the empty state only')
})
