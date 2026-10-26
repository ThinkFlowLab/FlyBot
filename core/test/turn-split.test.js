import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

import { fitFixed, foldSessionEvents, scanZstdFrames, splitStep } from '../dev/turn-split.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'core', 'dev', 'turn-split.mjs')

const usage = (input, cacheRead, output) => ({
  type: 'chunk',
  chunk: { type: 'usage', usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output } },
})
const system = (text) => ({ type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text }] } } })
const header = (tools) => ({ type: 'request/header', data: { header: { tools } } })
const user = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const toolResult = (callId, name, text) => ({
  type: 'tool/result',
  data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } },
})
const toolCall = (callId, name) => ({ type: 'tool/call', data: { callId, name } })
const assistant = (turn, step, input, cacheRead, output, text = 'ok') => ({
  type: 'assistant/message',
  time: 1_792_900_000_000 + turn * 100_000 + step * 1000,
  data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [{ type: 'chunk', chunk: { type: 'finish' } }, usage(input, cacheRead, output)] },
})

// One turn that reads a 1000-character tool result, then a second turn whose task is short.
function fixtureEvents() {
  return [
    system('S'.repeat(100)),
    header([{ name: 'bash', description: 'd'.repeat(900) }]),
    user('context before the turn'),
    { type: 'turn/start', data: { turn: 1 } },
    user('do the thing'),
    assistant(1, 1, 100, 900, 10),
    toolCall('call-1', 'bash'),
    toolResult('call-1', 'bash', 'T'.repeat(1000)),
    assistant(1, 2, 50, 1950, 20),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    user('next'),
    assistant(2, 1, 40, 2960, 5),
  ]
}

test('a turn separates its task from the history that came before it', () => {
  const folded = foldSessionEvents(fixtureEvents())
  assert.equal(folded.steps.length, 3)
  const [first, , third] = folded.steps
  // Everything admitted before the turn opens — the injected context and the user's words —
  // is that turn's task; nothing before it counts as history yet.
  assert.equal(first.chars.task, 'context before the turn'.length + 'do the thing'.length)
  assert.equal(first.chars.history, 0)
  assert.equal(first.chars.tool, 0)
  // Turn 2 opens with a short task; turn 1's two user messages and its two "ok" replies are
  // history by then.
  assert.equal(third.chars.task, 'next'.length)
  assert.equal(third.chars.history, 'context before the turn'.length + 'do the thing'.length + 2 * 'ok'.length)
})

test('a tool result is its own part, never folded into the history', () => {
  const folded = foldSessionEvents(fixtureEvents())
  const second = folded.steps[1]
  assert.equal(second.chars.tool, 1000)
  // The kill: counting tool text as history would move all 1000 characters there.
  assert.ok(second.chars.tool >= 1000)
  // What the assistant itself wrote is history; the turn's task stays its own part.
  assert.equal(second.chars.history, 'ok'.length)
})

test('the fixed block is the intercept of the Session\'s prompt fit', () => {
  const steps = Array.from({ length: 10 }, (_, index) => ({
    prompt: 48_000 + Math.round((index + 1) * 3_320),
    messageChars: (index + 1) * 10_000,
    systemChars: 20_000,
    toolsChars: 110_000,
  }))
  const fit = fitFixed(steps)
  assert.ok(fit)
  assert.ok(Math.abs(fit.fixedTokens - 48_000) <= 1)
  assert.ok(Math.abs(fit.charsPerToken - 10000 / 3320) < 1e-9)
  assert.ok(fit.r2 > 0.999)
  assert.equal(fit.n, 10)
  // The kill: a fit that reported no fixed block would put every prompt token in the parts.
  assert.ok(fit.fixedTokens > 0)
})

test('a Session with too few calls gets no fit instead of a guess', () => {
  const steps = Array.from({ length: 7 }, (_, index) => ({ prompt: 1000 + index, messageChars: index * 10, systemChars: 1, toolsChars: 1 }))
  assert.equal(fitFixed(steps), null)
  const flat = Array.from({ length: 12 }, () => ({ prompt: 1000, messageChars: 10, systemChars: 1, toolsChars: 1 }))
  assert.equal(fitFixed(flat), null)
})

test('a split accounts for the whole prompt and never claims the fixed block twice', () => {
  const fit = { fixedTokens: 48_000, charsPerToken: 3.32, r2: 1, n: 100, fixedChars: 130_000 }
  const step = { prompt: 148_000, messageChars: 100_000, chars: { task: 10_000, history: 30_000, tool: 60_000 } }
  const split = splitStep(step, fit)
  const sum = split.fixed + split.task + split.history + split.tool
  assert.ok(Math.abs(sum - step.prompt) <= 1)
  assert.equal(split.fixed, 48_000)
  // A short prompt is all fixed block, not a negative remainder.
  const tiny = splitStep({ prompt: 30_000, messageChars: 1000, chars: { task: 1000, history: 0, tool: 0 } }, fit)
  assert.equal(tiny.fixed, 30_000)
  assert.equal(tiny.task + tiny.history + tiny.tool, 0)
})

test('the frame walker finds every frame of a concatenated log', (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('this Node has no zstd in node:zlib (needs 22.15+)')
    return
  }
  const first = zstdCompressSync(Buffer.from('{"type":"a"}\n'))
  const second = zstdCompressSync(Buffer.from('{"type":"b"}\n'))
  const buffer = Buffer.concat([first, second])
  const { frames } = scanZstdFrames(buffer)
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[0], { start: 0, end: first.length })
  assert.deepEqual(frames[1], { start: first.length, end: buffer.length })
})

function sessionFile(events) {
  const bytes = [events.map((event) => JSON.stringify(event)).join('\n') + '\n', JSON.stringify({ type: 'session/title', data: { title: 'x' } })]
  return Buffer.concat(bytes.map((text) => zstdCompressSync(Buffer.from(text))))
}

function sample(t) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-split-'))
  const workspace = join(dir, 'sessions', '--workspace--')
  mkdirSync(workspace, { recursive: true })
  // Twelve calls with a growing message surface: the fit needs variation and eight calls.
  const events = [system('S'.repeat(100)), header([{ name: 'bash', description: 'd'.repeat(900) }]), { type: 'turn/start', data: { turn: 1 } }]
  for (let step = 1; step <= 12; step += 1) {
    events.push(user(`task ${step} `.repeat(step * 10)))
    events.push(assistant(1, step, 100, 48_000 + step * 500, 10))
    events.push(toolCall(`call-${step}`, 'bash'))
    events.push(toolResult(`call-${step}`, 'bash', 'T'.repeat(step * 400)))
  }
  const folder = join(workspace, 'session-fixture')
  mkdirSync(folder)
  writeFileSync(join(folder, 'session.v4.jsonl.zstd'), sessionFile(events))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'sessions')
}

test('the CLI prints a split for the sampled turn', (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('this Node has no zstd in node:zlib (needs 22.15+)')
    return
  }
  const root = sample(t)
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', root], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Sessions with a fit: 1/)
  assert.match(result.stdout, /fixed block \d[\d,]* tokens/)
})

test('the --days table divides each day by the same measured fixed block', (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('this Node has no zstd in node:zlib (needs 22.15+)')
    return
  }
  const root = sample(t)
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', root, '--days'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  // The fixture is twelve calls of 48,100 + 500 × step: 616,200 prompt over one local day.
  const row = result.stdout.split('\n').find((line) => /^\d{4}-\d{2}-\d{2}\s/.test(line))
  assert.ok(row, `the --days table printed no day row:\n${result.stdout}`)
  const cells = row.trim().split(/\s+/)
  assert.equal(cells[1], '12')
  assert.equal(cells[2], '616,200')
  // Every call's fixed block comes from the fixture's own fit (49,459 tokens), so 96.1% of
  // the day's prompt is the same block re-sent. The kill: `row.fixed += 0` at `turn-split.mjs`
  // prints 0.0% here and leaves every other test green, which is how this path went unpinned.
  assert.equal(cells.at(-1), '96.1%')
})

test('a missing session root is an error that names the path', () => {
  const missing = join(tmpdir(), 'turn-split-no-such-root')
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', missing], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no session root at/)
  assert.match(result.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

// The report this script backs ships a number only in a table row whose last cell names
// where it came from: the provider's usage, a direct count in the log, or a formula.
const REPORT = join(ROOT, 'docs', 'reports', '2026-10-26-turn-input-split.md')
const PROVENANCE = /^(provider usage|measured: .+|derived: .+)$/

test('every row of the committed split report carries its provenance', () => {
  const lines = readFileSync(REPORT, 'utf8').split(/\r?\n/)
  const rows = []
  let header = null
  for (const line of lines) {
    const cells = line.startsWith('|') ? line.split('|').slice(1, -1).map((cell) => cell.trim()) : null
    if (cells === null) { header = null; continue }
    if (header === null) { header = cells; continue }
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
    assert.equal(header.at(-1), 'Source', `a table starting with ${header[0]} has no Source column`)
    rows.push({ header, cells })
  }
  assert.ok(rows.length > 0, 'the report has no tables')
  for (const row of rows) {
    assert.match(row.cells.at(-1), PROVENANCE, `no provenance: | ${row.cells.join(' | ')} |`)
    assert.equal(row.cells.length, row.header.length, `a row has ${row.cells.length} cells, its table ${row.header.length}: | ${row.cells.join(' | ')} |`)
  }
})
