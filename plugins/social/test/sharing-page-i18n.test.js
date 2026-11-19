// #3114 cut 20: the two cards a Bot's Sharing page draws by default — People with access
// (`ManageAccess`) and Share with a friend (`ShareWithFriend`) — drew thirteen positions as bare
// English in a zh window. This pins them: a zh window reads the dictionary's words, a window whose
// host has no translator keeps today's English word for word, and the two i18n baselines lose the
// pins those draws held. Copy is read out of the rendered tree, where a translated draw and a
// string merely spelled like the dictionary's text differ.
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
  const sandbox = { window: { __ModuleLoader__: { load: entry => registered.push(entry) } }, console, setTimeout, clearTimeout }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = flybot
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  let seed = 0
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  return registered[0].factory(() => ({
    createElement, Fragment: 'F', useEffect() {},
    useState: value => [seed < states.length ? states[seed++] : value, () => {}],
    useRef: value => ({ current: value }),
  }))
}

// These cards are plain render functions once the effects are inert, so the tree is the render.
// Text is every string the tree paints, in draw order: names and handles included, so a card that
// keeps drawing English shows it in the list the assertion prints.
function draw(node, all = []) {
  if (!node || typeof node !== 'object') return all
  if (typeof node.type === 'function') return draw(node.type(node.props), all)
  for (const child of node.children ?? []) {
    if (typeof child === 'string') { if (child.trim()) all.push(child) } else draw(child, all)
  }
  return all
}
const button = (node, id) => {
  if (typeof node?.type === 'function') return button(node.type(node.props), id)
  return node?.props?.['data-flybot'] === id ? node : (node?.children ?? []).map(child => button(child, id)).find(Boolean)
}
const bot = { id: 'b1', name: 'Mine' }
const grant = { id: 'g1', name: 'Eve', home: '@eve.home', person: 'Eve', grantee: '@eve.home', autoSend: false, rooms: [] }
const empty = { grants: [], rooms: [] }
test('#3114 cut 20: the People-with-access card speaks the window’s language', () => {
  const app = loadApp(zhWindow, [{ grants: [grant], rooms: [] }])
  const nodes = app.ManageAccess({ bot, onGrants: () => {} })
  const drawn = draw(nodes)
  // Every position this card draws is a dictionary entry, so a missing one names itself here.
  for (const key of [
    'Auto-send', 'Auto-send on', 'Auto-send off', 'Auto-send {name} → {who}',
    '{name}’s replies to {who} go out without asking you first.', 'Revoke', 'Revoke {name}', 'Revoking…',
    'Revoke {who}? They lose this Bot.', 'Revoke {who}? They lose this Bot in {n} room.',
    'Revoke {who}? They lose this Bot in {n} rooms.', 'this person',
    'One row per Bot. Default: nobody, Chief included.',
    'One row per Bot. Revoke one without affecting the rest. Default: nobody, Chief included.',
    'Nobody has this Bot yet. Copy an invite link above and send it to a friend.',
  ]) assert.ok(zh[key], `expected ${zh[key]} (${key}), saw ${JSON.stringify(drawn)}`)
  assert.deepEqual(drawn, ['可访问的人', '每行一个 Bot。撤销其中一个不影响其他。默认谁都没有，包括 Chief。', 'Eve', '@eve.home', '自动发送', '撤销授权'])
  assert.equal(button(nodes, 'access-auto-state'), undefined, 'a writable card draws the switch, not the state')
  assert.equal(button(nodes, 'access-auto-send').children[0].props['aria-label'], 'Mine 发给 Eve 的消息自动发送')
  assert.equal(button(nodes, 'access-auto-send').props.title, 'Mine 发给 Eve 的回复不再先问你。')
  assert.equal(button(nodes, 'revoke-grant').props['aria-label'], '撤销 Eve 的授权')

  // Read-only drops the two writes and keeps the list, its note and the Auto-send state.
  const locked = loadApp(zhWindow, [{ grants: [{ ...grant, autoSend: true }], rooms: [] }]).ManageAccess({ bot, readOnly: true })
  assert.deepEqual(draw(locked), ['可访问的人', '每行一个 Bot。默认谁都没有，包括 Chief。', 'Eve', '@eve.home', '自动发送已开'])
  // Nobody holds the Bot yet.
  const none = loadApp(zhWindow, [empty]).ManageAccess({ bot })
  assert.deepEqual(draw(none), ['可访问的人', '每行一个 Bot。撤销其中一个不影响其他。默认谁都没有，包括 Chief。', '还没有人拿到这个 Bot。复制上面的邀请链接发给朋友。'])
  // The inline revoke question counts the rooms the grant reaches, and the busy label follows too.
  const asked = loadApp(zhWindow, [{ grants: [{ ...grant, rooms: [{ id: 'r1', name: 'Den' }] }], rooms: [] }, 'g1', '', 'g1']).ManageAccess({ bot })
  const askedDraw = draw(asked)
  assert.ok(askedDraw.includes('撤销 Eve 的授权？对方将在 1 个房间里失去这个 Bot。'), `the question reads: ${askedDraw.join(' | ')}`)
  assert.ok(askedDraw.includes('正在撤销…'), 'the busy button follows the window too')
  assert.equal(button(asked, 'revoke-grant-yes').props['aria-label'], '撤销 Eve 的授权')
  // `'this person'` is a dictionary entry of its own: a grant naming nobody reads Chinese.
  const anon = loadApp(zhWindow, [{ grants: [{ id: 'g2', home: '@x.home', rooms: [] }], rooms: [] }, '', '', 'g2']).ManageAccess({ bot })
  assert.ok(draw(anon).some(text => text.startsWith('撤销 这个人 的授权')), 'the fallback noun is Chinese too')
})

test('#3114 cut 20: the share-with-a-friend card speaks the window’s language', () => {
  const app = loadApp(zhWindow, [[]])
  const nodes = app.ShareWithFriend({ bot })
  const drawn = draw(nodes)
  for (const key of [
    'Share with a friend',
    'One click shares {name} with someone you already know. No invite link. They can decline; you can Revoke in People with access.',
    'Loading friends…', 'No friends left to share with. Invite someone new above, or they already have this Bot.',
    'Share', 'Share {name} with {who}', 'Sharing…', 'That Bot was removed from that home.',
  ]) assert.ok(zh[key], `expected ${zh[key]} (${key}), saw ${JSON.stringify(drawn)}`)
  assert.deepEqual(drawn, ['分享给朋友', '一键把 Mine 分享给你已经认识的人，不需要邀请链接。对方可以拒绝，你也可以在「可访问的人」里撤销。', '没有可分享的朋友了。在上面邀请新朋友，或者他们已经拿到了这个 Bot。'])
  // A list still loading says so, and a row says who it shares with.
  const loading = loadApp(zhWindow, []).ShareWithFriend({ bot })
  assert.deepEqual(draw(loading).slice(-1), ['正在加载朋友…'])
  const friend = { peerBotId: 'p1', name: 'Helper', home: '@helper.eve.home', handle: '@helper' }
  const row = loadApp(zhWindow, [[friend]]).ShareWithFriend({ bot })
  assert.deepEqual(draw(row).slice(-3), ['Helper', '@helper', '分享'])
  assert.equal(button(row, 'share-friend').props['aria-label'], '把 Mine 分享给 Helper')
  // A row whose Bot left that home keeps its reason in the window's language, and one in flight says so.
  const gone = loadApp(zhWindow, [[{ ...friend, removed: true, reason: undefined }]]).ShareWithFriend({ bot })
  assert.ok(draw(gone).includes('那个 Bot 已从对方那里移除。'), `the removed row reads: ${draw(gone).join(' | ')}`)
  const busy = loadApp(zhWindow, [[friend], 'p1']).ShareWithFriend({ bot })
  assert.equal(button(busy, 'share-friend').children.join(''), '正在分享…')
})

// The baselines may only shrink, and an entry leaves when its zh key lands — a draw that is
// translated no longer needs pinning. The files are read as the repository ships them.
const pinned = [
  ['i18n-missing-entries.baseline.json', [
    'One row per Bot. Default: nobody, Chief included.',
    'Nobody has this Bot yet. Copy an invite link above and send it to a friend.',
    'Auto-send', 'Auto-send on', 'Auto-send off', 'Revoking…', 'Revoke#1', 'Revoke#2',
    'Revoke {}? They lose this Bot.', 'Revoke {}? They lose this Bot in {} room{}.',
    'Share with a friend', 'Loading friends…', 'Sharing…', 'That Bot was removed from that home.',
    'No friends left to share with. Invite someone new above, or they already have this Bot.',
  ]],
  ['i18n-template-draws.baseline.json', [
    'Revoke {}#1', 'Revoke {}#2', 'Share {} with {}', 'Auto-send {} → {}',
    "{}'s replies to {} go out without asking you first.#1",
    "{}'s replies to {} go out without asking you first.#2",
  ]],
]
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries

test('#3114 cut 20: the three baselines lose these draws', () => {
  for (const [file, keys] of pinned) {
    const entries = entriesOf(file)
    const still = keys.map(key => `plugins/social/client.js:${key}`).filter(id => entries.includes(id))
    assert.deepEqual(still, [], `${file.replace('.baseline.json', '')} still pins ${still[0]}`)
  }
  // The baselines shrink by exactly these draws and nothing else does: the totals are the ratchet's
  // numbers, and a later cut that moves them moves these numbers with it.
  assert.deepEqual([entriesOf('i18n-plugins.baseline.json').length, entriesOf('i18n-template-draws.baseline.json').length, entriesOf('i18n-missing-entries.baseline.json').length], [14, 21, 94])

  // A host with no translator keeps the English it drew before this change, character for
  // character — `tr()` replaces a string only when the host answers for it.
  const bare = loadApp(bareWindow, [{ grants: [grant], rooms: [] }])
  assert.deepEqual(draw(bare.ManageAccess({ bot })), ['People with access', 'One row per Bot. Revoke one without affecting the rest. Default: nobody, Chief included.', 'Eve', '@eve.home', 'Auto-send', 'Revoke'])
  assert.deepEqual(draw(loadApp(bareWindow, [[]]).ShareWithFriend({ bot })), ['Share with a friend', 'One click shares Mine with someone you already know. No invite link. They can decline; you can Revoke in People with access.', 'No friends left to share with. Invite someone new above, or they already have this Bot.'])
  // People with access is reused, never added twice.
  assert.equal(zh['People with access'], '可访问的人')
})
