// #3114 cut 23: a friend Bot's settings card (`FriendChatSettings`) drew its Auto-send box, its
// hint, the Remove this Bot link with its title and busy label, and the inline remove question as
// bare English in a zh window. This pins them: a zh window reads the dictionary's words, a window
// whose host has no translator keeps today's English word for word, and the two i18n baselines
// lose the pins those draws held. The same sentence also draws on the sidebar's friend row, whose
// menu item and aria-label has to travel with the dictionary key (#2998).
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
// `states` seeds the component's useState calls in order (the remove question is the fourth).
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
// Text is every string the tree paints, in draw order, so a card that keeps drawing English shows
// it in the list the assertion prints.
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

// A friend's Bot as the card reads it: the home names the person, the Bot carries its own name.
const friend = { id: 'b1', name: 'Eve', remote: { home: '@eve.home', handle: '@eve.bot', homeName: 'Eve' } }
const row = (window, states = [true], onRemove = () => {}) => loadApp(window, states).FriendBotRow({
  bot: { handle: '@eve.bot', name: 'Eve' },
  chat: { id: 'c1' },
  renderBot: () => ({ type: 'div', props: {}, children: ['Eve'] }),
  onRemove,
})

test('#3114 cut 23: a friend Bot’s settings card speaks the window’s language', () => {
  const card = loadApp(zhWindow).FriendChatSettings({ bot: friend })
  const drawn = draw(card)
  // Every position this card draws is a dictionary entry, so a missing one names itself here.
  for (const key of [
    "Auto-send my Bots' replies to {who}",
    "Your Bots' replies to {who} go out without asking you first. What you type is not affected.",
    'Remove this Bot', 'Removing…', "Don't ask each time.",
  ]) assert.ok(zh[key], `expected ${zh[key]} (${key}), saw ${JSON.stringify(drawn)}`)
  assert.deepEqual(drawn, ['我的 Bot 发给 Eve 的回复自动发送', '你的 Bot 发给 Eve 的回复不再先问你。你输入的内容不受影响。', '移除这个 Bot'])
  assert.equal(button(card, 'friend-auto-send').props.title, '不要每次都问。')
  const remove = button(card, 'remove-friend-bot')
  assert.equal(remove.props.title, '把这个 Bot 从你的列表和群聊中移除。这不会解除与主人的好友关系。')
  assert.equal(remove.props['aria-label'], '移除这个 Bot')

  // The same sentence draws on the sidebar's friend row: its menu item and aria-label travel
  // with the key, so a zh window never reads it bare next to a translated card (#2998).
  const sidebar = row(zhWindow)
  assert.deepEqual(draw(sidebar), ['Eve', '×', '移除这个 Bot'])
  assert.equal(button(sidebar, 'remove-friend-bot').props['aria-label'], '移除这个 Bot')
})

test('#3114 cut 23: the inline remove question speaks the window’s language', () => {
  // Asking is the fourth useState; the roster still lists the friend's other shared Bot, which is
  // the sentence that keeps the friend in the list.
  const linked = loadApp(zhWindow, [false, false, false, true, '']).FriendChatSettings({
    bot: friend,
    roster: { remoteBots: [{ handle: '@eve.two', name: 'Eve Two', home: '@eve.home' }] },
  })
  assert.deepEqual(draw(linked), ['我的 Bot 发给 Eve 的回复自动发送', '你的 Bot 发给 Eve 的回复不再先问你。你输入的内容不受影响。', '把 Eve 从你的列表中移除吗？Eve 仍是好友：仍通过 Eve Two 共享。', '删除', '保留'])
  assert.equal(button(linked, 'remove-friend-bot-yes').props['data-flybot'], 'remove-friend-bot-yes')

  // With no other Bot of that friend still shared, the question ends the other way.
  const lone = loadApp(zhWindow, [false, false, false, true, '']).FriendChatSettings({ bot: friend, roster: { remoteBots: [] } })
  assert.deepEqual(draw(lone), ['我的 Bot 发给 Eve 的回复自动发送', '你的 Bot 发给 Eve 的回复不再先问你。你输入的内容不受影响。', '把 Eve 从你的列表中移除吗？你自己的 Bot 仍然保持共享。Eve 可以再次分享它。', '删除', '保留'])
})

test('#3114 cut 23: a host with no translator keeps today’s English', () => {
  // `tr()` replaces a string only when the host answers for it, so today's English is the fallback
  // character for character — the guard that this cut changes what a zh window reads, not the copy.
  const card = loadApp(bareWindow).FriendChatSettings({ bot: friend })
  assert.deepEqual(draw(card), [
    "Auto-send my Bots' replies to Eve",
    "Your Bots' replies to Eve go out without asking you first. What you type is not affected.",
    'Remove this Bot',
  ])
  assert.equal(button(card, 'friend-auto-send').props.title, "Don't ask each time.")
  assert.equal(button(card, 'remove-friend-bot').props.title, 'Remove this Bot from your list and from your groups. This does not unfriend the owner.')
  assert.equal(button(card, 'remove-friend-bot').props['aria-label'], 'Remove this Bot')
  const asking = loadApp(bareWindow, [false, false, false, true, '']).FriendChatSettings({ bot: friend, roster: { remoteBots: [] } })
  assert.deepEqual(draw(asking), ["Auto-send my Bots' replies to Eve", "Your Bots' replies to Eve go out without asking you first. What you type is not affected.", 'Remove Eve from your list? Your own Bots stay shared. Eve can share it again.', 'Remove', 'Keep'])
  const sidebar = row(bareWindow)
  assert.deepEqual(draw(sidebar), ['Eve', '×', 'Remove this Bot'])
  assert.equal(button(sidebar, 'remove-friend-bot').props['aria-label'], 'Remove this Bot')
})

// The baselines may only shrink, and an entry leaves when its zh key lands — a draw that is
// translated no longer needs pinning. The files are read as the repository ships them.
const pinned = [
  ['i18n-missing-entries.baseline.json', [
    "Don't ask each time.#1", "Don't ask each time.#2",
    'Remove this Bot#1', 'Remove this Bot#2', 'Removing…',
    'Remove this Bot from your list and from your groups. This does not unfriend the owner.',
    '{} stays a friend: still shared through {}.',
    'Your own Bots stay shared. {} can share it again.',
  ]],
  ['i18n-template-draws.baseline.json', [
    "Auto-send my Bots' replies to {}",
    "Your Bots' replies to {} go out without asking you first. What you type is not affected.",
    'Remove {} from your list? {}',
  ]],
]
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries

test('#3114 cut 23: the two baselines lose these draws and nothing else', () => {
  for (const [file, keys] of pinned) {
    const entries = entriesOf(file)
    const still = keys.map(key => `plugins/social/client.js:${key}`).filter(id => entries.includes(id))
    assert.deepEqual(still, [], `${file.replace('.baseline.json', '')} still pins ${still[0]}`)
  }
  // The baselines shrink by exactly these draws and nothing else does: the totals are the ratchet's
  // numbers, and a later cut that moves them moves these numbers with it.
  assert.deepEqual([
    entriesOf('i18n-plugins.baseline.json').length,
    entriesOf('i18n-template-draws.baseline.json').length,
    entriesOf('i18n-missing-entries.baseline.json').length,
  ], [13, 14, 55])
  // People with access is reused, never added twice; the same for the friend's own fallback name.
  assert.equal(zh['Your friend'], '你的朋友')
})
