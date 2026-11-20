// #3114 cut 28: a friend chat Bot Social paused drew its whole quiet card in bare English — the title
// `Chat paused`, the sentence with or without Bot Social's reason, and the `Send your message again`
// line. This pins the card to the window's language: a zh window reads the dictionary's words with
// Bot Social's reason left as it arrived, a window whose host has no translator keeps today's English
// word for word, and the two baselines lose the draws those English strings held.
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
// `states` seeds the component's useState calls in order (the paused card reads what `social/paused`
// answered; the effects are inert, so the seeded answer is the render).
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
const card = states => {
  const app = loadApp(zhWindow, states)
  const nodes = walk(app.PausedChat({ bot: { remote: { handle: '@coder.bob.home' } } }))
  return {
    card: nodes[0],
    texts: () => [
      directTexts(findNode(nodes, n => n.props?.className === 'fs-label')),
      directTexts(findNode(nodes, n => n.props?.className === 'fs-draft')),
    ],
  }
}

test('#3114 cut 28: the paused friend chat speaks the window’s language, with Bot Social’s reason', () => {
  const { card: node, texts } = card([{ reason: 'loop detected' }])
  // The card is still the same quiet notice: same class, same mount point, still a status region.
  assert.equal(node.props['data-flybot'], 'chat-paused')
  assert.equal(node.props.role, 'status')
  assert.equal(node.props.className, 'fs-hold fs-chat-approval')
  // One reason sentence and one what-to-do-next sentence, both in the window's language. Bot
  // Social's reason is server data and stays as it arrived, inside full-width brackets.
  assert.deepEqual(texts(), [
    ['聊天已暂停'],
    ['Bot Social 暂停了与这个 Bot 的上一次聊天（loop detected）。请重新发送消息：这会开始一段新聊天。'],
  ])
})

test('#3114 cut 28: a pause with no reason still reads as one sentence pair', () => {
  const { texts } = card([{ pausedAt: '2026-11-19T23:00:00Z' }])
  // No reason: the sentence that carries it is gone, and the notice is still the two sentences.
  assert.deepEqual(texts(), [
    ['聊天已暂停'],
    ['Bot Social 暂停了与这个 Bot 的上一次聊天。请重新发送消息：这会开始一段新聊天。'],
  ])
})

// A host with no translator keeps the English it drew before this change, character for character —
// `tr()` replaces a string only when the host answers for it.
test('a host with no translator keeps today’s English in the paused notice', () => {
  const app = loadApp(bareWindow, [{ reason: 'loop detected' }])
  const withReason = walk(app.PausedChat({ bot: { remote: { handle: '@coder.bob.home' } } }))
  assert.deepEqual(directTexts(findNode(withReason, n => n.props?.className === 'fs-label')), ['Chat paused'])
  assert.deepEqual(directTexts(findNode(withReason, n => n.props?.className === 'fs-draft')), [
    'Bot Social paused the last chat with this Bot (loop detected). Send your message again: it starts a new chat.',
  ])
  const plain = loadApp(bareWindow, [{}])
  const withoutReason = walk(plain.PausedChat({ bot: { remote: { handle: '@coder.bob.home' } } }))
  assert.deepEqual(directTexts(findNode(withoutReason, n => n.props?.className === 'fs-draft')), [
    'Bot Social paused the last chat with this Bot. Send your message again: it starts a new chat.',
  ])
})

// The card only exists for a friend's Bot chat that Bot Social actually paused: without a handle
// there is nothing to ask about, and a null answer draws nothing.
test('the card is still drawn only for a friend’s Bot chat that Bot Social paused', () => {
  const app = loadApp(zhWindow, [{ reason: 'loop detected' }])
  assert.equal(app.PausedChat({}), null, 'no bot at all draws nothing')
  assert.equal(app.PausedChat({ bot: { remote: {} } }), null, 'a bot with no handle draws nothing')
  const unpaused = loadApp(zhWindow, [null])
  assert.equal(unpaused.PausedChat({ bot: { remote: { handle: '@coder.bob.home' } } }), null, 'an unpaused chat draws nothing')
})

// The baselines may only shrink, and an entry leaves when its zh key lands — a draw that is
// translated no longer needs pinning. The files are read as the repository ships them.
const pinned = [
  ['i18n-missing-entries.baseline.json', ['Chat paused']],
  ['i18n-template-draws.baseline.json', ['{} Send your message again: it starts a new chat.']],
]
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries

test('#3114 cut 28: the two baselines lose these draws and the dictionary gains the keys', () => {
  for (const [file, keys] of pinned) {
    const entries = entriesOf(file)
    const still = keys.map(key => `plugins/social/client.js:${key}`).filter(id => entries.includes(id))
    assert.deepEqual(still, [], `${file.replace('.baseline.json', '')} still pins ${still[0]}`)
  }
  // The baselines shrink by exactly these draws and nothing else does: the totals are the ratchet's
  // numbers, and a later cut that moves them moves these numbers with it.
  assert.deepEqual([entriesOf('i18n-plugins.baseline.json').length, entriesOf('i18n-template-draws.baseline.json').length, entriesOf('i18n-missing-entries.baseline.json').length], [12, 9, 46])
  // Every new key is the dictionary's, each answer character for character — the full-width brackets
  // and the `{note}` prefix with no space included, so a trimmed or half-width copy is caught here.
  const keys = {
    'Chat paused': '聊天已暂停',
    'Bot Social paused the last chat with this Bot.': 'Bot Social 暂停了与这个 Bot 的上一次聊天。',
    'Bot Social paused the last chat with this Bot ({reason}).': 'Bot Social 暂停了与这个 Bot 的上一次聊天（{reason}）。',
    '{note} Send your message again: it starts a new chat.': '{note}请重新发送消息：这会开始一段新聊天。',
  }
  assert.deepEqual(Object.entries(keys).map(([key]) => [key, zh[key]]), Object.entries(keys))
})
