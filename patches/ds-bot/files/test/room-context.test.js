import assert from 'node:assert/strict'
import test from 'node:test'
import { ROOM_CONTEXT_BUDGET, compactStatus, fitRoomLines, formatRoomBoard, prepareRoomLine, statusShaped } from '../src/host/room-context.js'

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
  assert.match(board, /Task board \(progress lives here/)
  assert.match(board, /Chief \[open 40%\] Ship the note — line one line two/)
  assert.match(board, /Writer \[claimed waiting\] Writer implements/)
  assert.doesNotMatch(board, /FINISHED_MARKER|OTHER_ROOM|Older plan|<|>/)
  assert.equal(formatRoomBoard({}, { roomId: 'room' }), '')
  assert.equal(formatRoomBoard(tasks, { roomId: 'missing' }), '')
})
