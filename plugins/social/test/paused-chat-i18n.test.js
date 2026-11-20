// #3114 cut 28: the quiet card a friend chat draws above the composer once Bot Social has paused
// that chat was bare English (`Chat paused`, `Bot Social paused the last chat with this Bot…` and
// `Send your message again: it starts a new chat.`). This pins it: a zh window reads the
// dictionary's sentences, a window whose host has no translator keeps today's English word for
// word, Bot Social's own reason stays untranslated inside the parentheses, and the two baselines
// lose the two pins those draws held.
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
const windowWith = t => ({ ...(t ? { t } : {}), slots: { register: () => () => {} }, call: async () => ({}) })
const zhWindow = windowWith(translator)
const bareWindow = windowWith(null)

// The client is a classic script that registers its factory on `window`, and the plugin reads
// `__flybot__` off the global object at render time — so the sandbox is that global object.
// `states` seeds the component's useState calls in order (the card reads its `paused` answer).
function loadApp(flybot, states = []) {
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: entry => registered.push(entry) } }, console, setTimeout, clearTimeout, setInterval, clearInterval }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = flybot
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  let seed = 0
  return registered[0].factory(() => ({
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'F', useEffect() {},
    useState: value => [seed < states.length ? states[seed++] : value, () => {}],
  }))
}
// These are plain render functions once the effects are inert, so the tree is the render.
function walk(node, all = []) {
  if (!node || typeof node !== 'object') return all
  if (typeof node.type === 'function') return walk(node.type(node.props), all)
  all.push(node)
  for (const child of node.children ?? []) walk(child, all)
  return all
}

const BOT = { remote: { handle: '@coder.bob.home' } }
// The answer Bot Social gave for this chat, and the two lines the card draws from it.
const lines = (flybot, paused) => {
  const nodes = walk(loadApp(flybot, [paused]).PausedChat({ bot: BOT }))
  const texts = className => nodes.find(node => node.props?.className === className)?.children.filter(child => typeof child === 'string').join('')
  return { nodes, title: texts('fs-label'), draft: texts('fs-draft') }
}
const reason = 'loop detected'
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries

test('#3114 cut 28: the paused friend chat speaks the window’s language, with Bot Social’s reason', () => {
  const { title, draft } = lines(zhWindow, { reason })
  assert.equal(title, '聊天已暂停')
  assert.equal(draft, 'Bot Social 暂停了与这个 Bot 的上一次聊天（loop detected）。请重新发送消息：这会开始一段新聊天。')
})

test('#3114 cut 28: a pause with no reason still reads as one sentence pair', () => {
  // Bot Social left the reason out: the card drops the parentheses, not the second sentence.
  const { title, draft } = lines(zhWindow, {})
  assert.equal(title, '聊天已暂停')
  assert.equal(draft, 'Bot Social 暂停了与这个 Bot 的上一次聊天。请重新发送消息：这会开始一段新聊天。')
})

// A host with no translator keeps the English it drew before this change, character for character —
// `tr()` replaces a string only when the host answers for it, and it fills `{note}` itself.
test('a host with no translator keeps today’s English in the paused notice', () => {
  assert.equal(lines(bareWindow, { reason }).draft, 'Bot Social paused the last chat with this Bot (loop detected). Send your message again: it starts a new chat.')
  assert.equal(lines(bareWindow, {}).draft, 'Bot Social paused the last chat with this Bot. Send your message again: it starts a new chat.')
  assert.equal(lines(bareWindow, { reason }).title, 'Chat paused')
})

test('the card is still drawn only for a friend’s Bot chat that Bot Social paused', () => {
  // No `bot.remote.handle` — a Bot that has not told us its handle gets no card, not an empty one.
  assert.equal(loadApp(zhWindow).PausedChat({}), null)
  // A handle but no pause answer: nothing has been paused, so nothing is drawn.
  assert.equal(loadApp(zhWindow, [null]).PausedChat({ bot: BOT }), null)
  // Drawn: the marks the host and the styles hang off are the ones they were.
  const { nodes } = lines(zhWindow, { reason })
  const hold = nodes.find(node => node.props?.['data-flybot'] === 'chat-paused')
  assert.equal(hold.props.role, 'status')
  assert.equal(hold.props.className, 'fs-hold fs-chat-approval')
})

// The baselines may only shrink, and an entry leaves when its zh key lands — a draw that is
// translated no longer needs pinning. The files are read as the repository ships them.
const pinned = [
  ['i18n-missing-entries.baseline.json', ['Chat paused']],
  ['i18n-template-draws.baseline.json', ['{} Send your message again: it starts a new chat.']],
]
test('#3114 cut 28: the two baselines lose these draws and the dictionary gains the keys', () => {
  for (const [file, keys] of pinned) {
    const entries = entriesOf(file)
    const still = keys.map(key => `plugins/social/client.js:${key}`).filter(id => entries.includes(id))
    assert.deepEqual(still, [], `${file.replace('.baseline.json', '')} still pins ${still[0]}`)
  }
  // The baselines shrink by exactly these draws and nothing else does: the totals are the ratchet's
  // numbers, and a later cut that moves them moves these numbers with it.
  assert.deepEqual([entriesOf('i18n-plugins.baseline.json').length, entriesOf('i18n-template-draws.baseline.json').length, entriesOf('i18n-missing-entries.baseline.json').length], [12, 9, 46])
  // Every new key is the dictionary's, each answer character for character — the full-width
  // parentheses and the missing space after `{note}` included, so a trimmed copy is caught here.
  const keys = {
    'Chat paused': '聊天已暂停',
    'Bot Social paused the last chat with this Bot.': 'Bot Social 暂停了与这个 Bot 的上一次聊天。',
    'Bot Social paused the last chat with this Bot ({reason}).': 'Bot Social 暂停了与这个 Bot 的上一次聊天（{reason}）。',
    '{note} Send your message again: it starts a new chat.': '{note}请重新发送消息：这会开始一段新聊天。',
  }
  assert.deepEqual(Object.entries(keys).map(([key]) => [key, zh[key]]), Object.entries(keys))
})
