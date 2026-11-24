// The JSON exporter stops at a byte cap. It used to warn on every export once the file reached it —
// with the default 5 s interval that is a warning every 5 s for as long as the file stays full, the
// same noise #P699 removed from the OTLP path (one warning per streak, not per attempt). The cap is
// terminal for that file until someone makes room, so it reads as one event.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeExporter } from '../index.js'

const CAP = 8 * 1024 * 1024

test('a json export past the cap warns once, not on every export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-json-cap-'))
  try {
    const file = join(dir, 'export.jsonl')
    writeFileSync(file, '')
    truncateSync(file, CAP)
    const warns = []
    const exporter = makeExporter({ exporter: 'json' }, dir, (...args) => warns.push(args))
    const payload = { resourceSpans: [] }
    await exporter.send(payload)
    await exporter.send(payload)
    assert.equal(warns.length, 1, `a full export file warned ${warns.length} time(s) in 2 exports; the cap is one event, not one per tick`)
    assert.equal(warns[0][1], CAP, 'the warning names the cap it reached')
    assert.match(warns[0][0], /json export is capped at %d bytes in %s/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a write that makes room warns again the next time the cap is hit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-json-cap-'))
  try {
    const file = join(dir, 'export.jsonl')
    writeFileSync(file, '')
    truncateSync(file, CAP)
    const warns = []
    const exporter = makeExporter({ exporter: 'json' }, dir, (...args) => warns.push(args))
    const payload = { resourceSpans: [] }

    await exporter.send(payload)
    assert.equal(warns.length, 1, 'the first full export warns once')

    truncateSync(file, 0)
    await exporter.send(payload)
    assert.equal(warns.length, 1, 'a write that makes room does not warn')
    assert.notEqual(readFileSync(file, 'utf8'), '', 'the export that made room wrote its line')

    truncateSync(file, CAP)
    await exporter.send(payload)
    assert.equal(warns.length, 2, 'the cap being hit again warns again, once')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
