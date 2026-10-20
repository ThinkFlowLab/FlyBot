import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Agent inbox, step 1 (#349): three groups built from data the client already has,
// approvals answered with the chat card's own answer, and one Inbox row in the sidebar.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/inbox.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { inboxModel, needsCount, InboxCard, InboxDialog, InboxRow, GROUPS, STATUSES, KEEP_MS } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))

// Draws the inbox's own components; Bot marks and icons stay as elements.
const OWN = new Set(['InboxCard', 'Status'])
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (OWN.has(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(expand) }
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.children, out) }
  return out
}
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(textOf).join('') : '')
const byClass = (tree, name) => all(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name))
const buttons = tree => all(tree).filter(node => node.type === 'button')

const NOW = Date.UTC(2026, 9, 20, 1, 0, 0)
const DAY = 86_400_000
const roster = {
  self: { memberId: 'm1' },
  bots: [
    { id: 'b1', name: 'Anvil', ownerId: 'm1', sessionId: 's1' },
    { id: 'b2', name: 'Flint', ownerId: 'm1', sessionId: 's2', pendingCount: 2 },
    { id: 'b3', name: 'Prism', ownerId: 'm1', sessionId: 's3' },
    { id: 'f1', name: 'Helper', remote: { handle: 'helper@friend.bot' }, sessionId: 'f1' },
    { id: 'o1', name: 'Theirs', ownerId: 'm2', sessionId: 'o1' },
  ],
  rooms: [{ id: 'r1', name: 'Ops', members: ['b1', 'b3'], pendingCount: 1 }],
}
roster.byId = Object.fromEntries(roster.bots.map(bot => [bot.id, bot]))
roster.roomsById = Object.fromEntries(roster.rooms.map(room => [room.id, room]))
const work = {
  bots: { b1: { since: NOW - 5 * 60_000, tool: 'pwsh' }, f1: { since: NOW - 1000 }, o1: { since: NOW - 1000 } },
  rooms: { r1: [{ botId: 'b3', since: NOW - 30_000 }, { botId: 'b1', since: NOW - 60_000 }] },
  approvals: [
    { id: 'a1', botId: 'b3', roomId: 'r1', tool: 'pwsh', detail: { text: 'Delete the build folder' }, reason: 'Runs a shell command', at: NOW - 2000, answerable: true },
    { id: 'a2', botId: 'b1', tool: 'edit', at: NOW - 1000, answerable: false },
    { id: 'a3', botId: 'f1', tool: 'edit', at: NOW, answerable: false },
    { id: 'a4', botId: 'o1', tool: 'edit', at: NOW, answerable: true },
  ],
}
const task = (id, status, extra = {}) => ({ id, status, title: `Task ${id}`, ownerBotId: 'b2', requesterId: 'm1', createdAt: NOW - DAY, updatedAt: NOW - 60_000, origin: {}, actors: [], ...extra })
const tasks = [
  task('t1', 'working'),
  task('t2', 'failed', { actors: [{ status: 'failed', why: 'the responsible Bot was deleted' }] }),
  task('t3', 'failed', { updatedAt: NOW - KEEP_MS - 1 }),
  task('t4', 'result-ready', { result: { summary: 'Draft is ready' } }),
  task('t5', 'blocked', { waitingFor: 'input', inputRequest: { question: 'Which branch?' } }),
  task('t6', 'accepted', { updatedAt: NOW - 2 * DAY }),
  task('t7', 'cancelled', { updatedAt: NOW - 3 * DAY }),
  task('t8', 'accepted', { updatedAt: NOW - 8 * DAY }),
  task('t9', 'working', { ownerBotId: 'f1' }),
]
const sessions = {
  byId: {
    s1: { updatedAt: NOW - DAY, projectionValues: { turnOutline: [{ turn: 1, prompt: 'hi', response: 'Old' }] } },
    s2: { updatedAt: NOW - 4 * DAY, projectionValues: { turnOutline: [{ turn: 1, prompt: 'Sum up', response: 'Here is the weekly summary of everything that changed' }] } },
    s3: { updatedAt: NOW - 9 * DAY, projectionValues: { turnOutline: [{ turn: 1, prompt: 'x', response: 'Too old' }] } },
  },
}
const model = inboxModel({ roster, work, tasks, sessions, now: NOW })
const ids = list => list.map(card => card.id)

test('the groups are Needs you, In progress and Done, in that order, each with an empty line', () => {
  assert.deepEqual(plain(GROUPS.map(group => group.title)), ['Needs you', 'In progress', 'Done'])
  for (const group of GROUPS) assert.ok(group.empty.length > 0)
})

test('Needs you: my own Bots\' approvals, held messages, and tasks that wait for me or failed in the last 7 days', () => {
  assert.deepEqual(plain(ids(model.needs).sort()), [
    'approval:a1', 'approval:a2', 'held:b2', 'held:r1', 'task:t2', 'task:t4', 'task:t5',
  ])
  const byId = Object.fromEntries(model.needs.map(card => [card.id, card]))
  assert.equal(byId['approval:a1'].status, 'approval')
  assert.equal(byId['approval:a1'].chat, 'r1')
  assert.equal(byId['approval:a1'].title, 'pwsh · Delete the build folder')
  assert.equal(byId['approval:a2'].chat, 'b1')
  assert.equal(byId['held:b2'].status, 'held')
  assert.equal(byId['held:b2'].title, '2 messages wait for your approval')
  assert.equal(byId['held:r1'].title, '1 message waits for your approval')
  assert.equal(byId['task:t2'].status, 'failed')
  assert.equal(byId['task:t2'].reason, 'the responsible Bot was deleted')
  assert.equal(byId['task:t4'].status, 'result')
  assert.equal(byId['task:t5'].status, 'input')
  assert.equal(byId['task:t5'].reason, 'Which branch?')
  assert.equal(needsCount(roster, work, tasks), model.needs.length)
})

test("a friend's Bot and another member's Bot never show, in any group", () => {
  for (const card of [...model.needs, ...model.progress, ...model.done]) {
    if (card.kind === 'held') continue
    assert.ok(!['f1', 'o1'].includes(card.bot.id), card.id)
  }
})

test('In progress: running turns per chat and group, without the ones waiting for an approval, and open tasks', () => {
  // b1's own chat waits for approval a2, b3 in Ops waits for a1: both are in Needs you instead.
  assert.deepEqual(plain(ids(model.progress).sort()), ['run:b1|r1', 'task:t1'])
  const run = model.progress.find(card => card.id === 'run:b1|r1')
  assert.equal(run.place, 'in Ops')
  assert.equal(run.chat, 'r1')
})

test('Done: accepted and cancelled tasks and finished Bot chats from the last 7 days only', () => {
  assert.deepEqual(plain(ids(model.done)), ['task:t6', 'task:t7', 'chat:b2'])
  assert.deepEqual(plain(model.done.map(card => card.status)), ['done', 'cancelled', 'done'])
  assert.equal(model.done[2].title, 'Here is the weekly summary of everything that changed')
  // A chat waiting for an approval (b1) is not done; one older than 7 days (b3) aged out.
  assert.ok(!ids(model.done).includes('chat:b1'))
  assert.ok(!ids(model.done).includes('chat:b3'))
})

test('every card carries assigner, owner and executing Bot; in step 1 the first two are me', () => {
  for (const card of [...model.needs, ...model.progress, ...model.done]) {
    assert.equal(card.assigner, 'm1')
    assert.equal(card.owner, 'm1')
    assert.ok('executingBot' in card)
  }
  assert.equal(model.progress.find(card => card.id === 'task:t1').executingBot, 'b2')
})

test('every status has a word and an icon besides its color', () => {
  for (const [id, status] of Object.entries(STATUSES)) {
    assert.ok(status.label, id)
    assert.equal(typeof status.Icon, 'function', id)
    assert.ok(['ask', 'danger', 'run', 'done', 'muted'].includes(status.tone), id)
  }
})

const draw = (card, extra = {}) => expand(InboxCard({ card, roster, now: NOW, busy: false, error: '', onAnswer: () => {}, onOpen: () => {}, ...extra }))
const cardOf = id => [...model.needs, ...model.progress, ...model.done].find(card => card.id === id)

test('a card shows exactly one status, as an icon and a word, and its full title on hover', () => {
  for (const card of [...model.needs, ...model.progress, ...model.done]) {
    const tree = draw(card)
    const statuses = byClass(tree, 'bt-inbox-status')
    assert.equal(statuses.length, 1, card.id)
    assert.ok(all(statuses[0]).some(node => node.type?.name === 'StatusIcon'), card.id)
    assert.equal(textOf(statuses[0]), STATUSES[card.status].label)
    const [title] = byClass(tree, 'bt-inbox-title')
    assert.equal(title.props.title, card.title)
  }
})

test('an answerable approval has Reject, Allow once and Open; everything else only Open', () => {
  const labels = card => plain(buttons(draw(card)).map(textOf))
  assert.deepEqual(labels(cardOf('approval:a1')), ['Reject', 'Allow once', 'Open'])
  // DSH's own card in the Bot's chat answers this one; the inbox opens that chat.
  assert.deepEqual(labels(cardOf('approval:a2')), ['Open'])
  // Bot-sent messages are approved in their chat by the owner, never from the inbox.
  assert.deepEqual(labels(cardOf('held:b2')), ['Open'])
  assert.deepEqual(labels(cardOf('task:t2')), ['Open'])
  assert.deepEqual(labels(cardOf('chat:b2')), ['Open'])
})

test('the card buttons call back with the card and the choice', () => {
  const log = []
  const tree = draw(cardOf('approval:a1'), { onAnswer: (card, choice) => log.push([card.id, choice]), onOpen: card => log.push(['open', card.chat]) })
  for (const button of buttons(tree)) button.props.onClick()
  assert.deepEqual(log, [['approval:a1', 'reject'], ['approval:a1', 'allow'], ['open', 'r1']])
})

const dialog = (actions) => {
  const hooks = { useWork: pick => pick(work), useSessions: pick => pick(sessions) }
  return InboxDialog({ roster, ...hooks, actions })
}
const cardsIn = tree => all(tree).filter(node => node.type?.name === 'InboxCard')

test('Allow once in the inbox gives the same answer as the chat card (answerApproval), and Open goes to the chat', async () => {
  const log = []
  const actions = {
    closeInbox: () => log.push('close'),
    openSession: id => log.push(`open ${id}`),
    answerApproval: (id, choice) => { log.push(`answer ${id} ${choice}`); return Promise.resolve(true) },
    tasks: () => Promise.resolve(tasks),
  }
  const tree = dialog(actions)
  const card = cardsIn(tree).find(node => node.props.card.id === 'approval:a1')
  card.props.onAnswer(card.props.card, 'allow')
  await new Promise(resolve => setTimeout(resolve, 0))
  card.props.onOpen(card.props.card)
  assert.deepEqual(log, ['answer a1 allow', 'close', 'open r1'])
})

test('the dialog draws the three groups with their headings, and an empty line where a group is empty', () => {
  const tree = InboxDialog({ roster: { bots: [], rooms: [], byId: {}, roomsById: {} }, useWork: pick => pick({}), useSessions: pick => pick({ byId: {} }), actions: {} })
  assert.deepEqual(plain(byClass(tree, 'bt-inbox-head').map(textOf)), ['Needs you', 'In progress', 'Done'])
  assert.deepEqual(plain(byClass(tree, 'bt-inbox-empty').map(textOf)), plain(GROUPS.map(group => group.empty)))
  const [dialogNode] = all(tree).filter(node => node.props?.role === 'dialog')
  assert.equal(dialogNode.props['aria-modal'], true)
  // The close button takes focus, so the dialog is reachable from the keyboard at once.
  assert.ok(buttons(tree).some(button => button.props.autoFocus === true))
})

test('the Inbox row shows how many cards need me and opens the inbox', () => {
  const log = []
  const row = InboxRow({ wide: true, useRoster: pick => pick(roster), useWork: pick => pick(work), useUi: pick => pick({}), actions: { openInbox: () => log.push('open') } })
  const [count] = byClass(row, 'bt-inbox-count')
  // Tasks load asynchronously; before they arrive the row counts the snapshot's cards.
  assert.equal(textOf(count), String(needsCount(roster, work, [])))
  assert.match(row.props['aria-label'], /^Inbox, \d+ need you$/)
  row.props.onClick()
  assert.deepEqual(log, ['open'])
  const quiet = InboxRow({ wide: true, useRoster: pick => pick({ bots: [], rooms: [], byId: {}, roomsById: {} }), useWork: pick => pick({}), useUi: pick => pick({}), actions: {} })
  assert.equal(byClass(quiet, 'bt-inbox-count').length, 0)
  assert.equal(quiet.props['aria-label'], 'Inbox')
})

test('the inbox has no second approval path and no native confirm dialog', () => {
  const source = readFileSync(new URL('../src/client/inbox.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bconfirm\(|\balert\(|\bprompt\(/)
  assert.doesNotMatch(source, /call\(['"]decide['"]|['"]approval-answer['"]/)
  assert.match(source, /actions\.answerApproval\(card\.approval\.id, choice\)/)
  // The group chat's card answers through the same action.
  assert.match(readFileSync(new URL('../src/client/member-status.js', import.meta.url), 'utf8'), /actions\.answerApproval\(approval\.id, choice\)/)
})

test('the sidebar has one Inbox row at its top, and the dialog is an overlay', () => {
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  assert.equal(sidebar.match(/h\(InboxRow,/g)?.length, 1)
  assert.ok(sidebar.indexOf('h(InboxRow,') < sidebar.indexOf("className: 'bt-list'"))
  assert.match(readFileSync(new URL('../src/client/overlays.js', import.meta.url), 'utf8'), /h\(InboxDialog,/)
})
