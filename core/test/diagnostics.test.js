import assert from 'node:assert/strict'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

// The Read-only row answered one constant for every window that may not write, but the store
// answers three ways (#2153): `stuck` (the team file cannot be read) is not a live lock at all,
// and a report that calls a newer or unreadable team file "another dsh holds the team" sends the
// reader to close a host that is not running. These four build the real store and the real
// diagnostics on one runtime, so the sentence is the one the host actually produces.
async function realHost(t, { saved, locked = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-ro-'))
  const statePath = join(home, 'state.json')
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
  return { home, readOnly: rt.readOnly(), report: await rt.diagnostics.report({}) }
}

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
