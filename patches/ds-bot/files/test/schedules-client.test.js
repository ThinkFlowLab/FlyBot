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
    contents: "export { SchedulesPage, BotSchedules, openPlugins, formStart } from './src/client/schedules.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const OFF = { available: false, tasks: [] }
// States handed out in order before the defaults, to render a page with tasks or a row being edited.
const seeded = []
const react = { createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [seeded.length > 0 ? seeded.shift() : v === null ? OFF : v, () => {}], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
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
const { SchedulesPage, BotSchedules, openPlugins, formStart } = module.exports
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

// Function components expanded, so their rows and buttons can be read.
const render = (node) => {
  if (Array.isArray(node)) return node.map(render)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, props: { ...node.props, children: render(node.props?.children) } }
}
const ACTIVE = { id: 's1', sessionId: 'chat-b1', botId: 'b1', title: 'Briefing', prompt: 'Sum up', kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai', scheduledAt: '2030-01-01T01:00:00.000Z', status: 'active' }
const PAUSED = { id: 's2', sessionId: 'chat-b1', botId: 'b1', title: 'Weekly', prompt: 'Plan', kind: 'every', everySeconds: 7200, status: 'paused' }
const ROSTER = { bots: [{ id: 'b1', name: 'B' }], rooms: [], byId: {}, roomsById: {} }

test("a task row offers Edit and Pause; a paused one reads Paused and offers Resume (#354)", async () => {
  const calls = []
  const actions = { ...spy(), schedulePause: async (...args) => { calls.push(['pause', ...args]); return OFF }, scheduleResume: async (...args) => { calls.push(['resume', ...args]); return OFF } }
  seeded.push({ available: true, tasks: [ACTIVE, PAUSED] }, null)
  const card = render(BotSchedules({ bot: { id: 'b1' }, roster: ROSTER, actions }))
  const lines = text(card)
  assert.ok(lines.includes('Paused'))
  const buttons = buttonsOf(card)
  assert.equal(buttons.filter(button => button.props['aria-label'] === 'Edit').length, 2)
  const pause = buttons.find(button => text(button).includes('Pause'))
  const resume = buttons.find(button => text(button).includes('Resume'))
  pause.props.onClick()
  resume.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['pause', 'chat-b1', 's1'], ['resume', 'chat-b1', 's2']])
})

test('Edit opens the task form filled in, and saving updates that task (#354)', async () => {
  const sent = []
  const actions = { ...spy(), scheduleUpdate: async (task) => { sent.push(task); return OFF } }
  seeded.push({ available: true, tasks: [ACTIVE, PAUSED] }, ACTIVE)
  const card = render(BotSchedules({ bot: { id: 'b1' }, roster: ROSTER, actions }))
  const form = all(card).find(node => node.type === 'form')
  assert.ok(form, 'the edited row is a form')
  assert.ok(all(form).some(node => node.type === 'input' && node.props.value === 'Briefing'))
  assert.ok(all(form).some(node => node.type === 'textarea' && node.props.value === 'Sum up'))
  assert.ok(text(form).includes('Save changes'))
  assert.equal(all(card).filter(node => node.type === 'form').length, 1)
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ sessionId: 'chat-b1', id: 's1', target: 'b1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }])
})

test('the form starts from the edited task: repeat interval, one time, cron kept', () => {
  assert.deepEqual([formStart(PAUSED).kind, formStart(PAUSED).count, formStart(PAUSED).unit], ['every', 2, 'hours'])
  assert.deepEqual([formStart({ kind: 'every', everySeconds: 2 * 86400 }).count, formStart({ kind: 'every', everySeconds: 2 * 86400 }).unit], [2, 'days'])
  const once = formStart({ kind: 'at', scheduledAt: new Date(2030, 0, 2, 7, 5).toISOString() })
  assert.deepEqual([once.kind, once.at], ['at', '2030-01-02T07:05'])
  assert.equal(formStart({ kind: 'cron', expression: '0 9 * * 1', timeZone: 'UTC' }).kind, 'cron')
  assert.deepEqual([formStart(undefined).kind, formStart(undefined).title, formStart(undefined).time], ['daily', '', '09:00'])
})
