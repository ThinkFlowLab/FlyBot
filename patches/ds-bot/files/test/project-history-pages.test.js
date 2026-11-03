import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentHistoryPage, sealedLogPage } from '../src/host/project-history-pages.js'

test('all log bytes remain recoverable through bounded UTF-8 pages and invalid offsets are refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-log-pages-')); t.after(() => rm(root, { recursive: true, force: true }))
  const text = 'a😀日志\n'.repeat(7), log = join(root, 'sealed.log')
  await writeFile(log, text)
  const evidence = { log, sha256: createHash('sha256').update(text).digest('hex') }
  let offset = 0, recovered = ''
  do { const page = await sealedLogPage(evidence, { offset, limit: 9 }); recovered += page.text; offset = page.nextOffset } while (offset !== null)
  assert.equal(recovered, text)
  for (const body of [{ offset: 2 }, { limit: 9000 }, { limit: 0 }, { offset: 10000 }, { expectedSha256: 'old' }]) await assert.rejects(sealedLogPage(evidence, body))
  await writeFile(log, '')
  const empty = await sealedLogPage({ log, sha256: createHash('sha256').update('').digest('hex') }, {})
  assert.equal(empty.text, ''); assert.equal(empty.nextOffset, null)
})

test('history budgets retain latest messages and exact long-record sources without all-history clones', () => {
  const rows = Array.from({ length: 100 }, (_, n) => ({ id: String(n), text: n < 70 ? 'short' : 'x'.repeat(7000) }))
  rows[0].text = '完整😀'.repeat(5000)
  const tail = agentHistoryPage(rows, {}, 'private-owner')
  assert.ok(Buffer.byteLength(JSON.stringify(tail)) < 65536)
  assert.equal(tail.messages.at(-1).id, '99')
  assert.ok(tail.previousCursor)
  const first = agentHistoryPage(rows, { offset: 0, limit: 1 }, 'private-owner')
  const ref = first.messages[0].sourceRef
  assert.equal(first.messages[0].truncated, true)
  let offset = 0, reconstructed = ''
  do {
    const page = agentHistoryPage(rows, { ...ref, textOffset: offset, textLimit: 997 }, 'private-owner')
    reconstructed += page.text; offset = page.nextOffset
  } while (offset !== null)
  assert.deepEqual(JSON.parse(reconstructed), rows[0])
  for (const body of [{ cursor: 'not-json' }, { cursor: null }, { limit: 101 }, { offset: -1 }, { messageIndex: 100 }, { expectedSha256: 'old' }, { ...ref, textOffset: -1 }, { ...ref, expectedSha256: 'old' }]) assert.throws(() => agentHistoryPage(rows, body, 'private-owner'))
  assert.throws(() => agentHistoryPage(rows, { cursor: first.nextCursor }, 'other-owner'), /scope/)
  assert.equal(agentHistoryPage([], {}, 'empty').messages.length, 0)
})
