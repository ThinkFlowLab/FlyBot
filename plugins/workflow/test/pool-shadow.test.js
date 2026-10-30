import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

const roster = [
  { id: 'bot-planner', name: 'Planner', role: '计划', remote: false },
  { id: 'bot-writer', name: 'Writer', role: '撰写', remote: false },
  { id: 'bot-coder', name: 'Coder', role: '实现', remote: false },
  { id: 'bot-deployer', name: 'Deployer', role: '发布', remote: false },
]

function service(extra = {}) {
  return createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => roster, ...extra })
}

// The facts the P0 contract reads: the workflow's roles and pools, a single-owner exec, a worker
// holding at most one card, and room in the pool (#1853).
function context() {
  return {
    roles: ['planner', 'writer', 'coder', 'reviewer', 'tester', 'deployer'],
    pools: { writer: 2, coder: 2 },
    execOwner: 'owner-1',
    worker: { wip: 1 },
    pool: { inflight: 0, workers: 2 },
    cycleMax: 3,
  }
}

// A real open pull request whose acceptance wants a green tests-ok: PR 42 has not finished CI,
// so the contract refuses it with missing-evidence.
function rejected() {
  return {
    fromRole: 'planner',
    toRole: 'coder',
    attempt: 1,
    acceptance: { requires: [{ pr: 42, checks: 'tests-ok' }] },
    evidence: [{ pr: 42, checks: 'pending' }],
  }
}

function accepted() {
  return {
    fromRole: 'planner',
    toRole: 'writer',
    attempt: 0,
    acceptance: { requires: [{ pr: 7, checks: 'tests-ok' }] },
    evidence: [{ pr: 7, checks: 'tests-ok' }],
  }
}

const delivery = (state) => state.workflows.find(item => item.id === DELIVERY_ID)
const shadowLines = (state) => delivery(state).messages.filter(message => typeof message.text === 'string' && message.text.startsWith('shadow: '))

function assign(svc, handoff) {
  return svc.assign({
    workflowId: DELIVERY_ID,
    taskId: '#1862',
    title: 'Ship the shadow pass',
    ...(handoff ? { handoff, handoffContext: context() } : {}),
  })
}

test('a handoff the contract rejects is recorded as shadow: reject on the run and in its log', () => {
  const svc = service()
  const assigned = assign(svc, rejected())
  assert.equal(assigned.ok, true)

  const run = delivery(assigned).run
  assert.equal(run.shadow?.verdict, 'reject', 'the run record carries the contract refusal')
  assert.equal(run.shadow.code, 'missing-evidence')
  assert.match(run.shadow.reason, /tests-ok/)

  const line = shadowLines(assigned).at(-1)
  assert.ok(line, 'the run posts its own shadow: line')
  assert.match(line.text, /^shadow: reject · missing-evidence/)
})

test('a handoff the contract accepts is recorded as shadow: pass', () => {
  const svc = service()
  const assigned = assign(svc, accepted())

  const run = delivery(assigned).run
  assert.equal(run.shadow?.verdict, 'pass')
  assert.equal(run.shadow.code, undefined)
  assert.match(shadowLines(assigned).at(-1).text, /^shadow: pass/)
})

test('a run whose card carries no handoff facts keeps today\'s record: no shadow, no line', () => {
  const svc = service()
  const assigned = assign(svc, null)

  const run = delivery(assigned).run
  assert.equal(run.shadow, undefined)
  assert.equal(shadowLines(assigned).length, 0)
})

test('a card that carries its own acceptance gate is shadowed from the run and its graph', () => {
  const svc = service()
  const assigned = svc.assign({
    workflowId: DELIVERY_ID,
    taskId: '#1862',
    title: 'Ship the shadow pass',
    acceptance: { requires: [{ pr: 42, checks: 'tests-ok' }] },
    evidence: [{ pr: 42, checks: 'pending' }],
  })

  const run = delivery(assigned).run
  assert.equal(run.shadow?.verdict, 'reject', 'no caller had to learn a new contract')
  assert.equal(run.shadow.code, 'missing-evidence')
  assert.match(shadowLines(assigned).at(-1).text, /^shadow: reject · missing-evidence/)
})

test('shadow: reject neither blocks the run nor changes the PR fast lane', () => {
  const plain = service()
  const control = delivery(assign(plain, null)).run
  const shadowed = service()
  const state = assign(shadowed, rejected())
  const run = delivery(state).run

  // Same status, same step count, same node map as the run without a handoff: the verdict is a
  // record, never a gate.
  assert.equal(run.status, control.status)
  assert.equal(run.steps, control.steps)
  assert.deepEqual(run.nodeStatus, control.nodeStatus)
  assert.equal(delivery(state).queueDepth, 0, 'a rejected handoff never re-queues the card')

  // The human path still decides: the run walks its graph to done with the refusal on the record.
  const step = (nodeId, outcome) => shadowed.advance({ workflowId: DELIVERY_ID, nodeId, outcome })
  step('planner', 'done')
  const afterPlanner = delivery(shadowed.state()).run
  assert.equal(afterPlanner.status, 'running')
  assert.equal(afterPlanner.shadow.verdict, 'reject')
})

test('a parked run keeps its handoff and records the verdict when it starts', () => {
  const svc = service()
  svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 1 })
  svc.assign({ workflowId: DELIVERY_ID, taskId: '#1000', title: 'The run ahead of it' })
  const parked = svc.assign({
    workflowId: DELIVERY_ID,
    taskId: '#1862',
    title: 'Ship the shadow pass',
    handoff: rejected(),
    handoffContext: context(),
  })
  assert.equal(delivery(parked).queueDepth, 1, 'the second card waits for the free slot')

  const step = (nodeId) => svc.advance({ workflowId: DELIVERY_ID, nodeId, outcome: 'done' })
  for (const nodeId of ['planner', 'writer', 'coder', 'reviewer', 'tester', 'deployer']) step(nodeId)

  const run = delivery(svc.state()).run
  assert.equal(run.task.id, '#1862', 'the parked card is the one that started')
  assert.equal(run.shadow?.verdict, 'reject', 'the handoff travelled with the parked task')
  assert.match(shadowLines(svc.state()).at(-1).text, /^shadow: reject/)
})

test('a handoff that cannot be stored is dropped: the run still starts, nothing is recorded', () => {
  const svc = service()
  const circular = rejected()
  circular.self = circular
  const assigned = svc.assign({
    workflowId: DELIVERY_ID,
    taskId: '#1862',
    title: 'Ship the shadow pass',
    handoff: circular,
    handoffContext: context(),
  })
  assert.equal(assigned.ok, true)
  const run = delivery(assigned).run
  assert.equal(run.status, 'running', 'the shadow pass never stops a run')
  assert.equal(run.shadow, undefined)
  assert.equal(shadowLines(assigned).length, 0)
})

test('the shadow pass is a dry run: it writes nothing into the caller\'s contract context', async () => {
  const { shadowVerdict } = await import('../src/pool-shadow.js')
  const seen = new Set()
  const ctx = { ...context(), seen }
  assert.equal(shadowVerdict(rejected(), ctx).verdict, 'reject')
  assert.equal(shadowVerdict(accepted(), ctx).verdict, 'pass')
  assert.equal(seen.size, 0, 'the shadow pass never records an accepted handoff key')
  assert.deepEqual(Object.keys(shadowVerdict(accepted(), ctx)).sort(), shadowsKeys())
})

// Only two shapes are a record: a verdict with the refusal that produced it, or a pass with the
// key the real contract would have recorded. Nothing that could be read as a gate or an action.
function shadowsKeys() {
  return ['key', 'verdict']
}
