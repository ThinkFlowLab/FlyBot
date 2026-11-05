// #2486: `#2477` made an explicit `brief` the authority on the assign side — it
// replaces the cached facts, and `brief: ''` clears them. The re-match path still
// omitted the key when the card held no brief, so `assign` read "keep what the
// lane already knows" and the facts the author cleared came back on the next hop.
//
// The card is the authority once it reaches `ingest`: what it holds travels, and
// what it no longer holds is cleared explicitly rather than left to the cache.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const FACTS = 'OLD facts.\nSecond line.'

function serviceAt(dir) {
  return createWorkflowService({ dir, persist: true, now: () => CLOCK, bots: () => [] })
}

// The lane cache lives on the store (`state.briefs`), which `state()` does not
// expose — it is read back from the file the service itself wrote.
function store(dir) {
  return JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
}

function named(svc, name) {
  const created = svc.create({
    name,
    nodes: [{ id: 'only', name: 'Only', prompt: 'Do it.' }],
    edges: [],
  })
  assert.equal(created.ok, true, created.error)
  return created.workflows.find(item => item.name === name)
}

function runOf(svc, workflowId, taskId) {
  const item = svc.state().workflows.find(workflow => workflow.id === workflowId)
  return item.runs.find(run => run?.task?.id === taskId) ?? item.queue.find(run => run.id === taskId)
}

test('#2486: a card whose facts were cleared re-matches with no brief, and the old text does not come back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf2486-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')
    const gamma = named(svc, 'Gamma')
    svc.assign({ workflowId: alpha.id, taskId: 't-a1', title: 'Ship it', brief: FACTS })

    // The author clears the card (`brief: ''` on the card), so the board hands
    // `ingest` a task that carries no brief at all.
    svc.ingest({ id: 't-a1', status: 'open', title: 'Ship it', workflowId: beta.id })

    const moved = runOf(svc, beta.id, 't-a1')
    assert.equal(
      moved?.task?.brief,
      undefined,
      "the card no longer holds facts, so the re-matched run must start without them",
    )
    assert.equal(
      store(dir).briefs['t-a1']?.brief,
      undefined,
      "the lane cache must not keep the facts the card no longer holds",
    )

    // A later assignment that omits `brief` still means "the card's facts", and
    // the card is empty — so the old text must not return through the cache.
    svc.assign({ workflowId: gamma.id, taskId: 't-a1', title: 'Ship it' })
    assert.equal(
      runOf(svc, gamma.id, 't-a1')?.task?.brief,
      undefined,
      'a call that passes no brief must not resurrect the cleared facts',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#2486: a card that still holds facts re-matches with them, and the cache keeps them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf2486-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')
    svc.assign({ workflowId: alpha.id, taskId: 't-b', title: 'Ship it', brief: FACTS })

    svc.ingest({ id: 't-b', status: 'open', title: 'Ship it', brief: FACTS, workflowId: beta.id })

    const moved = runOf(svc, beta.id, 't-b')
    assert.equal(moved?.task?.brief, FACTS, 'the card holds facts, so the re-matched run receives them verbatim')
    assert.equal(store(dir).briefs['t-b']?.brief, FACTS, 'the lane cache carries the same facts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
