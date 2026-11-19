// #3114 cut 24: the join/create a room dialog — the Bot picker's name, the six-digit field and its
// two refusals, the link row and the scan row, the `nobody` step's way out, and the copy tables the
// dialog reads (invite refusals, scan failures, an older Bot Social) — drew English in a zh window.
// A zh window reads the dictionary's words, a host with no translator keeps today's English word
// for word, and the three baselines lose these pins.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { DICTIONARY } from '../../../core/src/client/i18n.js'

const zh = DICTIONARY.zh
const translator = (text, params) => {
  const translated = Object.hasOwn(zh, text) ? zh[text] : String(text)
  return params ? translated.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : translated
}
const zhWindow = { t: translator, slots: { register: () => () => {} }, call: async () => ({}) }
const bareWindow = { slots: { register: () => () => {} }, call: async () => ({}) }

// The dialog keeps its state in eleven hook slots, answered in this order: step, bots, selected,
// code, busy, status, failures, room, tick, scan, invite. A setter records what the dialog would
// have drawn next, so a refusal a click produces is read without a browser.
function loadApp(flybot, states = []) {
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: entry => registered.push(entry) } }, console, setTimeout, clearTimeout }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = flybot
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  const written = []
  let seed = 0
  const app = registered[0].factory(() => ({
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'F', useEffect() {}, useRef: value => ({ current: value }),
    useState: value => [seed < states.length ? states[seed++] : value, next => written.push(typeof next === 'function' ? next(value) : next)],
  }))
  return { app, written }
}
function walk(node, all = []) {
  if (!node || typeof node !== 'object') return all
  if (typeof node.type === 'function') return walk(node.type(node.props), all)
  all.push(node)
  for (const child of node.children ?? []) walk(child, all)
  return all
}
const textsOf = nodes => nodes.flatMap(node => (node.children ?? []).filter(child => typeof child === 'string'))
const byId = (nodes, id) => nodes.find(node => node.props?.['data-flybot'] === id)
const BOT = { id: 'b1', name: 'Chief', handle: '@chief.home', isMain: true }
const props = { mode: 'join', roster: { byId: {}, readOnly: '' }, remoteChats: [], actions: {}, onClose: () => {} }
const seed = ({ bots = [], selected = ['b1'], code = '', invite = { link: '', status: null }, status = null, scan = null, room = null, step = 'setup' } = {}) =>
  [step, bots, selected, code, false, status, [], room, 0, scan, invite]
const open = (flybot, more = {}) => {
  const ui = loadApp(flybot, seed(more))
  return { ...ui, nodes: walk(ui.app.FaceToFaceGroup(props)) }
}

test('#3114 cut 24: the join dialog speaks the window’s language', () => {
  const { nodes } = open(zhWindow)
  assert.equal(byId(nodes, 'face-pick').props['aria-label'], '你的 Bot', 'the Bot picker’s name is still English')
  assert.ok(!textsOf(nodes).includes('Loading your Bots…'), 'the English "Loading your Bots…" is still drawn')
  assert.ok(textsOf(nodes).includes('正在加载你的 Bot…') || textsOf(nodes).includes('正在加载你的 Bot…'), 'the loading line follows the window')
  assert.equal(nodes.find(node => node.type === 'input' && node.props.maxLength === 6)?.props.placeholder, '6 位数字')
})

test('#3114 cut 24: what a press refuses is said in the window’s language', () => {
  // Six digits with no Bot picked: the submit answers about the picker, not the number.
  const pick = open(zhWindow, { bots: [BOT], selected: [], code: '482913' })
  pick.app.FaceToFaceGroup(props)
  const form = pick.nodes.find(node => node.type === 'form')
  form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(pick.written.map(v => v?.text ?? v?.status?.text).filter(Boolean), ['请选择用哪些 Bot 加入。'])
  // A short number is refused in the window too.
  const short = open(zhWindow, { bots: [BOT], selected: ['b1'], code: '12' })
  short.nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(short.written.map(v => v?.text ?? v?.status?.text).filter(Boolean), ['请输入 6 位数字。'])
  // A paste that is not an invite link, and a browser that cannot scan, answer in the window.
  const link = open(zhWindow, { bots: [BOT], invite: { link: 'https://social.example/nope', status: null } })
  byId(link.nodes, 'face-link-join-go').props.onClick()
  assert.deepEqual(link.written.map(v => v?.text ?? v?.status?.text).filter(Boolean), ['这不是邀请链接。它看起来像 https://…/r/…'])
  const scan = open(zhWindow, { bots: [BOT] })
  byId(scan.nodes, 'face-scan').props.onClick()
  assert.deepEqual(scan.written.map(v => v?.text ?? v?.status?.text).filter(Boolean), ['把镜头对准 FlyBot 房间码。', '这个浏览器不能扫码。请直接输入 6 位号码。'])
})

test('#3114 cut 24: no translator keeps today’s English in the join dialog', () => {
  const { nodes } = open(bareWindow)
  assert.equal(byId(nodes, 'face-pick').props['aria-label'], 'Your Bots')
  assert.ok(textsOf(nodes).includes('Loading your Bots…'))
  const pick = open(bareWindow, { bots: [BOT], selected: [], code: '482913' })
  pick.nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(pick.written.map(v => v?.text ?? v?.status?.text).filter(Boolean), ['Choose which of your Bots join.'])
  const scan = open(bareWindow, { bots: [BOT] })
  byId(scan.nodes, 'face-scan').props.onClick()
  assert.deepEqual(scan.written.map(v => v?.text ?? v?.status?.text).filter(Boolean), ['Point the camera at a FlyBot room code.', 'This browser cannot scan codes. Type the 6-digit number instead.'])
})

// The baselines may only shrink, and a pin leaves when its draw goes through `tr()`.
const MISSING_PINS = [
  'Enter a 6-digit number.', 'Choose which of your Bots join.',
  'Joining with that link…#1', 'Joining with that link…#2',
  'Looking up that room…#1', 'Looking up that room…#2',
  'This group is already in your sidebar.', 'Point the camera at a FlyBot room code.',
  'Scanned a group link.', 'Scanned an invite link.', 'Loading your Bots…',
  'Invites need a newer Bot Social. The 6-digit number still works.#1',
  'Invites need a newer Bot Social. The 6-digit number still works.#2',
  'Invites need a newer Bot Social. The 6-digit number still works.#3',
  'That is not an invite link. It looks like https://…/r/…',
  'That link has expired. Ask for a new one.', 'That link was withdrawn. Ask for a new one.',
  'You already joined with that link using other Bots. Leave the group first to join with different ones.',
  'That link is for this FlyBot’s own room.', 'Too many tries for now. Wait a minute and try again.',
  'That link does not open any room. Check that it was copied whole.',
  'Bot Social could not look up that link right now. Try again.',
  'That link cannot seat these Bots. Ask for a new one.',
  'That room cannot take guests right now.', 'This FlyBot has no Bot Social identity yet.',
  'This browser cannot scan codes. Type the 6-digit number instead.',
  'This browser cannot use a camera here. Type the 6-digit number instead.',
  'FlyBot cannot use the camera. Allow the camera for this page, or type the 6-digit number instead.',
  'That is not a FlyBot room code. Ask for the 6-digit number instead.',
  'The camera stopped before it read a code. Type the 6-digit number instead.',
]
const TEMPLATE_PINS = [
  'Asked to join {}. It opens in your sidebar as soon as their FlyBot seats your Bots.',
  'Scanned {}.', 'Scanned {}. Pick a Bot to join.',
  'Waiting for {} to let you in. If the group does not appear, press Join group to ask again.',
]
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries
test('#3114 cut 24: the baselines lose these draws and the dictionary gains the keys', () => {
  const pinned = entriesOf('i18n-missing-entries.baseline.json')
  const still = MISSING_PINS.map(key => `plugins/social/client.js:${key}`).filter(id => pinned.includes(id))
  assert.deepEqual(still, [], `i18n-missing-entries still pins ${still.join(', ')}`)
  const templates = TEMPLATE_PINS.map(key => `plugins/social/client.js:${key}`).filter(id => entriesOf('i18n-template-draws.baseline.json').includes(id))
  assert.deepEqual(templates, [], `i18n-template-draws still pins ${templates.join(', ')}`)
  assert.deepEqual(entriesOf('i18n-plugins.baseline.json').filter(id => id === 'plugins/social/client.js:Your Bots'), [], 'the bare-draw baseline still pins Your Bots')

  // The English is today's English, verbatim: a key renamed on one side only is a red test.
  const added = {
    'Enter a 6-digit number.': '请输入 6 位数字。',
    'Choose which of your Bots join.': '请选择用哪些 Bot 加入。',
    'Joining with that link…': '正在用这条链接加入…',
    'Looking up that room…': '正在查找那个房间…',
    'This group is already in your sidebar.': '这个群已经在你的侧边栏里了。',
    'Point the camera at a FlyBot room code.': '把镜头对准 FlyBot 房间码。',
    'Scanned a group link.': '已扫描到群链接。',
    'Scanned an invite link.': '已扫描到邀请链接。',
    'Loading your Bots…': '正在加载你的 Bot…',
    'Scanned {code}.': '已扫描到 {code}。',
    'Scanned {code}. Pick a Bot to join.': '已扫描到 {code}。选一个 Bot 加入。',
    'Waiting for {who} to let you in. If the group does not appear, press Join group to ask again.': '正在等 {who} 放你进去。如果群没有出现，再按一次「加入群」重新申请。',
    'Asked to join {name}. It opens in your sidebar as soon as their FlyBot seats your Bots.': '已申请加入 {name}。对方的 FlyBot 放好你的 Bot 后，群会出现在你的侧边栏。',
    'the group': '那个群',
    'the group’s owner': '那个群的主人',
    'This FlyBot has not approved the request yet, so their group has not been asked.': '这个 FlyBot 还没批准这次申请，所以对方的群还没收到请求。',
    'Their FlyBot was not asked. Check the link and try again.': '对方的 FlyBot 没有收到请求。检查链接后再试一次。',
    'Could not join that room. Try another number.': '没能加入那个房间。换一个号码试试。',
    'Could not join that room with that link.': '没能用那条链接加入那个房间。',
    'A group on another FlyBot': '另一个 FlyBot 上的群',
    'Invites need a newer Bot Social. The 6-digit number still works.': '邀请需要更新版本的 Bot Social。6 位号码仍然可用。',
    'That is not an invite link. It looks like https://…/r/…': '这不是邀请链接。它看起来像 https://…/r/…',
    'That link has expired. Ask for a new one.': '这条链接已过期。向他们要一条新的。',
    'That link was withdrawn. Ask for a new one.': '这条链接已被撤回。向他们要一条新的。',
    'You already joined with that link using other Bots. Leave the group first to join with different ones.': '你已经用别的 Bot 通过这条链接加入过了。想换 Bot 请先退出那个群。',
    'That link is for this FlyBot’s own room.': '这条链接是给这个 FlyBot 自己的房间用的。',
    'Too many tries for now. Wait a minute and try again.': '尝试次数太多了。等一分钟再试。',
    'That link does not open any room. Check that it was copied whole.': '这条链接打不开任何房间。检查一下是否复制完整。',
    'Bot Social could not look up that link right now. Try again.': 'Bot Social 现在查不了这条链接。请再试一次。',
    'That link cannot seat these Bots. Ask for a new one.': '这条链接放不下这些 Bot。向他们要一条新的。',
    'That room cannot take guests right now.': '那个房间现在不能接待访客。',
    'This FlyBot has no Bot Social identity yet.': '这个 FlyBot 还没有 Bot Social 身份。',
    'This browser cannot scan codes. Type the 6-digit number instead.': '这个浏览器不能扫码。请直接输入 6 位号码。',
    'This browser cannot use a camera here. Type the 6-digit number instead.': '这个浏览器在这里用不了摄像头。请直接输入 6 位号码。',
    'FlyBot cannot use the camera. Allow the camera for this page, or type the 6-digit number instead.': 'FlyBot 用不了摄像头。给这个页面开放摄像头权限，或直接输入 6 位号码。',
    'That is not a FlyBot room code. Ask for the 6-digit number instead.': '这不是 FlyBot 房间码。向他们要 6 位号码吧。',
    'The camera stopped before it read a code. Type the 6-digit number instead.': '摄像头还没读到码就停了。请直接输入 6 位号码。',
  }
  for (const [key, value] of Object.entries(added)) assert.equal(zh[key], value, `the dictionary carries ${key}`)
  assert.equal(zh['Your Bots'], '你的 Bot', 'the picker’s name reuses the entry it already has')
})
