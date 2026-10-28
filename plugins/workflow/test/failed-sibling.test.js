// #1493: a failed run is not a Runs-tab secret. While another run is live, the
// stage keeps the failed sibling, the timeline says the run ended, and the Runs
// row carries the time and the reason. A failure of the task that is live again
// is a retry, not a sibling, so it stays in history and leaves one row (#1507).
// The silent ending the screenshot shows is the reap: a host that came back with
// the run still marked running archived it as failed and said nothing (#1424).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

const CLOCK = 1_700_000_000_000

const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
  { id: 'bot-coder', name: 'Coder', role: '实现', remote: false },
]

function harness({ dir = null, clock = CLOCK } = {}) {
  let seq = 0
  let now = clock
  const svc = createWorkflowService({
    ...(dir ? { dir, persist: true } : { persist: false }),
    now: () => now,
    bots: () => roster,
    spawn: async () => {
      seq += 1
      return `eph-${seq}`
    },
    release: async () => {},
    dispatch: async () => ({ ok: true }),
  })
  return { svc, tick(ms = 1000) { now += ms; return now } }
}

function delivery(svc) {
  return svc.state().workflows.find(item => item.id === DELIVERY_ID)
}

const label = (run) => `${run.task.id} ${run.status}`

test('#1493: a failed sibling stays on the stage with the reason it ended', async () => {
  const { svc, tick } = harness()
  svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 2 })
  await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1460', title: 'issue #1460: every stage chat line is capped' })
  tick()
  await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1445', title: 'issue #1445: a Workflow run keeps the team task' })
  tick()
  const before = delivery(svc)
  assert.deepEqual(before.runs.map(label), ['#1460 running', '#1445 running'])
  const victim = before.runs.find(run => run.task.id === '#1460')
  const stopped = await svc.reset({ workflowId: DELIVERY_ID, runId: victim.id })
  assert.equal(stopped.ok, true)
  tick()

  const after = delivery(svc)
  assert.equal(after.activeCount, 1, 'activeCount still counts only running runs')
  assert.equal(after.run.task.id, '#1445', 'the running run stays the focused one')
  assert.deepEqual(after.runs.map(label), ['#1445 running', '#1460 failed'], 'the failed sibling is missing from the stage')
  const failed = after.runs.find(run => run.status === 'failed')
  assert.equal(failed.id, victim.id)
  assert.equal(failed.failure?.code, 'stopped', 'the failed run does not say what ended it')
  assert.equal(failed.updatedAt, failed.failure.at)

  const row = after.history.find(item => item.task.id === '#1460')
  assert.equal(row.status, 'failed')
  assert.equal(row.id, victim.id, 'a history row cannot be matched to the run it came from')
  assert.equal(row.at, failed.updatedAt)
  assert.equal(row.failure?.code, 'stopped', 'the history row dropped the reason')
})

test('#1493: a retry of the same task leaves the live run as its only row', async () => {
  const { svc, tick } = harness()
  svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 2 })
  await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1460', title: 'issue #1460: retried' })
  tick()
  const first = delivery(svc).runs[0]
  await svc.reset({ workflowId: DELIVERY_ID, runId: first.id })
  tick()
  await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1460', title: 'issue #1460: retried' })
  tick()

  const after = delivery(svc)
  assert.deepEqual(after.runs.map(label), ['#1460 running'], 'the failed attempt of a task that is live again must not add a row (#1507)')
  const row = after.history.find(item => item.task.id === '#1460')
  assert.equal(row?.status, 'failed', 'the failed attempt left no history row')
})

test('#1493: a run the host lost on reload is archived failed with a reason and a line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-failed-sibling-'))
  try {
    const first = harness({ dir })
    await first.svc.assign({ workflowId: DELIVERY_ID, taskId: '#1460', title: 'issue #1460: the host went away' })
    first.tick(5000)
    // A host that came back without disposing: the store still says the run is running.
    const after = harness({ dir, clock: CLOCK + 10_000 })
    await after.svc.reap()
    const lane = delivery(after.svc)
    assert.deepEqual(lane.runs.map(label), ['#1460 failed'])
    const failed = lane.runs[0]
    assert.equal(failed.failure?.code, 'host-ended')
    assert.equal(failed.failure.at, failed.updatedAt)
    const line = [...lane.messages].reverse().find(message => message.tone === 'bad')
    assert.ok(line, 'the timeline never says the run was lost')
    assert.match(line.text, /失败 · #1460/)
    const row = lane.history.find(item => item.status === 'failed')
    assert.equal(row.id, failed.id)
    assert.equal(row.failure?.code, 'host-ended')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
