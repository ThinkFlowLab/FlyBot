// #3282: a start the host refused said only "the host did not create the run Bots within 60s".
// The issue fast line (a six-node graph) failed that way three times while three- and five-node
// lines started, and the sentence could not say which node it was waiting on or why — so the owner
// re-dispatched the same task twice. Two things are pinned here:
//   a) a spawn the host refuses, and a spawn that never answers, name the node and the reason;
//   b) the endpoint seam refuses the way the Bots API can report it, instead of returning
//      `{ ok: false }` inside the `{ ok: true, value }` envelope every caller reads first.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SPAWN_DEADLINE_MS, createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const ROSTER = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

// Same fake timer wheel as late-spawn-release.test.js: the deadline is fired by the test.
function scheduler() {
  let seq = 0
  const queue = new Map()
  function setTimer(fn, ms) {
    const id = ++seq
    queue.set(id, { fn, due: Math.max(1, Number(ms) || 0) })
    return id
  }
  function clearTimer(id) {
    queue.delete(id)
  }
  function fire(ms) {
    let left = Math.max(0, Number(ms) || 0)
    let fired = 0
    for (;;) {
      let next
      for (const [id, entry] of queue) {
        if (entry.due > left) continue
        if (!next || entry.due < next.entry.due) next = { id, entry }
      }
      if (!next) break
      queue.delete(next.id)
      left -= next.entry.due
      for (const entry of queue.values()) entry.due -= next.entry.due
      fired += 1
      Promise.resolve(next.entry.fn()).catch(() => {})
    }
    for (const entry of queue.values()) entry.due -= left
    return fired
  }
  return { setTimer, clearTimer, fire, pending: () => queue.size }
}

async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i += 1) await new Promise(done => setImmediate(done))
}

// `spawnFor(nodeId)` answers one node: an id, a throw the host wrote, or a promise that never
// settles (the case that used to reach the caller as a bare deadline).
function harness(spawnFor) {
  const released = []
  const warnings = []
  const timers = scheduler()
  const svc = createWorkflowService({
    persist: false,
    now: () => CLOCK,
    bots: () => ROSTER,
    spawn: spec => spawnFor(spec),
    release: async (id) => { released.push(id) },
    dispatch: async () => ({ ok: true }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    warn: line => warnings.push(String(line)),
  })
  return { svc, released, warnings, timers }
}

function sixNodes(svc) {
  const made = svc.define({
    name: 'Issue fast line',
    nodes: [
      { id: 'triage', name: 'Triage', role: 'triage', model: 'opencsitool/DeepSeek-V4.1-Flash-1017', prompt: 'Triage it.' },
      { id: 'claim', name: 'Claim', role: 'dev', model: 'opencsitool/DeepSeek-V4.1-Flash-1017', prompt: 'Claim it.' },
      { id: 'gate', name: 'Gate', role: 'review', model: 'opencsitool/DeepSeek-V4.1-Flash-1017', prompt: 'Gate it.' },
      { id: 'enqueue', name: 'Enqueue', role: 'merge', model: 'opencsitool/DeepSeek-V4.1-Flash-1017', prompt: 'Queue it.' },
      { id: 'escalate', name: 'Escalate', role: 'stop', model: 'opencsitool/DeepSeek-V4.1-Flash-1017', prompt: 'Escalate it.' },
      { id: 'attest', name: '取证', role: 'attest', model: 'opencsitool/DeepSeek-V4.1-Flash-1017', prompt: 'Attest it.' },
    ],
    edges: [{ from: 'triage', to: 'claim' }],
  })
  assert.equal(made.ok, true)
  return made.workflows.find(item => item.name === 'Issue fast line')
}

test('#3282a: a node whose model does not exist names the node and the host reason', async () => {
  const { svc } = harness((spec) => {
    if (spec.nodeId === 'claim') throw new Error('Unknown model opencsitool/Nope-1017')
    return `eph-${spec.nodeId}`
  })
  const item = sixNodes(svc)
  const refused = await svc.assign({ workflowId: item.id, taskId: '#3282-model', title: 'Bad model' })

  assert.equal(refused.ok, false, 'the start is refused')
  assert.match(refused.error, /Claim/, `the node that failed is named: ${refused.error}`)
  assert.match(refused.error, /Unknown model opencsitool\/Nope-1017/, `the host reason is carried: ${refused.error}`)
  assert.doesNotMatch(refused.error, /^the host did not create the run Bots within/, 'not the bare deadline sentence')
  assert.equal(refused.nodeId, 'claim', 'the node id rides along for a machine reader')
  assert.equal(refused.reason, 'model-missing', 'the reason is classified')
})

test('#3282a: a node the host never answers names that node, not only the deadline', async () => {
  const hang = new Promise(() => {})
  const { svc, timers } = harness((spec) => (spec.nodeId === 'attest' ? hang : `eph-${spec.nodeId}`))
  const item = sixNodes(svc)
  const assigning = svc.assign({ workflowId: item.id, taskId: '#3282-hang', title: 'Never answered' })
  assigning.catch(() => {})
  await settle()

  timers.fire(SPAWN_DEADLINE_MS + 1)
  await settle()
  const refused = await assigning

  assert.equal(refused.ok, false, 'the start is refused at the deadline')
  assert.match(refused.error, /did not create the run Bots within 60s/, 'the deadline is still the frame')
  assert.match(refused.error, /"取证"/, `the node that never answered is named: ${refused.error}`)
  assert.match(refused.error, /5 of 6/, `how far the spawn got is said: ${refused.error}`)
  assert.equal(refused.nodeId, 'attest', 'the node id rides along for a machine reader')
  assert.equal(refused.reason, 'no-answer')
})

// core/src/host/channel.js answers every plugin endpoint as `ok(await rt.flybotEndpoint(...))` —
// `{ ok: true, value }` — and reports a thrown refusal as `fail(message, code, details)` —
// `{ ok: false, error }`. That is the envelope a caller sees, so the seam has to throw; `assign()`
// itself keeps its `{ ok: false }` answer for the in-process callers that read it.
async function channelEnvelope(run, details = {}) {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error: { code: error?.code ?? 'bot/error', message: error?.message ?? String(error), details: error?.details ?? details } }
  }
}

test('#3282b: a refused start fails the envelope a caller checks first', async () => {
  const { svc: okSvc } = harness(spec => `eph-${spec.nodeId}`)
  const startedLane = sixNodes(okSvc)
  const started = await okSvc.assignEndpoint({ workflowId: startedLane.id, taskId: '#3282-envelope-ok', title: 'Envelope ok' })
  assert.equal(started.ok, true, 'a started answer passes through unchanged')

  const { svc } = harness((spec) => {
    if (spec.nodeId === 'gate') throw new Error('A Bot named Gate 3f2a already exists')
    return `eph-${spec.nodeId}`
  })
  const item = sixNodes(svc)
  const envelope = await channelEnvelope(() => svc.assignEndpoint({ workflowId: item.id, taskId: '#3282-envelope', title: 'Envelope' }))

  assert.equal(envelope.ok, false, 'the outer envelope says the dispatch failed')
  assert.equal(envelope.error.code, 'bot/refused')
  assert.match(envelope.error.message, /Gate/, `the sentence names the node: ${envelope.error.message}`)
  assert.equal(envelope.error.details.nodeId, 'gate', 'the node is machine-readable on the envelope')
  assert.equal(envelope.error.details.reason, 'name-taken')

  // The in-process contract is untouched: `assign()` still answers `{ ok: false }` and never throws.
  const inProcess = await svc.assign({ workflowId: item.id, taskId: '#3282-envelope-2', title: 'In process' })
  assert.equal(inProcess.ok, false, 'assign() keeps its own answer')
  assert.match(inProcess.error, /Gate/)
})
