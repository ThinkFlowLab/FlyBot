import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The "Automation tasks are off" hint and its button send people to DSH's Plugins panel,
// where the switch is; the Harness settings dialog has none.
const { outputFiles } = await build({
  stdin: {
    contents: "export { SchedulesPage, BotSchedules, openPlugins } from './src/client/schedules.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const OFF = { available: false, tasks: [] }
const react = { createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [v === null ? OFF : v, () => {}], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
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
const { SchedulesPage, BotSchedules, openPlugins } = module.exports
// Every node and string under a tree; an array (what a page returns) is walked too.
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (typeof node === 'string') out.push(node)
  else if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const text = node => all(node).filter(item => typeof item === 'string')
const spy = () => {
  const log = []
  return { log, closeSettings: () => log.push('closeSettings'), selectPanel: id => log.push(`selectPanel ${id}`), openSettings: () => log.push('openSettings') }
}
const buttonsOf = tree => all(tree).filter(node => node.type === 'button')

test('openPlugins closes the Settings dialog first, then opens the Plugins panel', () => {
  const actions = spy()
  openPlugins(actions)
  assert.deepEqual(actions.log, ['closeSettings', 'selectPanel plugins'])
})

test('Settings → Scheduled tasks, with Automation tasks off, has one button and it opens Plugins', () => {
  const actions = spy()
  const element = SchedulesPage({ roster: { bots: [], rooms: [] }, actions, start: null })
  const page = element.type(element.props)
  const buttons = buttonsOf(page)
  assert.equal(buttons.length, 1)
  assert.deepEqual(text(buttons[0]), ['Open Plugins'])
  buttons[0].props.onClick()
  assert.deepEqual(actions.log, ['closeSettings', 'selectPanel plugins'])
  assert.ok(text(page).includes('Switch on Automation tasks on the Plugins page.'))
  assert.ok(!text(page).some(line => /Harness settings/.test(line)))
})

test("a Bot's Scheduled tasks card, with Automation tasks off, opens Plugins too", () => {
  const actions = spy()
  const card = BotSchedules({ bot: { id: 'b1' }, roster: { bots: [], rooms: [] }, actions })
  const buttons = buttonsOf(card)
  assert.equal(buttons.length, 1)
  assert.deepEqual(text(buttons[0]), ['Open Plugins'])
  buttons[0].props.onClick()
  assert.deepEqual(actions.log, ['closeSettings', 'selectPanel plugins'])
})

test('the hint reads the same in English and Chinese, and says Plugins page, not Harness settings', () => {
  const source = readFileSync(new URL('../src/client/i18n.js', import.meta.url), 'utf8')
  assert.match(source, /'Switch on Automation tasks on the Plugins page\.': '在「插件」页面打开「自动化任务」。'/)
  assert.match(source, /'Open Plugins': /)
  assert.doesNotMatch(source, /Automation tasks on the Plugins page in Harness settings/)
  assert.doesNotMatch(readFileSync(new URL('../src/client/schedules.js', import.meta.url), 'utf8'), /openHarnessSettings|Open Harness settings/)
})
