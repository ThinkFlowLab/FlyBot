import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #1104: room details drew one pink S for SelfA1025 and SelfB1025. The chat already
// tells those Chiefs apart (local whale, the friend's same whale stepped aside).

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

const settings = await load('group-settings.js')
const { FacePersonRow } = settings
const { facePeople } = await load('face-seats.js')
const { personInitial } = await load('mark.js')

const HANDLE = '@chief.selfa1025.home'
const chiefB = { id: 'b1', name: 'Chief', color: 'deepseek', avatar: { shape: 'whale' } }
const chiefA = {
  id: 'remote-a', name: 'Chief', color: '#4d6bfe', avatar: { shape: 'whale' },
  remote: { handle: HANDLE, homeName: 'SelfA1025', owner: 'SelfA1025' },
}
const seatB = { kind: 'bot', id: 'b1', handle: '@chief.selfb1025.home', displayName: 'Chief', ownerName: 'SelfB1025' }
const seatA = {
  kind: 'bot', remote: true, id: HANDLE, handle: HANDLE, displayName: 'Chief', ownerName: 'SelfA1025',
  color: '#4d6bfe', avatar: { shape: 'whale' },
}

function roster(participants = [seatB, seatA], bots = [chiefB, chiefA]) {
  return {
    self: { displayName: 'SelfB1025' },
    bots,
    byId: { b1: chiefB },
    roomsById: { r: { id: 'r', origin: 'face-to-face', name: '739184', members: ['b1'], participants } },
  }
}

function rowsOf(view) {
  settings.setLocalBots?.(view.bots)
  const people = facePeople(view.roomsById.r, view)
  return people.map(person => expand(FacePersonRow({ person, roster: view }), ['BotMark', 'PersonMark']))
}
const shapesOf = row => find(row, n => typeof n.props?.['data-shape'] === 'string').map(n => n.props['data-shape'])

test('#1104: SelfA1025 and SelfB1025 share an initial, so a letter mark cannot tell the homes apart', () => {
  const view = roster()
  const people = facePeople(view.roomsById.r, view)
  // Copy out of the bundled realm; a vm array is not reference-equal to a host array.
  assert.deepEqual(JSON.parse(JSON.stringify(people.map(person => person.name))), ['SelfB1025', 'SelfA1025'])
  assert.equal(personInitial(people[0].name), 'S')
  assert.equal(personInitial(people[1].name), 'S')
})

test('#1104: member rows draw each home\'s chat look, not the same initial', () => {
  const drawn = rowsOf(roster())
  const shapes = drawn.map(shapesOf)
  assert.deepEqual(shapes[0], ['whale'], 'my Chief stays the whale the sidebar and the transcript draw')
  assert.equal(shapes[1].length, 1)
  assert.notEqual(shapes[1][0], 'whale', 'the friend\'s same whale is stepped, as the chat mark is')
  assert.equal(find(drawn, n => n.props?.['data-initial'] === 'S').length, 0)
  for (const row of drawn) {
    const mark = find(row, n => typeof n.props?.['data-shape'] === 'string')[0]
    assert.ok(mark)
    assert.equal(find(mark, n => n.type === 'svg').length, 1, 'a character, not a blank disc')
  }
  if (typeof settings.faceMemberLook === 'function' && typeof settings.faceSeatBot === 'function' && typeof settings.lookKey === 'function') {
    const view = roster()
    settings.setLocalBots(view.bots)
    const people = facePeople(view.roomsById.r, view)
    const keys = people.map(person => settings.lookKey(settings.faceMemberLook(settings.faceSeatBot(person.seats[0], view))))
    assert.match(keys[0], /^shape:whale:/)
    assert.notEqual(keys[0], keys[1])
    assert.deepEqual(shapes, people.map(person => [settings.faceMemberLook(settings.faceSeatBot(person.seats[0], view)).shape]))
  }
})

test('#1104: a seat with no stored look still draws a seeded character (#1089)', () => {
  const bareA = { kind: 'bot', remote: true, id: '@chief.selfa1025.home', handle: '@chief.selfa1025.home', displayName: 'Chief', ownerName: 'SelfA1025' }
  const bareB = { kind: 'bot', id: 'b1', handle: '@chief.selfb1025.home', displayName: 'Chief', ownerName: 'SelfB1025' }
  const plain = { id: 'b1', name: 'Chief' }
  const drawn = rowsOf({
    self: { displayName: 'SelfB1025' },
    bots: [plain],
    byId: { b1: plain },
    roomsById: { r: { id: 'r', origin: 'face-to-face', members: ['b1'], participants: [bareB, bareA] } },
  })
  const shapes = drawn.map(shapesOf)
  assert.equal(shapes.length, 2)
  for (const shape of shapes) {
    assert.equal(shape.length, 1)
    assert.match(shape[0], /^[a-z]/)
  }
  assert.equal(find(drawn, n => n.props?.['data-initial']).length, 0)
  const view = {
    self: { displayName: 'SelfB1025' },
    bots: [plain],
    byId: { b1: plain },
    roomsById: { r: { id: 'r', origin: 'face-to-face', members: ['b1'], participants: [bareB, bareA] } },
  }
  settings.setLocalBots(view.bots)
  const people = facePeople(view.roomsById.r, view)
  const keys = people.map(person => settings.lookKey(settings.faceMemberLook(settings.faceSeatBot(person.seats[0], view))))
  assert.equal(keys.length, 2)
  assert.notEqual(keys[0], keys[1], 'a seeded shape or color still tells the homes apart')
  const looked = people.map(person => [settings.faceMemberLook(settings.faceSeatBot(person.seats[0], view)).shape])
  assert.equal(JSON.stringify(shapes), JSON.stringify(looked))
})
