import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #457: a face-to-face room is person-first. One entry per person (count = people, "(you)" only on
// the person), every Bot named "Bot (Person)" (mine too), a sent mention stays bound to the Bot it
// named after that person leaves, and my own line keeps one colour and has my person mark.

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
const plain = value => JSON.parse(JSON.stringify(value))
const text = node => find(node, () => true).flatMap(n => n.children ?? []).filter(child => typeof child === 'string').join('')

const { facePeople, facePersonLabel, faceBotLabel } = await load('face-seats.js')
const { FacePersonRow, roomSubtitle } = await load('group-settings.js')
const { mentionableBots, userTextParts, UserMessageCell } = await load('user-message.js')
const { RemoteMessage, remoteSpeaker } = await load('cells.js')

// The self-test room: A (SelfA0056) brought Chief and Researcher, B (SelfB0056, me) brought Chief.
const chiefB = { id: 'b1', name: 'Chief' }
const seatB = { kind: 'bot', id: 'b1', handle: '@chief.selfb0056.home', displayName: 'Chief', ownerName: 'SelfB0056' }
const chiefA = { kind: 'bot', remote: true, id: '@chief.selfa0056.home', handle: '@chief.selfa0056.home', displayName: 'Chief', ownerName: 'SelfA0056' }
const researcherA = { kind: 'bot', remote: true, id: '@researcher.selfa0056.home', handle: '@researcher.selfa0056.home', displayName: 'Researcher', ownerName: 'SelfA0056', label: 'Researcher · SelfA0056' }
const onB = (participants = [seatB, chiefA, researcherA], extra = {}) => ({
  self: { memberId: 'm1', displayName: 'SelfB0056' },
  bots: [chiefB],
  byId: { b1: chiefB },
  roomsById: { r: { id: 'r', origin: 'face-to-face', members: ['b1'], participants, ...extra } },
})

test('one entry per person, mine first, "(you)" only on the person, count = people', () => {
  const roster = onB()
  const people = facePeople(roster.roomsById.r, roster)
  assert.deepEqual(plain(people.map(facePersonLabel)), ['SelfB0056 (you)', 'SelfA0056'])
  assert.deepEqual(plain(people.map(person => person.seats.map(seat => seat.bot))), [['Chief'], ['Chief', 'Researcher']])
  assert.equal(roomSubtitle(roster.roomsById.r, roster), '2 people · 3 Bots')

  const opened = []
  const row = expand(FacePersonRow({ person: people[1], onOpenBot: id => opened.push(id) }), ['PersonMark'])
  assert.equal(row.props['data-flybot'], 'face-person')
  assert.equal(find(row, n => String(n.props?.className ?? '').split(' ').includes('bt-person-mark')).length, 1, 'a person mark, not a Bot avatar')
  const words = node => text(find(node, n => n.props?.className === 'bt-face-person-text')[0])
  assert.match(words(row), /^SelfA0056Chief, Researcher$/)
  assert.equal(find(row, n => n.type === 'button').length, 0, "another person's Bots are not my chats")
  const mine = expand(FacePersonRow({ person: people[0], onOpenBot: id => opened.push(id) }), ['PersonMark'])
  assert.equal(mine.props['data-mine'], true)
  assert.match(words(mine), /^SelfB0056 \(you\)Chief$/)
  find(mine, n => n.type === 'button')[0].props.onClick()
  assert.deepEqual(opened, ['b1'], 'my own Bot opens its chat')
  // No Bot is ever "(you)".
  assert.doesNotMatch(JSON.stringify(people.flatMap(person => person.seats.map(seat => seat.bot))), /\(you\)/)
})

test('my own Bot reads "Chief (SelfB0056)" in the room, a plain name elsewhere', () => {
  const roster = onB()
  assert.equal(faceBotLabel(roster.roomsById.r, roster, chiefB), 'Chief (SelfB0056)')
  assert.equal(faceBotLabel({ origin: undefined, members: ['b1'], participants: [] }, roster, chiefB), 'Chief')
})

test('a sent mention stays bound to the Bot it named after that person leaves', () => {
  const sent = '@Chief (SelfA0056) what noodle dish?'
  const live = onB()
  assert.equal(userTextParts(sent, mentionableBots(live, 'r'))[0].bot.id, '@chief.selfa0056.home')
  // A left: its seats keep leftSeq. The chip is still A's Chief, never my own Chief.
  const gone = onB([seatB, { ...chiefA, leftSeq: 7 }, { ...researcherA, leftSeq: 7 }])
  const parts = userTextParts(sent, mentionableBots(gone, 'r'))
  assert.equal(parts[0].bot.id, '@chief.selfa0056.home')
  assert.equal(parts[0].bot.mentionLabel, 'Chief (SelfA0056)')
  assert.equal(parts[1].text, ' what noodle dish?')
  // A bare "@Chief" is still mine, as before.
  assert.equal(userTextParts('@Chief hi', mentionableBots(gone, 'r'))[0].bot.id, 'b1')
})

test('a Bot bubble header in a face room is "Bot (Person)", no handle and no lowercase id', () => {
  const roster = onB()
  const source = { remote: { handle: '@researcher.selfa0056.home' }, senderName: 'Researcher · SelfA0056' }
  assert.equal(remoteSpeaker(source, roster, 'r').name, 'Researcher (SelfA0056)')
  const drawn = RemoteMessage({ source, text: 'Try the noodles.', roster, actions: {}, sessionId: 'r' })
  const header = find(drawn, n => n.props?.className === 'bt-group-name')[0]
  assert.equal(text(header), 'Researcher (SelfA0056)')
  assert.equal(header.props.title, '@researcher.selfa0056.home', 'the handle is on hover only')
  assert.equal(find(drawn, n => n.props?.className === 'bt-remote-handle').length, 0)
  // Still named after the person left.
  const gone = onB([seatB, { ...researcherA, leftSeq: 3 }])
  assert.equal(remoteSpeaker(source, gone, 'r').name, 'Researcher (SelfA0056)')
})

test('my own face-room line keeps one colour and has my name and person mark', () => {
  const roster = onB(undefined, { pendingCount: 2 })
  const node = { kind: 'user', data: { content: [{ type: 'text', text: 'hello' }], source: { authorId: 'm1', authorKind: 'human', authorName: 'Danyang' } } }
  const cell = expand(UserMessageCell({ node, sessionId: 'r', useRoster: select => select(roster), actions: {} }), ['PersonMark'])
  assert.equal(cell.props['data-held'], undefined, 'a Bot reply waiting elsewhere in the room does not grey my line')
  assert.equal(cell.props['data-face-mine'], true)
  assert.equal(find(cell, n => String(n.props?.className ?? '').split(' ').includes('bt-person-mark')).length, 1)
  assert.equal(text(find(cell, n => n.props?.className === 'bt-uauthor')[0]), 'SelfB0056')
})
