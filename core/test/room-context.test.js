import assert from 'node:assert/strict'
import test from 'node:test'
import { ROOM_CONTEXT_BUDGET, ROOM_PRESENCE_BUDGET, boardCoversCue, compactStatus, fitRoomLines, formatRoomBoard, formatRoomPresence, prepareRoomLine, statusShaped } from '../src/host/room-context.js'

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
