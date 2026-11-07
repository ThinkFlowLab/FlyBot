import assert from 'node:assert/strict'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ISSUES_URL, cleanText, install as installDiagnostics, reportMarkdown } from '../src/host/diagnostics.js'
import { openJournal, stateText } from '../src/host/journal.js'
import { install as installStore } from '../src/host/store.js'
import { failureLine, install as installTurns, turnFailure } from '../src/host/turns.js'
import { errorCode } from '../src/host/channel.js'
import { SOURCE_KIND } from '../src/host/constants.js'

test('cleanText hides keys, tokens and the home folder', () => {
  const home = '/home/user'
  const text = 'key sk-abcdef123456 and Bearer abc.def.ghi.jkl at http://h:1/?token=XYZ123&x=1 in /home/user/.dsh/bot, "api_key": "zzzzzzzzz", saved VALUE1234'
  const out = cleanText(text, { home, redact: value => value.replaceAll('VALUE1234', '[secret:DEMO]') })
  assert.equal(out, 'key sk-[hidden] and Bearer [hidden] at http://h:1/?token=[hidden]&x=1 in ~/.dsh/bot, "api_key": "[hidden]", saved [secret:DEMO]')
  assert.equal(cleanText('C:\\Users\\Shared\\x and C:/Users/Shared/y', { home: 'C:\\Users\\Shared' }), '~\\x and ~/y')
  assert.ok(cleanText('x'.repeat(5000)).length < 2100)
})

test('cleanText hides standalone credentials it was never given', () => {
  // Synthetic shapes only, built from parts so no string looks like a real key.
  const made = (...parts) => parts.join('')
  const out = cleanText([
    made('ghp_', 'A1'.repeat(12)),
    made('github_pat_', 'B2'.repeat(12)),
    made('AKIA', '0'.repeat(16)),
    made('xoxb-', '1234', '-', 'abcd'.repeat(3)),
    made('AIza', 'C3'.repeat(12)),
    made('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'dGVzdC1zaWduYXR1cmUtcGFydA'),
  ].join(' '), { home: '' })
  assert.equal(out, '[hidden] [hidden] [hidden] [hidden] [hidden] [hidden]')
})

function host(home, extra = {}) {
  const warnings = []
  const disposers = []
  // The real context's effect pair: `dispose()` settles every cleanup, including the writes
  // some of them wait for (the store's and, since #1983, this log's).
  const effect = (execute) => {
    const dispose = execute()
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  const rt = {
    ctx: { logger: { warn: (...args) => warnings.push(args) }, effect },
    home,
    config: {},
    state: { bots: { a: { id: 'a', name: 'Chief', model: 'deepseek/deepseek-chat' } }, mainBotIds: ['a'], rooms: {} },
    readOnly: () => undefined,
    ...extra,
  }
  // A test that overrides `ctx` to drop a logger keeps the effect pair the install needs.
  rt.ctx = { effect, ...rt.ctx }
  installDiagnostics(rt)
  rt.dispose = () => Promise.all(disposers.splice(0).map(dispose => dispose()))
  return rt
}

test('warnings are kept, cleaned, written to the log, and read back after a restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const error = Object.assign(new Error(`cannot open ${homedir()}/x with sk-abcdefghij`), { code: 'EACCES' })
  const quiet = t.mock.method(console, 'error', () => {})
  const rt = host(home)
  rt.warn('ds-bot: state write failed: %s', error)
  rt.noteFailure({ source: 'turn', text: 'Rate limited', code: 'RATE_LIMIT', status: 429, bot: 'Chief', where: 'own chat' })
  const [first, second] = await rt.diagnostics.entries()
  assert.equal(first.level, 'warn')
  assert.equal(first.code, 'EACCES')
  assert.equal(first.text, 'state write failed: cannot open ~/x with sk-[hidden]')
  assert.match(first.stack, /^at TestContext/)
  assert.equal(second.code, 'RATE_LIMIT')

  const report = await rt.diagnostics.report({ client: { surface: 'Web', language: 'zh-CN', userAgent: 'Test/1' }, clientErrors: [{ time: 1, text: 'state: HTTP 502' }] })
  assert.match(report.markdown, /\| FlyBot \| \d+\.\d+\.\d+(?:-[\w.]+)? \|/)
  assert.match(report.markdown, /\| Surface \| Web \|/)
  assert.match(report.markdown, /\| Models \| deepseek\/deepseek-chat \|/)
  assert.match(report.markdown, /WARN host \[EACCES\] state write failed/)
  assert.match(report.markdown, /ERROR turn \(Chief · own chat\) \[RATE_LIMIT 429\] Rate limited/)
  assert.match(report.markdown, /ERROR browser state: HTTP 502/)
  assert.doesNotMatch(report.markdown, /sk-abc|\/home\//)
  assert.equal(report.entries[0].code, 'RATE_LIMIT', 'newest first')

  // Written as JSON lines in the background; a new host reads them back. Wait for the
  // lines rather than a fixed pause, which a busy CI disk can outlast (#551 queue run).
  const logLines = () => {
    try {
      return readFileSync(join(home, 'logs', 'diagnostics.jsonl'), 'utf8').trim().split('\n').length
    } catch {
      return 0 // not written yet
    }
  }
  for (let waited = 0; logLines() < 2 && waited < 5000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(logLines(), 2)
  const again = host(home)
  assert.deepEqual((await again.diagnostics.entries()).map(entry => entry.code), ['EACCES', 'RATE_LIMIT'])
  assert.match(await again.diagnostics.logText(), /\n {4}at TestContext/)
  await again.diagnostics.clear()
  assert.deepEqual(await again.diagnostics.entries(), [])
  assert.deepEqual(await host(home).diagnostics.entries(), [])
  quiet.mock.restore()
})

// #1983: the log is written in the background, so a shutdown that does not drain it leaves a file
// being created after the caller has removed the home — the nightly teardown lost `rmdir` to
// exactly that. A burst guarantees the chain is still busy when `dispose()` is called; every line
// queued before it must be on disk when it resolves.
test('dispose waits for the queued log appends (#1983)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const rt = host(home)
  for (let index = 0; index < 500; index += 1) rt.warn('ds-bot: queued %d', index)
  await rt.dispose()
  const lines = readFileSync(join(home, 'logs', 'diagnostics.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 500, 'every warning queued before dispose is on disk when it resolves')
})

// The log is one leaf file under the home, so a link there is not a place to write — the rule the
// journal keeps (#2074) and the memory side record keeps (#2079). A refusal drops the line and says
// so once; the entries stay readable in memory, and `clear` must not truncate what is behind the link.
test('a linked diagnostics log is refused, not written through', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const target = join(elsewhere, 'diagnostics.jsonl')
  const before = 'PRE-EXISTING LINE\n'
  writeFileSync(target, before)
  const leaf = join(home, 'logs', 'diagnostics.jsonl')
  symlinkSync(target, leaf)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  rt.warn('ds-bot: first entry')
  rt.warn('ds-bot: second entry')
  await rt.dispose()
  const afterWrites = readFileSync(target, 'utf8')
  const entries = await rt.diagnostics.entries()
  await rt.diagnostics.clear()
  const afterClear = readFileSync(target, 'utf8')
  quiet.mock.restore()

  assert.equal(afterWrites, before, 'the file behind the link is not written through')
  assert.equal(afterClear, before, 'clear does not truncate what is behind the link')
  assert.equal(lstatSync(leaf).isSymbolicLink(), true, 'the link is still the leaf')
  assert.equal(readlinkSync(leaf), target)
  assert.deepEqual(entries.map(entry => entry.text), ['first entry', 'second entry'], 'the entries are still readable in memory')
  const refusals = stderr.filter(line => /not a plain file/.test(line))
  assert.equal(refusals.length, 1, 'one refusal, not one for every dropped line')
  assert.equal(refusals[0].includes(home), false, 'the refusal does not print the home folder')
})

// #1916: the browser-log lines in the report are bounded, and those bounds are code-unit ones:
// a line cut inside an emoji is stored and shown as U+FFFD in a report meant for a public issue.
test('a browser-log line cut at its bound never splits a surrogate pair (#1916)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const rt = host(home, { config: { diagnosticsFile: false } })
  const report = await rt.diagnostics.report({
    clientErrors: [{ time: 1, text: `${'x'.repeat(499)}\u{1F600}tail`, code: `${'y'.repeat(39)}\u{1F600}tail` }],
  })
  const line = report.markdown.split('\n').find(item => item.includes('ERROR browser')) ?? ''
  assert.notEqual(line, '')
  assert.equal(line.isWellFormed(), true)
  assert.equal(line.includes('\ufffd'), false)
  assert.ok(line.includes('x'.repeat(499)), 'the text keeps its whole-character prefix')
  assert.ok(line.includes(`[${'y'.repeat(39)}]`), `expected the code prefix, got ${line}`)
})

// #1919: the stack summary in the report is bounded too, and its bound is a code-unit one:
// a message cut inside an emoji shows U+FFFD in a report meant for a public issue.
test('a stack summary cut at its bound never splits a surrogate pair (#1919)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const rt = host(home, { config: { diagnosticsFile: false } })
  const stack = 'Error: x\n    at fake (/tmp/x.js:1:1)'
  const text = `${'a'.repeat(79)}\u{1F600}tail`
  rt.noteFailure({ source: 'host', text, stack })
  const report = await rt.diagnostics.report({})
  const lines = report.markdown.split('\n')
  const at = lines.findIndex(item => item.startsWith('<details><summary>Stack:'))
  assert.notEqual(at, -1)
  const shown = lines[at].replace(/^<details><summary>Stack: /, '').replace(/<\/summary>$/, '')
  // The bound itself: on this input the boundary backs off one unit, so the summary is
  // the 79 characters before the pair. A smaller bound changes this string.
  assert.equal(shown, 'a'.repeat(79))
  assert.ok(shown.length <= 80, `summary is ${shown.length} code units`)
  assert.equal(shown.isWellFormed(), true, `the summary is not well formed: ${shown}`)
  assert.equal(shown.includes('\ufffd'), false)
  assert.equal(Buffer.from(shown, 'utf8').equals(Buffer.from(text, 'utf8').subarray(0, Buffer.byteLength(shown))), true, 'the summary is a byte prefix of the message')
  // Everything below the summary is the entry's stack, unchanged.
  assert.deepEqual(lines.slice(at + 1, at + 6), ['', '```', 'at fake (/tmp/x.js:1:1)', '```', '</details>'])
  assert.equal((await rt.diagnostics.entries()).at(-1).stack, 'at fake (/tmp/x.js:1:1)')

  // `<` is escaped after the cut, on the same text the summary shows.
  const marked = `${'<'.repeat(3)}${'c'.repeat(200)}`
  rt.noteFailure({ source: 'host', text: marked, stack })
  const second = (await rt.diagnostics.report({})).markdown.split('\n')
  const escapedAt = second.findIndex(item => item.startsWith('<details><summary>Stack:') && item.includes('&lt;'))
  assert.notEqual(escapedAt, -1)
  const escaped = second[escapedAt].replace(/^<details><summary>Stack: /, '').replace(/<\/summary>$/, '')
  assert.equal(escaped, `${'&lt;'.repeat(3)}${'c'.repeat(77)}`, 'the cut comes first, then the escaping')
  assert.equal(escaped.includes('<'), false)
  assert.equal(escaped.replaceAll('&lt;', '<').length, 80)
})

test('warnings send only cleaned text to the logger and stderr', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const values = ['synthetic-api-key-123456', 'synthetic-bearer-token-12345', 'synthetic-query-token-12345']
  const error = new Error(`api_key=${values[0]} Bearer ${values[1]} https://example.invalid/?token=${values[2]}`)
  error.stack = `${error.name}: ${error.message}\n    at fake (https://example.invalid/?token=${values[2]}:1:1)`
  const warnings = []
  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home, { config: { diagnosticsFile: false } })
  rt.ctx.logger.warn = (...args) => warnings.push(args)
  rt.warn('ds-bot: warning: %s', error)
  quiet.mock.restore()

  assert.equal(warnings[0][0], '%s')
  assert.match(warnings[0][1], /\[hidden\]/)
  assert.match(stderr[0], /\[hidden\]/)
  assert.match(stderr[0], /at fake/)
  for (const value of values) {
    assert.equal(warnings.flat().join('\n').includes(value), false)
    assert.equal(stderr.join('\n').includes(value), false)
  }
})

test('warnings reach stderr and the log when ctx.logger is missing or has no warn', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const noWarn = host(home, { ctx: { logger: {} }, config: { diagnosticsFile: false } })
  noWarn.warn('ds-bot: logger without warn: %s', 'state.json')
  const noLogger = host(home, { ctx: {}, config: { diagnosticsFile: false } })
  noLogger.warn('ds-bot: no logger at all: %s', 'state.json')
  quiet.mock.restore()
  assert.deepEqual((await noWarn.diagnostics.entries()).map(entry => [entry.level, entry.text]), [['warn', 'logger without warn: state.json']])
  assert.deepEqual((await noLogger.diagnostics.entries()).map(entry => [entry.level, entry.text]), [['warn', 'no logger at all: state.json']])
  assert.equal(stderr.length, 2)
  assert.match(stderr.join('\n'), /logger without warn: state\.json/)
  assert.match(stderr.join('\n'), /no logger at all: state\.json/)
})

test('diagnostics append fallback redacts an error message', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const value = 'synthetic-api-key-append-123456'
  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  const originalAppend = fsp.appendFile
  fsp.appendFile = async (path, ...args) => {
    if (path === join(home, 'logs', 'diagnostics.jsonl')) throw new Error(`synthetic append failure api_key=${value}`)
    return originalAppend(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    rt.noteFailure({ text: 'synthetic entry' })
    await rt.diagnostics.clear()
  } finally {
    fsp.appendFile = originalAppend
    syncBuiltinESMExports()
    quiet.mock.restore()
  }
  assert.equal(stderr.join('\n').includes(value), false)
  assert.match(stderr.join('\n'), /api_key=\[hidden\]/)
})

// #2134: the report is where a user looks after a bug the journal was turned on for, so it says
// whether the journal is still recording or why it stopped, and says nothing while it is off.
test('the diagnostics report says whether the state journal is recording or why it stopped (#2134)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const off = await host(home, { config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.equal(off.facts.stateJournal, undefined, 'a host without the journal says nothing about it')
  assert.doesNotMatch(off.markdown, /state journal:/)

  const target = join(home, 'someone-else.txt')
  writeFileSync(target, 'PRIVATE LINE\n')
  mkdirSync(join(home, 'journal'), { recursive: true })
  const path = join(home, 'journal', 'state.jsonl')
  symlinkSync(target, path)
  const journal = openJournal({ path, warn: () => {} })
  await journal.record(stateText({ version: 2, revision: 1 }))
  const stopped = await host(home, { journal, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.match(stopped.markdown, /^state journal: stopped \(.*not a plain file.*\)$/m)
  assert.equal(stopped.facts.stateJournal.startsWith('stopped ('), true)

  const recording = openJournal({ path: join(home, 'live', 'state.jsonl'), warn: () => {} })
  const live = await host(home, { journal: recording, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.match(live.markdown, /^state journal: recording$/m)
  assert.equal(live.facts.stateJournal, 'recording')
})

// The journal is created before the state lock is asked for, and a window another dsh keeps
// read-only never reaches `journal.record()` at all, so saying `recording` would promise a line
// the file will not get. The paused wording is this host's own state, not a journal fault.
test('a read-only window does not say the state journal is recording (#2153)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const readOnly = () => 'Another dsh (pid 1 on host) holds the team'
  const journal = openJournal({ path: join(home, 'journal', 'state.jsonl'), warn: () => {} })
  const held = await host(home, { journal, readOnly, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.match(held.markdown, /^\| Read-only \| Another dsh \(pid 1 on host\) holds the team \|$/m)
  assert.doesNotMatch(held.markdown, /state journal: recording/)
  assert.match(held.markdown, /^state journal: paused \(this window is read-only\)$/m)
  assert.equal(held.facts.stateJournal, 'paused (this window is read-only)')

  // A journal that did stop keeps its own reason: that is the fault a report is usually for.
  const target = join(home, 'neighbour.txt')
  writeFileSync(target, 'PRIVATE LINE\n')
  mkdirSync(join(home, 'journal'), { recursive: true })
  const path = join(home, 'journal', 'state.jsonl')
  symlinkSync(target, path)
  const stoppedJournal = openJournal({ path, warn: () => {} })
  await stoppedJournal.record(stateText({ version: 2, revision: 1 }))
  const stoppedHeld = await host(home, { journal: stoppedJournal, readOnly, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.match(stoppedHeld.markdown, /^state journal: stopped \(.*not a plain file.*\)$/m)
})

// The writer opens on the first save, so a host that has not saved yet has not read or repaired
// anything: `recording` there promises a line nobody asked the file for. A journal with no
// `opened` is the shape before this change and still says `recording`.
test('a state journal that has not opened says it starts with the first save (#2373)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const notStarted = { status: () => ({ recording: true, opened: false }) }
  const fresh = await host(home, { journal: notStarted, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.match(fresh.markdown, /^state journal: not started \(opens with the first save\)$/m)
  assert.equal(fresh.facts.stateJournal, 'not started (opens with the first save)')

  const legacy = { status: () => ({ recording: true }) }
  const old = await host(home, { journal: legacy, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.match(old.markdown, /^state journal: recording$/m)
  assert.equal(old.facts.stateJournal, 'recording')

  // A read-only window keeps its own wording, before the first save as after it.
  const readOnly = () => 'Another dsh (pid 1 on host) holds the team'
  const held = await host(home, { journal: notStarted, readOnly, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.match(held.markdown, /^state journal: paused \(this window is read-only\)$/m)
  assert.equal(held.facts.stateJournal, 'paused (this window is read-only)')
})

// #2388: `state journal:` answers whether the host is recording, and reads the same on a host
// whose file is a few hundred bytes and on one whose leaf another programme replaced with a link.
// The report names the file instead — the path with the home as `~`, its size, and when it was
// last written — or says why there is nothing to name. `lstat` only: a report that read the file
// would need a permission it must not ask for, and would touch what it describes.
test('the report names the journal file, its size and when it was last written (#2388)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(home, 'journal', 'state.jsonl')
  const journal = openJournal({ path, warn: () => {} })
  await journal.record(stateText({ version: 2, revision: 1 }))
  const info = lstatSync(path)

  const report = await host(home, { journal, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.equal(report.facts.journalFile, `~/journal/state.jsonl (${info.size} bytes, last written ${new Date(info.mtimeMs).toISOString()})`)
  assert.match(report.markdown, /^journal file: ~\/journal\/state\.jsonl \(\d+ bytes, last written \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/m)
  assert.ok(report.markdown.includes('state journal: recording\n\njournal file: '), 'the file line is its own paragraph right after the journal sentence')
  assert.equal(report.markdown.includes(home), false, 'the line never carries the home folder')
})

// A journal that has not saved yet has no file to name, and naming it must not create one.
test('a journal with no file yet says so, and the report keeps its journal sentence (#2388)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(home, 'journal', 'state.jsonl')
  const journal = openJournal({ path, warn: () => {} })

  const report = await host(home, { journal, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.equal(report.facts.journalFile, 'none yet')
  assert.match(report.markdown, /^journal file: none yet$/m)
  assert.match(report.markdown, /^state journal: /m, 'the journal sentence keeps its own line')
  assert.equal(existsSync(path), false, 'naming the file creates nothing')
})

// A link and a second name both read as a file to a reader; a report may quote neither, because
// the bytes are not this host's own and the read would be the touch it must not make.
test('a journal leaf that is a link or a second name is named as not a plain file (#2388)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'journal'), { recursive: true })
  const kept = '{"seq":1,"op":"base"}\n'

  const target = join(elsewhere, 'someone-else.jsonl')
  writeFileSync(target, kept)
  const linked = join(home, 'journal', 'state.jsonl')
  symlinkSync(target, linked)
  const stub = { status: () => ({ recording: true }) }
  const linkedReport = await host(home, { journal: { ...stub, path: linked }, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.equal(linkedReport.facts.journalFile, 'not a plain file (nothing is read or written)')
  assert.match(linkedReport.markdown, /^journal file: not a plain file \(nothing is read or written\)$/m)
  assert.equal(readFileSync(target, 'utf8'), kept, 'the file behind the link keeps its bytes')

  const plain = join(home, 'journal', 'plain.jsonl')
  const shared = join(home, 'journal', 'shared.jsonl')
  writeFileSync(plain, kept)
  linkSync(plain, shared)
  const hardReport = await host(home, { journal: { ...stub, path: shared }, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.equal(hardReport.facts.journalFile, 'not a plain file (nothing is read or written)')
  assert.match(hardReport.markdown, /^journal file: not a plain file \(nothing is read or written\)$/m)
  assert.equal(readFileSync(plain, 'utf8'), kept, 'the other name keeps its bytes')
  assert.equal(hardReport.markdown.includes(home), false, 'the line never carries the home folder')
})

// The line belongs to the journal paragraph (#2134): a host without a journal says nothing.
test('a host with no journal says nothing about a journal file (#2388)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const report = await host(home, { config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.equal(report.facts.journalFile, undefined)
  assert.doesNotMatch(report.markdown, /journal file:/)
  assert.doesNotMatch(report.markdown, /state journal:/)
})

// The proof that the line never reads: a zero-byte file with no read bit still answers its size
// and last write time, which `readFile` could not do here at all.
test('a journal file the report may not read still answers its size and time (#2388)', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads a file without its read bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(home, 'journal', 'state.jsonl')
  mkdirSync(join(home, 'journal'), { recursive: true })
  writeFileSync(path, '')
  chmodSync(path, 0o000)
  const info = lstatSync(path)
  assert.throws(() => readFileSync(path), /EACCES/, 'this file cannot be read at all')

  const report = await host(home, { journal: { path, status: () => ({ recording: true }) }, config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.equal(report.facts.journalFile, `~/journal/state.jsonl (0 bytes, last written ${new Date(info.mtimeMs).toISOString()})`)
  assert.match(report.markdown, /^journal file: ~\/journal\/state\.jsonl \(0 bytes, last written .+\)$/m)
})

// #2383: the report is what a user hands over, and it never said that this host's own log file
// could not be written. The reason was already computed for stderr (`fileFailed`, `refusedLeaf`)
// and never reached `facts()`/`reportMarkdown()`, so a support bundle showed the recent errors
// without the one sentence that explains why their file is missing or short. The line follows the
// journal's shape (#2134): a host with the log off adds none, a host with it on says whether it is
// recording or why it is not, and it never carries the home folder.
test('the report says the diagnostics log could not be written (#2383)', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root writes a leaf without its write bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  writeFileSync(logPath, 'OLD LINE\n')
  chmodSync(logPath, 0o444)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  rt.warn('ds-bot: a line the log refuses')
  await rt.dispose()
  const report = await rt.diagnostics.report({})
  quiet.mock.restore()

  assert.equal(report.facts.diagnosticsLog, 'not written (EACCES)', 'the report carries the reason, not only stderr')
  assert.match(report.markdown, /^diagnostics log: not written \(EACCES\)$/m)
  assert.equal(stderr.filter(line => /not written/.test(line)).length, 1, 'stderr keeps its one line')
  assert.equal(report.markdown.includes(home), false, 'the line never carries the home folder')
  assert.equal(readFileSync(logPath, 'utf8'), 'OLD LINE\n', 'the leaf keeps its bytes')
})

// The other reason the log is not written is the leaf guard (#2089): a link at the path is not
// this host's to write. The report names the refusal in the same words stderr uses, and the file
// behind the link keeps its bytes (the refusal itself is unchanged).
test('the report says the diagnostics log is not a plain file of its own (#2383)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const target = join(elsewhere, 'diagnostics.jsonl')
  const before = 'PRE-EXISTING LINE\n'
  writeFileSync(target, before)
  symlinkSync(target, join(home, 'logs', 'diagnostics.jsonl'))

  const rt = host(home)
  rt.warn('ds-bot: first entry')
  await rt.dispose()
  const report = await rt.diagnostics.report({})

  assert.equal(report.facts.diagnosticsLog, 'not written (not a plain file of its own)')
  assert.match(report.markdown, /^diagnostics log: not written \(not a plain file of its own\)$/m)
  assert.equal(readFileSync(target, 'utf8'), before, 'the file behind the link keeps its bytes')
  assert.equal(report.markdown.includes(home), false, 'the line never carries the home folder')
})

// The refusal on stderr is a latch for the host's lifetime (#2089): one line per host, however many
// entries the guard drops. The report line answers a different question — what the leaf is now — so
// the two must not share one flag. A host whose link was replaced by a file of its own writes the
// next entry into that leaf, and the report has to say `recording`; the stderr latch keeps its one
// line and is not refreshed by the landing entry.
test('the report says recording again once the leaf is readable again (#2383)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const target = join(elsewhere, 'diagnostics.jsonl')
  const before = 'PRE-EXISTING LINE\n'
  writeFileSync(target, before)
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  symlinkSync(target, logPath)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  rt.warn('ds-bot: a line the link refuses')
  // The refusal is written inside the background chain, so wait for it rather than for a pause: the
  // link has to be gone only after the entry was actually refused, not only after it was queued.
  const refused = () => stderr.some(line => /is not a plain file of its own/.test(line))
  for (let waited = 0; !refused() && waited < 5000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(refused(), true, 'the guard refused the entry while the leaf was a link')
  rmSync(logPath)
  rt.warn('ds-bot: a line that lands')
  await rt.dispose()
  const report = await rt.diagnostics.report({})
  quiet.mock.restore()

  assert.equal(readFileSync(target, 'utf8'), before, 'the file behind the link keeps its bytes')
  const written = readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(written.length, 1, 'the entry landed in the leaf of its own')
  assert.match(written[0], /a line that lands/)
  assert.equal(report.facts.diagnosticsLog, 'recording', 'the report describes the leaf as it is now')
  assert.match(report.markdown, /^diagnostics log: recording$/m)
  const refusals = stderr.filter(line => /is not a plain file of its own/.test(line))
  assert.equal(refusals.length, 1, 'the stderr latch keeps its one line per host')
})

// The two reasons are read as the leaf stands when the report is built, and the leaf can change
// between attempts (#2383): a host whose link was refused and whose leaf is then a plain 0444 file
// meets EACCES on the next append, so the report has to name EACCES rather than the earlier refusal.
// The stderr latches keep their own lines: one guard line and one failure line for the host.
test('the report names the reason the last append met (#2383)', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root writes a leaf without its write bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const target = join(elsewhere, 'diagnostics.jsonl')
  const before = 'PRE-EXISTING LINE\n'
  writeFileSync(target, before)
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  symlinkSync(target, logPath)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  rt.warn('ds-bot: a line the link refuses')
  const refused = () => stderr.some(line => /is not a plain file of its own/.test(line))
  for (let waited = 0; !refused() && waited < 5000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(refused(), true, 'the guard refused the entry while the leaf was a link')
  rmSync(logPath)
  writeFileSync(logPath, 'OLD LINE\n')
  chmodSync(logPath, 0o444)
  rt.warn('ds-bot: a line the plain leaf refuses')
  await rt.dispose()
  const report = await rt.diagnostics.report({})
  quiet.mock.restore()

  assert.equal(readFileSync(target, 'utf8'), before, 'the file behind the link keeps its bytes')
  assert.equal(readFileSync(logPath, 'utf8'), 'OLD LINE\n', 'the leaf keeps its bytes')
  assert.equal(report.facts.diagnosticsLog, 'not written (EACCES)', 'the reason is the one the last attempt met')
  assert.match(report.markdown, /^diagnostics log: not written \(EACCES\)$/m)
  assert.equal(stderr.filter(line => /is not a plain file of its own/.test(line)).length, 1, 'the stderr latch keeps its one guard line')
  assert.equal(stderr.filter(line => /not written: EACCES/.test(line)).length, 1, 'the failure keeps its one line')
})

// The two ordinary states, in the shape #2134 gave the journal: off adds no line at all, on says
// the log is recording — the answer a bundle needs to tell "no errors were logged" from "the log
// could not take them".
test('the report says nothing about the log while it is off, and recording while it is on (#2383)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const off = await host(home, { config: { diagnosticsFile: false } }).diagnostics.report({})
  assert.equal(off.facts.diagnosticsLog, undefined, 'a host without the log says nothing about it')
  assert.doesNotMatch(off.markdown, /diagnostics log:/)

  const rt = host(home)
  rt.warn('ds-bot: a line that lands')
  await rt.dispose()
  const live = await rt.diagnostics.report({})
  assert.equal(live.facts.diagnosticsLog, 'recording')
  assert.match(live.markdown, /^diagnostics log: recording$/m)
})

// #2604: the log is read once at start-up and the rejection was discarded (`() => []`), so a log
// that exists and holds recorded errors but cannot be opened answered `No host errors recorded.` —
// the read side of #2383. Root reads a file without its read bit, so the case is skipped there.
test('the report says the diagnostics log could not be read (#2604)', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads a file without its read bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  writeFileSync(logPath, `${JSON.stringify({ time: Date.now() - 60_000, level: 'error', source: 'host', text: 'state write failed' })}\n`)
  chmodSync(logPath, 0o000)
  t.after(() => {
    try { chmodSync(logPath, 0o644) } catch { /* the home may already be gone */ }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  assert.throws(() => readFileSync(logPath), /EACCES/, 'this file cannot be read at all')

  const rt = host(home)
  const report = await rt.diagnostics.report({})

  assert.equal(report.facts.diagnosticsLog, 'not read (EACCES)', 'the report names the read it could not make')
  assert.match(report.markdown, /^diagnostics log: not read \(EACCES\)$/m)
  assert.match(report.markdown, /The diagnostics log could not be read \(EACCES\); the errors it holds are not shown\./)
  assert.doesNotMatch(report.markdown, /No host errors recorded\./, 'an unread log is not a log with no errors')
  assert.equal(report.total, 0, 'the lines it could not read are counted as nothing rather than guessed at')
  const listed = await rt.diagnostics.entries()
  assert.equal(listed.length, 0, 'the list does not invent the entries it could not read')
  assert.equal(listed.unread, 'EACCES', 'and says the log was not read rather than being empty')
  assert.equal(report.unread, 'EACCES', 'the report answers the same way')
  assert.match(await rt.diagnostics.logText(), /could not be read \(EACCES\); the errors it holds are not shown/, 'the Download says so instead of handing over an empty file')
  assert.equal(report.markdown.includes(home), false, 'the sentence never carries the home folder')
})

// The other half of #2604: the read failure is about the lines an earlier run wrote, so the errors
// this host recorded since start-up still reach the report — and the line names both faults when the
// same leaf refuses the append too.
test('a failed read of the log keeps the errors this host recorded since start-up (#2604)', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads a file without its read bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  writeFileSync(logPath, `${JSON.stringify({ time: Date.now() - 60_000, level: 'error', source: 'host', text: 'an earlier run line' })}\n`)
  chmodSync(logPath, 0o000)
  t.after(() => {
    try { chmodSync(logPath, 0o644) } catch { /* the home may already be gone */ }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  rt.warn('ds-bot: a line written since start-up')
  await rt.dispose()
  const report = await rt.diagnostics.report({})
  quiet.mock.restore()

  assert.equal(report.total, 1, 'the line this host recorded is still counted')
  assert.equal(report.entries[0].text, 'a line written since start-up')
  assert.match(report.markdown, /a line written since start-up/)
  assert.match(report.markdown, /The diagnostics log could not be read \(EACCES\); the errors it holds are not shown\./)
  assert.doesNotMatch(report.markdown, /No host errors recorded\./)
  assert.equal(report.facts.diagnosticsLog, 'not written (EACCES), not read (EACCES)', 'the one line names both faults')
  const download = await rt.diagnostics.logText()
  assert.match(download, /a line written since start-up/, 'the Download still carries the live line')
  assert.match(download, /could not be read \(EACCES\)/, 'and says the earlier lines were not read')
  assert.equal(stderr.filter(line => /not written/.test(line)).length, 1, 'stderr keeps its one line')
})

// The Read-only row answered one constant for every window that may not write, but the store
// answers three ways (#2153): `stuck` (the team file cannot be read) is not a live lock at all,
// and a report that calls a newer or unreadable team file "another dsh holds the team" sends the
// reader to close a host that is not running. These four build the real store and the real
// diagnostics on one runtime, so the sentence is the one the host actually produces.
async function realHost(t, { saved, locked = false, prepare } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-ro-'))
  const statePath = join(home, 'state.json')
  prepare?.(statePath)
  if (saved === 'dir') mkdirSync(statePath)
  else if (saved !== undefined) writeFileSync(statePath, JSON.stringify(saved))
  // A lock file naming a live process is exactly what a second dsh leaves behind.
  if (locked) writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, host: hostname(), token: 'the-other-dsh' }))
  const disposers = []
  const rt = {
    ctx: {
      logger: { warn: () => {} },
      effect(execute) {
        const dispose = execute()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
    },
    home,
    statePath,
    config: { diagnosticsFile: false },
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn: () => {},
  }
  installStore(rt)
  await rt.load()
  installDiagnostics(rt)
  t.after(async () => {
    await Promise.all(disposers.splice(0).map(dispose => dispose()))
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, statePath, rt, readOnly: rt.readOnly(), report: await rt.diagnostics.report({}) }
}

// The state line's own sentence for a link or a second name (#2404). The journal leaf keeps
// `nothing is read or written`; the store reads this file through the link and replaces the name.
const LINKED_STATE = 'not a plain file (described only; the store reads the team file through the link and the next save replaces the name)'

// #2394: the report counts the team — Bots, Main Bots, group chats — and never says what that team
// is saved in. `rt.statePath` was already on the runtime (store.js), and the file holds the members
// and the messages themselves, so the line describes it with `lstat` alone: size and last write
// time, `none yet` before this computer saves the team, or the one sentence for a leaf that is a
// link, a second name or anything else this report may describe but never read.
test('the report names the team file, its size and when it was last written (#2394)', async (t) => {
  const { home, statePath, rt } = await realHost(t)
  await rt.save()
  const info = lstatSync(statePath)
  const report = await rt.diagnostics.report({})

  assert.equal(report.facts.stateFile, `~/state.json (${info.size} bytes, last written ${new Date(info.mtimeMs).toISOString()})`)
  assert.match(report.markdown, /^state file: ~\/state\.json \(\d+ bytes, last written \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/m)
  assert.ok(report.markdown.indexOf('state file: ') > report.markdown.indexOf('| Team |'), 'the line follows the table that counts the team')
  assert.equal(report.markdown.includes(home), false, 'the line never carries the home folder')
  assert.match(readFileSync(statePath, 'utf8'), /"version": 2/, 'the file it names is the one the save wrote')
})

// Naming the file must not create it: a computer that has not saved this team has no team file yet,
// and the answer says that instead of quoting a size for a file the next save would make. The
// store's first boot saves the migrated team, so the absent file here is one this computer does not
// have — deleted since, or a save that never landed — and the report must describe that and nothing
// else.
test('a computer that has not saved the team says so, and naming the file creates nothing (#2394)', async (t) => {
  const { home, statePath, rt } = await realHost(t)
  rmSync(statePath)
  const report = await rt.diagnostics.report({})
  assert.equal(report.facts.stateFile, 'none yet (this computer has not saved the team)')
  assert.match(report.markdown, /^state file: none yet \(this computer has not saved the team\)$/m)
  assert.equal(existsSync(statePath), false, 'naming the file creates nothing')
  assert.equal(readdirSync(home).some(name => name.startsWith('state.json.')), false, 'and writes no temp name beside it')
})

// The team file's bytes are the members and the messages. A directory, a link and a second name are
// each a name this report may describe and must not read through — and the bytes behind the link and
// the other name stay exactly as they were. A directory keeps the journal leaf's sentence, which is
// true of it; a link says what the store does with that shape instead (#2404).
test('a team file that is a directory, a link or a second name is named as not a plain file (#2394)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  const kept = '{"version":2,"bots":{}}\n'
  const quiet = { config: { diagnosticsFile: false } }

  const asDir = join(home, 'dir-home')
  mkdirSync(join(asDir, 'state.json'), { recursive: true })
  const dirReport = await host(asDir, { ...quiet, statePath: join(asDir, 'state.json') }).diagnostics.report({})
  assert.equal(dirReport.facts.stateFile, 'not a plain file (nothing is read or written)')
  assert.match(dirReport.markdown, /^state file: not a plain file \(nothing is read or written\)$/m)

  const target = join(elsewhere, 'someone-else.json')
  writeFileSync(target, kept)
  const linked = join(home, 'link-home')
  mkdirSync(linked, { recursive: true })
  symlinkSync(target, join(linked, 'state.json'))
  const linkedReport = await host(linked, { ...quiet, statePath: join(linked, 'state.json') }).diagnostics.report({})
  assert.equal(linkedReport.facts.stateFile, LINKED_STATE)
  assert.match(linkedReport.markdown, /^state file: not a plain file \(described only; the store reads the team file through the link and the next save replaces the name\)$/m)
  assert.equal(readFileSync(target, 'utf8'), kept, 'the file behind the link keeps its bytes')

  const plain = join(elsewhere, 'plain.json')
  writeFileSync(plain, kept)
  const shared = join(home, 'hard-home')
  mkdirSync(shared, { recursive: true })
  linkSync(plain, join(shared, 'state.json'))
  const hardReport = await host(shared, { ...quiet, statePath: join(shared, 'state.json') }).diagnostics.report({})
  assert.equal(lstatSync(plain).nlink, 2, 'this is a file with a second name')
  assert.equal(hardReport.facts.stateFile, LINKED_STATE)
  assert.match(hardReport.markdown, /^state file: not a plain file \(described only; the store reads the team file through the link and the next save replaces the name\)$/m)
  assert.equal(readFileSync(plain, 'utf8'), kept, 'the other name keeps its bytes')
  assert.equal(hardReport.markdown.includes(home), false, 'the line never carries the home folder')
})

// #2404: the state line borrowed the journal leaf's sentence, `nothing is read or written`, but the
// store does both with the team file: `readFile(statePath)` follows the link and `rename(temp,
// statePath)` replaces the name on the next save. A linked `state.json` therefore said nothing had
// been read in the line above a `Read-only` row that could only exist because the read happened and
// failed. The state line describes its own file: described only, read through the link, name
// replaced by the next save. A directory or a check that cannot run keeps the leaf sentence, which
// is true of it.
test('a linked team file is described as read through the link, not as nothing being read (#2404)', async (t) => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  const newer = '{"version":99}\n'
  const target = join(elsewhere, 'newer.json')
  writeFileSync(target, newer)

  const linked = await realHost(t, { prepare: statePath => symlinkSync(target, statePath) })
  const line = linked.report.markdown.match(/^state file: (.*)$/m)?.[1]
  assert.ok(line !== undefined, 'the report still names the team file')
  assert.doesNotMatch(line, /nothing is read or written/, 'the line must not deny the read the row below it proves')
  assert.match(line, /the store reads the team file through the link and the next save replaces the name/)
  assert.match(linked.report.markdown, /^\| Read-only \| The Bot team file .* could not be read \(saved by a newer FlyBot; update FlyBot\)/m,
    'the row that only exists because the file was read stays as it is')
  assert.equal(readFileSync(target, 'utf8'), newer, 'the file behind the link keeps its bytes')

  const plain = join(elsewhere, 'plain.json')
  writeFileSync(plain, newer)
  const shared = await realHost(t, { prepare: statePath => linkSync(plain, statePath) })
  const hardLine = shared.report.markdown.match(/^state file: (.*)$/m)?.[1]
  assert.equal(lstatSync(plain).nlink, 2, 'this is a file with a second name')
  assert.doesNotMatch(hardLine, /nothing is read or written/, 'a second name is read and replaced the same way')
  assert.match(hardLine, /the store reads the team file through the link and the next save replaces the name/)
  assert.equal(readFileSync(plain, 'utf8'), newer, 'the other name keeps its bytes')
})

// A link does not say what it points at, and the store's answer depends on the target (#2404 wrote
// the link sentence for one shape of it). A linked plain file is read through the link and replaced
// by the next save; a link to a folder is read by `readFile(statePath)` as a folder — EISDIR, the
// store lands in `stuck`, `writable()` stays false and no save ever replaces the name. So the line
// above a `Read-only` row that says the read failed denied that read and promised a save that cannot
// happen. The target is asked with `stat` for its metadata only — the bytes behind the link stay
// unread, which is all this report may do with them — and only a plain file earns the link sentence;
// a folder or a link to nothing keeps the leaf sentence, which is true of both.
test('a team file linking to a folder keeps the leaf sentence, not the read-through-link one', async (t) => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  const folder = join(elsewhere, 'a-folder')
  mkdirSync(folder)
  writeFileSync(join(folder, 'kept.txt'), 'a file that stays\n')

  const linked = await realHost(t, { prepare: statePath => symlinkSync(folder, statePath) })
  const line = linked.report.markdown.match(/^state file: (.*)$/m)?.[1]
  assert.ok(line !== undefined, 'the report still names the team file')
  assert.match(line, /^not a plain file \(nothing is read or written\)$/,
    'a link the store cannot read through is not described as read through')
  assert.match(linked.report.markdown, /^\| Read-only \| The Bot team file .* could not be read \(EISDIR\)/m,
    'the row below it says that read happened and failed')
  assert.deepEqual(readdirSync(folder), ['kept.txt'], 'the folder behind the link keeps exactly what it had')

  const linkHome = join(elsewhere, 'link-home')
  mkdirSync(linkHome)
  const dangling = host(linkHome, { config: { diagnosticsFile: false }, statePath: join(linkHome, 'state.json') })
  symlinkSync(join(elsewhere, 'not-there.json'), join(linkHome, 'state.json'))
  const danglingReport = await dangling.diagnostics.report({})
  assert.match(danglingReport.markdown, /^state file: not a plain file \(nothing is read or written\)$/m,
    'a link to no file is not described as read through either')
  assert.equal(existsSync(join(elsewhere, 'not-there.json')), false, 'asking the link creates nothing')
})

// #2428: a link can name a plain file this host cannot read at all. `stat` alone answered "a plain
// file", so the state line promised a read and a save that the row below it already contradicted:
// `readFile(statePath)` fails EACCES, the store lands in `stuck`, `writable()` stays false and no
// save ever renames over the name. The permission is asked with `access(path, R_OK)`, which opens
// nothing and reads no byte, and only a target this host may read earns the link sentence.
test('a team file linking to a file it cannot read keeps the leaf sentence, not the read-through-link one', {
  // Root reads a file without its read bits, so the case cannot be built there; the runner marks
  // it skipped instead of asserting something the kernel never enforces.
  skip: process.getuid?.() === 0 ? 'root reads a file without its read bits' : undefined,
}, async (t) => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  const target = join(elsewhere, 'unreadable.json')
  const kept = '{"version":2,"bots":{}}\n'
  writeFileSync(target, kept)
  chmodSync(target, 0o000)
  // The restore is registered before the folder's removal, and the body restores it as well, so a
  // failed assertion never leaves a `000` file behind the symlink for a later hook to trip over.
  t.after(() => chmodSync(target, 0o600))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))

  const linked = await realHost(t, { prepare: statePath => symlinkSync(target, statePath) })
  const line = linked.report.markdown.match(/^state file: (.*)$/m)?.[1]
  assert.equal(linked.report.facts.stateFile, 'not a plain file (nothing is read or written)',
    'a link the store cannot read through is not described as read through')
  assert.equal(line, 'not a plain file (nothing is read or written)')
  assert.match(linked.report.markdown, /^\| Read-only \| The Bot team file .* could not be read \(EACCES\)/m,
    'the row below it says that read happened and failed')

  chmodSync(target, 0o600)
  assert.equal(readFileSync(target, 'utf8'), kept, 'the target keeps every byte while it is unreadable')
})

// The store keeps backups beside the team file, and a report about a team that cannot be read
// must say whether they are there and whether they can be read: one `state.json.v1` taken before
// a version-1 migration, and `state.json.broken-<stamp>` copies of a file that could not be read.
// The line lists names only — `lstat` for each and one `readdir` for the broken names, never an
// open: a backup holds the same members, messages and saved keys as the file itself.
test('a host with no state backups says none', async (t) => {
  const { rt } = await realHost(t)
  await rt.save()
  const report = await rt.diagnostics.report({})
  assert.equal(report.facts.stateBackups, 'none')
  assert.match(report.markdown, /^state backups: none$/m)
})

test('one readable backup is named with its size and age, and no other line moves', async (t) => {
  const { home, rt } = await realHost(t)
  await rt.save()
  const before = (await rt.diagnostics.report({})).markdown.split('\n')
  const v1 = join(home, 'state.json.v1')
  writeFileSync(v1, 'x'.repeat(12 * 1024))
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000)
  utimesSync(v1, twoHoursAgo, twoHoursAgo)

  const report = await rt.diagnostics.report({})
  assert.equal(report.facts.stateBackups, 'state.json.v1 (12 KB, 2 h ago)')
  const shown = report.markdown.split('\n')
  const at = shown.indexOf('state backups: state.json.v1 (12 KB, 2 h ago)')
  assert.ok(at > 0, 'the report carries the line')
  assert.match(shown[at - 1], /^state file: /, 'it follows the team file line inside the same block')
  const withoutBackups = text => text.filter(line => !line.startsWith('state backups: '))
  assert.deepEqual(withoutBackups(shown), withoutBackups(before), 'the backups line is the only line this change adds')
})

test('a backup whose lstat fails is named with its code and the report still prints', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => {
    try { chmodSync(home, 0o700) } catch { /* the home is already gone */ }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  writeFileSync(join(home, 'state.json'), '{"version":2}\n')
  writeFileSync(join(home, 'state.json.v1'), '{"version":1}\n')
  chmodSync(home, 0o000)
  const report = await host(home, { config: { diagnosticsFile: false }, statePath: join(home, 'state.json') }).diagnostics.report({})
  assert.equal(report.facts.stateBackups, 'state.json.v1 (unreadable: EACCES)')
  assert.match(report.markdown, /^state backups: state\.json\.v1 \(unreadable: EACCES\)$/m)
  assert.match(report.markdown, /^state file: /m, 'the team file line still prints')
})

test('a backup that is a directory or a link to nothing is drawn from its own lstat', async (t) => {
  const asDir = await realHost(t)
  mkdirSync(join(asDir.home, 'state.json.v1'))
  const dirReport = await asDir.rt.diagnostics.report({})
  assert.match(dirReport.facts.stateBackups, /^state\.json\.v1 \(\d+ (?:B|KB|MB), .+\)$/,
    'a name lstat answers for keeps the size-and-age shape, whatever it points at')
  assert.doesNotMatch(dirReport.markdown, /unreadable: not a plain file/, 'no sentence is invented for a name lstat could describe')

  const dangling = await realHost(t)
  symlinkSync(join(dangling.home, 'missing-backup'), join(dangling.home, 'state.json.v1'))
  const linkReport = await dangling.rt.diagnostics.report({})
  assert.match(linkReport.facts.stateBackups, /^state\.json\.v1 \(\d+ (?:B|KB|MB), .+\)$/)
  assert.equal(existsSync(join(dangling.home, 'missing-backup')), false, 'asking the link creates nothing')
})

test('the broken copies are listed newest first, three at most, with the rest counted', async (t) => {
  const { home, rt } = await realHost(t, { locked: true })
  const readOnly = (await rt.diagnostics.report({})).markdown.match(/^\| Read-only \| (.*)$/m)?.[1]
  for (let i = 1; i <= 5; i += 1) {
    const name = join(home, `state.json.broken-${1000 + i}`)
    writeFileSync(name, 'x'.repeat(12 * 1024))
    const when = new Date(Date.now() - i * 3_600_000)
    utimesSync(name, when, when)
  }
  writeFileSync(join(home, 'other.txt'), 'not a backup')
  const report = await rt.diagnostics.report({})
  assert.equal(report.facts.stateBackups, 'state.json.broken-1001 (12 KB, 1 h ago), state.json.broken-1002 (12 KB, 2 h ago), state.json.broken-1003 (12 KB, 3 h ago), and 2 more')
  assert.match(report.markdown, /^state backups: state\.json\.broken-1001 /m)
  assert.doesNotMatch(report.markdown, /other\.txt/, "only the store's own backup prefix is listed")
  assert.equal(report.markdown.match(/^\| Read-only \| (.*)$/m)?.[1], readOnly, 'the Read-only row is unchanged')
})

// The line is read information, not a write: a window another dsh keeps read-only still names the
// team file, the way it still counts the team it shows.
test('a read-only window names the team file too (#2394)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, '{"version":2}\n')
  const info = lstatSync(statePath)
  const report = await host(home, {
    config: { diagnosticsFile: false },
    statePath,
    readOnly: () => 'Another dsh (pid 1 on host) holds the team',
  }).diagnostics.report({})

  assert.match(report.markdown, /^\| Read-only \| /m, 'this window says it may not write')
  assert.equal(report.facts.stateFile, `~/state.json (${info.size} bytes, last written ${new Date(info.mtimeMs).toISOString()})`)
  assert.match(report.markdown, /^state file: ~\/state\.json \(\d+ bytes, last written .+\)$/m)
})

test('the Read-only row says a newer team file needs an update, not that another dsh holds the team (#2167)', async (t) => {
  const { home, readOnly, report } = await realHost(t, { saved: { version: 99 } })
  assert.match(readOnly, /update FlyBot/)
  assert.ok(report.markdown.includes(`| Read-only | The Bot team file ${join(home, 'state.json')} could not be read (saved by a newer FlyBot; update FlyBot). FlyBot does not change it; fix or move the file and reload. |`), report.markdown)
  assert.doesNotMatch(report.markdown, /another dsh holds the team/)
})

test('the Read-only row says an unreadable team file could not be read, not that another dsh holds the team (#2167)', async (t) => {
  const { report } = await realHost(t, { saved: 'dir' })
  assert.match(report.markdown, /^\| Read-only \| The Bot team file .* could not be read \(EISDIR\)\. FlyBot does not change it; fix or move the file and reload\. \|$/m)
  assert.doesNotMatch(report.markdown, /another dsh holds the team/)
})

test('the Read-only row keeps the other-dsh wording when a live lock names it (#2167)', async (t) => {
  const { report } = await realHost(t, { locked: true })
  assert.ok(report.markdown.includes('open in another dsh (Web or Desktop, pid 1 on '), report.markdown)
  assert.match(report.markdown, /This window shows the team but cannot change it; close the other one and reload\./)
  assert.doesNotMatch(report.markdown, /could not be read/)
})

test('a writable window has no Read-only row', async (t) => {
  const { report } = await realHost(t)
  assert.equal(report.facts.readOnly, undefined)
  assert.doesNotMatch(report.markdown, /^\| Read-only \|/m)
})

test('reportMarkdown says when nothing went wrong', () => {
  const text = reportMarkdown({ facts: { botVersion: '0.1.0', os: 'linux' } })
  assert.match(text, /No host errors recorded\./)
  assert.doesNotMatch(text, /DSH \|/)
})

test('errorCode tells refusals from DS Bot faults', () => {
  assert.equal(errorCode(new Error('Unknown Bot')), 'bot/refused')
  assert.equal(errorCode(new TypeError('x is undefined')), 'bot/internal')
  assert.equal(errorCode(Object.assign(new Error('no'), { code: 'ENOENT' })), 'bot/internal')
  assert.equal(errorCode(Object.assign(new Error('no'), { code: 'ERR_SQLITE_ERROR' })), 'bot/internal')
  assert.equal(errorCode(Object.assign(new Error('no'), { code: 'ERR_INVALID_ARG_TYPE' })), 'bot/internal')
  assert.equal(errorCode(Object.assign(new Error('no'), { code: 'bot/read-only' })), 'bot/read-only')
})

test('turnFailure drops AUTH messages and keeps the facts', () => {
  assert.deepEqual(turnFailure({ code: 'AUTH', message: 'bad key sk-12***34', status: 401 }), { code: 'AUTH', message: '', status: 401 })
  assert.deepEqual(turnFailure({ code: 'RATE_LIMIT', message: ' slow down ', requestId: 'r1' }), { code: 'RATE_LIMIT', message: 'slow down', requestId: 'r1' })
  assert.deepEqual(turnFailure(undefined), { code: 'UNKNOWN', message: '' })
  assert.equal(failureLine({ code: 'SERVER', status: 503, message: 'busy' }), 'SERVER 503: busy')
})

// A bound that lands between the halves of a surrogate pair keeps the high half alone, and that lone
// surrogate is what the record carries and every renderer draws as U+FFFD. The five bounds in
// turns.js go through `cut()`; each has its own case, in the file that reads its value.
test('a failure message cut at its 500-unit bound keeps the pair whole', () => {
  const message = `${'a'.repeat(499)}😀tail`
  const kept = turnFailure({ code: 'SERVER', message }).message
  assert.equal(kept.isWellFormed(), true, `the message is not well formed: ${JSON.stringify(kept.slice(-4))}`)
  // The emoji needs two units and only one is left inside the bound, so the prefix stops before it.
  assert.equal(kept, message.slice(0, 499))
  assert.ok(kept.length <= 500, `the 500-unit budget moved: ${kept.length}`)
  // A pair that ends exactly on the bound stays whole.
  const exact = `${'a'.repeat(498)}😀`
  assert.deepEqual(turnFailure({ code: 'SERVER', message: exact }).message, exact)
})

test('a failure line cut at its 200-unit message bound keeps the pair whole', () => {
  const line = failureLine({ code: 'SERVER', status: 503, message: `${'a'.repeat(199)}😀tail` })
  assert.equal(line.isWellFormed(), true, `the line is not well formed: ${JSON.stringify(line.slice(-4))}`)
  assert.equal(line, `SERVER 503: ${'a'.repeat(199)}`)
  assert.ok(line.length <= 'SERVER 503: '.length + 200, `the 200-unit budget moved: ${line.length}`)
  assert.equal(failureLine({ code: 'SERVER', status: 503, message: 'busy' }), 'SERVER 503: busy')
})

function turnsHost() {
  let listener
  const delivered = []
  const noted = []
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.bots[id],
    selfOf: id => id,
    save: async () => {},
    deliver: async (args) => { delivered.push(args) },
    noteFailure: entry => noted.push(entry),
    warn() {},
    switchJobs: () => [],
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, emit, delivered, noted }
}

const failed = { kind: 'error', error: { code: 'SERVER', message: 'upstream busy', status: 503 } }

test('a failed reply to message_bot tells the sender instead of leaving it waiting', () => {
  const { emit, delivered, noted } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'a', exchangeId: 'x1', hop: 1 } })
  emit('b', 'turn/end', { turn: 1, reason: failed })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 'x1')
  assert.equal(delivered[0].hop, 2)
  assert.match(delivered[0].text, /^Writer could not answer your message: its model call failed \(SERVER 503: upstream busy\)/)
  assert.deepEqual(noted.map(entry => [entry.source, entry.code, entry.bot, entry.where]), [['turn', 'SERVER', 'Writer', 'own chat']])
})

test('a failed group turn fails its waiter; a stopped one counts as no answer', () => {
  const { rt, emit } = turnsHost()
  rt.roomWaiters.set('r1', { resolve: () => assert.fail('resolved'), fail: failure => rt.roomWaiters.failed = failure })
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: [], source: { kind: SOURCE_KIND, role: 'room', exchangeId: 'r1' } })
  emit('b', 'turn/end', { turn: 1, reason: failed })
  assert.deepEqual(rt.roomWaiters.failed, { code: 'SERVER', message: 'upstream busy', status: 503 })

  let value
  rt.roomWaiters.set('r2', { resolve: reply => { value = reply }, fail: () => assert.fail('failed') })
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: [], source: { kind: SOURCE_KIND, role: 'room', exchangeId: 'r2' } })
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal(value, null)
})

test('issueUrl fills the issue form, keeps the versions when the errors are too long, and falls back to the clipboard', async () => {
  const { issueUrl } = await import('../src/client/diagnostics.js')
  const base = 'https://github.com/ThinkFlowLab/FlyBot/issues/new'
  const short = issueUrl(base, { what: 'Writer failed\nin the group', diagnostics: '| DS Bot | 0.1.0 |' })
  assert.equal(short.inline, true)
  const params = new URL(short.url).searchParams
  assert.equal(params.get('template'), 'bug.yml')
  assert.equal(params.get('title'), 'Writer failed')
  assert.equal(params.get('what'), 'Writer failed\nin the group')
  assert.equal(params.get('diagnostics'), '| DS Bot | 0.1.0 |')
  const long = issueUrl(base, { diagnostics: '错误'.repeat(2000) })
  assert.equal(long.inline, false)
  assert.ok(long.url.length < 7000)
  assert.match(new URL(long.url).searchParams.get('diagnostics'), /clipboard/)
  assert.equal(new URL(long.url).searchParams.has('title'), false)
  const table = '| | |\n|---|---|\n| DS Bot | 0.1.2 |\n| DSH | 0.2.0 |'
  const errors = issueUrl(base, { what: 'Writer failed', diagnostics: `${table}\n\nRecent host errors:\n${'错误'.repeat(2000)}` })
  assert.equal(errors.inline, false)
  assert.ok(errors.url.length < 7000)
  const kept = new URL(errors.url).searchParams.get('diagnostics')
  assert.ok(kept.startsWith(`${table}\n\n`))
  assert.match(kept, /clipboard: paste them below this line/)
  assert.doesNotMatch(kept, /错误/)
})

test('a browser error is noted once, repeats are counted, and clear empties the list', async () => {
  const { noteClientError, markNoted, clientErrors, clearClientErrors } = await import('../src/client/diagnostics.js')
  clearClientErrors()
  const shown = markNoted(new Error('Could not reach DSH.'))
  noteClientError('menu', shown)
  assert.equal(clientErrors().length, 0)
  const failed = new Error('HTTP 502')
  noteClientError('state', failed)
  noteClientError('menu', failed)
  noteClientError('state', new Error('HTTP 502'))
  assert.deepEqual(clientErrors().map(entry => entry.text), ['state: HTTP 502 (×2)'])
  clearClientErrors()
  assert.equal(clientErrors().length, 0)
})

test('Report on GitHub opens a new issue in FlyBot\'s own repository', () => {
  assert.equal(ISSUES_URL, 'https://github.com/ThinkFlowLab/FlyBot/issues/new')
})

// #2159: a hard link at the log is a plain file to `lstat` while its bytes are also a name outside
// the home, so the append and the truncate would land in the shared inode. The leaf is asked with
// the same predicate as the temp name (#2114): the line is dropped, `clear` leaves the other name
// untouched, and one line on stderr says so without printing the home folder.
test('#2159: a hard-linked diagnostics log is refused, and clear does not truncate the shared inode', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-hardlink-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const target = join(elsewhere, 'diagnostics.jsonl')
  const before = 'PRE-EXISTING LINE\n'
  writeFileSync(target, before)
  const leaf = join(home, 'logs', 'diagnostics.jsonl')
  linkSync(target, leaf)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  rt.warn('ds-bot: first entry')
  rt.warn('ds-bot: second entry')
  await rt.dispose()
  const afterWrites = readFileSync(target, 'utf8')
  const entries = await rt.diagnostics.entries()
  await rt.diagnostics.clear()
  const afterClear = readFileSync(target, 'utf8')
  quiet.mock.restore()

  assert.equal(afterWrites, before, 'the shared inode keeps its bytes')
  assert.equal(afterClear, before, 'clear does not truncate the shared inode')
  assert.equal(lstatSync(leaf).nlink, 2, 'the log is still another name of the same file')
  assert.deepEqual(entries.map(entry => entry.text), ['first entry', 'second entry'], 'the entries are still readable in memory')
  const refusals = stderr.filter(line => /not a plain file of its own/.test(line))
  assert.equal(refusals.length, 1, 'one refusal, not one for every dropped line')
  assert.equal(refusals[0].includes(home), false, 'the refusal does not print the home folder')

  // The control: a leaf of one name is written and cleared as before.
  rmSync(leaf)
  const plain = host(home)
  plain.warn('ds-bot: after the shared name is gone')
  await plain.dispose()
  assert.match(readFileSync(leaf, 'utf8'), /after the shared name is gone/)
  await plain.diagnostics.clear()
  assert.equal(readFileSync(leaf, 'utf8'), '')
})

// Clear promises the window's Feedback screen that the error log is gone, but rotation moves the full
// log aside to `diagnostics.jsonl.1` and the truncate only ever touched the leaf: everything that had
// rolled over stayed on disk, and nothing else in the repository reads or removes that name. Clear
// removes it too, in the same chain and behind the same leaf guard as the truncate, so a log moved to a
// link the host refuses still keeps both names exactly as they were.
test('clear removes the rotated log, not only the leaf', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const rotated = `${logPath}.1`
  writeFileSync(logPath, 'OLD LINE\n'.repeat(200_000))
  assert.equal(lstatSync(logPath).size > (1 << 20), true, 'the leaf is past the rotation bound')

  const rt = host(home)
  rt.warn('ds-bot: written after rotation')
  await rt.dispose()
  assert.equal(lstatSync(rotated).size > (1 << 20), true, 'the full log was rotated aside')
  assert.match(readFileSync(logPath, 'utf8'), /written after rotation/)

  await rt.diagnostics.clear()
  assert.equal(readFileSync(logPath, 'utf8'), '', 'the leaf is truncated as before')
  assert.equal(existsSync(rotated), false, 'the rotated log is gone as well')
})

// #2352 moved the rotated copy's removal into the clear chain, but outside a try of its own: `rm` on a
// name that is not a plain file of ours (a directory under the same name, a folder that refuses the
// removal) rejects the whole chain before the truncate runs, and the empty `catch` keeps it quiet — so
// the window answered "Cleared the error log." while every byte of the leaf stayed on disk.
test('#2358: clear truncates the leaf even when the rotated copy cannot be removed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const rotated = `${logPath}.1`
  writeFileSync(logPath, 'OLD LINE\n'.repeat(4))
  mkdirSync(rotated) // `rm` without `recursive` refuses a directory, so the removal throws EISDIR

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  rt.warn('ds-bot: written before the clear')
  await rt.dispose()
  assert.match(readFileSync(logPath, 'utf8'), /written before the clear/)

  await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.equal(readFileSync(logPath, 'utf8'), '', 'the leaf is truncated although the rotated copy stays')
  assert.equal(lstatSync(rotated).isDirectory(), true, 'the name that could not be removed is still there')
  assert.deepEqual(await rt.diagnostics.entries(), [], 'the window reads no entries after a clear')
  const noted = stderr.filter(line => /rotated copy/.test(line))
  assert.equal(noted.length, 1, 'one line says the rotated copy was not removed')
  assert.equal(noted[0].includes(home), false, 'the line does not print the home folder')

  // The control: with the obstructing name gone the same clear removes both, as the previous test asks.
  rmSync(rotated, { recursive: true })
  writeFileSync(rotated, 'ROTATED\n')
  writeFileSync(logPath, 'OLD LINE\n')
  await rt.diagnostics.clear()
  assert.equal(readFileSync(logPath, 'utf8'), '')
  assert.equal(existsSync(rotated), false)
})

// The same defect through the folder instead of the name: a `logs/` without its write bit refuses the
// removal (EACCES) while the leaf itself is still an ordinary file the host may truncate, so before the
// fix the truncate never ran at all. Root ignores the folder's mode, so the case is skipped there.
test('#2358: clear truncates the leaf when the folder refuses the removal', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root removes from a folder without its write bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  const logs = join(home, 'logs')
  t.after(() => {
    try { chmodSync(logs, 0o755) } catch { /* the folder may already be gone */ }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  mkdirSync(logs, { recursive: true })
  const logPath = join(logs, 'diagnostics.jsonl')
  const rotated = `${logPath}.1`

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  rt.warn('ds-bot: written before the clear')
  await rt.dispose()
  writeFileSync(rotated, 'ROTATED\n'.repeat(8))
  chmodSync(logs, 0o555)

  await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.equal(readFileSync(logPath, 'utf8'), '', 'the leaf is truncated although the folder refused the removal')
  assert.equal(readFileSync(rotated, 'utf8'), 'ROTATED\n'.repeat(8), 'the copy that could not be removed keeps its bytes')
  const noted = stderr.filter(line => /rotated copy/.test(line))
  assert.equal(noted.length, 1, 'one line says the rotated copy was not removed')
  assert.equal(noted[0].includes(home), false, 'the line does not print the home folder')

  chmodSync(logs, 0o755)
  await rt.diagnostics.clear()
  assert.equal(existsSync(rotated), false, 'once the folder allows it, the same clear removes the copy')
})
// #2360: Clear answered a constant, so the window could not tell a truncated leaf from a refused
// one, or a removed rotated copy from a leftover, and it said "cleared" whatever happened. Clear
// resolves what it did; the shapes #2352 and #2358 left behind are asserted here as values.
test('#2360: clear reports the leaf it truncated and the rotated copy it removed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  const rt = host(home)
  t.after(async () => { await rt.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const rotated = `${logPath}.1`
  writeFileSync(logPath, 'OLD LINE\n')
  writeFileSync(rotated, 'ROTATED\n')

  assert.deepEqual(await rt.diagnostics.clear(), { leaf: 'truncated', rotated: 'removed' })
  assert.equal(readFileSync(logPath, 'utf8'), '', 'the leaf is empty after the reported truncate')
  assert.equal(existsSync(rotated), false, 'the reported removal really removed the copy')
})

test('#2360: clear reports a rotated copy that could not be removed, and truncates anyway', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  const rt = host(home)
  t.after(async () => { await rt.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const rotated = `${logPath}.1`
  writeFileSync(logPath, 'OLD LINE\n'.repeat(4))
  mkdirSync(rotated) // `rm` without recursive refuses a directory: EISDIR

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const result = await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.deepEqual(result, { leaf: 'truncated', rotated: 'kept' }, 'the leaf says it was truncated, the copy says it stayed')
  assert.equal(readFileSync(logPath, 'utf8'), '', 'the reported truncate really emptied the leaf')
  assert.equal(lstatSync(rotated).isDirectory(), true, 'the reported leftover is still there')
  assert.equal(stderr.filter(line => /rotated copy/.test(line)).length, 1, 'one line says the copy was not removed')
})

test('#2360: clear reports a folder that refused the removal, and truncates anyway', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root removes from a folder without its write bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  const logs = join(home, 'logs')
  const rt = host(home)
  t.after(async () => {
    await rt.dispose()
    try { chmodSync(logs, 0o755) } catch { /* the folder may already be gone */ }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  mkdirSync(logs, { recursive: true })
  const logPath = join(logs, 'diagnostics.jsonl')
  const rotated = `${logPath}.1`
  writeFileSync(logPath, 'OLD LINE\n'.repeat(4))
  writeFileSync(rotated, 'ROTATED\n'.repeat(8))
  chmodSync(logs, 0o555)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const result = await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.deepEqual(result, { leaf: 'truncated', rotated: 'kept' }, 'the leaf says it was truncated, the copy says it stayed')
  assert.equal(readFileSync(logPath, 'utf8'), '', 'the reported truncate really emptied the leaf')
  assert.equal(readFileSync(rotated, 'utf8'), 'ROTATED\n'.repeat(8), 'the reported leftover keeps its bytes')
  assert.equal(stderr.filter(line => /rotated copy/.test(line)).length, 1, 'one line says the copy was not removed')
})

test('#2360: clear reports a leaf it did not truncate, and writes nothing through the link', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-diag-target-'))
  const rt = host(home)
  t.after(async () => {
    await rt.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 })
  })
  mkdirSync(join(home, 'logs'), { recursive: true })
  const target = join(elsewhere, 'diagnostics.jsonl')
  writeFileSync(target, 'PRE-EXISTING LINE\n')
  symlinkSync(target, join(home, 'logs', 'diagnostics.jsonl'))

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const result = await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.deepEqual(result, { leaf: 'kept', rotated: 'none' }, 'the leaf says it was left alone')
  assert.equal(readFileSync(target, 'utf8'), 'PRE-EXISTING LINE\n', 'not one byte was written through the link')
})

test('#2360: a home with no log folder answers absent and leaves the disk as it found it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  const rt = host(home)
  t.after(async () => { await rt.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  assert.deepEqual(await rt.diagnostics.clear(), { leaf: 'absent', rotated: 'none' }, 'nothing was there and nothing was written')
  assert.equal(existsSync(join(home, 'logs')), false, 'the truncate did not create the folder it never created before')
})

// #2364: the leaf guard asks the file's kind, not its mode, so a plain `0444` leaf passes it and
// the write fails with EACCES. #2360 gave the window an answer for that (`leaf: 'kept'`), but the
// host log said nothing at all about a leaf left full, while `append` names the same class of
// failure on one stderr line. Clear now names it too, on one line that carries the code and never
// the folder. Root ignores the mode.
test('#2364: a clear that cannot truncate the leaf says so', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root truncates a leaf without its write bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const rotated = `${logPath}.1`
  const old = 'OLD LINE\n'.repeat(4)
  writeFileSync(logPath, old)
  writeFileSync(rotated, 'ROTATED\n'.repeat(8))

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  chmodSync(logPath, 0o444)

  const result = await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.deepEqual(result, { leaf: 'kept', rotated: 'kept' }, 'the answer names the leaf it kept and the copy it did not remove')
  assert.equal(readFileSync(logPath, 'utf8'), old, 'the leaf keeps every line it had')
  assert.equal(readFileSync(rotated, 'utf8'), 'ROTATED\n'.repeat(8), 'the rotated copy is left where it was')
  const noted = stderr.filter(line => /not truncated/.test(line))
  assert.equal(noted.length, 1, 'one line says the leaf was not truncated')
  assert.match(noted[0], /\[ds-bot\] diagnostics log not truncated: [A-Z]+$/)
  assert.equal(noted[0].includes(home), false, 'the line does not print the home folder')

  // The control: a writable leaf truncates with no line at all.
  chmodSync(logPath, 0o644)
  const control = []
  const quietControl = t.mock.method(console, 'error', (...args) => control.push(args.join(' ')))
  writeFileSync(logPath, old)
  writeFileSync(rotated, 'ROTATED\n')
  await rt.diagnostics.clear()
  quietControl.mock.restore()
  assert.equal(readFileSync(logPath, 'utf8'), '', 'a writable leaf is truncated')
  assert.equal(existsSync(rotated), false, 'and its rotated copy is removed')
  assert.deepEqual(control, [], 'a clear that works says nothing')
})

// #2364 (P-528): the removal ran first, so the same `0444` leaf lost its rotated copy to a Clear
// that could not empty anything — the lines that had rolled over were the only copy left of them,
// and neither the answer nor the page mentioned it. The truncate now runs first: a leaf that stays
// full leaves `.1` byte for byte where it was, answers `rotated: 'none'`, and the one line it prints
// is the truncate failure. The rotated-copy line belongs to a leaf that was emptied. Root ignores
// the mode.
test('#2364: a clear that cannot truncate the leaf keeps the rotated copy', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root truncates a leaf without its write bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const rotated = `${logPath}.1`
  const old = 'OLD LINE\n'.repeat(4)
  const rolled = 'ROTATED\n'.repeat(8)
  writeFileSync(logPath, old)
  writeFileSync(rotated, rolled)
  chmodSync(logPath, 0o444)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  const result = await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.deepEqual(result, { leaf: 'kept', rotated: 'kept' }, 'a leaf that could not be emptied removed nothing')
  assert.equal(readFileSync(logPath, 'utf8'), old, 'the leaf keeps every line it had')
  assert.equal(readFileSync(rotated, 'utf8'), rolled, 'the rotated copy keeps every byte it had')
  assert.equal(existsSync(rotated), true, 'the name is still there to download')
  assert.equal(stderr.filter(line => /rotated copy/.test(line)).length, 0, 'nothing was removed, so no line claims a failed removal')
  const noted = stderr.filter(line => /not truncated/.test(line))
  assert.equal(noted.length, 1, 'one line says the leaf was not truncated')
  assert.match(noted[0], /\[ds-bot\] diagnostics log not truncated: [A-Z]+$/)

  // The control: once the leaf can be written, the same clear empties it and removes the copy.
  chmodSync(logPath, 0o644)
  writeFileSync(logPath, old)
  const control = []
  const quietControl = t.mock.method(console, 'error', (...args) => control.push(args.join(' ')))
  assert.deepEqual(await rt.diagnostics.clear(), { leaf: 'truncated', rotated: 'removed' })
  quietControl.mock.restore()
  assert.equal(readFileSync(logPath, 'utf8'), '', 'the writable leaf is truncated')
  assert.equal(existsSync(rotated), false, 'and its rotated copy is removed')
  assert.deepEqual(control, [], 'a clear that works says nothing')
})

// #2364 (P-530): a Clear that could not empty the leaf still wiped what the window reads. `entries()`
// is the old lines through `cleared` plus the live ones in `fresh`, and clear() advanced both the
// moment it was called, so a refused Clear answered "not cleared" on one line and "0 recent errors" /
// "No entries." next to it while every byte was still on disk and in the Download. Only a leaf that
// really was emptied, or nothing on disk at all, moves the readable surface now. Root ignores the
// mode.
test('#2364: a clear that cannot truncate leaves the readable surface alone', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root truncates a leaf without its write bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const rotated = `${logPath}.1`
  // One line from an earlier run (read through `cleared`) and one from this one (in `fresh`).
  writeFileSync(logPath, `${JSON.stringify({ time: Date.now() - 60_000, level: 'error', source: 'host', text: 'an earlier run line' })}\n`)
  writeFileSync(rotated, 'ROTATED\n')
  const rt = host(home)
  rt.warn('ds-bot: written before the clear')
  await rt.dispose()
  chmodSync(logPath, 0o444)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const result = await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.deepEqual(result, { leaf: 'kept', rotated: 'kept' }, 'the answer names the leaf it kept')
  const kept = await rt.diagnostics.entries()
  assert.equal(kept.length, 2, 'both the earlier line and the live one are still listed')
  assert.equal(kept.some(entry => entry.text === 'an earlier run line'), true, 'the line from an earlier run is still there')
  assert.equal(kept.some(entry => /written before the clear/.test(entry.text)), true, 'the live line is still there')
  const download = await rt.diagnostics.logText()
  assert.match(download, /an earlier run line/, 'the Download still carries the earlier line')
  assert.match(download, /written before the clear/, 'the Download still carries the live line')
  assert.equal(download.includes('No entries.'), false, 'the Download is not the empty page either')

  // The control: a Clear that empties the leaf empties the readable surface too.
  chmodSync(logPath, 0o644)
  assert.deepEqual(await rt.diagnostics.clear(), { leaf: 'truncated', rotated: 'removed' })
  assert.deepEqual(await rt.diagnostics.entries(), [], 'a real clear lists nothing afterwards')
  assert.equal(await rt.diagnostics.logText(), '', 'a real clear leaves nothing to download')
})

// A Clear on a home with no log folder used to print "not truncated" for a write that failed
// with ENOENT (#2379). There is nothing on disk to empty, so that line was a false alarm: the
// window answers "Cleared the error log." for `leaf: 'absent'`, and the stderr line reached
// support bundles where it could not be told apart from a leaf that really was refused.
test('a clear with no log on disk stays quiet', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  const rt = host(home)
  t.after(async () => { await rt.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const result = await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.deepEqual(result, { leaf: 'absent', rotated: 'none' }, 'nothing was there, so nothing was kept')
  assert.deepEqual(stderr, [], 'a Clear with nothing to empty does not claim it could not truncate')
  assert.equal(existsSync(join(home, 'logs')), false, 'the truncate did not create the folder')
})

// The other half of the same contract, and #2364 kept whole: a leaf that is there and
// refuses the truncate still names the code on exactly one line, and never the folder (#2379).
test('a clear that cannot truncate the leaf still says so on one line', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root truncates a leaf without its write bit')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(home, 'logs'), { recursive: true })
  const logPath = join(home, 'logs', 'diagnostics.jsonl')
  const old = 'OLD LINE\n'.repeat(4)
  writeFileSync(logPath, old)
  chmodSync(logPath, 0o444)
  const rt = host(home)

  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const result = await rt.diagnostics.clear()
  quiet.mock.restore()

  assert.deepEqual(result, { leaf: 'kept', rotated: 'none' }, 'the leaf says it was left alone')
  assert.deepEqual(stderr, ['[ds-bot] diagnostics log not truncated: EACCES'], 'one line, the code and never the folder')
  assert.equal(readFileSync(logPath, 'utf8'), old, 'the lines the answer did not claim to clear are still there')
})
