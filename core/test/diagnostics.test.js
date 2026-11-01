import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ISSUES_URL, cleanText, install as installDiagnostics, reportMarkdown } from '../src/host/diagnostics.js'
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
