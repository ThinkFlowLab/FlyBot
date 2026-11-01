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
    contents: "export { SchedulesPage, BotSchedules, ScheduleSummary, CopyRow, openPlugins, formStart, timingText } from './src/client/schedules.js'",
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
const { SchedulesPage, BotSchedules, ScheduleSummary, CopyRow, openPlugins, formStart, timingText } = module.exports
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

// #1651 (P-132): an interval that is not a whole number of minutes was shown rounded and
// then saved rounded, so editing only the title rewrote it. Seconds are stated as seconds.
const EVERY = (seconds, extra = {}) => ({ id: `e${seconds}`, sessionId: 'chat-b1', botId: 'b1', title: `Task ${seconds}`, prompt: 'Ping', kind: 'every', everySeconds: seconds, scheduledAt: '2030-01-01T01:00:00.000Z', status: 'active', ...extra })

test('a repeat that is not a whole number of minutes reads as seconds, not rounded (#1651 a, c)', () => {
  seeded.push({ available: true, tasks: [90, 100, 61, 3601].map(seconds => EVERY(seconds)) }, null)
  const card = render(BotSchedules({ bot: { id: 'b1' }, roster: ROSTER, actions: spy() }))
  const lines = text(card)
  for (const [seconds, want] of [[90, 'Every 90 seconds'], [100, 'Every 100 seconds'], [61, 'Every 61 seconds'], [3601, 'Every 3601 seconds']]) {
    assert.ok(lines.includes(want), `${seconds}s: ${lines.join(' | ')}`)
  }
  assert.ok(!lines.includes('Every 1 minutes'), lines.join(' | '))
})

test('whole-minute and whole-hour repeats keep the words they had (#1651 d)', () => {
  for (const [seconds, want] of [[60, 'Every 1 minutes'], [5400, 'Every 90 minutes'], [3600, 'Every hour'], [7200, 'Every 2 hours'], [86400, 'Every day'], [172800, 'Every 2 days']]) {
    assert.equal(timingText(EVERY(seconds)), want, `${seconds}s`)
  }
})

test('the edit form holds a non-whole-minute interval exactly (#1651 a)', () => {
  for (const seconds of [90, 100, 61, 3601]) {
    const start = formStart(EVERY(seconds))
    assert.deepEqual([start.kind, start.count, start.unit], ['every', seconds, 'seconds'], `${seconds}s`)
  }
  assert.deepEqual([formStart(EVERY(5400)).count, formStart(EVERY(5400)).unit], [90, 'minutes'])
})

test('editing only the title sends the stored repeat back unchanged (#1651 a, b)', async () => {
  const sent = []
  const actions = { ...spy(), scheduleUpdate: async (task) => { sent.push(task); return OFF } }
  const task = EVERY(90, { title: 'Ping' })
  seeded.push({ available: true, tasks: [task] }, task)
  const card = render(BotSchedules({ bot: { id: 'b1' }, roster: ROSTER, actions }))
  const form = all(card).find(node => node.type === 'form')
  assert.ok(form, 'the edited row is a form')
  const count = all(form).find(node => node.type === 'input' && node.props['aria-label'] === 'How many')
  assert.equal(count.props.value, 90)
  const unit = all(form).find(node => node.type === 'select' && node.props['aria-label'] === 'Unit')
  assert.equal(unit.props.value, 'seconds')
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ sessionId: 'chat-b1', id: 'e90', target: 'b1', title: 'Ping', prompt: 'Ping', when: { kind: 'every', seconds: 90 } }])
})

test('a row says how its last run went; only a failed run offers Retry, which runs the task now (#473)', async () => {
  const calls = []
  const actions = { ...spy(), scheduleRetry: async (...args) => { calls.push(['retry', ...args]); return OFF } }
  const at = new Date(2030, 0, 2, 9, 0).getTime()
  const failed = { ...ACTIVE, lastRun: { at, result: 'failed', reason: 'SERVER 503: upstream busy' } }
  const ran = { ...ACTIVE, id: 's3', lastRun: { at, result: 'ran' } }
  const missed = { ...PAUSED, lastRun: { at, result: 'failed', reason: 'DSH could not deliver it' } }
  seeded.push({ available: true, tasks: [failed, ran, missed] }, null)
  const card = render(BotSchedules({ bot: { id: 'b1' }, roster: ROSTER, actions }))
  const lines = text(card)
  assert.ok(lines.some(line => /^Last run .+ · Failed: SERVER 503: upstream busy$/.test(line)), lines.join('|'))
  assert.ok(lines.some(line => /^Last run [^·]+$/.test(line)))
  const retries = buttonsOf(card).filter(button => text(button).includes('Retry'))
  assert.equal(retries.length, 1, 'a ran task and a paused one have no Retry')
  retries[0].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['retry', 'chat-b1', 's1']])
})

// Quiet hours (#1166): a window checked when a task is created or edited, not a mute.
const QUIET = { on: true, from: '22:00', to: '07:00' }

test('with quiet hours off the page says Off and offers to turn them on (#1166)', () => {
  seeded.push({ available: true, tasks: [], quietHours: { on: false } })
  const page = render(SchedulesPage({ roster: ROSTER, actions: spy(), start: null }))
  const lines = text(page)
  assert.ok(lines.includes('Off'), lines.join('|'))
  assert.ok(lines.includes('Turn on'))
  assert.ok(!lines.some(line => /^On, /.test(line)))
  assert.ok(!lines.some(line => /still run inside quiet hours/.test(line)))
  assert.ok(lines.includes('A new or edited task cannot be due inside the window. It never mutes a task that already exists.'))
})

test('with quiet hours on the page shows the window, and a repeat task says it is not checked (#1166)', () => {
  seeded.push({ available: true, tasks: [{ ...ACTIVE, kind: 'every', everySeconds: 3600 }], quietHours: QUIET, quietUnchecked: true })
  const page = render(SchedulesPage({ roster: ROSTER, actions: spy(), start: null }))
  const lines = text(page)
  assert.ok(lines.includes('On, 22:00–07:00'), lines.join('|'))
  assert.ok(lines.includes('Turn off'))
  assert.equal(all(page).filter(node => node.type === 'input' && node.props.type === 'time').length, 2, 'the window has a start and an end')
  const hint = lines.find(line => /still run inside quiet hours/.test(line))
  assert.ok(hint, 'the marker is rendered, not kept silently')
  assert.ok(!lines.some(line => /suppressed count|Suppressed: \d+/i.test(line)), 'no suppression count: that half is DSH\'s')
})

test('turning quiet hours on saves the default window as the settings write (#1166)', async () => {
  const sent = []
  const actions = { ...spy(), setPrefs: async (prefs) => { sent.push(prefs); return {} } }
  seeded.push({ available: true, tasks: [], quietHours: { on: false } })
  const page = render(SchedulesPage({ roster: ROSTER, actions, start: null }))
  const on = buttonsOf(page).find(button => text(button).includes('Turn on'))
  assert.ok(on)
  on.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ quietHours: { on: true, from: '22:00', to: '07:00' } }])
})

test('a once task sends its zone, so the host reads its wall clock (#1166)', async () => {
  const sent = []
  const actions = { ...spy(), scheduleUpdate: async (task) => { sent.push(task); return OFF } }
  const once = { ...ACTIVE, kind: 'at', scheduledAt: '2030-01-02T07:05:00.000Z' }
  seeded.push({ available: true, tasks: [once], quietHours: QUIET }, once)
  const card = render(BotSchedules({ bot: { id: 'b1' }, roster: ROSTER, actions }))
  const form = all(card).find(node => node.type === 'form')
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  const [when] = JSON.parse(JSON.stringify(sent)).map(task => task.when)
  assert.equal(when.kind, 'at')
  assert.equal(typeof when.timeZone, 'string')
  assert.notEqual(when.timeZone, '')
})

test('the repeat-task warning is the view flag, not the page scanning its tasks (#1199)', () => {
  // The realistic drift: a repeat task was deleted between two polls, so the list says nothing while
  // the host's flag still does. The page renders the host's line, not a line of its own.
  seeded.push({ available: true, tasks: [{ ...ACTIVE }], quietHours: QUIET, quietUnchecked: true })
  const flagged = text(render(SchedulesPage({ roster: ROSTER, actions: spy(), start: null })))
  assert.ok(flagged.some(line => /still run inside quiet hours/.test(line)), 'the view flag alone renders the line')
  // The other way: a repeat task in the list is not the page's business. Without the flag the host made
  // no uncheckable-rule claim, so the page says nothing.
  seeded.push({ available: true, tasks: [{ ...ACTIVE, kind: 'every', everySeconds: 3600 }], quietHours: QUIET })
  const plain = text(render(SchedulesPage({ roster: ROSTER, actions: spy(), start: null })))
  assert.ok(!plain.some(line => /still run inside quiet hours/.test(line)), 'a repeat task alone is not a claim')
})

test('after the quiet-hours write the page reads the host view again, not a predicted flag (#1199)', async () => {
  let asked = 0
  const actions = {
    ...spy(),
    setPrefs: async () => ({}),
    schedules: async () => { asked += 1; return { available: true, tasks: [{ ...ACTIVE, kind: 'every', everySeconds: 3600 }], quietHours: QUIET, quietUnchecked: true } },
  }
  seeded.push({ available: true, tasks: [], quietHours: { on: false } })
  const page = render(SchedulesPage({ roster: ROSTER, actions, start: null }))
  const on = buttonsOf(page).find(button => text(button).includes('Turn on'))
  assert.ok(on)
  on.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(asked >= 1, 'the flag is asked for again, so the line appears now and not at the next 30-second poll')
})

test('the quiet-hours copy has Chinese entries, including the refusal with the window end (#1166)', () => {
  const source = readFileSync(new URL('../src/client/i18n.js', import.meta.url), 'utf8')
  assert.match(source, /'Quiet hours': '安静时段'/)
  assert.match(source, /'Quiet hours start': '安静时段开始'/)
  assert.match(source, /Quiet hours are on until \(\\d\\d:\\d\\d\)/)
  assert.match(source, /安静时段到 \$1 结束/)
})

// #1287: a row copies its task to another Bot or group chat. The picker offers only the
// other chats, and the copy is the one `schedule-create` call with `copyFrom` — no new
// endpoint, no new state.
const OTHERS = { bots: [{ id: 'b1', name: 'B' }, { id: 'b2', name: 'Writer' }], rooms: [{ id: 'g1', name: 'Launch' }], byId: {}, roomsById: {} }

test('Copy asks for another chat and posts schedule-create with copyFrom (#1287)', async () => {
  const sent = []
  const actions = { ...spy(), scheduleCreate: async (task) => { sent.push(task); return OFF } }
  seeded.push('b2')
  const form = render(h(CopyRow, { task: ACTIVE, roster: OTHERS, actions, onView() {}, onCancel() {} }))
  const select = all(form).find(node => node.type === 'select')
  assert.ok(select, 'the form has the target picker')
  assert.deepEqual(all(select).filter(node => node.type === 'option').map(node => node.props.value), ['', 'b2', 'g1'], 'the row’s own chat is not offered')
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ target: 'b2', copyFrom: { sessionId: 'chat-b1', id: 's1' } }])
})

// #1322: the picker opens on its placeholder, not on the first other chat — `others[0]` is roster
// order, so the old opening state made one click on Copy send the task to whichever Bot sorted
// first. A person has to pick a target; a submit without one sends nothing.
test('the copy picker opens with no target chosen, so one click cannot send it (#1322)', async () => {
  const sent = []
  const actions = { ...spy(), scheduleCreate: async (task) => { sent.push(task); return OFF } }
  const form = render(h(CopyRow, { task: ACTIVE, roster: OTHERS, actions, onView() {}, onCancel() {} }))
  const select = all(form).find(node => node.type === 'select')
  assert.equal(select.props.value, '', 'the placeholder is the opening choice, never the first other chat')
  const copy = buttonsOf(form).find(button => text(button).includes('Copy'))
  assert.equal(copy.props.disabled, true, 'Copy is disabled until a target is picked')
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent, [], 'submitting with no target sends nothing')
  // The target a person picked is the one sent, and only that chat.
  seeded.push('g1')
  const picked = render(h(CopyRow, { task: ACTIVE, roster: OTHERS, actions, onView() {}, onCancel() {} }))
  picked.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ target: 'g1', copyFrom: { sessionId: 'chat-b1', id: 's1' } }])
})

// #1334: the new-task form opens with no Bot chosen — `roster.bots[0]` is roster order, so the
// old opening state created the task for whichever Bot sorted first on one click. A person has to
// pick a target; a submit without one sends nothing.
test('the new-task form opens with no target chosen, so one click cannot create it (#1334)', async () => {
  const sent = []
  const actions = { ...spy(), scheduleCreate: async (task) => { sent.push(task); return OFF } }
  // The shim hands states out in hook order: the page's view, `adding` (the form is open),
  // `editing`, then QuietHoursCard's four. The form's own target is left unseeded on purpose —
  // this reads the state the form really opens with.
  seeded.push({ available: true, tasks: [] }, true, null, false, '', '22:00', '07:00')
  const page = render(SchedulesPage({ roster: OTHERS, actions, start: null }))
  const form = all(page).find(node => node.type === 'form')
  assert.ok(form, 'the new-task form is open')
  const select = all(form).find(node => node.type === 'select')
  assert.equal(select.props.value, '', 'the placeholder is the opening choice, never the first Bot')
  const first = all(select).filter(node => node.type === 'option')[0]
  assert.equal(first.props.value, '', 'the first option is the placeholder')
  assert.deepEqual(text(first), ['Pick a Bot or group chat'])
  const create = buttonsOf(form).find(button => text(button).includes('Create task'))
  assert.equal(create.props.disabled, true, 'Create is disabled until a target is picked')
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent, [], 'submitting with no target sends nothing')
  // The target a person picked is the one sent, with the rest of the form's values.
  seeded.push({ available: true, tasks: [] }, true, null, false, '', '22:00', '07:00', 'g1', 'Briefing', 'Sum up')
  const picked = render(SchedulesPage({ roster: OTHERS, actions, start: null }))
  all(picked).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.length, 1)
  assert.deepEqual([sent[0].target, sent[0].title, sent[0].prompt, sent[0].when.kind], ['g1', 'Briefing', 'Sum up', 'daily'])
})

test('a task row offers Copy (#1287)', () => {
  seeded.push({ available: true, tasks: [ACTIVE] }, null)
  const card = render(BotSchedules({ bot: { id: 'b1' }, roster: OTHERS, actions: { ...spy(), scheduleCreate: async () => OFF } }))
  const copy = buttonsOf(card).find(button => button.props['aria-label'] === 'Copy to another Bot or group chat')
  assert.ok(copy, 'the row offers Copy')
  assert.deepEqual(text(copy), [], 'an icon button, like Edit')
})


// #2024: the details panel's scheduled block and the settings page contradicted each other for
// the same Bot. The block kept only `status === 'active'` rows, so a Bot whose tasks were all
// paused fell into the empty branch — "No scheduled tasks yet. Add one", whose button opens the
// new-task form — and its rows never said when the next run is.
const opened = () => {
  const calls = []
  return { calls, openSettings: (...args) => calls.push(args), closeSettings() {}, selectPanel() {} }
}

test('#2024: a Bot whose tasks are all paused lists them, and the add-one empty state is gone', () => {
  const actions = opened()
  seeded.push({ available: true, tasks: [PAUSED, { ...PAUSED, id: 's3', title: 'Third' }, { ...PAUSED, id: 's4', title: 'Fourth' }] })
  const card = render(ScheduleSummary({ bot: { id: 'b1' }, actions }))
  const lines = text(card)
  assert.equal(lines.filter(line => line === 'Paused').length, 3, lines.join('|'))
  assert.ok(!lines.some(line => /No scheduled tasks yet/.test(line)), lines.join('|'))
  const rows = buttonsOf(card).filter(button => button.props.className === 'bt-task-line')
  assert.equal(rows.length, 3, 'three rows, not the empty state')
  rows[0].props.onClick()
  assert.deepEqual(actions.calls, [['schedules']], 'a row opens the settings list, not the new-task form')
})

test('#2024: each row answers when — Next: …, Paused, Finished', () => {
  const actions = opened()
  seeded.push({ available: true, tasks: [ACTIVE, PAUSED, { ...PAUSED, id: 's5', title: 'Done', status: 'finished' }] })
  const card = render(ScheduleSummary({ bot: { id: 'b1' }, actions }))
  const lines = text(card)
  const when = lines.filter(line => /^Next: \S/.test(line) || line === 'Paused' || line === 'Finished')
  assert.equal(when.length, 3, lines.join('|'))
  assert.ok(when.some(line => /^Next: \S/.test(line)), 'the active task says when its next run is')
  assert.ok(when.includes('Paused'), 'the paused one says so')
  assert.ok(when.includes('Finished'), 'the finished one says so')
  assert.ok(!lines.some(line => line.startsWith('Every day at')), 'the repeat rule alone does not answer when')
})

test('#2024: a missing or malformed scheduledAt renders without throwing', () => {
  const actions = opened()
  seeded.push({ available: true, tasks: [
    { ...ACTIVE, id: 'd1', title: 'No instant', scheduledAt: undefined },
    { ...ACTIVE, id: 'd2', title: 'Bad instant', scheduledAt: 'not-a-date' },
    { ...ACTIVE, id: 'd3', title: 'Bad once', kind: 'at', scheduledAt: 'not-a-date' },
  ] })
  let card
  assert.doesNotThrow(() => { card = render(ScheduleSummary({ bot: { id: 'b1' }, actions })) })
  const rows = buttonsOf(card).filter(button => button.props.className === 'bt-task-line')
  assert.equal(rows.length, 3, 'the rows are still drawn')
  assert.ok(!text(card).some(line => /Invalid/.test(line)), text(card).join('|'))
  assert.doesNotThrow(() => timingText({ kind: 'at', scheduledAt: 'not-a-date' }))
})

test('#2024: a Bot with no tasks at all keeps the empty state and its add button', () => {
  const actions = opened()
  seeded.push({ available: true, tasks: [] })
  const card = render(ScheduleSummary({ bot: { id: 'b1' }, actions }))
  assert.ok(text(card).includes('No scheduled tasks yet. Add one'), text(card).join('|'))
  const button = buttonsOf(card)[0]
  assert.equal(button.props.className, 'bt-more')
  button.props.onClick()
  assert.deepEqual(actions.calls, [['schedules', 'b1']], 'only the empty state opens the new-task form')
})
