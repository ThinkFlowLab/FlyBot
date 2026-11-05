// #1668: when a claim is re-matched into another workflow (#1647), only the target
// graph got a line: the source workflow's log did not change at all, so the card
// vanished from its held list with nothing to read. The source now gets exactly one
// system line naming the card and the destination, written in the same mutation as
// the target's claim (no extra write()), and the target side is untouched.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]
const REROUTE_KEY = 'Task re-matched · {task} → {to}'

function readStore(dir) {
  return JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
}

function serviceAt(dir, bots = () => roster) {
  let seq = 0
  return createWorkflowService({
    dir,
    persist: true,
    now: () => CLOCK,
    bots,
    spawn: async () => `eph-${++seq}`,
    release: async () => {},
    dispatch: async () => ({ ok: true }),
    // Step deadlines are timers; they are not part of what these cases assert.
    setTimer: () => 0,
    clearTimer: () => {},
  })
}

function named(svc, name, extra = {}) {
  const created = svc.create({
    name,
    nodes: [{ id: 'only', name: 'Only', prompt: 'Do it.' }],
    edges: [],
    ...extra,
  })
  assert.equal(created.ok, true, created.error)
  return created.workflows.find(item => item.name === name)
}

const messagesOf = (svc, name) => svc.state().workflows.find(item => item.name === name).messages

// The store assigns ids from one global counter, so two runs that reach the same
// entries at different counter positions differ in `id` (and only there, with the
// clock frozen). Compare what a reader sees.
const readable = entries => entries.map(({ kind, key, params, text }) => ({ kind, key, params, text }))

test('#1668: a re-matched card leaves exactly one line in the source graph', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-log-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')
    await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })

    const beforeCount = messagesOf(svc, 'Alpha').length
    const second = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: beta.id })
    assert.deepEqual({ matched: second.matched, already: second.already }, { matched: true, already: false })
    assert.deepEqual(second.decision, { kind: 'workflow', id: beta.id })

    const after = messagesOf(svc, 'Alpha')
    assert.equal(after.length, beforeCount + 1, 'the source graph gains exactly one line')
    const line = after.at(-1)
    assert.equal(line.kind, 'system')
    assert.equal(line.key, REROUTE_KEY, 'the line is the re-match notice')
    assert.match(String(line.params.task), /task-9/, 'the line names the card')
    assert.equal(line.params.to, 'Beta', 'the line names the destination workflow')
    assert.match(String(line.text), /task-9/, 'the Chinese fallback names the card too')
    assert.match(String(line.text), /Beta/)
    assert.deepEqual(readStore(dir).logs[alpha.id].at(-1), line, 'the line is on disk, not only in memory')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1668: the target side of a re-match is what a first assignment writes', async () => {
  const controlDir = mkdtempSync(join(tmpdir(), 'wf-reroute-control-'))
  const routedDir = mkdtempSync(join(tmpdir(), 'wf-reroute-target-'))
  try {
    const control = serviceAt(controlDir)
    named(control, 'Alpha')
    const controlBeta = named(control, 'Beta')
    await control.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: controlBeta.id })

    const routed = serviceAt(routedDir)
    const routedAlpha = named(routed, 'Alpha')
    const routedBeta = named(routed, 'Beta')
    await routed.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: routedAlpha.id })
    await routed.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: routedBeta.id })

    assert.deepEqual(readable(messagesOf(routed, 'Beta')), readable(messagesOf(control, 'Beta')), 'the destination log gains nothing of its own')
  } finally {
    rmSync(controlDir, { recursive: true, force: true })
    rmSync(routedDir, { recursive: true, force: true })
  }
})

test('#1668: a claim that simply matches appends nothing and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-noop-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
    const file = join(dir, 'workflows.json')
    const before = readFileSync(file, 'utf8')
    const mtime = statSync(file).mtimeMs

    const again = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
    assert.equal(again.already, true)
    assert.equal(messagesOf(svc, 'Alpha').filter(entry => entry.key === REROUTE_KEY).length, 0)
    assert.equal(readFileSync(file, 'utf8'), before, 'the non-reroute path writes no bytes')
    assert.equal(statSync(file).mtimeMs, mtime, 'and touches no mtime')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1668: an already:true re-match appends nothing to the source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-already-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')
    // Beta is already running the card, so re-matching it there is `already: true`.
    await svc.assign({ workflowId: beta.id, taskId: 'task-9', title: 'Ship it' })
    await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id, rematch: true })
    const before = messagesOf(svc, 'Alpha').length

    const again = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: beta.id })
    assert.equal(again.already, true, 'the destination already runs the card')
    assert.equal(messagesOf(svc, 'Alpha').length, before, 'already:true adds no source line')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1668: the MAX_MESSAGES cap still holds after the source line is added', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-cap-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')
    const store = readStore(dir)
    store.logs[alpha.id] = Array.from({ length: 200 }, (_, index) => ({ id: `old-${index + 1}`, at: CLOCK, kind: 'system', text: `old line ${index + 1}` }))
    store.seq = 1000
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(store))

    const reloaded = serviceAt(dir)
    await reloaded.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
    await reloaded.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: beta.id })

    const after = messagesOf(reloaded, 'Alpha')
    assert.equal(after.length, 200, 'the source log stays at the cap')
    assert.equal(after.at(-1).key, REROUTE_KEY, 'the newest line is the re-match notice')
    assert.ok(after.every(entry => entry.id !== 'old-1'), 'the oldest line was dropped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
