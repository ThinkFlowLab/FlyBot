// #3114 cut 21: the Face-to-face waiting room — the dialog's `waiting` step and the room
// overview's candidate card — drew its number, QR hint, roster heading, alone line, Enter chat,
// Leave question and mine badges as bare English, while the rest of the panel followed the
// window's language. `plugins/social/client.js` already carries `tr()`, so this pins the block: a
// zh window reads the dictionary's words, a host with no translator keeps today's English word for
// word, and the two i18n baselines lose the 19 pins. The copy is read out of the rendered tree.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { DICTIONARY } from '../../../core/src/client/i18n.js'

const zh = DICTIONARY.zh
// The language a window runs in, and a host with no translator at all: `tr()` then hands back the
// English it was given, so the two windows differ only in the copy the panel draws.
const translator = (text, params) => {
  const translated = Object.hasOwn(zh, text) ? zh[text] : String(text)
  return params ? translated.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : translated
}
const zhWindow = { t: translator, slots: { register: () => () => {} }, call: async () => ({}) }
const bareWindow = { slots: { register: () => () => {} }, call: async () => ({}) }

// The client is a classic script registering its factory on `window`, and the plugin reads
// `__flybot__` off the global object at render time — so the sandbox is that global object. The
// `useState` list is how a screen a click reaches (the waiting step) is drawn without a browser.
function loadApp(flybot) {
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: entry => registered.push(entry) } }, console, setTimeout, clearTimeout }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = flybot
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  const ui = { queue: [], at: 0, app: null }
  ui.app = registered[0].factory(() => ({
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'F', useEffect() {}, useRef: value => ({ current: value }), useMemo: fn => fn(), useCallback: fn => fn(),
    useState: () => [ui.queue[ui.at++], () => {}],
  }))
  return ui
}
// A component element is a function in `type`: it has to be called to see what it draws.
function walk(node, all = []) {
  if (!node || typeof node !== 'object') return all
  if (typeof node.type === 'function') return walk(node.type(node.props), all)
  all.push(node)
  for (const child of node.children ?? []) walk(child, all)
  return all
}
const draw = (ui, name, props = {}, queue = []) => { ui.queue = queue; ui.at = 0; return walk(ui.app[name](props)) }
const textsOf = nodes => nodes.flatMap(node => (node.children ?? []).filter(child => typeof child === 'string'))
const textAt = (nodes, id) => (nodes.find(node => node.props?.['data-flybot'] === id)?.children ?? []).filter(child => typeof child === 'string').join('')
const propAt = (nodes, id, prop) => nodes.find(node => node.props?.['data-flybot'] === id)?.props?.[prop]
const buttons = nodes => nodes.filter(node => node.type === 'button').map(node => node.children.join(''))
// One sentence as a person reads it: the dictionary's answer, or undefined while it is English.
function says(nodes, english) {
  const hit = textsOf(nodes).find(text => text === zh[english])
  assert.ok(hit, `expected ${hit} (${english}), saw ${JSON.stringify(textsOf(nodes))}`)
}
// The waiting step after a start or a join: one room of mine, six digits, nobody else in it yet. The dialog keeps its state in eleven hook slots, answered in this order by the stub's list.
const ROOM = {
  roomId: 'local1', faceRoomId: 'fr1', joinCode: '482913', status: 'open', mineHandles: ['@chief.home'],
  members: [{ id: 'b1', remote: false, handle: '@chief.home', name: 'Chief', ownerName: 'Ann' }],
}
// A candidate room is the same screen with a deadline, so it draws the QR next to the number.
const CANDIDATE = { ...ROOM, status: 'candidate', expiresAt: new Date(Date.now() + 90000).toISOString() }
const BOT = { id: 'b1', name: 'Chief', handle: '@chief.home', isMain: true }
const dialog = (flybot, room = ROOM) => draw(loadApp(flybot), 'FaceToFaceGroup', { mode: 'join', roster: { byId: {}, readOnly: '' }, remoteChats: [] },
  ['waiting', [BOT], ['b1'], '482913', false, null, [], room, 0, null, { link: '', status: null }])
const leave = (flybot, ask) => draw(loadApp(flybot), 'ConfirmLeave', {}, [ask])
test('#3114 cut 21: the waiting room speaks the window’s language', () => {
  const nodes = dialog(zhWindow)
  says(nodes, 'The room is open. The number is no longer valid.')
  says(nodes, 'Waiting for others to join…')
  says(nodes, 'Enter chat')
  assert.equal(propAt(nodes, 'face-wait-roster', 'aria-label'), '谁已加入', `the roster’s name: saw ${propAt(nodes, 'face-wait-roster', 'aria-label')}`)
  // The badge and the one-name form are the two entries this cut reuses, not adds.
  assert.equal(propAt(nodes, 'face-mine', 'title'), '我的', 'the mine badge follows the window too')
  assert.equal(propAt(nodes, 'face-owner', 'title'), 'Ann（你）', 'the person tile reads {name} (you) through the dictionary')
})

test('#3114 cut 21: the room number and its QR speak the window’s language', () => {
  const nodes = dialog(zhWindow, CANDIDATE)
  assert.equal(propAt(nodes, 'face-wait-code', 'aria-label'), '房间号码 482913', 'the number’s accessible name follows the window')
  assert.ok(textsOf(nodes).includes('房间号码'), `expected 房间号码, saw ${JSON.stringify(textsOf(nodes))}`)
  assert.equal(nodes.find(node => node.type === 'svg')?.props?.['aria-label'], '房间号码 482913 的二维码', 'the QR’s accessible name follows it too')
  assert.equal(textAt(nodes, 'face-qr-hint'), '用 FlyBot 扫描加入', 'the hint under the QR follows the window too')
})

test('#3114 cut 21: Leave asks in the window’s language', () => {
  const asked = leave(zhWindow, true)
  says(asked, 'Leave this room?')
  assert.deepEqual(buttons(asked), ['离开', '留下'], 'both answers follow the window')
  assert.deepEqual(buttons(leave(zhWindow, false)), ['离开'], 'and so does the one button before the question')
})

test('#3114 cut 21: no translator keeps today\'s English in the waiting room', () => {
  const nodes = dialog(bareWindow)
  assert.equal(textAt(nodes, 'face-wait-count'), 'The room is open. The number is no longer valid.')
  assert.deepEqual([propAt(nodes, 'face-wait-roster', 'aria-label'), propAt(nodes, 'face-mine', 'title'), propAt(nodes, 'face-owner', 'title')], ['Who has joined', 'mine', 'Ann (you)'])
  assert.deepEqual(textsOf(nodes).filter(text => ['Waiting for others to join…', 'Enter chat'].includes(text)), ['Waiting for others to join…', 'Enter chat'])
  const candidate = dialog(bareWindow, CANDIDATE)
  assert.deepEqual([propAt(candidate, 'face-wait-code', 'aria-label'), candidate.find(node => node.type === 'svg')?.props?.['aria-label'], textAt(candidate, 'face-qr-hint'), ...textsOf(candidate).filter(text => text === 'Room number')],
    ['Room number 482913', 'QR code for room number 482913', 'Scan this with FlyBot to join', 'Room number'])
  const asked = leave(bareWindow, true)
  assert.deepEqual([asked.filter(node => node.props?.className === 'fs-hint').map(node => node.children.join('')).join('|'), buttons(asked).join('|')], ['Leave this room?', 'Leave|Stay'])
})
// The baselines may only shrink, and a pin leaves when its draw goes through `tr()`.
const MISSING_PINS = [
  'Anyone with the number can still join.', 'The room is open. The number is no longer valid.',
  'Who has joined#1', 'Who has joined#2', 'Waiting for others to join…#1', 'Waiting for others to join…#2',
  'Enter chat#1', 'Enter chat#2', 'Leave this room?', 'Leave#1', 'Leave#2', 'Stay',
  'mine#1', 'mine#2', 'Room number', 'Scan this with FlyBot to join', '{} (you)',
]
const TEMPLATE_PINS = ['Room number {}', 'QR code for room number {}']
const baselineEntries = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries
test('#3114 cut 21: the baselines lose these draws and the dictionary gains the keys', () => {
  const pinned = baselineEntries('i18n-missing-entries.baseline.json')
  const missing = MISSING_PINS.map(key => `plugins/social/client.js:${key}`).filter(id => pinned.includes(id))
  assert.deepEqual(missing, [], `i18n-missing-entries still pins ${missing.join(', ')}`)
  const templates = TEMPLATE_PINS.map(key => `plugins/social/client.js:${key}`).filter(id => baselineEntries('i18n-template-draws.baseline.json').includes(id))
  assert.deepEqual(templates, [], `i18n-template-draws still pins ${templates.join(', ')}`)

  // The English is today's English, verbatim: a key renamed on one side only is a red test.
  const added = {
    'Anyone with the number can still join.': '只要房间还开着，拿到号码的人都能加入。',
    'The room is open. The number is no longer valid.': '房间已经开了，这个号码不再有效。',
    'Who has joined': '谁已加入',
    'Waiting for others to join…': '正在等其他人加入…',
    'Enter chat': '进入聊天',
    'Leave this room?': '离开这个房间？',
    Leave: '离开',
    Stay: '留下',
    mine: '我的',
    'Room number': '房间号码',
    'Room number {code}': '房间号码 {code}',
    'QR code for room number {code}': '房间号码 {code} 的二维码',
    'Scan this with FlyBot to join': '用 FlyBot 扫描加入',
  }
  for (const [key, value] of Object.entries(added)) assert.equal(zh[key], value, `the dictionary carries ${key}`)
  assert.equal(zh['{name} (you)'], '{name}（你）', 'the one-name form is reused, never added twice')
})
