import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

import { fitFixed, foldSessionEvents, scanZstdFrames, sessionIdFromPath, splitStep } from '../dev/turn-split.mjs'

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

// #1989: `compat · windows-latest` lost four cases to one cause — the Session id came from
// `file.split('/')`. The walk builds paths with `join`, so on Windows the separator is `\`,
// `split('/')` read one element, and every Session row carried `id: undefined`: the id column
// died on `.padEnd`, `--room` on `.startsWith`, and the derived tables printed `undefined`.
// The id is the directory holding the log, so read it with the path API — once under the host's
// separator and once under a Windows-shaped one, which no Linux run would otherwise reach.
test('#1989: a Session id is the directory name under either path separator', () => {
  const below = ['sessions', '--workspace--', 'session-fixture', 'session.v4.jsonl.zstd']
  const windowsFile = win32.join('D:\\a\\FlyBot\\FlyBot', ...below)
  assert.ok(windowsFile.includes('\\'), `the fixture must be Windows-shaped: ${windowsFile}`)
  assert.equal(sessionIdFromPath(windowsFile, win32), 'session-fixture')
  assert.equal(sessionIdFromPath(join(...below)), 'session-fixture')
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

// ---- #1259: the three follow-ups #1241's INC left open -------------------------------

const TOOLS = JSON.stringify([{ name: 'bash', description: 'd'.repeat(900) }])

// One Session whose system prompt grows mid-way: the first call's surface is not the last
// call's, which is the §2/§4 mismatch this issue is about.
function grownFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-split-grown-'))
  const workspace = join(dir, 'sessions', '--workspace--')
  mkdirSync(workspace, { recursive: true })
  const events = [system('S'.repeat(100)), header([{ name: 'bash', description: 'd'.repeat(900) }]), { type: 'turn/start', data: { turn: 1 } }]
  for (let step = 1; step <= 10; step += 1) {
    if (step === 6) events.push(system('S'.repeat(300)))
    events.push(user(`task ${step} `.repeat(step * 10)))
    events.push(assistant(1, step, 100, 48_000 + step * 500, 10))
  }
  const folder = join(workspace, 'session-grown')
  mkdirSync(folder)
  writeFileSync(join(folder, 'session.v4.jsonl.zstd'), sessionFile(events))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'sessions')
}

test('#1259: the report and the CLI name the moment each fixed-block number is measured at', (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('this Node has no zstd in node:zlib (needs 22.15+)')
    return
  }
  const root = grownFixture(t)
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', root], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  // §2's number is each Session's FIRST call: 100 system chars + the tool schema, never the
  // 300-character system prompt that comes later in the same Session.
  const fixedChars = 100 + TOOLS.length
  assert.match(result.stdout, new RegExp(`fixed chars p50 ${fixedChars.toLocaleString('en-US')} \\(first call's surface\\)`))
  // §4's number is the sample turn's LAST call, and the block that backs it says so.
  assert.match(result.stdout, /the turn's last call's surface/)
  assert.match(result.stdout, /system prompt 300 chars/)
  assert.match(result.stdout, new RegExp(`tool schemas ${TOOLS.length.toLocaleString('en-US')} chars`))
})

test('#1259: the committed report says which moment §2 and §4 each measure', () => {
  const report = readFileSync(REPORT, 'utf8')
  const row = report.split(/\r?\n/).find((line) => line.startsWith('| Fixed characters per call'))
  assert.ok(row, 'the report has no "Fixed characters per call" row')
  assert.match(row, /each Session's first call/)
  const section4 = report.slice(report.indexOf('## 4.'))
  assert.match(section4, /the sample turn's last call/)
  assert.match(report, /different moments/)
  assert.match(report, /not comparable/)
})

// A Session whose prompt falls as its messages grow: the slope is negative, so the fit has a
// fixed block but no characters-per-token figure. Half the sample looking like this used to
// reach `.toFixed(2)` as a null median.
function degenerateFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-split-degenerate-'))
  const workspace = join(dir, 'sessions', '--workspace--')
  mkdirSync(workspace, { recursive: true })
  for (const name of ['session-null-a', 'session-null-b']) {
    const folder = join(workspace, name)
    mkdirSync(folder)
    const events = [system('S'.repeat(100)), header([{ name: 'bash', description: 'd'.repeat(900) }]), { type: 'turn/start', data: { turn: 1 } }]
    for (let step = 1; step <= 10; step += 1) {
      events.push(user(`task ${step} `.repeat(step * 10)))
      // Fewer prompt tokens per call as the message surface grows: slope < 0.
      events.push(assistant(1, step, 100, 100_000 - step * 2_000, 10))
    }
    writeFileSync(join(folder, 'session.v4.jsonl.zstd'), sessionFile(events))
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'sessions')
}

test('#1259: a fit with no characters-per-token figure does not crash the summary', (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('this Node has no zstd in node:zlib (needs 22.15+)')
    return
  }
  const root = degenerateFixture(t)
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', root], { encoding: 'utf8' })
  // Before the fix this exits 1 with `Cannot read properties of null (reading 'toFixed')`.
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /message chars\/token p50 n\/a/)
})

test('#1259: an unknown --tz is refused by name instead of an uncaught RangeError', (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('this Node has no zstd in node:zlib (needs 22.15+)')
    return
  }
  const root = sample(t)
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', root, '--tz', 'Not/AZone'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /turn-split: unknown time zone Not\/AZone/)
  assert.doesNotMatch(result.stderr, /RangeError|Invalid time zone/)
})

// ---- #1259 item 2: a command per quoted number in §5, §7 and §8 ----------------------

const BASE = Date.UTC(2026, 9, 25, 1, 0, 0)
const MINUTE = 60_000
const at = (ms) => 1_792_900_000_000 + ms

function roomSession() {
  const events = []
  for (let index = 1; index <= 3; index += 1) {
    events.push({ type: 'turn/start', data: { turn: index }, time: BASE + (index - 1) * 20 * MINUTE })
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `message ${index}` }] }, time: BASE + (index - 1) * 20 * MINUTE })
    events.push({ type: 'assistant/message', time: BASE + (index - 1) * 20 * MINUTE + 1000, data: { turn: index, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 30, cacheReadTokens: 3000, outputTokens: 5 } } }] } })
    events.push({ type: 'turn/end', data: { turn: index } })
  }
  return events
}

function memberSession(startTimes, shares) {
  const events = [system('S'.repeat(100)), header([{ name: 'bash', description: 'd'.repeat(900) }]),
    { type: 'user/message', data: { content: [{ type: 'text', text: `room session-room` }] }, time: BASE }]
  let step = 0
  for (const [index, start] of startTimes.entries()) {
    const share = shares[index]
    events.push({ type: 'turn/start', data: { turn: 1 }, time: start })
    for (let call = 1; call <= 8; call += 1) {
      step += 1
      events.push({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(100 * call) }] }, time: start + call * 1000 })
      events.push({ type: 'assistant/message', time: at(start - BASE + call * 1000), data: { turn: 1, step, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 40_000 + call * 1000, outputTokens: 3 } } }] } })
      if (share && call === 1) {
        events.push(toolCall(`call-${step}`, 'bash'))
        events.push({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: `call-${step}`, content: [{ type: 'text', text: 'B'.repeat(1000) }] } }, time: start + call * 1000 })
        events.push(toolCall(`call-g-${step}`, 'github'))
        events.push({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: `call-g-${step}`, content: [{ type: 'text', text: 'G'.repeat(100) }] } }, time: start + call * 1000 })
      }
      if (share && call === 2) {
        events.push(toolCall(`call-2-${step}`, 'bash'))
        events.push({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: `call-2-${step}`, content: [{ type: 'text', text: 'C'.repeat(500) }] } }, time: start + call * 1000 })
      }
      if (share && call === 3) events.push({ type: 'llm/retry', data: { attempt: 1 }, time: start + call * 1000 })
      if (share && call === 4) events.push({ type: 'llm/retry', data: { attempt: 2 }, time: start + call * 1000 })
      if (share && call <= 3) events.push({ type: 'assistant/attempt', time: start + call * 1000, data: { turn: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: call === 1 ? 7 : 0, cacheReadTokens: 0, outputTokens: 0 } } }] } })
    }
    events.push({ type: 'turn/end', data: { turn: 1 } })
  }
  return events
}

function statsSample(t) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-split-stats-'))
  const workspace = join(dir, 'sessions', '--workspace--')
  mkdirSync(workspace, { recursive: true })
  const sessions = {
    'session-room': roomSession(),
    'session-mem-a': memberSession([BASE + 1 * MINUTE, BASE + 21 * MINUTE], [true, false]),
    'session-mem-b': memberSession([BASE + 2 * MINUTE, BASE + 41 * MINUTE], [false, false]),
  }
  for (const [name, events] of Object.entries(sessions)) {
    const folder = join(workspace, name)
    mkdirSync(folder)
    writeFileSync(join(folder, 'session.v4.jsonl.zstd'), sessionFile(events))
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'sessions')
}

test('#1259: --stats re-derives the §5, §7 and §8 numbers from one command', (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('this Node has no zstd in node:zlib (needs 22.15+)')
    return
  }
  const root = statsSample(t)
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', root, '--stats', '--room', 'session-room'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  // §5 — the sample turn's tool results, counted in the log.
  assert.match(result.stdout, /## Tool results/)
  assert.match(result.stdout, /results 3; characters added 1,600; largest single result 1,000; bash 1,500 chars \(93\.8%\)/)
  // §7 — fan-out: three room messages, member Bots per message 2/1/1, turns 2/1/1.
  assert.match(result.stdout, /## Fan-out/)
  assert.match(result.stdout, /member Bots per message p50\/p90\/max 1\/1\/2/)
  assert.match(result.stdout, /member turns per message p50\/p90\/max 1\/1\/2/)
  // §8 — retries and attempts, by day, with the non-zero usage count.
  assert.match(result.stdout, /## Retries/)
  const retries = result.stdout.slice(result.stdout.indexOf('## Retries'))
  const day = retries.split('\n').find((line) => /^2026-10-25\s+\d/.test(line))
  assert.ok(day, `no per-day retry row:\n${result.stdout}`)
  assert.match(day, /^\S+\s+2\s+3\s+1\s*$/)
})

test('#1259: --stats says which command measures §7 when no room is named', (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('this Node has no zstd in node:zlib (needs 22.15+)')
    return
  }
  const root = statsSample(t)
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', root, '--stats'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /not measured: pass --room <session-id>/)
})
