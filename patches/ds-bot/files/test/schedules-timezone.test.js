// #3110: a scheduled task's rule is a wall clock in a zone. The form had no zone control, so
// "Every day at 09:00" always meant this device's zone, and the zone an already stored task keeps
// (the row prints it: `Every day at 09:00 (Asia/Tokyo)`) was invisible in the one place that edits
// it. A Once task is the same problem in the other direction: its `datetime-local` is a wall clock,
// and reading it in the device's zone stores an instant hours away from the zone the form shows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The component tree is built with the same shim `schedules-client.test.js` uses: a hook runtime
// that hands out the states a test seeds, in hook order, and never re-renders.
const { outputFiles } = await build({
  stdin: {
    // A star re-export keeps a missing name a runtime `undefined` in one test instead of a build
    // failure that would hide which case is red (#2039).
    contents: "export * from './src/client/schedules.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const OFF = { available: false, tasks: [] }
const seeded = []
const sets = []
const react = { createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [seeded.length > 0 ? seeded.shift() : v === null ? OFF : v, next => { sets.push(next) }], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
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
const { SchedulesPage, BotSchedules, timingText, formStart, whenFromForm, wallClockInput, instantFromWallClock } = module.exports

// Every node and string under a tree; an array (what a page returns) is walked too.
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (typeof node === 'string') out.push(node)
  else if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const text = node => all(node).filter(item => typeof item === 'string')
const render = (node) => {
  if (Array.isArray(node)) return node.map(render)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, props: { ...node.props, children: render(node.props?.children) } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const spy = () => {
  const log = []
  return { log, closeSettings: () => log.push('closeSettings'), selectPanel: id => log.push(`selectPanel ${id}`), openSettings: () => log.push('openSettings') }
}

const ACTIVE = { id: 's1', sessionId: 'chat-b1', botId: 'b1', title: 'Briefing', prompt: 'Sum up', kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai', scheduledAt: '2030-01-01T01:00:00.000Z', status: 'active' }
const ROSTER = { bots: [{ id: 'b1', name: 'B' }], rooms: [], byId: {}, roomsById: {} }
// This device's zone: the form's default, and the value the stored task does NOT use.
const device = Intl.DateTimeFormat().resolvedOptions().timeZone
// The one control this cut adds, found the way a reader finds it: a labelled zone selector.
const zoneSelects = tree => all(tree).filter(node => node.type === 'select' && node.props['aria-label'] === 'Time zone')
const optionsOf = select => all(select).filter(node => node.type === 'option')

// The settings page's states, in the order the shim hands them out: the view, `adding`, `editing`,
// then the Quiet hours card's four, then the create form's own (the shape #1334's test documents).
const openNewTaskForm = (overrides = []) => {
  seeded.push({ available: true, tasks: [] }, true, null, false, '', '22:00', '07:00', 'b1', 'Briefing', 'Sum up', ...overrides)
  const page = render(SchedulesPage({ roster: ROSTER, actions: spy(), start: null }))
  return all(page).find(node => node.type === 'form')
}

test('#3110: the scheduled-task form draws a Time zone control for a rule that carries one, and none for a repeat interval', () => {
  const form = openNewTaskForm()
  assert.ok(form, 'the new-task form is open')
  const zone = zoneSelects(form)[0]
  assert.ok(zone, `the form draws no Time zone control: ${JSON.stringify(text(form))}`)
  assert.equal(zone.props['data-flybot'], 'task-timezone', 'the control is addressable as the zone selector')
  assert.equal(zone.props.value, device, 'a new task opens in this device\'s zone')
  const options = optionsOf(zone)
  assert.equal(options[0].props.value, device, 'the opening zone is listed first')
  assert.ok(options.length > 5, `the control offers IANA zones, saw ${options.length}`)
  // A repeat interval is a duration, not a wall clock: it carries no zone in DSH, so the form
  // must not pretend to send one.
  const repeat = openNewTaskForm(['every'])
  assert.ok(repeat, 'the repeat form is open')
  assert.equal(zoneSelects(repeat).length, 0, 'a repeat interval draws no zone control')
  assert.equal(zoneSelects(openNewTaskForm(['weekly'])).length, 1, 'a weekly rule keeps the control')
})

test('#3110: an edited daily task shows its own zone, saves it, and its row names the same zone', async () => {
  const sent = []
  const actions = { ...spy(), scheduleUpdate: async (task) => { sent.push(task); return OFF } }
  seeded.push({ available: true, tasks: [ACTIVE] }, ACTIVE)
  const card = render(BotSchedules({ bot: { id: 'b1' }, roster: ROSTER, actions }))
  const form = all(card).find(node => node.type === 'form')
  assert.ok(form, 'the edited row is a form')
  const zone = zoneSelects(form)[0]
  assert.ok(zone, 'the edit form names the zone its task keeps')
  assert.equal(zone.props.value, 'Asia/Shanghai', 'the form shows the task\'s zone, not this device\'s')
  assert.equal(optionsOf(zone)[0].props.value, 'Asia/Shanghai', 'a zone already on the task stays listed, and first')
  // The row and the form must agree about which 09:00 this is.
  const row = timingText(ACTIVE)
  assert.ok(row.includes('(Asia/Shanghai)'), `the row names the zone, saw ${row}`)
  form.props.onSubmit({ preventDefault() {} })
  await tick()
  const [saved] = JSON.parse(JSON.stringify(sent))
  assert.deepEqual(saved.when, { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' })
})

test('#3110: a Once task\'s wall clock is read in the form\'s zone, not this device\'s', () => {
  // A Once task is an instant built from a wall clock. With a zone control, that wall clock is the
  // one in the chosen zone: 07:05 in Tokyo is 22:05Z the day before, not 07:05Z.
  assert.equal(typeof instantFromWallClock, 'function', 'the form converts a wall clock in its zone')
  assert.equal(instantFromWallClock('2030-01-02T07:05', 'Asia/Tokyo'), '2030-01-01T22:05:00.000Z')
  assert.equal(wallClockInput(Date.parse('2030-01-01T22:05:00.000Z'), 'Asia/Tokyo'), '2030-01-02T07:05', 'editing it shows the same wall clock back')
  // The bundle answers from its own realm, so the payload is compared as plain data.
  const same = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(
    same(whenFromForm({ kind: 'at', at: '2030-01-02T07:05', time: '07:05', timeZone: 'Asia/Tokyo' })),
    { kind: 'at', at: '2030-01-01T22:05:00.000Z', timeZone: 'Asia/Tokyo' },
  )
  // A duration carries no zone, and a wall clock the zone skips (a DST gap) is refused rather than
  // silently moved to another hour.
  assert.deepEqual(same(whenFromForm({ kind: 'every', count: 2, unit: 'hours' })), { kind: 'every', seconds: 7200 })
  assert.throws(() => instantFromWallClock('2030-03-10T02:30', 'America/New_York'), /Pick a date and time/)
  // The form's own opening state reads a Once task in the zone it keeps, so opening Edit and
  // saving without touching the time does not move the task.
  const once = { ...ACTIVE, kind: 'at', timeZone: 'Asia/Tokyo', scheduledAt: '2030-01-01T22:05:00.000Z' }
  const start = formStart(once)
  assert.deepEqual(same([start.kind, start.at, start.timeZone]), ['at', '2030-01-02T07:05', 'Asia/Tokyo'])
})
