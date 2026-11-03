import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// P-457: composer.js "+" menu → "Scheduled task" reaches
// openSettings('schedules', target), which a read-only window must not offer — the settings list
// asks for the create form and a locked page draws none (#2232).

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/client/composer.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const LOCK = 'Another FlyBot window has this home open; this window is read-only.'
const seeded = []
const react = {
  createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {},
  useState: v => [seeded.length > 0 ? seeded.shift() : v, () => {}],
  useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f,
  useSyncExternalStore: (_s, get) => get(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame: run => run(),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { ComposerPlus } = module.exports

const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (typeof node === 'string') out.push(node)
  else if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
// The menu is open already: useState hands out the position, useLinger keeps it as `kept`.
const render = (roster) => {
  seeded.length = 0
  seeded.push({ left: 0, bottom: 0 }, null)
  const actions = { log: [], openSettings: (...args) => actions.log.push(args) }
  const element = ComposerPlus({
    sessionId: 's1',
    inputActions: { captureInsertion: () => 'insert' },
    useRoster: select => select(roster),
    actions: { ...actions, canReferenceChat: () => true, referenceChat: () => {} },
  })
  return { tree: element, actions }
}
const menuRows = tree => all(tree).filter(node => node?.props?.role === 'menuitem')

const WRITABLE = { bots: [], rooms: [], byId: { s1: { id: 'b1' } }, roomsById: {}, readOnly: '' }
const LOCKED = { ...WRITABLE, readOnly: LOCK }

test('writable window: the "+" menu offers Scheduled task and it opens the schedules page for the chat', () => {
  const { tree, actions } = render(WRITABLE)
  const rows = menuRows(tree).map(row => all(row).filter(item => typeof item === 'string').join(''))
  assert.ok(rows.includes('Scheduled task'), `rows: ${JSON.stringify(rows)}`)
  menuRows(tree).find(row => all(row).includes('Scheduled task')).props.onClick()
  assert.deepEqual(actions.log, [['schedules', 'b1']])
})

test('read-only window: no menu row opens the schedules page', () => {
  const { tree, actions } = render(LOCKED)
  const rows = menuRows(tree).map(row => all(row).filter(item => typeof item === 'string').join(''))
  assert.ok(!rows.includes('Scheduled task'), `a read-only window still offers the row: ${JSON.stringify(rows)}`)
  const scheduleRows = menuRows(tree).filter(row => all(row).includes('Scheduled task'))
  for (const row of scheduleRows) row.props.onClick()
  assert.deepEqual(actions.log, [])
  assert.deepEqual(scheduleRows.map(row => all(row).filter(item => typeof item === 'string').join('')), [])
})
