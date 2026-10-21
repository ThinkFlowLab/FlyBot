import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/member-status.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, Fragment: 'fragment' },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { busyMembers, summaryText, splitBusy, MemberDock, MemberWork, MEMBER_CSS } = module.exports
// Values from the bundle's realm compare by content only.
const plain = value => JSON.parse(JSON.stringify(value))
// Renders the dock's own parts of an element tree, and lists its rows' labels.
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (['WorkRow', 'SummaryLine'].includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(expand) }
}
const rowLabels = (node) => {
  if (Array.isArray(node)) return node.flatMap(rowLabels)
  if (node === null || typeof node !== 'object') return []
  return [...(node.props.className === 'bt-mw-row' ? [node.props['aria-label']] : []), ...rowLabels(node.children)]
}

test('the members line names who waits for an approval first, then who is at work', () => {
  const names = { a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill', e: 'King', f: 'Comet' }
  const roster = { byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])) }
  const room = { id: 'g', members: ['e', 'd', 'a', 'b', 'c', 'f'] }
  const work = {
    rooms: { g: [{ botId: 'd', since: 1, tool: 'edit' }, { botId: 'a', since: 1, tool: 'pwsh' }, { botId: 'f', since: 1 }] },
    approvals: [{ botId: 'a', roomId: 'g' }, { botId: 'b', roomId: 'g' }, { botId: 'c', roomId: 'g' }],
  }
  const busy = busyMembers(room, work, roster)
  assert.deepEqual(plain(busy.map(entry => [entry.bot.name, entry.state])), [['Anvil', 'ask'], ['Flint', 'ask'], ['Prism', 'ask'], ['Quill', 'work'], ['Comet', 'work']])
  assert.deepEqual(plain(summaryText(busy)), { waiting: 'Anvil, Flint and 1 more are waiting for your approval', doing: 'Quill · Writing changes… +1' })
  assert.deepEqual(plain(summaryText(busy.slice(1, 3))), { waiting: 'Flint and Prism are waiting for your approval', doing: '' })
  assert.deepEqual(plain(summaryText(busy.slice(4))), { waiting: '', doing: 'Comet · Thinking about it…' })
  assert.equal(busyMembers(room, { bots: {}, approvals: [] }, roster).length, 0)
})

const names = { a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill' }
const team = {
  byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])),
  roomsById: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c', 'd'] }, r2: { id: 'r2', name: 'Docs', members: ['a', 'b'] } },
}
const dock = (sessionId, work) => expand(MemberDock({ sessionId, useRoster: pick => pick(team), useWork: pick => pick(work), actions: {} }))

test('a member at work in the group gets a row, the speaker first; approvals go on the line, work elsewhere nowhere', () => {
  const work = {
    // Anvil runs in its own chat too; its work here wins.
    bots: { a: { since: 1, tool: 'pwsh' }, b: { since: 1, roomId: 'r2', tool: 'edit' } },
    rooms: { r1: [{ botId: 'a', since: 1, tool: 'write' }, { botId: 'd', since: 1, speaking: true }], r2: [{ botId: 'b', since: 1, tool: 'edit' }] },
    approvals: [{ botId: 'c', roomId: 'r1' }],
  }
  const busy = busyMembers(team.roomsById.r1, work, team)
  const { rows, rest } = splitBusy(busy)
  assert.deepEqual(plain(rows.map(entry => [entry.bot.name, entry.doing.tool, entry.doing.roomId])), [['Quill', null, 'r1'], ['Anvil', 'write', 'r1']])
  assert.deepEqual(plain(rest.map(entry => [entry.bot.name, entry.state])), [['Prism', 'ask']])
  assert.deepEqual(rowLabels(dock('r1', work)), ['Quill · Thinking about it…', 'Anvil · Writing changes…'])
  assert.deepEqual(plain(busyMembers(team.roomsById.r2, work, team).map(entry => [entry.bot.name, entry.state])), [['Flint', 'work']])
})

test('a Bot\'s own chat shows the groups it is at work in, unless its own chat runs', () => {
  const away = { bots: { a: { since: 1, roomId: 'r1', tool: 'pwsh' } }, rooms: { r1: [{ botId: 'a', since: 1, tool: 'pwsh' }], r2: [{ botId: 'a', since: 1 }] }, approvals: [] }
  assert.deepEqual(rowLabels(dock('a', away)), ['in Ops · Running shell commands…', 'in Docs · Thinking about it…'])
  assert.deepEqual(rowLabels(dock('a', { ...away, bots: { a: { since: 1 } } })), [])
  assert.equal(dock('b', away), null)
})

// #540: the approval card offers a standing grant next to Reject / Allow once.
const cardButtons = (approval, bot) => {
  const tree = MemberWork({ entry: { state: 'ask', approvals: [approval] }, bot, room: { id: 'r1' }, roster: team, actions: {}, now: 0 })
  const card = tree.children.find(node => node?.type?.name === 'ApprovalCard')
  const walk = node => (node === null || typeof node !== 'object' ? [] : [...(node.type === 'button' ? [[node.props['data-choice'] ?? '', node.children.join('')]] : []), ...node.children.flatMap(walk)])
  return plain(walk(card.type(card.props)))
}

test('the approval card offers Always allow for this Bot, and for this group when the ask came from one', () => {
  const ask = { id: 'p1', tool: 'bash', reason: 'escalate sandbox to danger-full-access: grep', answerable: true }
  assert.deepEqual(cardButtons({ ...ask, roomId: 'r1' }, { id: 'a', name: 'Anvil' }), [['', 'Reject'], ['', 'Allow once'], ['always-bot', 'Always allow for this Bot'], ['always-room', 'Always allow for this group']])
  assert.deepEqual(cardButtons(ask, { id: 'a', name: 'Anvil' }).map(([choice]) => choice), ['', '', 'always-bot'])
  // A friend's Bot is not the viewer's to give a standing grant to.
  assert.deepEqual(cardButtons({ ...ask, roomId: 'r1' }, { id: 'x', name: 'X', remote: { handle: '@x' } }).map(([choice]) => choice), ['', ''])
})

// Owner report 2026-10-20: one member's row sat left with its time, another's centered or
// right with neither, and both said only "On it…" or "Running shell commands…".
const nodes = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...nodes(node.children, match)]
}
const textOf = node => (Array.isArray(node) ? node.map(textOf).join('') : node === null || typeof node !== 'object' ? String(node ?? '') : textOf(node.children))

test('every member at work in the group, the speaker too, gets the same left row with its step and time', () => {
  const now = Date.now()
  const work = {
    bots: { a: { since: now - 11 * 60000, roomId: 'r1', tool: 'pwsh', step: 'npm test' }, b: { since: now - 3 * 60000, tool: 'mcp_custom_tool' } },
    rooms: { r1: [{ botId: 'a', since: now - 11 * 60000, tool: 'pwsh', speaking: true }, { botId: 'd', since: now - 2 * 60000, tool: 'grep' }] },
    approvals: [{ id: 'p1', botId: 'c', roomId: 'r1', at: now - 60000 }],
  }
  // The dock's clock is a stub here, so the rows draw at a real now.
  const at = node => (Array.isArray(node) ? node.map(at) : node === null || typeof node !== 'object' ? node
    : { ...node, props: 'now' in node.props ? { ...node.props, now } : node.props, children: node.children.map(at) })
  const tree = expand(at(MemberDock({ sessionId: 'r1', useRoster: pick => pick(team), useWork: pick => pick(work), actions: {} })))
  assert.deepEqual(rowLabels(tree), ['Anvil · Running shell commands: npm test · 11m', 'Quill · Looking through files… · 2m'])
  // The rest is one line in the same column, never a centered event line; Flint's own chat
  // is not this group's work (#553).
  const [line] = nodes(tree, node => String(node.props.className ?? '').includes('bt-mw-line'))
  assert.equal(line.type, 'button')
  assert.equal(nodes(tree, node => String(node.props.className ?? '').split(' ').includes('bt-event')).length, 0)
  assert.equal(line.props['aria-label'], 'Prism is waiting for your approval')
  assert.doesNotMatch(textOf(tree), /Flint|mcp_custom_tool/)
})

// #553, owner report 2026-10-20 23:03: in 研发组 the dock read "Chief · Running shell
// commands: cd … && sed -n 55,80p AGENTS.md · 1m" and the member list "… in FlyBot 交付组"
// while Chief worked in that other group. A room shows only its own work.
const rooms = {
  byId: { ...team.byId, h: { id: 'h', name: 'Chief' } },
  roomsById: {
    dev: { id: 'dev', name: '研发组', members: ['h', 'a', 'b'] },
    ship: { id: 'ship', name: 'FlyBot 交付组', members: ['h', 'c'] },
    face: { id: 'face', name: 'Face', face: { roomId: 'srv1' }, members: ['h', 'a'] },
  },
}
const roomDock = (sessionId, work) => expand(MemberDock({ sessionId, useRoster: pick => pick(rooms), useWork: pick => pick(work), actions: {} }))
const memberText = (roomId, work, id) => {
  const room = rooms.roomsById[roomId]
  const entry = busyMembers(room, work, rooms).find(item => item.id === id)
  return entry === undefined ? '' : textOf(MemberWork({ entry, bot: rooms.byId[id], room, actions: {}, now: Date.now() }))
}
const SED = 'cd /data/dsh/bot/workspace/main && sed -n 55,80p AGENTS.md'

test('a Bot at work in another room shows nothing in this room or face room, not even a hint (#553)', () => {
  const work = {
    bots: { h: { since: 1, roomId: 'ship', tool: 'pwsh', step: SED } },
    rooms: { ship: [{ botId: 'h', since: 1, tool: 'pwsh' }] },
    approvals: [],
  }
  for (const roomId of ['dev', 'face']) {
    assert.equal(roomDock(roomId, work), null, roomId)
    assert.equal(busyMembers(rooms.roomsById[roomId], work, rooms).length, 0, roomId)
  }
  // Its own room still shows it, with the step; so does the Bot's own chat dock.
  assert.deepEqual(rowLabels(roomDock('ship', work)), [`Chief · Running shell commands: ${SED}`])
  assert.match(memberText('ship', work, 'h'), /sed -n 55,80p/)
  assert.deepEqual(rowLabels(roomDock('h', work)), [`in FlyBot 交付组 · Running shell commands: ${SED}`])
})

test('a Bot busy in its own chat, or waiting for an approval elsewhere, is idle in this room (#553)', () => {
  const work = {
    bots: { h: { since: 1, tool: 'pwsh', step: SED } },
    rooms: {},
    approvals: [{ id: 'p1', botId: 'h', tool: 'pwsh', detail: { code: SED }, answerable: false }, { id: 'p2', botId: 'a', roomId: 'ship', tool: 'pwsh', answerable: true }],
  }
  for (const roomId of ['dev', 'face']) {
    assert.equal(roomDock(roomId, work), null, roomId)
    assert.equal(memberText(roomId, work, 'h'), '', roomId)
  }
})

test('work handed out from this room with message_bot shows here with its step, and nowhere else (#553)', () => {
  const work = {
    bots: { h: { since: 1, tool: 'pwsh', step: 'npm test', fromRoomId: 'dev' } },
    rooms: {},
    approvals: [],
  }
  assert.deepEqual(rowLabels(roomDock('dev', work)), ['Chief · Running shell commands: npm test'])
  assert.equal(roomDock('ship', work), null)
  assert.equal(roomDock('face', work), null)
  // It runs in the Bot's own chat, so the group's Stop (which stops the group turn) is not offered.
  const room = rooms.roomsById.dev
  const [entry] = busyMembers(room, work, rooms)
  const stops = nodes(MemberWork({ entry, bot: rooms.byId.h, room, actions: {}, now: 0 }), node => node.props.className === 'bt-mw-stop')
  assert.equal(stops.length, 0)
  const local = busyMembers(room, { bots: {}, rooms: { dev: [{ botId: 'h', since: 1, tool: 'pwsh' }] }, approvals: [] }, rooms)[0]
  assert.equal(nodes(MemberWork({ entry: local, bot: rooms.byId.h, room, actions: {}, now: 0 }), node => node.props.className === 'bt-mw-stop').length, 1)
  // Its approval waits here too.
  const asking = { ...work, approvals: [{ id: 'p1', botId: 'h', tool: 'pwsh', answerable: false }] }
  assert.deepEqual(plain(busyMembers(room, asking, rooms).map(item => [item.id, item.state])), [['h', 'ask']])
  assert.equal(busyMembers(rooms.roomsById.ship, asking, rooms).length, 0)
})

// The approval card is four buttons wide since the two `Always allow` choices (#540); in the
// narrow group details panel the row has to wrap instead of overflowing off the left edge, where
// 拒绝 and half of 允许一次 were unreachable (#593).
test('the approval card action row wraps and stays right-aligned', () => {
  const rule = MEMBER_CSS.match(/(?:^|\n)\.bt-mw-actions\{([^}]*)\}/)?.[1] ?? ''
  assert.match(rule, /display:flex/)
  assert.match(rule, /flex-wrap:wrap/, 'the four-button row wraps rather than overflowing to the left')
  assert.match(rule, /justify-content:flex-end/, 'each wrapped line stays right-aligned')
})
