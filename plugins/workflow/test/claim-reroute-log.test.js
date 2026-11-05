// #1668: when a card is re-matched into another workflow (#1647), the target
// workflow got its "Task assigned" / "Started" lines and the source workflow got
// nothing — the held card vanished from a graph with no explanation.
//
// The re-route branch now pushes one system line on the source side, in the same
// store write that attaches the new target, so the graph that lost the card says
// where it went. The target's own lines are untouched, and an ingest that changes
// nothing still writes nothing.
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

function readStore(dir) {
  return JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
}

function serviceAt(dir) {
  let seq = 0
  return createWorkflowService({
    dir,
    persist: true,
    now: () => CLOCK,
    bots: () => roster,
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

// `state()` hands back the live `state.logs[...]` array, so every read is a copy:
// a later push must not change a snapshot this file is comparing against.
const messagesOf = (svc, name) => svc.state().workflows.find(item => item.name === name).messages.slice()

// A reroute: Alpha holds the card, then the card names Beta.
async function rerouted(dir) {
  const svc = serviceAt(dir)
  const alpha = named(svc, 'Alpha')
  const beta = named(svc, 'Beta')
  const first = await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: alpha.id })
  assert.deepEqual(first.decision, { kind: 'workflow', id: alpha.id })
  assert.deepEqual(first.already, false)
  return { svc, alpha, beta }
}

// The read-only shape of a log entry: what the stage draws, minus the store's
// ids and the names two sibling workflows spell differently.
function shape(entries, task, workflow) {
  return JSON.parse(JSON.stringify(entries).replaceAll(task, '<task>').replaceAll(workflow, '<workflow>'))
    .map(entry => {
      const copy = { ...entry }
      delete copy.id
      return copy
    })
}

test('#1668: a reroute leaves exactly one line on the source workflow, naming task and destination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-log-'))
  try {
    const { svc, alpha, beta } = await rerouted(dir)
    const sourceBefore = messagesOf(svc, 'Alpha')

    const moved = await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: beta.id })
    assert.deepEqual({ matched: moved.matched, already: moved.already }, { matched: true, already: false })

    const sourceAfter = messagesOf(svc, 'Alpha')
    assert.equal(sourceAfter.length, sourceBefore.length + 1, 'the source log gained exactly one entry')
    assert.deepEqual(sourceAfter.slice(0, sourceBefore.length), sourceBefore, 'the earlier source entries are untouched')
    const line = sourceAfter.at(-1)
    assert.equal(line.kind, 'system')
    assert.equal(line.key, 'Task re-matched · {task} → {to}')
    assert.equal(line.params.task, 't-1 · Ship it', 'the line names the task')
    assert.equal(line.params.to, 'Beta', 'the line names the destination workflow')
    assert.equal(line.text, '任务已改投 · t-1 · Ship it → Beta')
    assert.equal(line.at, CLOCK)

    // The line is stored, not just painted from memory: a reload sees it too.
    const reloaded = serviceAt(dir)
    const onDisk = messagesOf(reloaded, 'Alpha')
    assert.equal(onDisk.length, sourceBefore.length + 1)
    assert.equal(onDisk.at(-1).key, 'Task re-matched · {task} → {to}')
    assert.equal(readStore(dir).logs[alpha.id].at(-1).params.to, 'Beta')
    assert.equal(messagesOf(reloaded, 'Beta').length, 4, 'the target got its own assignment lines, nothing more')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1668: the target side keeps the entries it wrote before, entry for entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-target-'))
  try {
    const { svc, beta } = await rerouted(dir)
    const before = messagesOf(svc, 'Beta')
    await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: beta.id })

    // A first-time assignment into a third lane is the control: main wrote the
    // same three entries there for any fresh card.
    const gamma = named(svc, 'Gamma')
    await svc.ingest({ id: 't-2', status: 'open', title: 'Ship elsewhere', workflowId: gamma.id })

    const moved = messagesOf(svc, 'Beta').slice(before.length)
    const control = messagesOf(svc, 'Gamma').slice(before.length)
    assert.deepEqual(
      shape(moved, 't-1 · Ship it', 'Beta'),
      shape(control, 't-2 · Ship elsewhere', 'Gamma'),
      'the reroute writes the same entries a fresh assignment writes, and nothing else',
    )
    assert.equal(moved.some(entry => String(entry.key).includes('re-matched')), false, 'the source line never leaks onto the target')
    assert.deepEqual(messagesOf(svc, 'Beta').slice(0, before.length), before, 'the target log before the reroute is unchanged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1668: a claim that simply matches appends nothing and writes no bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-noop-'))
  try {
    const { svc, alpha } = await rerouted(dir)
    const sourceBefore = messagesOf(svc, 'Alpha')
    const targetBefore = messagesOf(svc, 'Beta')
    const bytes = readFileSync(join(dir, 'workflows.json'))
    const mtimeMs = statSync(join(dir, 'workflows.json')).mtimeMs

    const again = await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: alpha.id })
    assert.equal(again.already, true)

    assert.deepEqual(messagesOf(svc, 'Alpha'), sourceBefore, 'the source log did not move')
    assert.deepEqual(messagesOf(svc, 'Beta'), targetBefore, 'and neither did the target')
    assert.deepEqual(readFileSync(join(dir, 'workflows.json')), bytes, 'the store is byte-identical')
    assert.equal(statSync(join(dir, 'workflows.json')).mtimeMs, mtimeMs, 'the store was not rewritten')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// #2480: this case used to pin the queued leg's silence (`an already:true
// ingest writes no source line`), which is the defect the issue names: the
// target already runs the card, so nothing starts, but the graph that lost it
// still has to say where it went. The return value is unchanged; the line is new.
test('#2480: a reroute into a lane that already runs the card logs the source once and starts nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-live-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')

    // Beta already runs t-1 with no claim; a first ingest hands the claim to
    // Alpha; naming Beta again is a reroute, but there is no run to start.
    await svc.assign({ workflowId: beta.id, taskId: 't-1', title: 'Ship it' })
    await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: alpha.id })

    const sourceBefore = messagesOf(svc, 'Alpha')
    const targetBefore = messagesOf(svc, 'Beta')
    const already = await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: beta.id })
    assert.equal(already.already, true, 'the live run is not restarted')
    assert.deepEqual(already.decision, { kind: 'workflow', id: beta.id })

    const sourceAfter = messagesOf(svc, 'Alpha')
    assert.equal(sourceAfter.length, sourceBefore.length + 1, 'the source says where the card went')
    assert.deepEqual(sourceAfter.slice(0, sourceBefore.length), sourceBefore, 'the earlier source entries are untouched')
    const line = sourceAfter.at(-1)
    assert.equal(line.key, 'Task re-matched · {task} → {to}')
    assert.equal(line.params.task, 't-1 · Ship it')
    assert.equal(line.params.to, 'Beta', 'the line names the destination workflow')
    assert.deepEqual(messagesOf(svc, 'Beta'), targetBefore, 'no new run and no new target line')
    assert.deepEqual(readStore(dir).claims['t-1'], { kind: 'workflow', id: beta.id }, 'the claim still moved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1668: MAX_MESSAGES keeps the source log at 200 and keeps the newest line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-cap-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')

    // A store that already holds more than the cap: 220 seeded lines.
    const store = readStore(dir)
    store.logs[alpha.id] = Array.from({ length: 220 }, (_, i) => ({ id: `seed-${i}`, kind: 'system', text: `seed ${i}` }))
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(store))
    const reloaded = serviceAt(dir)

    await reloaded.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: alpha.id })
    await reloaded.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: beta.id })

    const source = messagesOf(reloaded, 'Alpha')
    assert.equal(source.length, 200, 'the source log is capped, never 201')
    assert.equal(source.at(-1).key, 'Task re-matched · {task} → {to}', 'the newest line is the one kept')
    assert.equal(source[0].id, 'seed-24', 'the oldest entries were dropped as before')
    // The cap is one slice on the same array; the target still fits under it.
    assert.equal(messagesOf(reloaded, 'Beta').length, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// #2480: the bot leg of the same contract — a claim that yields to a local Bot
// used to attach the new claim and return before the source line was pushed.
// `from` is resolved before either early return, so the line rides that write.
test('#2480: a reroute from a workflow to a Bot leaves one line on the source, naming the Bot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reroute-bot-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: alpha.id })
    const sourceBefore = messagesOf(svc, 'Alpha')

    const moved = await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', assignee: 'Chief' })
    assert.deepEqual(moved.decision, { kind: 'bot', id: 'main' })
    assert.equal(moved.already, false, 'a real reroute: the Bot takes the card')

    const sourceAfter = messagesOf(svc, 'Alpha')
    assert.equal(sourceAfter.length, sourceBefore.length + 1, 'the source log gained exactly one entry')
    assert.deepEqual(sourceAfter.slice(0, sourceBefore.length), sourceBefore, 'the earlier source entries are untouched')
    const line = sourceAfter.at(-1)
    assert.equal(line.kind, 'system')
    assert.equal(line.key, 'Task re-matched · {task} → {to}')
    assert.equal(line.params.task, 't-1 · Ship it', 'the line names the task')
    assert.equal(line.params.to, 'Chief', 'the line names the Bot that took the card')
    assert.equal(line.text, '任务已改投 · t-1 · Ship it → Chief')
    assert.equal(line.at, CLOCK)

    // Stored, not painted from memory: a reload sees it too.
    const reloaded = serviceAt(dir)
    assert.equal(messagesOf(reloaded, 'Alpha').length, sourceAfter.length, 'the line is on disk')
    assert.equal(readStore(dir).logs[alpha.id].at(-1).params.to, 'Chief')

    const again = await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', assignee: 'Chief' })
    assert.equal(again.already, true, 'the card already sits with the Bot')
    assert.equal(messagesOf(svc, 'Alpha').length, sourceAfter.length, 'a repeated ingest adds nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
