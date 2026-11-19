// #3114 cut 25: the invite card inside an open face-to-face room — the `Link ready` button, the QR's
// name and hint, the `Copied` state, the no-deadline line and the error a mint with no link comes back
// with — drew English in a zh window. A zh window reads the dictionary's words, a host with no
// translator keeps today's English word for word, and the baselines lose these pins.
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

// The room overview keeps five hook slots before its children: busy, note, tick, snapshot, dialog
// tick. The open branch then draws ConfirmLeave (ask), FaceAutoSendControl (on, busy, error) and
// FaceInviteCard (invite, busy, copied, tick). A setter records what the card would draw next, so a
// mint with no link can be read without a browser.
function loadApp(flybot, states = []) {
  const registered = []
  const sandbox = { window: { __ModuleLoader__: { load: entry => registered.push(entry) } }, console, setTimeout, clearTimeout, setInterval, clearInterval }
  sandbox.globalThis = sandbox
  sandbox.__flybot__ = flybot
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  const written = []
  let seed = 0
  const app = registered[0].factory(() => ({
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'F', useEffect() {}, useMemo: fn => fn(), useRef: value => ({ current: value }),
    useState: (value) => {
      const at = seed++
      return [at < states.length ? states[at] : value, next => written.push({ at, value: typeof next === 'function' ? next(at < states.length ? states[at] : value) : next })]
    },
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
const ROOM = { id: 'g1', origin: 'face-to-face', face: { roomId: 'frm_1', status: 'open' }, participants: [] }
const props = { room: ROOM, roster: { byId: {} } }
const inviteState = (invite = null) => ['', null, 0, null, 0, false, {}, '', '', invite, false, true, 0]
const open = (flybot, invite, more = {}) => {
  const ui = loadApp(flybot, [...inviteState(invite), ...(more.states ?? [])])
  return { ...ui, nodes: walk(ui.app.FaceRoomOverview(props)) }
}
const LINK = { url: 'https://social.example/r/abc123', ticket: 'tkt_1' }

test('#3114 cut 25: the room invite card speaks the window’s language', () => {
  const { nodes } = open(zhWindow, LINK)
  assert.ok(textsOf([byId(nodes, 'face-invite-mint')]).includes('链接已就绪'), 'the mint button is still "Link ready"')
  assert.equal(nodes.find(node => node.props.className === 'fs-qr-svg')?.props['aria-label'], '这个房间邀请的二维码', 'the QR’s name is still English')
  assert.ok(textsOf([byId(nodes, 'face-invite-qr-hint')]).includes('扫码打开这个房间'), 'the QR’s hint is still English')
  assert.ok(textsOf([byId(nodes, 'face-invite-copy')]).includes('已复制'), 'the copied state is still "Copied"')
  assert.ok(textsOf([byId(nodes, 'face-invite-count')]).includes('只要房间还开着，拿到链接的人都能加入。'), 'the no-deadline line is still English')
})

test('a mint with no link comes back in the window’s language', async () => {
  const { nodes, written } = open(zhWindow, null)
  byId(nodes, 'face-invite-mint').props.onClick()
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(written.filter(item => item.at === 9).map(item => item.value?.error), ['Bot Social 没有发来邀请，请重试。'])
})

test('no translator keeps today’s English in the invite card', () => {
  const { nodes } = open(bareWindow, LINK)
  assert.ok(textsOf([byId(nodes, 'face-invite-mint')]).includes('Link ready'))
  assert.equal(nodes.find(node => node.props.className === 'fs-qr-svg')?.props['aria-label'], 'QR code for this room invite')
  assert.ok(textsOf([byId(nodes, 'face-invite-qr-hint')]).includes('Scan to open this room'))
  assert.ok(textsOf([byId(nodes, 'face-invite-copy')]).includes('Copied'))
  assert.ok(textsOf([byId(nodes, 'face-invite-count')]).includes('Anyone with the link can join while the room is open.'))
})

// The baselines may only shrink, and a pin leaves when its draw goes through `tr()`.
const MISSING_PINS = [
  'Link ready', 'QR code for this room invite',
  'Scan to open this room', 'Anyone with the link can join while the room is open.',
]
const entriesOf = file => JSON.parse(readFileSync(new URL(`../../../core/test/${file}`, import.meta.url), 'utf8')).entries
test('the baselines lose these draws and the dictionary gains the keys', () => {
  const pinned = entriesOf('i18n-missing-entries.baseline.json')
  const still = MISSING_PINS.map(key => `plugins/social/client.js:${key}`).filter(id => pinned.includes(id))
  assert.deepEqual(still, [], `i18n-missing-entries still pins ${still.join(', ')}`)
  const copies = entriesOf('i18n-plugins.baseline.json').filter(id => id.startsWith('plugins/social/client.js:Copied'))
  assert.deepEqual(copies, ['plugins/social/client.js:Copied'], 'the bare-draw baseline keeps exactly one social Copied')

  // The English is today's English, verbatim: a key renamed on one side only is a red test.
  const added = {
    'Link ready': '链接已就绪',
    'QR code for this room invite': '这个房间邀请的二维码',
    'Scan to open this room': '扫码打开这个房间',
    'Anyone with the link can join while the room is open.': '只要房间还开着，拿到链接的人都能加入。',
    'Bot Social did not send an invite. Try again.': 'Bot Social 没有发来邀请，请重试。',
  }
  for (const [key, value] of Object.entries(added)) assert.equal(zh[key], value, `the dictionary carries ${key}`)
  assert.equal(zh.Copied, '已复制', 'the copied state reuses the entry it already has')
})
