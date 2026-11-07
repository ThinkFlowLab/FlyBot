// A line in logs/diagnostics.jsonl that the reader keeps is not a line the renderer can trust (#2591):
// the reader only proves `time` is a number and `text` is a string, so a hand-edited line (or one an
// older build wrote) without `level`/`source`, or with a `time` JSON parses as `Infinity`, reaches
// `entryLine`. One such line must not cost the whole report or the whole downloaded log.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installDiagnostics } from '../src/host/diagnostics.js'

function host(home, lines) {
  const warnings = []
  const disposers = []
  // The real context's effect pair: `dispose()` settles every cleanup, including this log's writes.
  const effect = (execute) => {
    const dispose = execute()
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  mkdirSync(join(home, 'logs'), { recursive: true })
  writeFileSync(join(home, 'logs', 'diagnostics.jsonl'), lines.map(line => `${line}\n`).join(''), 'utf8')
  const rt = {
    ctx: { logger: { warn: (...args) => warnings.push(args) }, effect },
    home,
    config: {},
    state: { bots: { a: { id: 'a', name: 'Chief', model: 'deepseek/deepseek-chat' } }, mainBotIds: ['a'], rooms: {} },
    readOnly: () => undefined,
  }
  installDiagnostics(rt)
  rt.dispose = () => Promise.all(disposers.splice(0).map(dispose => dispose()))
  return rt
}

test('a hand-edited log line without a level does not kill the report', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-corrupt-'))
  const rt = host(home, ['{"time":1700000000000,"text":"an earlier run line"}'])
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  t.after(() => rt.dispose())

  // The reader keeps the line: it is a real line of this host's log, not junk to be dropped.
  assert.equal((await rt.diagnostics.entries()).length, 1)

  const report = await rt.diagnostics.report({})
  assert.match(report.markdown, /Recent host errors \(1 of 1, oldest first\):/)
  // The parts the reader does not guarantee are defaulted, so the line stays readable.
  assert.match(report.markdown, /ERROR host an earlier run line/)

  assert.match(await rt.diagnostics.logText(), /ERROR host an earlier run line/)
})

test('a log line whose time JSON parses as Infinity does not kill the report', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-corrupt-time-'))
  const rt = host(home, ['{"time":1e400,"text":"a line with an unusable time"}'])
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  t.after(() => rt.dispose())

  assert.equal((await rt.diagnostics.entries()).length, 1)

  const report = await rt.diagnostics.report({})
  assert.match(report.markdown, /Recent host errors \(1 of 1, oldest first\):/)
  // No time is shown for a stamp that cannot be a time; the rest of the line still is.
  assert.match(report.markdown, /ERROR host a line with an unusable time/)

  assert.match(await rt.diagnostics.logText(), /ERROR host a line with an unusable time/)
})
