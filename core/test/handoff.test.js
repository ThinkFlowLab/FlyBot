// #450 item 1: the merge handoff seam. A plugin allowed by the host leaves one line with the Bot
// that keeps a merged Bot's role; the note lands in the kept Bot's own memory with the source Bot
// as metadata, and the archived Bot is only read. These are the refusals a plugin can hit.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HANDOFF, createHandoff } from '../src/host/handoff.js'

function fakeRt({ readOnly = false, names = {} } = {}) {
  const bots = new Map([['old', { id: 'old', name: names.old ?? 'Editor' }], ['new', { id: 'new', name: names.new ?? 'Editor Prime' }]])
  const writes = []
  return {
    rt: {
      readOnly: () => (readOnly ? 'another host holds the team' : undefined),
      botOf: id => bots.get(id),
      botMemoryAppend: async (id, text, meta) => { writes.push({ id, text, meta }) },
    },
    writes,
  }
}

test('#450: a plugin the host did not name may not leave a handoff note', async () => {
  const { rt, writes } = fakeRt()
  const note = createHandoff(rt, { allow: [] })
  assert.deepEqual(await note('flybot-tree', { from: 'old', to: 'new', note: 'did dev' }), { ok: false, code: 'not-allowed' })
  assert.equal(writes.length, 0, 'no memory write happens')
})

test('#450: a handoff note needs a live source and target, a string note and room under the cap', async () => {
  const { rt, writes } = fakeRt()
  const note = createHandoff(rt, { allow: ['flybot-tree'] })
  assert.deepEqual(await note('flybot-tree', { to: 'new', note: 'x' }), { ok: false, code: 'no-source' })
  assert.deepEqual(await note('flybot-tree', { from: 'gone', to: 'new', note: 'x' }), { ok: false, code: 'source-gone' })
  assert.deepEqual(await note('flybot-tree', { from: 'old', to: 'gone', note: 'x' }), { ok: false, code: 'target-gone' })
  assert.deepEqual(await note('flybot-tree', { from: 'old', to: 'old', note: 'x' }), { ok: false, code: 'same-bot' })
  assert.deepEqual(await note('flybot-tree', { from: 'old', to: 'new', note: 42 }), { ok: false, code: 'bad-note' })
  assert.deepEqual(await note('flybot-tree', { from: 'old', to: 'new', note: '  ' }), { ok: false, code: 'empty-note' })
  assert.deepEqual(await note('flybot-tree', { from: 'old', to: 'new', note: 'x'.repeat(HANDOFF.note + 1) }), { ok: false, code: 'note-too-long' })
  assert.equal(writes.length, 0, 'a refused call writes nothing')
})

test('#450: a handoff note lands in the kept Bot only and answers the source reference', async () => {
  const { rt, writes } = fakeRt()
  const at = Date.UTC(2026, 10, 22, 9)
  const note = createHandoff(rt, { allow: ['flybot-tree'], now: () => at })
  const result = await note('flybot-tree', { from: 'old', to: 'new', note: 'role "editor"; 1 child Bot moved to you' })
  assert.deepEqual(result, { ok: true, ref: { bot: 'old', name: 'Editor', at: new Date(at).toISOString() } })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].id, 'new', 'the kept Bot gets the note; the archived Bot is only read')
  assert.match(writes[0].text, /^Editor \(old\) was merged into you: role "editor"/)
  assert.deepEqual(writes[0].meta, { source: 'handoff', from: 'old', at: new Date(at).toISOString() })
})

test('#450: a read-only host refuses the handoff note before any memory write', async () => {
  const { rt, writes } = fakeRt({ readOnly: true })
  const note = createHandoff(rt, { allow: ['flybot-tree'] })
  assert.deepEqual(await note('flybot-tree', { from: 'old', to: 'new', note: 'x' }), { ok: false, code: 'read-only' })
  assert.equal(writes.length, 0)
})

test('#450: a note at the cap, with a long source name, still fits the memory entry cap', async () => {
  const { rt, writes } = fakeRt({ names: { old: 'E'.repeat(400) } })
  const at = Date.UTC(2026, 10, 22, 9)
  const note = createHandoff(rt, { allow: ['flybot-tree'], now: () => at })
  assert.equal((await note('flybot-tree', { from: 'old', to: 'new', note: 'x'.repeat(HANDOFF.note) })).ok, true)
  const text = writes[0].text
  assert.ok([...text].length <= 300, `the memory entry holds at most 300 characters: ${[...text].length}`)
  assert.ok(text.startsWith(`${'E'.repeat(40)} (old) was merged into you: `), 'the source name is clipped, not the note')
  assert.ok(text.endsWith('x'.repeat(HANDOFF.note)), 'the note stays whole')
})
