import assert from 'node:assert/strict'
import test from 'node:test'
import { ROOM_CONTEXT_BUDGET, ROOM_PRESENCE_BUDGET, boardCoversCue, compactStatus, fitRoomLines, formatRoomBoard, formatRoomPresence, prepareRoomLine, statusShaped } from '../src/host/room-context.js'
import { fenceUntrusted } from '../src/host/delivery.js'

const render = line => `${line.who}: ${line.text}`
const essay = (tail) => `CI on tip abcdef12 is green. tests-ok passed. enqueue when mergeable. merge_group is next. PASS at abcdef12. @Chief ${'detail '.repeat(80)}${tail}`

test('a long CI essay is status-shaped and a work note is not', () => {
  assert.equal(statusShaped(essay('end')), true)
  assert.equal(statusShaped('CI enqueue'), false, 'a short line is a handoff')
  const work = `Please change docs/autonomous-dev.md so the four spots say the mechanism is not enabled. ${'word '.repeat(80)}`
  assert.equal(statusShaped(work), false)
})

test('collapsing a status line keeps the opening and the @name, not the essay', () => {
  const text = essay('ESSAY_BODY_MARKER')
  assert.ok(text.indexOf('ESSAY_BODY_MARKER') > 200)
  const compact = compactStatus(text)
  assert.match(compact, /^\[status on the board, \d+ chars\] /)
  assert.match(compact, /@Chief/)
  assert.doesNotMatch(compact, /ESSAY_BODY_MARKER/)
  assert.ok(compact.length < 220)
})

test('prepare collapses bot status and leaves the stored line and a person line', () => {
  const stored = { seq: 1, who: 'Dev', botId: 'dev', text: essay('TAIL') }
  const next = prepareRoomLine(stored)
  assert.equal(stored.text.includes('TAIL'), true, 'the log line is not rewritten')
  assert.notEqual(next, stored)
  assert.match(next.text, /\[status on the board/)
  assert.doesNotMatch(next.text, /TAIL/)
  const person = { seq: 2, who: 'User', text: essay('PERSON') }
  assert.equal(prepareRoomLine(person), person)
  const short = { seq: 3, who: 'Dev', botId: 'dev', text: 'short handoff keep me' }
  assert.equal(prepareRoomLine(short), short)
})

test('the transcript stays inside the budget and prefers a newer short line over an older essay', () => {
  const lines = []
  for (let seq = 1; seq <= 8; seq += 1) lines.push({ seq, who: 'Dev', botId: 'dev', text: essay(`marker-${seq}`) })
  lines.push({ seq: 9, who: 'Dev', botId: 'dev', text: 'short handoff keep me' })
  const fitted = fitRoomLines(lines, { budget: ROOM_CONTEXT_BUDGET, render, prepare: prepareRoomLine })
  assert.ok(fitted.text.length <= ROOM_CONTEXT_BUDGET)
  assert.match(fitted.text, /short handoff keep me/)
  assert.match(fitted.text, /\[status on the board/)
  assert.doesNotMatch(fitted.text, /marker-/)
  assert.equal(fitted.entries.at(-1).line.seq, 9)
})

// #1251: both writers of `room.log` run this one function. A line a writer already fenced for another
// home's Bot must stay fenced: `compactStatus` flattens the angle brackets, so compacting the whole wrap
// stores a guest's essay as this home's own text — the defect the fence exists to prevent.
test('a fenced peer essay is collapsed inside its wrap, never unwrapped (#1251)', () => {
  const fenced = fenceUntrusted('Guest Bot', essay('GUEST_TAIL'))
  const stored = { seq: 4, who: 'Guest Bot', botId: 'guest', text: fenced }
  const next = prepareRoomLine(stored)
  assert.match(next.text, /^<untrusted-message from="Guest Bot">\n/)
  assert.match(next.text, /\n<\/untrusted-message>$/)
  assert.equal(next.text, fenceUntrusted('Guest Bot', compactStatus(essay('GUEST_TAIL'))))
  assert.doesNotMatch(next.text, /GUEST_TAIL/)
  assert.equal(stored.text, fenced, 'the stored line is not rewritten')
  // `kind` and `authorKind` come from the other home (room-membership.js copies them), so while the
  // line is fenced neither is an exemption: a peer marking the essay `notice`, or typing it as a person,
  // still gets the stub inside the same wrap.
  const notice = { seq: 6, who: 'Guest Bot', botId: 'guest', kind: 'notice', text: fenced }
  assert.equal(prepareRoomLine(notice).text, next.text)
  const typed = { seq: 7, who: 'Guest', authorKind: 'human', text: fenced }
  assert.equal(prepareRoomLine(typed).text, next.text)
  // A short fenced line stays exactly as stored.
  const short = { seq: 5, who: 'Guest Bot', botId: 'guest', text: fenceUntrusted('Guest Bot', 'hello') }
  assert.equal(prepareRoomLine(short), short)
  // An unfenced kind line is this home's own and stays verbatim.
  const ownNotice = { seq: 8, who: 'Dev', botId: 'dev', kind: 'notice', text: essay('TAIL') }
  assert.equal(prepareRoomLine(ownNotice), ownNotice)
})

test('a non-status flood is cut newest-first instead of being collapsed', () => {
  const lines = []
  for (let seq = 1; seq <= 10; seq += 1) lines.push({ seq, who: 'Dev', botId: 'dev', text: `work item ${seq} ${'word '.repeat(160)}` })
  const fitted = fitRoomLines(lines, { budget: 1000, render, prepare: prepareRoomLine })
  assert.ok(fitted.text.length <= 1000)
  assert.match(fitted.text, /work item 10 /)
  assert.doesNotMatch(fitted.text, /work item 1 /)
  assert.ok(fitted.omitted > 0)
  assert.equal(fitted.entries.at(-1).text.includes('word '), true, 'a work line is not rewritten as status')
})

test('one line longer than the budget is clipped to it', () => {
  const lines = [{ seq: 1, who: 'User', text: 'x'.repeat(ROOM_CONTEXT_BUDGET + 500) }]
  const fitted = fitRoomLines(lines, { budget: ROOM_CONTEXT_BUDGET, render, prepare: prepareRoomLine })
  assert.ok(fitted.text.length <= ROOM_CONTEXT_BUDGET)
  assert.equal(fitted.omitted, 0)
  assert.ok(fitted.text.endsWith('…'))
})

test('the board snapshot is the open overall task and its subtasks', () => {
  const tasks = {
    overall: { id: 'overall', kind: 'group', status: 'open', title: 'Ship <the> note', progress: 40, note: 'line one\nline two', ownerBotId: 'chief', origin: { roomId: 'room' }, updatedAt: 2 },
    child: { id: 'child', status: 'claimed', title: 'Writer implements', parentId: 'overall', ownerBotId: 'writer', origin: { roomId: 'room' }, updatedAt: 3, waitingFor: 'input' },
    done: { id: 'done', status: 'accepted', title: 'FINISHED_MARKER', ownerBotId: 'writer', origin: { roomId: 'room' }, updatedAt: 4 },
    other: { id: 'other', status: 'open', title: 'OTHER_ROOM', ownerBotId: 'writer', origin: { roomId: 'elsewhere' }, updatedAt: 5 },
    stray: { id: 'stray', kind: 'group', status: 'open', title: 'Older plan', ownerBotId: 'chief', origin: { roomId: 'room' }, updatedAt: 1 },
  }
  const names = { chief: 'Chief', writer: 'Writer' }
  const board = formatRoomBoard(tasks, { roomId: 'room', nameOf: task => names[task.ownerBotId] })
  assert.match(board, /Task board \(assign, claim, and progress live here/)
  assert.match(board, /Chief \[open 40%\] Ship the note — line one line two/)
  assert.match(board, /Writer \[claimed waiting\] Writer implements/)
  assert.doesNotMatch(board, /FINISHED_MARKER|OTHER_ROOM|Older plan|<|>/)
  assert.equal(formatRoomBoard({}, { roomId: 'room' }), '')
  assert.equal(formatRoomBoard(tasks, { roomId: 'missing' }), '')
})

test('an open card covers a status @ and not a question or a new ask', () => {
  const tasks = {
    child: { id: 'child', status: 'working', title: 'Writer implements', note: 'draft is in', progress: 40, ownerBotId: 'writer', origin: { roomId: 'room' } },
    waiting: { id: 'waiting', status: 'blocked', title: 'Need a name', waitingFor: 'input', ownerBotId: 'writer', origin: { roomId: 'room' } },
  }
  const cue = { roomId: 'room', botId: 'writer' }
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer Writer implements' }), true)
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer Writer implements — draft is in' }), true)
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer draft is in' }), true)
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer Writer implements the rollback instead' }), false)
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer Writer implements, then delete the notes file' }), false)
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer done' }), true)
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer' }), true)
  assert.equal(boardCoversCue(tasks, { ...cue, text: essay('@Writer') }), true)
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer which file?' }), false)
  assert.equal(boardCoversCue(tasks, { ...cue, text: '@Writer the draft is wrong, redo paragraph two' }), false)
  assert.equal(boardCoversCue(tasks, { roomId: 'room', botId: 'other', text: '@Other Writer implements' }), false)
  assert.equal(boardCoversCue({ only: { ...tasks.waiting } }, { ...cue, text: '@Writer done' }), false)
})

// #1213: the room shows who is on what, read from the board, so a member that claimed
// and stayed quiet is not read as idle. These are the fixtures the issue asks for: two
// holders and one idle member, and a holder whose card is removed.
const presenceAt = Date.parse('2026-10-26T02:00:00Z')
const presenceMembers = [{ id: 'dev2', name: 'Dev2' }, { id: 'dev3', name: 'Dev3' }, { id: 'chief', name: 'Chief' }]
const presenceTasks = () => ({
  race: { id: 'race', status: 'working', progress: 15, title: 'Connectors test race', ownerBotId: 'dev2', origin: { roomId: 'room' }, target: { number: 1081 }, createdAt: presenceAt - 27 * 60000, updatedAt: presenceAt - 27 * 60000 },
  recursion: { id: 'recursion', status: 'claimed', progress: 0, title: 'Face room recursion', ownerBotId: 'dev3', origin: { roomId: 'room' }, target: { number: 979 }, createdAt: presenceAt - 3 * 60000, updatedAt: presenceAt - 3 * 60000 },
  done: { id: 'done', status: 'accepted', title: 'FINISHED_MARKER', ownerBotId: 'dev3', origin: { roomId: 'room' }, updatedAt: presenceAt },
  elsewhere: { id: 'elsewhere', status: 'working', progress: 50, title: 'OTHER_ROOM', ownerBotId: 'dev2', origin: { roomId: 'elsewhere' }, updatedAt: presenceAt },
})

test('presence: two holders and an idle member each get one line, with column, progress and age', () => {
  const text = formatRoomPresence(presenceTasks(), { roomId: 'room', members: presenceMembers, now: presenceAt })
  assert.match(text, /^- Dev2 — #1081 Connectors test race \(in progress 15%, open 27 min\)$/m)
  assert.match(text, /^- Dev3 — #979 Face room recursion \(not started, just claimed, open 3 min\)$/m)
  assert.match(text, /^- Chief — idle \(no open card\)$/m)
  assert.doesNotMatch(text, /FINISHED_MARKER|OTHER_ROOM/)
  assert.ok(text.startsWith('Who is working'))
})

test('presence: a card removed turns its holder into idle (the strip follows the board)', () => {
  const tasks = presenceTasks()
  delete tasks.recursion
  const text = formatRoomPresence(tasks, { roomId: 'room', members: presenceMembers, now: presenceAt })
  assert.doesNotMatch(text, /Dev3 — #979/)
  assert.match(text, /^- Dev3 — idle \(no open card\)$/m)
  assert.match(text, /^- Dev2 — #1081/m)
})

test('presence: a waiting card says so, and a moved card adds when it moved', () => {
  const tasks = {
    ask: { id: 'ask', status: 'blocked', waitingFor: 'input', progress: 40, title: 'Need a name', ownerBotId: 'dev2', origin: { roomId: 'room' }, createdAt: presenceAt - 12 * 60000, updatedAt: presenceAt - 2 * 60000 },
  }
  const text = formatRoomPresence(tasks, { roomId: 'room', members: [{ id: 'dev2', name: 'Dev2' }], now: presenceAt })
  assert.match(text, /- Dev2 — Need a name \(waiting on an answer, open 12 min, moved 2 min ago\)/)
})

test('presence: a holder with three cards names the first and counts the rest', () => {
  const tasks = {
    one: { id: 'one', status: 'working', progress: 10, title: 'First card', ownerBotId: 'dev2', origin: { roomId: 'room' }, createdAt: presenceAt, updatedAt: presenceAt },
    two: { id: 'two', status: 'open', progress: 0, title: 'Second card', ownerBotId: 'dev2', origin: { roomId: 'room' }, createdAt: presenceAt, updatedAt: presenceAt },
    three: { id: 'three', status: 'open', progress: 0, title: 'Third card', ownerBotId: 'dev2', origin: { roomId: 'room' }, createdAt: presenceAt, updatedAt: presenceAt },
  }
  const text = formatRoomPresence(tasks, { roomId: 'room', members: [{ id: 'dev2', name: 'Dev2' }], now: presenceAt })
  assert.match(text, /^- Dev2 — First card \(in progress 10%, open 0 min\) \+2 more$/m)
})

test('presence: nobody holding a card is one readable line, never an empty block', () => {
  assert.equal(formatRoomPresence({}, { roomId: 'room', members: presenceMembers, now: presenceAt }), 'Who is working: nobody (no open card).')
  assert.equal(formatRoomPresence(presenceTasks(), { roomId: 'no-such-room', members: presenceMembers, now: presenceAt }), 'Who is working: nobody (no open card).')
})

test('presence: at most eight members, the rest counted, and the whole block stays under the budget', () => {
  const tasks = {}
  const members = []
  for (let at = 0; at < 12; at += 1) {
    const id = `bot${at}`
    members.push({ id, name: `Bot${at}` })
    tasks[id] = { id, status: 'working', progress: 50, title: `Card ${at}`, ownerBotId: id, origin: { roomId: 'room' }, createdAt: presenceAt, updatedAt: presenceAt }
  }
  const text = formatRoomPresence(tasks, { roomId: 'room', members, now: presenceAt })
  const memberLines = text.split('\n').filter(line => line.startsWith('- ') && line.includes(' — '))
  assert.ok(memberLines.length <= 8, `at most eight member lines, got ${memberLines.length}`)
  assert.match(text, /^- \+\d+ more member\(s\)$/m)
  assert.ok(text.length <= ROOM_PRESENCE_BUDGET, `block is ${text.length} chars`)
})

test('presence: a long title is flattened and cut, and no note prose rides along', () => {
  const tasks = {
    long: { id: 'long', status: 'working', progress: 5, title: `${'x'.repeat(300)}<b>`, note: 'NOTE_PROSE '.repeat(40), ownerBotId: 'dev2', origin: { roomId: 'room' }, createdAt: presenceAt, updatedAt: presenceAt },
  }
  const text = formatRoomPresence(tasks, { roomId: 'room', members: [{ id: 'dev2', name: 'Dev2' }], now: presenceAt })
  assert.doesNotMatch(text, /NOTE_PROSE|<b>/)
  assert.ok(text.length <= ROOM_PRESENCE_BUDGET)
})

test('presence: no members or no room renders nothing at all', () => {
  assert.equal(formatRoomPresence(presenceTasks(), { roomId: 'room', members: [], now: presenceAt }), '')
  assert.equal(formatRoomPresence(presenceTasks(), { members: presenceMembers, now: presenceAt }), '')
})

// P-305: a character bound must not land between the halves of a surrogate pair. `oneLine` ends a long
// card, board or presence line with `flat.slice(0, max - 1) + '…'` and `fitRoomLines` clips a transcript
// line with `text.slice(0, room - 1) + '…'`; both are bare `slice`, so a pair straddling the bound is
// stored and sent whole-half — a lone high surrogate the encoder turns into U+FFFD.
test('P-305: a card title cut at its bound keeps a whole emoji', () => {
  // 78 units, then an emoji whose pair sits across the 80-unit bound.
  const title = `${'a'.repeat(78)}\u{1F600}TAIL`
  const board = formatRoomBoard({
    card: { id: 'card', status: 'open', title, ownerBotId: 'dev2', origin: { roomId: 'room' }, createdAt: presenceAt, updatedAt: presenceAt },
  }, { roomId: 'room', nameOf: () => 'Dev2', now: presenceAt })
  assert.equal(board.isWellFormed(), true, `the board line is not well formed: ${JSON.stringify(board.slice(-60))}`)
  const card = board.split('\n').find(item => item.startsWith('- '))
  assert.equal(card, `- Dev2 [open] ${'a'.repeat(78)}…`, 'the pair on the bound is dropped whole, never cut in half')

  // Control: a title that ends exactly on the bound keeps the whole pair …
  const exact = formatRoomBoard({
    card: { id: 'card', status: 'open', title: `${'b'.repeat(78)}\u{1F600}`, ownerBotId: 'dev2', origin: { roomId: 'room' } },
  }, { roomId: 'room', nameOf: () => 'Dev2' })
  assert.equal(exact.split('\n').find(item => item.startsWith('- ')), `- Dev2 [open] ${'b'.repeat(78)}\u{1F600}`)
  // … and a family emoji well inside the bound is untouched.
  const family = `Ship \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} now`
  const kept = formatRoomBoard({
    card: { id: 'card', status: 'open', title: family, ownerBotId: 'dev2', origin: { roomId: 'room' } },
  }, { roomId: 'room', nameOf: () => 'Dev2' })
  assert.match(kept, new RegExp(`- Dev2 \\[open\\] Ship \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} now$`, 'm'))
  assert.equal(kept.isWellFormed(), true)
})

test('P-305: a clipped transcript line ends on a whole emoji', () => {
  const budget = 1000
  const clipped = fitRoomLines(
    [{ seq: 1, who: 'User', text: `${'a'.repeat(budget - 2)}\u{1F600}TAIL` }],
    { budget, render: line => line.text },
  )
  assert.equal(clipped.text.isWellFormed(), true, `the clipped line is not well formed: ${JSON.stringify(clipped.text.slice(-8))}`)
  assert.equal(clipped.text, `${'a'.repeat(budget - 2)}…`, 'the pair on the clip point is dropped whole')

  // Control: a line that fits with a family emoji is untouched …
  const fits = fitRoomLines(
    [{ seq: 1, who: 'User', text: `work \u{1F468}\u200D\u{1F469}\u200D\u{1F467}` }],
    { budget, render: line => line.text },
  )
  assert.equal(fits.text, `work \u{1F468}\u200D\u{1F469}\u200D\u{1F467}`)
  // … and a pair that ends just before the clip point survives whole.
  const before = fitRoomLines(
    [{ seq: 1, who: 'User', text: `${'b'.repeat(budget - 3)}\u{1F600}TAIL` }],
    { budget, render: line => line.text },
  )
  assert.equal(before.text.isWellFormed(), true)
  assert.equal(before.text, `${'b'.repeat(budget - 3)}\u{1F600}…`)
})
