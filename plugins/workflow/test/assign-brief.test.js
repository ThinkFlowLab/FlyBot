// #1869: `workflow/assign` took a `brief` and dropped it, so a node was only ever
// handed the task title. The brief now travels with the task — parked, on disk and
// into the step — and the call says which fields it did not read.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const roster = [
  { id: 'bot-planner', name: 'Planner', role: 'plan', remote: false },
  { id: 'bot-coder', name: 'Coder', role: 'code', remote: false },
]

const BRIEF = [
  'Baseline sha 09309f74 (read the live tarball anyway).',
  'THE-MAGIC-STRING-1234',
  'Files: plugins/workflow/src/service.js',
  'Do not run the full core suite on this host.',
  'Reply with OUTPUT lines.',
].join('\n')

function harness(extra = {}) {
  const dispatched = []
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => roster,
    spawn: async () => `eph-${++seq}`,
    release: async () => {},
    dispatch: async (step) => { dispatched.push(step); return { ok: true } },
    ...extra,
  })
  return { svc, dispatched }
}

function lane(svc, extra = {}) {
  const defined = svc.define({
    name: 'Brief lane',
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', botId: 'bot-planner', prompt: 'Plan it.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Build it.' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
    ...extra,
  })
  assert.equal(defined.ok, true)
  return defined.workflows.find(item => item.name === 'Brief lane').id
}

test('#1869: assign stores the brief on the task and the step prompt carries it', async () => {
  const { svc, dispatched } = harness()
  const id = lane(svc)
  const title = 'i1869-impl: assign 丢 brief'
  assert.equal(BRIEF.includes(title), false, 'the fixture brief must not contain the title')

  const assigned = await svc.assign({ workflowId: id, taskId: '#1869', title, brief: BRIEF })
  assert.equal(assigned.ok, true)
  const run = assigned.workflows.find(item => item.id === id).run
  assert.equal(run.task.brief, BRIEF)
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].brief, BRIEF)
  assert.equal(dispatched[0].brief.includes('THE-MAGIC-STRING-1234'), true)
})

test('#1869: a task with no brief still hands the node its title', async () => {
  const { svc, dispatched } = harness()
  const id = lane(svc)
  const assigned = await svc.assign({ workflowId: id, taskId: '#1870', title: 'Ship the note' })
  assert.equal(assigned.ok, true)
  assert.equal(dispatched[0].brief, 'Ship the note')
  assert.equal(assigned.workflows.find(item => item.id === id).run.task.brief, undefined)
})

test('#1869: runNamed reads brief as the instruction, deriving the title from its first line', async () => {
  const { svc, dispatched } = harness()
  const id = lane(svc)
  const started = await svc.runNamed({ workflow: 'Brief lane', task: '#1871', brief: BRIEF })
  assert.equal(started.ok, true)
  const run = started.workflows.find(item => item.id === id).run
  assert.equal(run.task.title, 'Baseline sha 09309f74 (read the live tarball anyway).')
  assert.equal(run.task.brief, BRIEF)
  assert.equal(dispatched[0].brief, BRIEF)

  const single = harness()
  const singleId = lane(single.svc)
  const oneLine = await single.svc.runNamed({ workflow: 'Brief lane', task: '#1872', brief: 'Ship the note' })
  const second = oneLine.workflows.find(item => item.id === singleId).run
  assert.equal(second.task.title, 'Ship the note')
  assert.equal(second.task.brief, 'Ship the note')
  assert.equal(single.dispatched[0].brief, 'Ship the note')
})

test('#1869: a parked task keeps its brief on disk and hands it on when it starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-workflow-brief-'))
  try {
    const { svc, dispatched } = harness({ persist: true, dir })
    const id = lane(svc)
    await svc.setConcurrency({ workflowId: id, maxConcurrent: 1 })
    const first = await svc.assign({ workflowId: id, taskId: '#1873', title: 'First card' })
    assert.equal(first.ok, true)
    const parked = await svc.assign({ workflowId: id, taskId: '#1874', title: 'Second card', brief: BRIEF })
    assert.equal(parked.ok, true)
    assert.equal(dispatched.length, 1, 'the second card waits for the slot')

    const store = JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
    const queue = store.lanes[id].queue
    assert.equal(queue.length, 1)
    assert.equal(queue[0].id, '#1874')
    assert.equal(queue[0].brief, BRIEF)

    svc.advance({ workflowId: id, nodeId: 'plan', outcome: 'done' })
    await svc.advance({ workflowId: id, nodeId: 'code', outcome: 'done' })
    const second = dispatched.find(step => step.brief === BRIEF)
    assert.ok(second, 'the parked card was started without its brief')
    assert.equal(second.nodeId, 'plan')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1869: assign names the fields it did not read instead of dropping them silently', async () => {
  const { svc } = harness()
  const id = lane(svc)
  const typo = await svc.assign({ workflowId: id, taskId: '#1875', title: 'Typo card', brief: 'x', brif: 'meant brief' })
  assert.equal(typo.ok, true)
  assert.deepEqual(typo.ignored, ['brif'])

  const clean = await svc.assign({ workflowId: id, taskId: '#1876', title: 'Clean card', brief: 'y' })
  assert.equal(clean.ignored, undefined)
})
