// #3114 cut 27: the face-to-face room head drew its per-Bot Auto-send switch as bare English
// (`Auto-send Chief → room` and the checkbox's own name `Auto-send Chief's room messages`), and the
// sidebar's folded list of ended rooms drew `Past rooms` the same way. This pins them: a zh window
// reads the dictionary's words, a window whose host has no translator keeps today's English word for
// word, and the two baselines lose the three pins those draws held.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { DICTIONARY } from '../../../core/src/client/i18n.js'

const zh = DICTIONARY.zh
// The language a window runs in: `t` answers with the Chinese dictionary for a key it carries and
// echoes anything else, which is what the host's own translator does for an entry it lacks.
const translator = (text, params) => {
  const translated = Object.hasOwn(zh, text) ? zh[text] : String(text)
  return params ? translated.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : translated
}
const zhWindow = { t: translator, slots: { register: () => () => {} }, call: async () => ({}) }
const bareWindow = { slots: { register: () => () => {} }, call: async () => ({}) }

// The client is a classic script that registers its factory on `window`, and the plugin reads
// `__flybot__` off the global object at render time — so the sandbox is that global object.
// `states` seeds the component's useState calls in order (the room list reads its loaded rooms).
function loadApp(flybot, states = []) {
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: entry => registered.push(entry) } }, console, setTimeout, clearTimeout, setInterval, clearInterval }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = flybot
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  let seed = 0
  const app = registered[0].factory(() => ({
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'F', useEffect() {}, useRef: value => ({ current: value }), useMemo: fn => fn(),
    useState: value => [seed < states.length ? states[seed++] : value, () => {}],
  }))
  return app
}
// These are plain render functions once the effects are inert, so the tree is the render.
function walk(node, all = []) {
  if (!node || typeof node !== 'object') return all
  if (typeof node.type === 'function') return walk(node.type(node.props), all)
  all.push(node)
  for (const child of node.children ?? []) walk(child, all)
  return all
}
const findNode = (nodes, match) => nodes.find(match)
const directTexts = node => (node?.children ?? []).filter(child => typeof child === 'string' && child.trim())

test('#3114 cut 27: the room head’s Auto-send switches speak the window’s language', () => {
  const app = loadApp(zhWindow)
  const nodes = walk(app.FaceAutoSend({ bot: 'Chief', on: true }))
  // The switch keeps the note it already had, and its two names come from the dictionary.
  assert.equal(nodes[0].props.title, '不要每次都问。', 'the tooltip is still "Don\'t ask each time."')
  assert.equal(findNode(nodes, n => n.props?.type === 'checkbox')?.props['aria-label'], '自动发送 Chief 在房间里的消息')
  assert.deepEqual(directTexts(nodes[0]), ['Chief 发给房间的消息自动发送'])
  // A Bot whose name did not arrive falls back through the dictionary too, not to bare `my Bot`.
  const unknown = walk(app.FaceAutoSend({}))
  assert.deepEqual(directTexts(unknown[0]), ['我的 Bot 发给房间的消息自动发送'])
  assert.equal(findNode(unknown, n => n.props?.type === 'checkbox')?.props['aria-label'], '自动发送 我的 Bot 在房间里的消息')
})

test('#3114 cut 27: the sidebar’s Past rooms fold speaks the window’s language', () => {
  // One ended room: the fold draws its head and the count, and the section is still `fs-past`.
  const room = { id: 'g1', faceRoomId: 'frm_1', status: 'closed', name: 'Den' }
  const app = loadApp(zhWindow, [[room], false])
  const nodes = walk(app.FaceRooms({}))
  const head = findNode(nodes, n => n.props?.className === 'fs-past-head')
  assert.deepEqual(directTexts(head), ['历史房间'])
  assert.equal(findNode(nodes, n => n.props?.className === 'fs-count')?.children[0], '1', 'the count is still the number of ended rooms')
  assert.ok(findNode(nodes, n => n.props?.['data-flybot'] === 'face-past'), 'the fold is still `face-past`')
})

// A host with no translator keeps the English it drew before this change, character for character —
// `tr()` replaces a string only when the host answers for it.
test('a host with no translator keeps today’s English in the room head and the fold', () => {
  const app = loadApp(bareWindow)
  const named = walk(app.FaceAutoSend({ bot: 'Chief' }))
  assert.deepEqual(directTexts(named[0]), ['Auto-send Chief → room'])
  assert.equal(findNode(named, n => n.props?.type === 'checkbox')?.props['aria-label'], "Auto-send Chief's room messages")
  const unknown = walk(app.FaceAutoSend({}))
  assert.deepEqual(directTexts(unknown[0]), ['Auto-send my Bot → room'])
  const room = { id: 'g1', faceRoomId: 'frm_1', status: 'closed', name: 'Den' }
  const fold = loadApp(bareWindow, [[room], false])
  const head = findNode(walk(fold.FaceRooms({})), n => n.props?.className === 'fs-past-head')
  assert.deepEqual(directTexts(head), ['Past rooms'])
})

// The baselines may only shrink, and an entry leaves when its zh key lands — a draw that is
// translated no longer needs pinning. The files are read as the repository ships them.
const pinned = [
  ['i18n-missing-entries.baseline.json', ['Past rooms']],
  ['i18n-template-draws.baseline.json', ['Auto-send {} → room', "Auto-send {}'s room messages"]],
]
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries

test('#3114 cut 27: the two baselines lose these draws and the dictionary gains the keys', () => {
  for (const [file, keys] of pinned) {
    const entries = entriesOf(file)
    const still = keys.map(key => `plugins/social/client.js:${key}`).filter(id => entries.includes(id))
    assert.deepEqual(still, [], `${file.replace('.baseline.json', '')} still pins ${still[0]}`)
  }
  // The baselines shrink by exactly these draws and nothing else does: the totals are the ratchet's
  // numbers, and a later cut that moves them moves these numbers with it.
  assert.deepEqual([entriesOf('i18n-plugins.baseline.json').length, entriesOf('i18n-template-draws.baseline.json').length, entriesOf('i18n-missing-entries.baseline.json').length], [12, 9, 46])
  // Every new key is the dictionary's, each answer character for character — the arrow's single
  // spaces and the straight `'` included, so a trimmed or curly-quoted copy is caught here.
  assert.deepEqual(Object.entries({
    'Auto-send {bot} → room': '{bot} 发给房间的消息自动发送',
    "Auto-send {bot}'s room messages": '自动发送 {bot} 在房间里的消息',
    'my Bot': '我的 Bot',
    'Past rooms': '历史房间',
  }).map(([key]) => [key, zh[key]]), Object.entries({
    'Auto-send {bot} → room': '{bot} 发给房间的消息自动发送',
    "Auto-send {bot}'s room messages": '自动发送 {bot} 在房间里的消息',
    'my Bot': '我的 Bot',
    'Past rooms': '历史房间',
  }))
})
