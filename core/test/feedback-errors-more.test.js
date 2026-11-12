// #2266: the Feedback page's error list reported the whole count in its title
// (`Recent errors · 60`) while drawing eight rows and offering nothing to reach the rest,
// so a person reading a burst of failures could not see the ninth error at all. The list
// now draws the first eight and a `Show more` control that expands it to every loaded row,
// with `Show less` folding it back; a report of eight or fewer errors keeps the list and
// the title exactly as they were, and the control is not drawn.
//
// This test runs the real hooks: `useState` below re-renders the page, `useEffect` runs the
// report load, and a click is the control's own `onClick`. A `useEffect() {}` stub would
// never show the list filling in.
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

// A tiny hooks runtime: state slots survive re-renders, setters mark the tree dirty, and
// effects run after the tree is committed (and only when their deps change).
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

// The host read caps its payload at fifty entries while `total` counts the whole log, so a
// sixty-error log arrives as fifty rows and a total of sixty — the shape the probe showed.
async function mount({ entries, total } = {}) {
  const runtime = hooks()
  const report = {
    entries,
    total,
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

  // The renderer's one job: call the function components (Section, Row) the page hands
  // its children to, so the drawn tree is what the browser would get.
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
  const find = predicate => all(tree).find(predicate)
  const rows = () => all(tree).filter(node => node.props?.className === 'bt-set-row bt-fb-entry')
  const more = () => find(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('bt-fb-more'))
  const count = () => find(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('bt-fb-count'))
  const text = (node) => [node?.props?.children].flat(Infinity).filter(child => typeof child === 'string' || typeof child === 'number').join('')
  const deepText = (node) => all(node).map(part => text(part)).filter(Boolean).join(' ')
  const heading = () => find(node => node.type === 'h3' && text(node).startsWith('Recent errors'))
  return {
    get rows() { return rows() },
    get more() { return more() },
    get count() { return count() },
    get heading() { return heading() },
    text, deepText,
    title: () => text(heading()),
    countText: () => text(count()),
    async click() { more().props.onClick({}); await settle() },
  }
}

test('#2266: a sixty-error report draws eight rows and offers the rest', async () => {
  const page = await mount({ entries: errorEntries(50), total: 60 })
  assert.equal(page.title(), 'Recent errors · 60', 'the title still reports the whole log')
  assert.equal(page.rows.length, 8, 'the list still opens with eight rows')
  assert.ok(page.more, 'the list offers a way to see the remaining errors')
  assert.equal(page.more.props['aria-expanded'], false, 'the control says the rest is not drawn yet')
  assert.equal(page.text(page.more).trim(), 'Show more')
})

test('#2266: Show more draws the errors past the eighth, and Show less folds them back', async () => {
  const page = await mount({ entries: errorEntries(50), total: 60 })
  await page.click()
  assert.equal(page.rows.length, 50, 'every loaded error is drawn after the click')
  const texts = page.rows.map(row => page.deepText(row))
  assert.ok(texts.some(value => value.includes('failure number 9')), 'the ninth error is reachable')
  assert.equal(page.more.props['aria-expanded'], true)
  assert.equal(page.text(page.more).trim(), 'Show less')
  await page.click()
  assert.equal(page.rows.length, 8, 'Show less folds the list back to eight rows')
  assert.equal(page.text(page.more).trim(), 'Show more')
})

test('#2266: eight or fewer errors draw no control and keep the title as it was', async () => {
  const page = await mount({ entries: errorEntries(3), total: 3 })
  assert.equal(page.title(), 'Recent errors · 3')
  assert.equal(page.rows.length, 3)
  assert.equal(page.more, undefined, 'nothing to expand means no control')

  const exact = await mount({ entries: errorEntries(8), total: 8 })
  assert.equal(exact.title(), 'Recent errors · 8')
  assert.equal(exact.rows.length, 8)
  assert.equal(exact.more, undefined, 'exactly eight rows are all drawn, so no control')
})

// #2884: `Show more` was an unlabelled way out — a reader with more than eight errors
// could not tell whether the list was cut or complete from the page itself, and wrote
// bug reports from the eight rows it showed. The control row now carries the count of
// what is drawn against what is loaded: `Showing 8 of 50` while folded, `Showing all 50`
// once open. A report of eight or fewer rows draws neither, exactly as before.
test('#2884: a list cut at eight rows says how many rows of how many it draws', async () => {
  const page = await mount({ entries: errorEntries(50), total: 60 })
  assert.equal(page.countText(), 'Showing 8 of 50', 'the folded list says it is drawing eight of the fifty rows it holds')
  assert.equal(page.text(page.more).trim(), 'Show more')
  await page.click()
  assert.equal(page.countText(), 'Showing all 50', 'open, the panel says every loaded row is drawn')
  assert.equal(page.rows.length, 50)
  await page.click()
  assert.equal(page.countText(), 'Showing 8 of 50', 'folded again, the count returns to eight')
})

test('#2884: eight or fewer rows draw no count line', async () => {
  const page = await mount({ entries: errorEntries(8), total: 8 })
  assert.equal(page.count, undefined, 'nothing is hidden, so nothing counts it')
  assert.equal(page.rows.length, 8)
})
