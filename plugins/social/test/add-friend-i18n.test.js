// #3114 cut 22: the Add friend panel — both groups, the paste box, both Bot pickers, the invite
// controls it shares with a Bot's Sharing page and the result lines — drew twenty-five positions
// as bare English in a zh window. A zh window reads the dictionary's words, a window whose host
// has no translator keeps today's English word for word, and the three baselines lose these pins.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { DICTIONARY } from '../../../core/src/client/i18n.js'
const zh = DICTIONARY.zh
// `t` answers with the Chinese dictionary for a key it carries and echoes the key otherwise.
const translator = (text, params) => {
  const translated = Object.hasOwn(zh, text) ? zh[text] : String(text)
  return params ? translated.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : translated
}
const zhWindow = { t: translator, slots: { register: () => () => {} }, call: async () => ({}) }
const bareWindow = { slots: { register: () => () => {} }, call: async () => ({}) }
// The client registers its factory on `window`; the sandbox is the global the plugin reads
// `__flybot__` off at render time. `states` seeds the useState calls in order: friend list, paste
// box, status line, busy, both pickers, my handle, and the invite just made.
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
// Every string the tree paints, in draw order: Bot names included, so English shows in the list.
function draw(node, all = []) {
  if (!node || typeof node !== 'object') return all
  if (typeof node.type === 'function') return draw(node.type(node.props), all)
  for (const child of node.children ?? []) { if (typeof child === 'string') { if (child.trim()) all.push(child) } else draw(child, all) }
  return all
}
const byId = (node, id) => {
  if (!node || typeof node !== 'object') return undefined
  const one = typeof node.type === 'function' ? node.type(node.props) : node
  if (one?.props?.['data-flybot'] === id) return one
  for (const child of one?.children ?? []) { const hit = byId(child, id); if (hit) return hit }
  return undefined
}
const bots = [{ id: 'b1', name: 'Mine', isMain: true }, { id: 'b2', name: 'Helper' }]
const overview = { incoming: [], outgoing: [] }
const made = { link: 'https://social.example/r/1', text: 'Hello', botName: 'Mine' }
const states = (invite = null, me = '') => [overview, '', null, false, bots, 'b1', 'b1', me, invite]
test('#3114 cut 22: the Add friend panel speaks the window’s language', () => {
  const nodes = loadApp(zhWindow, states(null, 'you@home')).AddFriend({ actions: {}, onChange: () => {} })
  const drawn = draw(nodes)
  assert.ok(!drawn.includes('Accept an invite'), 'the English "Accept an invite" is still drawn')
  assert.deepEqual(drawn, [
    '添加好友', '你是 you@home', '接受邀请', '通过', 'Mine', 'Helper', '接受邀请', '邀请朋友', '分享', 'Mine', 'Helper', '复制给 Mine 的邀请链接',
  ])
  // The paste box, both pickers and the tooltips are copy attributes, not painted text.
  const box = byId(nodes, 'accept-group').children.find(child => child.props?.placeholder)
  assert.deepEqual([box.props.placeholder, box.props['aria-label']], ['粘贴邀请链接或邀请码', '邀请链接或邀请码'])
  assert.equal(byId(nodes, 'join-as').props.title, '这个 Bot 替你说话，不会被共享；除非你邀请，否则你的朋友用不了它。')
  assert.equal(byId(nodes, 'share-bot').props['aria-label'], '分享哪个 Bot')
  assert.equal(byId(nodes, 'share-as').props.title, '你的朋友只会拿到这个 Bot。')
})

test('#3114 cut 22: the invite controls speak the window’s language', () => {
  const nodes = loadApp(zhWindow, states(made)).AddFriend({ actions: {}, onChange: () => {} })
  // A made link draws its own name and the three buttons, then every copy receipt follows it.
  assert.equal(byId(nodes, 'invite-link').props['aria-label'], 'Mine 的邀请链接', 'the English Invite link for {bot} is still drawn')
  assert.deepEqual(draw(nodes).slice(-3), ['复制链接', '连说明一起复制', '新链接'])
  // Before a link exists the one button is named after the Bot, in its tooltip and its text.
  const fresh = loadApp(zhWindow, states()).AddFriend({ actions: {}, onChange: () => {} })
  assert.equal(byId(fresh, 'mint-invite').props.title, '复制给 Mine 的邀请链接', 'the English Copy invite link for {bot} is still drawn')
  assert.equal(byId(fresh, 'mint-invite').children[0], '复制给 Mine 的邀请链接')
  // Copy link and New link are dictionary entries already: reused, never added a second time.
  assert.deepEqual([zh['Copy link'], zh['New link']], ['复制链接', '新链接'])
})

test('#3114 cut 22: no translator keeps today’s English in the Add friend panel', () => {
  // A host with no translator keeps the English it drew before this change, character for
  // character — `tr()` replaces a string only when the host answers for it.
  const nodes = loadApp(bareWindow, states(made, 'you@home')).AddFriend({ actions: {}, onChange: () => {} })
  assert.deepEqual(draw(nodes), [
    'Add friend', 'You are you@home', 'Accept an invite', 'Talk through ', 'Mine', 'Helper', 'Accept invite',
    'Invite a friend', 'Share ', 'Mine', 'Helper', 'Copy link', 'Copy with instructions', 'New link',
  ])
  const box = byId(nodes, 'accept-group').children.find(child => child.props?.placeholder)
  assert.deepEqual([box.props.placeholder, box.props['aria-label'], byId(nodes, 'invite-link').props['aria-label']], ['Paste invite link or code', 'Invite link or code', 'Invite link for Mine'])
  assert.equal(byId(nodes, 'share-bot').props['aria-label'], 'Which of your Bots to share')
  assert.equal(byId(nodes, 'join-as').props.title, "Talks for you. Not shared: your friend can't use it unless you invite them to it.")
  assert.equal(byId(loadApp(bareWindow, states()).AddFriend({ actions: {} }), 'mint-invite').props.title, 'Copy invite link for Mine')
})

// The baselines may only shrink, and an entry leaves when its zh key lands; read as shipped.
const pinned = [
  ['i18n-missing-entries.baseline.json', [
    'Accept an invite', 'Copy with instructions', 'Could not copy. Select the link and copy it by hand.#1',
    'Could not copy. Select the link and copy it by hand.#2', 'Declined {}.', 'Invite a friend',
    'Invite for {} copied with instructions.', 'Invite link for {} copied.', 'Invite link or code',
    "Joined {}'s invite, but their Bot hasn't loaded yet. It shows in your list when it does; if not, accept the link again.{}", 'Paste invite link or code', 'Request sent to {}. They show up here once they accept.',
    'Share ', 'Talk through ', "Talks for you. Not shared: your friend can't use it unless you invite them to it.",
    'Which of your Bots talks', 'Which of your Bots to share', 'Your friend gets this Bot only.',
    '{} is now a friend.', '{} shared {} with you.{}', '{} {} back in your list.',
  ]],
  ['i18n-template-draws.baseline.json', ['Copy invite link for {}', 'Invite link for {}', 'You are {}', '{} failed: {}']],
  ['i18n-plugins.baseline.json', ['Copy link', 'New link']],
]
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries

test('#3114 cut 22: the baselines lose these draws and the dictionary gains the keys', () => {
  for (const [file, keys] of pinned) {
    const entries = entriesOf(file)
    const still = keys.map(key => `plugins/social/client.js:${key}`).filter(id => entries.includes(id))
    assert.deepEqual(still, [], `${file.replace('.baseline.json', '')} still pins ${still[0]}`)
  }
  // The three baselines shrink by exactly these draws and nothing else does: the ratchet's numbers.
  assert.deepEqual([entriesOf('i18n-plugins.baseline.json').length, entriesOf('i18n-template-draws.baseline.json').length, entriesOf('i18n-missing-entries.baseline.json').length], [13, 14, 55])
  // Every new key is the dictionary's, and each answers with Chinese.
  for (const key of [
    'Accept an invite', 'Invite a friend', 'Paste invite link or code',
    'Invite link or code', 'Talk through ', 'Which of your Bots talks',
    "Talks for you. Not shared: your friend can't use it unless you invite them to it.", 'Share ', 'Which of your Bots to share',
    'Your friend gets this Bot only.', 'You are {me}', 'Copy invite link for {bot}',
    'Invite link for {bot}', 'Copy with instructions', 'Invite for {bot} copied with instructions.',
    'Invite link for {bot} copied.', 'Could not copy. Select the link and copy it by hand.', '{bots} {verb} back in your list.',
    '{who} shared {bot} with you.{note}', "Joined {who}'s invite, but their Bot hasn't loaded yet. It shows in your list when it does; if not, accept the link again.{note}", 'Request sent to {who}. They show up here once they accept.',
    '{name} is now a friend.', 'Declined {name}.', '{what} failed: {why}',
    'Your friend',
  ]) assert.ok(zh[key], `expected ${zh[key]} (${key})`)
})
