import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import * as labels from '../src/shared/remote-label.js'
import { presentRoom } from '../src/host/room-membership.js'

// #526: in a group chat or face room a friend's Bot read "Reviewer · FlyBot 682b8a43 (flybot682b8a43)":
// Bot Social's member label ("<Bot> · <owner>") as the Bot's name, then the owner again from its
// handle. Owner decision 2026-10-20 (option a): the #498 person-first name, "Reviewer (flybot682b8a43)",
// with an owner name made up from the install id replaced by the owner's username; the handle stays
// on hover.

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
          createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
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

const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}
const plain = value => JSON.parse(JSON.stringify(value))
const text = node => find(node, () => true).flatMap(n => n.children ?? []).filter(child => typeof child === 'string').join('')

const { facePeople, faceSeatLabel, faceSeats } = await load('face-seats.js')
const { FacePersonRow } = await load('group-settings.js')
const { RemoteMessage, remoteSpeaker } = await load('cells.js')

const { ownerNameOf, remoteBotTitle } = labels
// Added by #526; read through the namespace so the test also runs (red) on the tip before it.
const remoteBotName = record => labels.remoteBotName(record)
const isAutoOwnerName = name => labels.isAutoOwnerName(name)

const handle = '@reviewer.flybot682b8a43.home'
// The seat as Bot Social sends it for an owner who never set a name (face-rooms.ts memberLabel).
const reviewer = { kind: 'bot', remote: true, id: handle, handle, displayName: 'Reviewer', ownerName: 'FlyBot 682b8a43', label: 'Reviewer · FlyBot 682b8a43' }
const mine = { id: 'b1', name: 'Chief' }
const seatMine = { kind: 'bot', id: 'b1', handle: '@chief.ann.home', displayName: 'Chief', ownerName: 'Ann' }
const roster = (participants = [seatMine, reviewer], origin = 'face-to-face') => ({
  self: { memberId: 'm1', displayName: 'Ann' },
  bots: [mine],
  byId: { b1: mine },
  remoteBots: [],
  roomsById: { r: { id: 'r', origin, members: ['b1'], participants } },
})

test('#526: the reported label becomes Bot name + owner username', () => {
  // The bubble header with no seat to read (a group chat, a seat not synced yet): the sender label.
  const source = { remote: { handle }, senderName: 'Reviewer · FlyBot 682b8a43' }
  assert.equal(remoteSpeaker(source, { bots: [], remoteBots: [] }).name, 'Reviewer (flybot682b8a43)')
  assert.equal(remoteBotTitle({ displayName: 'Reviewer · FlyBot 682b8a43', handle }), 'Reviewer (flybot682b8a43)')
  assert.equal(remoteBotTitle({ displayName: 'Reviewer', ownerName: 'FlyBot 682b8a43', handle }), 'Reviewer (flybot682b8a43)')
  assert.equal(ownerNameOf({ ownerName: 'FlyBot 682b8a43', ownerHome: '@flybot682b8a43.home' }), 'flybot682b8a43')
})

test('#526: a face room names that Bot and its person the same way, the id on hover', () => {
  const view = roster()
  const seat = faceSeats(view.roomsById.r, view).find(item => !item.mine)
  assert.equal(faceSeatLabel(seat), 'Reviewer (flybot682b8a43)')
  const people = facePeople(view.roomsById.r, view)
  assert.deepEqual(plain(people.map(person => person.name)), ['Ann', 'flybot682b8a43'])
  const row = FacePersonRow({ person: people[1] })
  const bot = find(row, n => n.props?.className === 'bt-face-bot')[0]
  assert.equal(text(bot), 'Reviewer')
  assert.equal(bot.props.title, handle, 'the full handle stays in the tooltip')

  const source = { remote: { handle }, senderName: 'Reviewer · FlyBot 682b8a43' }
  assert.equal(remoteSpeaker(source, view, 'r').name, 'Reviewer (flybot682b8a43)')
  const drawn = RemoteMessage({ source, text: 'LGTM', roster: view, actions: {}, sessionId: 'r' })
  const header = find(drawn, n => n.props?.className === 'bt-group-name')[0]
  assert.equal(text(header), 'Reviewer (flybot682b8a43)')
  assert.equal(header.props.title, handle)

  // The host's room view (Members panel, @ menu labels) says the same.
  const shown = presentRoom({ id: 'r', origin: 'face-to-face', members: ['b1'], participants: [seatMine, reviewer], log: [] }, undefined, { bots: {}, rooms: {} })
  assert.equal(shown.presentedParticipants.find(p => p.handle === handle).label, 'Reviewer (flybot682b8a43)')
  // My own Bot when my own owner name is the made-up one.
  const auto = roster([{ ...seatMine, handle: '@chief.flybot1a2b3c4d.home', ownerName: 'FlyBot 1a2b3c4d' }, reviewer])
  assert.equal(faceSeatLabel(faceSeats(auto.roomsById.r, auto).find(item => item.mine)), 'Chief (flybot1a2b3c4d)')
})

test('#526: real names stay as they are', () => {
  assert.equal(remoteBotTitle({ displayName: 'Coder', ownerName: 'Bob', handle: '@coder.bob.home' }), 'Coder (Bob)')
  // A "·" in a Bot's own name is not an owner label.
  assert.equal(remoteBotTitle({ displayName: 'Ops · Night', ownerName: 'Bob', handle: '@ops.bob.home' }), 'Ops · Night (Bob)')
  assert.equal(remoteBotName({ displayName: 'Coder · Bob', handle: '@coder.bob.home' }), 'Coder')
  // A person really called FlyBot, or a home renamed FlyBot2 on a taken handle (#136), keeps that name.
  for (const name of ['FlyBot', 'FlyBot2', 'FlyBot Team', 'Flybot fan']) assert.equal(isAutoOwnerName(name), false, name)
  assert.equal(remoteBotTitle({ displayName: 'Helper', ownerName: 'FlyBot2', handle: '@helper.flybot2.home' }), 'Helper (FlyBot2)')
  // No username to fall back on: the made-up name is still better than none.
  assert.equal(remoteBotTitle({ displayName: 'Helper', ownerName: 'FlyBot 682b8a43' }), 'Helper (FlyBot 682b8a43)')
  // A group chat (not face to face) seat reads the same.
  const view = roster([seatMine, { ...reviewer, label: undefined }], 'group')
  assert.equal(remoteSpeaker({ remote: { handle }, senderName: 'Reviewer' }, view, 'r').name, 'Reviewer (flybot682b8a43)')
})
