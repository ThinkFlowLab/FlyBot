import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { lookAvoidingLocals, lookKey, lookOf } from '../src/client/characters.js'
import { indexRoster } from '../src/client/sources.js'

// A face-room @ row and the mention chip used to draw a stand-in whose color and
// avatar lived only on `remote`. lookOf ignores that and seeds the handle, so
// @chief.selfa1025.home is a green moon while the sidebar chat is the stored blue whale.
// BotMark then steps that whale when a local Bot of the same name draws it (#1069).

const HANDLE = '@chief.selfa1025.home'

async function load(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: (name) => {
      const platform = {
        react: {
          Component: class {}, createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
          useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
          useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useSyncExternalStore: (sub, get) => get(), Fragment: 'fragment',
        },
        'react-dom': { createPortal: node => node },
        '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: function MarkdownText() { return null }, projectUserText: text => text },
      }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  return module.exports
}

const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: (node.children ?? []).map(child => expand(child, names)) }
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}

const { mentionRows } = await load('at-menu.js')
const { menuIcons } = await load('composer.js')
const { UserMessageCell } = await load('user-message.js')

const local = { id: 'b1', name: 'Chief', color: 'deepseek', avatar: { shape: 'whale' }, sessionId: 'b1' }
const chat = { id: 'remote-1', name: 'Chief', color: '#4d6bfe', avatar: { shape: 'whale' }, remote: { handle: HANDLE, homeName: 'SelfA1025', owner: 'SelfA1025' } }
const seat = { kind: 'bot', remote: true, id: HANDLE, handle: HANDLE, displayName: 'Chief', ownerName: 'SelfA1025', isChief: true, color: '#4d6bfe', avatar: { shape: 'whale' } }
const mine = { kind: 'bot', id: 'b1', handle: '@chief.selfb.home', displayName: 'Chief', ownerName: 'SelfB' }

function roomRoster(bots) {
  return indexRoster({
    self: { displayName: 'SelfB' },
    bots,
    mainBotIds: ['b1'],
    rooms: [{ id: 'room', origin: 'face-to-face', name: 'Face', members: ['b1'], participants: [mine, seat] }],
  })
}

const storedKey = lookKey(lookOf(chat))
const seededKey = lookKey(lookOf({ id: HANDLE, name: 'Chief (SelfA1025)', remote: seat, handle: HANDLE }))
// The picture BotMark paints: the stored record, stepped off a same-named local Chief.
const drawnKey = bot => lookKey(lookAvoidingLocals(bot))

function iconBot(roster, row) {
  const Icon = menuIcons({ getSnapshot: () => roster })(row)
  const drawn = Icon({ size: 14 })
  assert.equal(drawn.type?.name, 'BotMark')
  return drawn.props.bot
}

function chipBot(roster, text) {
  const cell = UserMessageCell({
    node: { kind: 'user', data: { content: [{ type: 'text', text }] } },
    sessionId: 'room',
    useRoster: select => select(roster),
    actions: { openSession() {} },
  })
  const marks = find(expand(cell, ['UserText']), node => node.type?.name === 'BotMark')
  assert.equal(marks.length, 1)
  return marks[0].props.bot
}

test('the reported handle seed is a green moon, not the stored blue whale', () => {
  assert.equal(seededKey, 'shape:moon:green')
  assert.equal(storedKey, 'shape:whale:#4d6bfe')
  assert.notEqual(seededKey, storedKey)
})

test('a face-room @ row and mention chip draw the stored friend look, not the handle seed (#1088)', () => {
  const roster = roomRoster([local, chat])
  const rows = mentionRows(roster, 'room')
  const friend = rows.find(row => row.bot?.remote)
  const mineRow = rows.find(row => row.bot && !row.bot.remote)
  assert.ok(friend)
  assert.equal(iconBot(roster, friend).id, chat.id)
  assert.equal(lookKey(lookOf(iconBot(roster, friend))), storedKey)
  assert.equal(drawnKey(iconBot(roster, friend)), drawnKey(chat))
  assert.notEqual(drawnKey(chat), seededKey)
  assert.notEqual(drawnKey(chat), lookKey(lookOf(local)))
  assert.equal(lookKey(lookOf(iconBot(roster, mineRow))), lookKey(lookOf(local)))
  const chip = chipBot(roster, "@SelfA1025's Chief hi")
  assert.equal(chip.id, chat.id)
  assert.equal(lookKey(lookOf(chip)), storedKey)
  assert.equal(drawnKey(chip), drawnKey(chat))
  // The chip still names the seat. The picture is the stored chat, the label is not.
  const cell = expand(UserMessageCell({
    node: { kind: 'user', data: { content: [{ type: 'text', text: "@SelfA1025's Chief hi" }] } },
    sessionId: 'room',
    useRoster: select => select(roster),
    actions: { openSession() {} },
  }), ['UserText'])
  const button = find(cell, node => node.props?.className === 'bt-umention')[0]
  assert.match(JSON.stringify(button.children), /Chief \(SelfA1025\)/)
})

test('a face-room seat look is drawn when the friend has no chat yet (#1088)', () => {
  const roster = roomRoster([local])
  const friend = mentionRows(roster, 'room').find(row => row.bot?.remote)
  const icon = iconBot(roster, friend)
  const chip = chipBot(roster, "@SelfA1025's Chief hi")
  assert.equal(lookKey(lookOf(icon)), storedKey)
  assert.equal(lookKey(lookOf(chip)), storedKey)
  assert.equal(drawnKey(icon), drawnKey(chip))
  assert.equal(drawnKey(icon), drawnKey(chat))
  assert.notEqual(drawnKey(icon), seededKey)
})
