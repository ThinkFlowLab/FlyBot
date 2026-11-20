// #3114 cut 26: on a Bot's own Sharing page the hint above the invite link (`Invite grants <Bot>
// only.`, with and without the Revoke tail) and the rooms a grant reaches (`In use in N rooms: …`,
// `This room only: …`, ` +N more`) drew English in a zh window. This pins them: a zh window reads
// the dictionary's words, a window whose host has no translator keeps today's English word for
// word, and the two baselines lose the five pins those draws held.
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
// `states` seeds the component's useState calls in order (a card that reads a loaded list).
function loadApp(flybot, states = []) {
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: entry => registered.push(entry) } }, console, setTimeout, clearTimeout, setInterval, clearInterval }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = flybot
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  let seed = 0
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  return registered[0].factory(() => ({
    createElement, Fragment: 'F', useEffect() {}, useRef: value => ({ current: value }),
    useState: value => [seed < states.length ? states[seed++] : value, () => {}],
  }))
}

// These cards are plain render functions once the effects are inert, so the tree is the render.
// Text is every string the tree paints, in draw order.
function draw(node, all = []) {
  if (!node || typeof node !== 'object') return all
  if (typeof node.type === 'function') return draw(node.type(node.props), all)
  for (const child of node.children ?? []) {
    if (typeof child === 'string') { if (child.trim()) all.push(child) } else draw(child, all)
  }
  return all
}
// The first node the tree paints that the predicate claims, so a hint's `title` can be read too.
const findNode = (node, match) => {
  if (!node || typeof node !== 'object') return undefined
  if (typeof node.type === 'function') return findNode(node.type(node.props), match)
  if (match(node)) return node
  return (node.children ?? []).map(child => findNode(child, match)).find(Boolean)
}
const textOf = (node, id) => findNode(node, n => n.props?.['data-flybot'] === id)?.children.join('')

const room = (id, name) => ({ id, name })
const bot = { id: 'b1', name: 'Mine' }
const grant = { id: 'g1', name: 'Eve', home: '@eve.home', person: 'Eve', grantee: '@eve.home', autoSend: false, rooms: [room('r1', 'Den'), room('r2', 'Lab')] }

test('#3114 cut 26: the rooms a grant reaches read in the window’s language', () => {
  const app = loadApp(zhWindow)
  // Two rooms: the hint counts them and the tooltip still carries every name, untruncated.
  const two = app.roomHint('use', [room('r1', 'Den'), room('r2', 'Lab')])
  assert.equal(two.text, '正在 2 个房间里使用：Den, Lab')
  assert.equal(two.title, 'Den\nLab', 'the tooltip is still the whole list')
  assert.deepEqual(Array.from(two.ids), ['r1', 'r2'])
  // One room keeps the singular English form; its zh key says the same words.
  assert.equal(app.roomHint('use', [room('r1', 'Den')]).text, '正在 1 个房间里使用：Den')
  // Three names print whole and the fourth becomes the count — the truncation itself is untouched.
  assert.equal(app.roomHint('use', [room('r1', 'Den'), room('r2', 'Lab'), room('r3', 'Hall'), room('r4', 'Loft')]).text,
    '正在 4 个房间里使用：Den, Lab, Hall，还有 1 个')
  // A grant used only face to face keeps its own words.
  assert.equal(app.roomHint('only', [room('r1', 'Den')]).text, '只在这个房间使用：Den')

  // The card wires them: the grant row paints the use hint, and a face-to-face room the rows do not
  // name comes back under `This room only`.
  const view = { grants: [grant], rooms: [room('r1', 'Den'), room('r2', 'Lab'), { id: 'r3', name: 'Hall', origin: 'face-to-face' }] }
  const nodes = loadApp(zhWindow, [view]).ManageAccess({ bot })
  const drawn = draw(nodes)
  assert.ok(drawn.includes('正在 2 个房间里使用：Den, Lab'), `the row reads: ${drawn.join(' | ')}`)
  assert.ok(drawn.includes('只在这个房间使用：Hall'), `the room-only line reads: ${drawn.join(' | ')}`)
  assert.equal(findNode(nodes, n => n.props?.title === 'Den\nLab')?.props.title, 'Den\nLab', 'the tooltip is still the whole list')
})

test('#3114 cut 26: the invite hint above the link speaks the window’s language', () => {
  assert.equal(textOf(loadApp(zhWindow).InviteToBot({ bot }), 'invite-hint-sharing'), '邀请只把 Mine 授权给对方。')
  // Revoke is mentioned only once People with access has someone to revoke.
  assert.equal(textOf(loadApp(zhWindow).InviteToBot({ bot, revocable: true }), 'invite-hint-sharing'),
    '邀请只把 Mine 授权给对方。随时可以在「可访问的人」里撤销。')
})

// A host with no translator keeps the English it drew before this change, character for character —
// `tr()` replaces a string only when the host answers for it.
test('#3114 cut 26: a host with no translator keeps today’s English', () => {
  const app = loadApp(bareWindow)
  assert.equal(app.roomHint('use', [room('r1', 'Den'), room('r2', 'Lab')]).text, 'In use in 2 rooms: Den, Lab')
  assert.equal(app.roomHint('only', [room('r1', 'Hall')]).text, 'This room only: Hall')
  assert.equal(app.roomHint('use', [room('r1', 'Den'), room('r2', 'Lab'), room('r3', 'Hall'), room('r4', 'Loft')]).text,
    'In use in 4 rooms: Den, Lab, Hall +1 more')
  assert.equal(textOf(loadApp(bareWindow).InviteToBot({ bot }), 'invite-hint-sharing'), 'Invite grants Mine only.')
  assert.equal(textOf(loadApp(bareWindow).InviteToBot({ bot, revocable: true }), 'invite-hint-sharing'),
    'Invite grants Mine only. Revoke anytime in People with access.')
})

// The baselines may only shrink, and an entry leaves when its zh key lands — a draw that is
// translated no longer needs pinning. The files are read as the repository ships them.
const pinned = [
  ['i18n-missing-entries.baseline.json', ['In use in {} room{}: ', 'This room only: ', ' +{} more']],
  ['i18n-template-draws.baseline.json', [
    'Invite grants {} only.',
    'Invite grants {} only. Revoke anytime in People with access.',
  ]],
]
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries

test('#3114 cut 26: the two baselines lose these draws and the dictionary gains the keys', () => {
  for (const [file, keys] of pinned) {
    const entries = entriesOf(file)
    const still = keys.map(key => `plugins/social/client.js:${key}`).filter(id => entries.includes(id))
    assert.deepEqual(still, [], `${file.replace('.baseline.json', '')} still pins ${still[0]}`)
  }
  // The baselines shrink by exactly these draws and nothing else does: the totals are the ratchet's
  // numbers, and a later cut that moves them moves these numbers with it.
  assert.deepEqual([entriesOf('i18n-plugins.baseline.json').length, entriesOf('i18n-template-draws.baseline.json').length, entriesOf('i18n-missing-entries.baseline.json').length], [12, 9, 46])
  // Every new key is the dictionary's, each answer character for character — the four keys that end
  // in a space and the one that starts with it included, so a trimmed copy is caught here.
  assert.deepEqual(Object.entries({
    'Invite grants {bot} only.': '邀请只把 {bot} 授权给对方。',
    'Invite grants {bot} only. Revoke anytime in People with access.': '邀请只把 {bot} 授权给对方。随时可以在「可访问的人」里撤销。',
    'In use in {n} room: ': '正在 {n} 个房间里使用：',
    'In use in {n} rooms: ': '正在 {n} 个房间里使用：',
    'This room only: ': '只在这个房间使用：',
    ' +{n} more': '，还有 {n} 个',
  }).map(([key]) => [key, zh[key]]), Object.entries({
    'Invite grants {bot} only.': '邀请只把 {bot} 授权给对方。',
    'Invite grants {bot} only. Revoke anytime in People with access.': '邀请只把 {bot} 授权给对方。随时可以在「可访问的人」里撤销。',
    'In use in {n} room: ': '正在 {n} 个房间里使用：',
    'In use in {n} rooms: ': '正在 {n} 个房间里使用：',
    'This room only: ': '只在这个房间使用：',
    ' +{n} more': '，还有 {n} 个',
  }))
})
