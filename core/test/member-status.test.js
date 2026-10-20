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
const { busyMembers, summaryText, splitBusy, MemberDock } = module.exports
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
  const room = { members: ['e', 'd', 'a', 'b', 'c', 'f'] }
  const work = {
    bots: { d: { since: 1, tool: 'edit' }, a: { since: 1, tool: 'pwsh' }, f: { since: 1 } },
    approvals: [{ botId: 'a' }, { botId: 'b' }, { botId: 'c' }],
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

test('a member at work in the group gets a row, the speaker first; work elsewhere and approvals do not', () => {
  const work = {
    // Anvil runs in its own chat too; its work here wins.
    bots: { a: { since: 1, tool: 'pwsh' }, b: { since: 1, roomId: 'r2', tool: 'edit' } },
    rooms: { r1: [{ botId: 'a', since: 1, tool: 'write' }, { botId: 'd', since: 1, speaking: true }], r2: [{ botId: 'b', since: 1, tool: 'edit' }] },
    approvals: [{ botId: 'c', roomId: 'r1' }],
  }
  const busy = busyMembers(team.roomsById.r1, work, team)
  const { rows, rest } = splitBusy(busy)
  assert.deepEqual(plain(rows.map(entry => [entry.bot.name, entry.doing.tool, entry.doing.roomId])), [['Quill', null, 'r1'], ['Anvil', 'write', 'r1']])
  assert.deepEqual(plain(rest.map(entry => [entry.bot.name, entry.state])), [['Prism', 'ask'], ['Flint', 'work']])
  assert.deepEqual(rowLabels(dock('r1', work)), ['Quill · Thinking about it…', 'Anvil · Writing changes…'])
  assert.equal(busyMembers(team.roomsById.r2, work, team).length, 2)
})

test('a Bot\'s own chat shows the groups it is at work in, unless its own chat runs', () => {
  const away = { bots: { a: { since: 1, roomId: 'r1', tool: 'pwsh' } }, rooms: { r1: [{ botId: 'a', since: 1, tool: 'pwsh' }], r2: [{ botId: 'a', since: 1 }] }, approvals: [] }
  assert.deepEqual(rowLabels(dock('a', away)), ['in Ops · Running shell commands…', 'in Docs · Thinking about it…'])
  assert.deepEqual(rowLabels(dock('a', { ...away, bots: { a: { since: 1 } } })), [])
  assert.equal(dock('b', away), null)
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
    approvals: [],
  }
  // The dock's clock is a stub here, so the rows draw at a real now.
  const at = node => (Array.isArray(node) ? node.map(at) : node === null || typeof node !== 'object' ? node
    : { ...node, props: 'now' in node.props ? { ...node.props, now } : node.props, children: node.children.map(at) })
  const tree = expand(at(MemberDock({ sessionId: 'r1', useRoster: pick => pick(team), useWork: pick => pick(work), actions: {} })))
  assert.deepEqual(rowLabels(tree), ['Anvil · Running shell commands: npm test · 11m', 'Quill · Looking through files… · 2m'])
  // Work elsewhere is one line in the same column, never a centered event line.
  const [line] = nodes(tree, node => String(node.props.className ?? '').includes('bt-mw-line'))
  assert.equal(line.type, 'button')
  assert.equal(nodes(tree, node => String(node.props.className ?? '').split(' ').includes('bt-event')).length, 0)
  assert.equal(line.props['aria-label'], 'Flint · Using mcp_custom_tool… · 3m')
  assert.match(textOf(line), /Flint · Using mcp_custom_tool…· 3m/)
})
