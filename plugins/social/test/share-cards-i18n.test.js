// #3114 cut 18: the Social panel's share-request card and invite-accepted card drew their
// sentence, the "you already asked" hint, both buttons and the Open …'s Sharing title as bare
// English, while the rest of the panel followed the window's language — a Chinese window read
// English on those two cards only. `plugins/social/client.js` already carries `tr()` for the rest
// of the panel, so this pins all of it: a zh window reads the dictionary's words, a window whose
// host has no translator at all keeps today's English word for word, and the three i18n baselines
// lose the eight entries that pinned these draws.
//
// The copy is read out of the rendered tree, not out of the source: a string that reaches the
// card through the dictionary and a string that is merely spelled like the dictionary's
// translation look the same in a diff and differ here.
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

// A host with a translator, and a host without one: `tr()` then falls back to the English it was
// handed, so the two windows differ only in the copy the panel draws.
const zhWindow = { t: translator, slots: { register: () => () => {} }, call: async () => ({}) }
const bareWindow = { slots: { register: () => () => {} }, call: async () => ({}) }

// The client is a classic script that registers its factory on `window`, and the plugin reads
// `__flybot__` off the global object at render time — so the sandbox is that global object.
function loadApp(flybot) {
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: entry => registered.push(entry) } }, console, setTimeout, clearTimeout }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = flybot
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  return registered[0].factory(() => ({
    createElement, Fragment: 'F', useEffect() {}, useState: value => [value, () => {}], useRef: value => ({ current: value }), useMemo: fn => fn(),
  }))
}

// A friend's Bot with its owner reads `Helper (Eve)`; the accepted invite names our Bot `Chief`.
const shareItem = { id: 'evt1', botId: 'b1', botName: 'Writer', from: '@helper.eve.home', name: 'Helper', owner: 'Eve' }
const notice = { id: 'n1', name: 'Chief Grant', owner: 'SelfB1025', botName: 'Chief', asked: true }

// These two cards are plain render functions — no hooks, no effects — so the tree is the render.
function walk(node, all = []) {
  if (!node || typeof node !== 'object') return all
  if (typeof node.type === 'function') return walk(node.type(node.props), all)
  all.push(node)
  for (const child of node.children ?? []) walk(child, all)
  return all
}

const shareCard = (app, props = {}) => walk(app.ShareRequests({ items: [shareItem], actions: {}, ...props }))
const acceptCard = (app, props = {}) => walk(app.AcceptNotices({ items: [notice], ...props }))
const textOf = (nodes, id) => (nodes.find(node => node.props?.['data-flybot'] === id)?.children ?? []).join('')
const buttonsOf = nodes => nodes.filter(node => node.type === 'button')
const buttonLabels = nodes => buttonsOf(nodes).map(node => node.children.join(''))

test('#3110: a zh window reads the share request card in Chinese', () => {
  const nodes = shareCard(loadApp(zhWindow))
  const text = textOf(nodes, 'share-request-text')
  assert.equal(text, 'Helper (Eve) 想和 Writer 开始聊天，但 Writer 没有分享给对方。', `the share request still reads: ${text}`)
  assert.doesNotMatch(text, /tried to start a chat with/, 'the English sentence is gone from a zh window')
  assert.deepEqual(buttonLabels(nodes), ['关闭', '分享 Writer…'], 'both buttons follow the window too')
  assert.equal(buttonsOf(nodes)[1].props.title, '打开 Writer 的分享', 'the Sharing title follows the window too')

  // Both fallback names are dictionary entries of their own: a request whose Bot has no name yet
  // reads `your Bot`, which is Chinese in a zh window as well.
  const nameless = walk(loadApp(zhWindow).ShareRequests({ items: [{ id: 'evt2', name: 'Helper', owner: 'Eve' }], actions: {} }))
  assert.equal(textOf(nameless, 'share-request-text'), 'Helper (Eve) 想和 你的 Bot 开始聊天，但 你的 Bot 没有分享给对方。')

  // The owner is optional: without one the card names the friend's Bot alone.
  const ownerless = walk(loadApp(zhWindow).ShareRequests({ items: [{ ...shareItem, owner: '' }], actions: {} }))
  assert.equal(textOf(ownerless, 'share-request-text'), 'Helper 想和 Writer 开始聊天，但 Writer 没有分享给对方。')

  // #2219: a read-only window still reads the card; only the write button is missing.
  const locked = shareCard(loadApp(zhWindow), { locked: true })
  assert.equal(textOf(locked, 'share-request-text'), 'Helper (Eve) 想和 Writer 开始聊天，但 Writer 没有分享给对方。')
  assert.deepEqual(buttonLabels(locked), ['分享 Writer…'], 'the read-only window drops only Dismiss')
})

test('#3110: a zh window reads the accept notice card in Chinese', () => {
  const nodes = acceptCard(loadApp(zhWindow))
  const text = textOf(nodes, 'accept-notice-text')
  assert.equal(text, 'Chief Grant (SelfB1025) 接受了你的邀请，可以给 Chief 发消息。在对方分享一个 Bot 给你之前，你还不能给对方发消息。', `the accept notice still reads: ${text}`)
  assert.doesNotMatch(text, /accepted your invite/, 'the English sentence is gone from a zh window')
  assert.equal(textOf(nodes, 'accept-notice-asked'), '你已经请对方分享一个 Bot。', 'the hint line follows the window too')
  assert.deepEqual(buttonLabels(nodes), ['关闭', '请对方分享一个 Bot'], 'both buttons follow the window too')

  // A notice that carries no Bot name and no owner reads both fallbacks through the translator.
  // The owner is what makes the parenthesised form: without one the card names the Bot alone.
  const ownerless = walk(loadApp(zhWindow).AcceptNotices({ items: [{ ...notice, owner: '' }] }))
  assert.match(textOf(ownerless, 'accept-notice-text'), /^Chief Grant 接受了你的邀请/)
  const nameless = walk(loadApp(zhWindow).AcceptNotices({ items: [{ id: 'n3' }] }))
  const fallback = textOf(nameless, 'accept-notice-text')
  assert.match(fallback, /^一位好友 接受了你的邀请/, 'the missing name reads `A friend` in Chinese')
  assert.match(fallback, /可以给 你的 Bot 发消息/, 'the missing Bot name reads `your Bot` in Chinese')

  // A notice nobody has asked about yet draws no hint line, and a read-only one keeps its words.
  const unasked = walk(loadApp(zhWindow).AcceptNotices({ items: [{ ...notice, asked: false }] }))
  assert.equal(textOf(unasked, 'accept-notice-asked'), '', 'the hint line is only drawn once we asked')
  const locked = acceptCard(loadApp(zhWindow), { locked: true })
  assert.equal(textOf(locked, 'accept-notice-asked'), '你已经请对方分享一个 Bot。')
  assert.deepEqual(buttonLabels(locked), [], 'the read-only window drops both writes')
})

// The baselines may only shrink, and an entry leaves when its zh key lands — a draw that is
// translated no longer needs pinning. The files are read as the repository ships them.
const pinnedDraws = [
  ['i18n-template-draws.baseline.json', [
    "Open {}'s Sharing",
    'Share {}…',
    '{} tried to start a chat with {}. {} is not shared with them.',
  ]],
  ['i18n-missing-entries.baseline.json', [
    'Ask them to share a Bot',
    'You asked them to share a Bot.',
    '{} accepted your invite. They can message {}. You cannot message them until they share a Bot with you.',
  ]],
]
const baselineEntries = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries

test("#3110: the i18n baselines no longer pin these draws, and a window without a translator keeps today's English", () => {
  const left = []
  for (const [file, keys] of pinnedDraws) {
    const entries = baselineEntries(file)
    for (const key of keys) {
      const id = `plugins/social/client.js:${key}`
      if (entries.includes(id)) left.push(id)
    }
  }
  assert.deepEqual(left, [], `the baselines still pin an English draw: ${left.join(', ')}`)

  // The third baseline is the bare-draw view of the same two `Dismiss` buttons.
  assert.deepEqual(baselineEntries('i18n-plugins.baseline.json').filter(id => id.startsWith('plugins/social/client.js:Dismiss')),
    [], 'both Dismiss draws are translated, so both entries leave as well')

  // A host with no translator keeps the English it drew before this change, character for
  // character — `tr()` replaces a string only when the host answers for it.
  const app = loadApp(bareWindow)
  const share = shareCard(app)
  assert.equal(textOf(share, 'share-request-text'), 'Helper (Eve) tried to start a chat with Writer. Writer is not shared with them.')
  assert.deepEqual(buttonLabels(share), ['Dismiss', 'Share Writer…'])
  assert.equal(buttonsOf(share)[1].props.title, "Open Writer's Sharing")
  // The fallback names keep today's English too, so the same card reads as it did before this cut.
  const nameless = walk(app.AcceptNotices({ items: [{ id: 'n4' }] }))
  assert.match(textOf(nameless, 'accept-notice-text'), /^A friend accepted your invite\./)
  assert.match(textOf(nameless, 'accept-notice-text'), /They can message your Bot\./)

  const accept = acceptCard(app)
  assert.equal(textOf(accept, 'accept-notice-text'), 'Chief Grant (SelfB1025) accepted your invite. They can message Chief. You cannot message them until they share a Bot with you.')
  assert.equal(textOf(accept, 'accept-notice-asked'), 'You asked them to share a Bot.')
  assert.deepEqual(buttonLabels(accept), ['Dismiss', 'Ask them to share a Bot'])

  // The dictionary carries the seven entries this cut adds, verbatim, so a key renamed on one side
  // and not the other is a red test rather than a card that keeps drawing English.
  const added = {
    'A friend': '一位好友',
    'You asked them to share a Bot.': '你已经请对方分享一个 Bot。',
    'Ask them to share a Bot': '请对方分享一个 Bot',
    "Open {bot}'s Sharing": '打开 {bot} 的分享',
    'Share {bot}…': '分享 {bot}…',
    '{name} accepted your invite. They can message {bot}. You cannot message them until they share a Bot with you.':
      '{name} 接受了你的邀请，可以给 {bot} 发消息。在对方分享一个 Bot 给你之前，你还不能给对方发消息。',
    '{name} tried to start a chat with {bot}. {bot} is not shared with them.':
      '{name} 想和 {bot} 开始聊天，但 {bot} 没有分享给对方。',
  }
  for (const [key, value] of Object.entries(added)) assert.equal(zh[key], value, `the dictionary carries ${key}`)
  // The two names the panel already translated are reused, never added twice.
  assert.deepEqual([zh.Dismiss, zh['your Bot']], ['关闭', '你的 Bot'])
})
