// #1647: a remembered claim is not a life sentence. `ingest` trusted any stored
// claim and never looked at the task again, so a card re-routed to another
// workflow stayed on the old one forever, and `workflow/state` showed no claims —
// nobody could see who held what, or clear a stale one.
//
// The claim now yields only to the task's own named target (workflow:/bot:
// token, workflowId/workflow, or an assignee naming a workflow or local Bot)
// and only when that target is a live, different one. A trigger match, or a task
// that names nothing, keeps the claim exactly as before. `rematch: true` drops
// that one claim and matches again — the panel's per-task action.
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

test('#1647: re-routing the card moves its claim, on disk and after a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-route-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')

    const first = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
    assert.deepEqual({ ok: first.ok, matched: first.matched, already: first.already }, { ok: true, matched: true, already: false })
    assert.deepEqual(first.decision, { kind: 'workflow', id: alpha.id })
    assert.deepEqual(readStore(dir).claims['task-9'], { kind: 'workflow', id: alpha.id }, 'the run recorded its claim')

    // The card's own field now names another workflow. The stored claim must not
    // short-circuit the match, or the task never appears under Beta.
    const second = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: beta.id })
    assert.deepEqual(
      { matched: second.matched, already: second.already, decision: second.decision },
      { matched: true, already: false, decision: { kind: 'workflow', id: beta.id } },
    )

    const store = readStore(dir)
    assert.deepEqual(store.claims['task-9'], { kind: 'workflow', id: beta.id }, 'one claim, naming only Beta')
    assert.equal(Object.keys(store.claims).length, 1, 'exactly one claim for the task')
    assert.deepEqual(Object.keys(store.routes), ['task-9'], 'exactly one route for the task')
    assert.equal(store.routes['task-9'].id, beta.id, 'the route moved with the claim')

    // The claim survives a reload, so the state view a person reads names Beta.
    const reloaded = serviceAt(dir)
    const state = reloaded.state()
    const held = Object.fromEntries(state.workflows.map(item => [item.name, item.heldTasks]))
    assert.deepEqual(held.Alpha, [], 'Alpha no longer holds the task')
    assert.deepEqual(held.Beta, ['task-9'], 'Beta holds it, and the state view says so')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1647: the same explicit target again is already:true and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-same-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
    const before = readFileSync(join(dir, 'workflows.json'), 'utf8')

    const again = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
    assert.equal(again.already, true, 'a second ingest of the same target is a no-op')
    assert.deepEqual(again.decision, { kind: 'workflow', id: alpha.id })
    assert.equal(readFileSync(join(dir, 'workflows.json'), 'utf8'), before, 'no writes, no churn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1647: a task with no named target keeps its claim, even when a trigger would match elsewhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-trigger-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta', { triggers: ['notice'] })

    const first = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
    assert.deepEqual(first.decision, { kind: 'workflow', id: alpha.id })

    // Only a trigger — an implicit intent — would now name Beta. That is not a
    // named target, so today's behaviour stands: the claim wins, unasked.
    const again = await svc.ingest({ id: 'task-9', status: 'open', title: 'notice' })
    assert.equal(again.already, true, 'a trigger never invalidates a claim')
    assert.deepEqual(again.decision, { kind: 'workflow', id: alpha.id })
    assert.deepEqual(readStore(dir).claims['task-9'], { kind: 'workflow', id: alpha.id })
    assert.equal(beta.id.length > 0, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1647: the state view lists held task ids per workflow, capped, and never a Bot claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-state-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const ids = []
    for (let i = 0; i < 23; i += 1) {
      const id = `task-${String(i).padStart(2, '0')}`
      ids.push(id)
      await svc.ingest({ id, status: 'open', title: `Ship ${i}`, workflowId: alpha.id })
    }
    const routed = svc.assign({ botId: 'main', taskId: 'task-bot', title: 'A Bot task' })
    assert.equal(routed.ok, true)

    const state = svc.state()
    const item = state.workflows.find(workflow => workflow.id === alpha.id)
    assert.equal(item.heldTaskCount, 23, 'the count is the whole truth')
    assert.deepEqual(item.heldTasks, ids.slice(0, 20), 'the list is bounded to 20 ids, sorted')
    assert.equal(
      state.workflows.some(workflow => (workflow.heldTasks ?? []).includes('task-bot')),
      false,
      'a task held by a Bot is not listed as a workflow claim',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1647: rematch:true drops the one claim and matches again through ingest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-flag-'))
  try {
    const svc = serviceAt(dir)
    const alpha = named(svc, 'Alpha')
    const beta = named(svc, 'Beta')
    await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })

    // A person asks for a re-match; the card names nothing, so the claim goes and
    // the task is left unassigned rather than guessed onto something.
    const dropped = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', rematch: true })
    assert.deepEqual({ ok: dropped.ok, matched: dropped.matched }, { ok: true, matched: false })
    const afterDrop = readStore(dir)
    assert.equal(afterDrop.claims['task-9'], undefined, 'the stale claim is gone from disk')
    assert.equal(afterDrop.routes['task-9'], undefined, 'its route goes with it')

    // Asking again with an explicit target lands on that target.
    const moved = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: beta.id, rematch: true })
    assert.deepEqual(moved.decision, { kind: 'workflow', id: beta.id })
    assert.deepEqual(readStore(dir).claims['task-9'], { kind: 'workflow', id: beta.id })

    // A re-match on a task that is still running on the same target is a no-op:
    // no second run, and the claim/route pair stays exactly one.
    const live = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: beta.id, rematch: true })
    assert.equal(live.already, true, 'a live run for the task is not restarted')
    const store = readStore(dir)
    assert.deepEqual(store.claims['task-9'], { kind: 'workflow', id: beta.id })
    assert.equal(store.routes['task-9'].id, beta.id)
    assert.equal(Object.keys(store.claims).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1647: a claim naming a Bot that is gone keeps today\'s behaviour until a person drops it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-ghost-'))
  try {
    const svc = serviceAt(dir)
    named(svc, 'Alpha')
    // The store an older version left: a claim whose Bot no longer exists.
    const store = readStore(dir)
    store.claims['task-9'] = { kind: 'bot', id: 'ghost' }
    store.routes['task-9'] = { key: 'bot:ghost', kind: 'bot', id: 'ghost', at: CLOCK }
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(store))

    const reloaded = serviceAt(dir)
    const kept = await reloaded.ingest({ id: 'task-9', status: 'open', title: 'Ship it' })
    assert.equal(kept.already, true, 'no named target, so nothing invalidates the claim')
    assert.deepEqual(kept.decision, { kind: 'bot', id: 'ghost' }, 'it does not guess a replacement')
    assert.deepEqual(readStore(dir).claims['task-9'], { kind: 'bot', id: 'ghost' })

    const dropped = await reloaded.ingest({ id: 'task-9', status: 'open', title: 'Ship it', rematch: true })
    assert.deepEqual({ ok: dropped.ok, matched: dropped.matched }, { ok: true, matched: false })
    assert.equal(readStore(dir).claims['task-9'], undefined, 'the panel action clears a dangling claim')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The store as it sits on disk: bytes and mtime, so a write that changes nothing
// is still caught, and a claim that silently disappears cannot hide behind a
// reload or behind `present()` rebuilding its answer.
const snapshot = dir => ({
  bytes: readFileSync(join(dir, 'workflows.json')),
  mtimeMs: statSync(join(dir, 'workflows.json')).mtimeMs,
})

test('#1647: a card that left `open` keeps its claim when it names another live workflow', async () => {
  // (a) The named target is live and different, so the invalidation branch runs, but
  // `matchTask` matches nothing that is not `open`. Dropping the claim first and
  // then finding no match leaves the card with no holder at all — the third state
  // that must never exist: recorded nowhere, accepted silently.
  for (const status of ['claimed', 'working', 'blocked', 'done']) {
    const dir = mkdtempSync(join(tmpdir(), `wf-claim-${status}-`))
    try {
      const svc = serviceAt(dir)
      const alpha = named(svc, 'Alpha')
      const beta = named(svc, 'Beta')
      await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
      const before = snapshot(dir)

      const moved = await svc.ingest({ id: 'task-9', status, title: 'Ship it', workflowId: beta.id })
      assert.deepEqual({ ok: moved.ok, matched: moved.matched }, { ok: true, matched: false }, `${status}: no match, and no error`)

      const after = snapshot(dir)
      assert.deepEqual(after.bytes, before.bytes, `${status}: the store is byte-identical`)
      assert.equal(after.mtimeMs, before.mtimeMs, `${status}: the store was not rewritten`)

      const store = readStore(dir)
      assert.deepEqual(store.claims['task-9'], { kind: 'workflow', id: alpha.id }, `${status}: the claim is still Alpha's`)
      assert.equal(store.routes['task-9'].id, alpha.id, `${status}: the route did not move without a new holder`)

      const held = Object.fromEntries(serviceAt(dir).state().workflows.map(item => [item.name, item.heldTasks]))
      assert.deepEqual(held.Alpha, ['task-9'], `${status}: Alpha still holds it after a reload`)
      assert.deepEqual(held.Beta, [], `${status}: and Beta never did`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('#1647: a non-open card naming a workflow that does not exist keeps its claim too', async () => {
  // (b) The guard beside (a): the named field names nothing live, so `namedTarget`
  // is null and the early return already keeps the claim. This case is not red on
  // the old code; it stays so the invalidation branch cannot later start dropping
  // records for a target that does not exist.
  for (const status of ['claimed', 'working', 'blocked', 'done']) {
    const dir = mkdtempSync(join(tmpdir(), `wf-claim-gone-${status}-`))
    try {
      const svc = serviceAt(dir)
      const alpha = named(svc, 'Alpha')
      named(svc, 'Beta')
      await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: alpha.id })
      const before = snapshot(dir)

      const kept = await svc.ingest({ id: 'task-9', status, title: 'Ship it', workflowId: 'no-such-workflow' })
      assert.equal(kept.ok, true, `${status}: no error`)
      assert.equal(kept.already, true, `${status}: nothing resolvable to move to, so the claim still answers`)

      const after = snapshot(dir)
      assert.deepEqual(after.bytes, before.bytes, `${status}: the store is byte-identical`)
      assert.equal(after.mtimeMs, before.mtimeMs, `${status}: the store was not rewritten`)

      const store = readStore(dir)
      assert.deepEqual(store.claims['task-9'], { kind: 'workflow', id: alpha.id }, `${status}: the claim is still Alpha's`)
      assert.equal(store.routes['task-9'].id, alpha.id, `${status}: the route stays with it`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
