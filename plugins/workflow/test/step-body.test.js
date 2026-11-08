// #2669: a step is only handed the outputs its node declares, while the outgoing
// edges read outputs too. A graph whose `triage` node declares nothing and whose
// edges branch on `state` therefore never told its node to print that line, and
// every run of that shape died on `Missing OUTPUT state`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createWorkflowService } from '../src/service.js'

const NOW = 1_700_000_000_000

// `wf-1cdf6ec5`'s shape: triage declares no outputs; its edges read `state`.
function fastLineGraph() {
  return {
    nodes: [
      { id: 'triage', name: 'Triage', prompt: 'Triage the issue.' },
      { id: 'claim', name: 'Claim', prompt: 'Claim the issue.' },
      { id: 'escalate', name: 'Escalate', prompt: 'Report where it stopped.' },
    ],
    edges: [
      { from: 'triage', to: 'claim', when: { output: 'state', eq: 'ready' } },
      { from: 'triage', to: 'escalate', when: { else: true } },
    ],
  }
}

function serviceHarness(graph = fastLineGraph()) {
  const dispatched = []
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => NOW,
    bots: () => [],
    spawn: async () => `eph-${++seq}`,
    release: async () => {},
    dispatch: async (step) => {
      dispatched.push(step)
      return { ok: true }
    },
  })
  const made = svc.define({ name: 'Fast line', ...graph }).workflows.find(item => item.name === 'Fast line')
  return { svc, id: made.id, dispatched }
}

const laneOf = (views, id) => views.workflows.find(item => item.id === id)

test('#2669: a node that declares no outputs is handed the ones its edges read', async () => {
  const { svc, dispatched } = serviceHarness()
  await svc.runNamed({ workflow: 'Fast line', brief: 'i2669-impl' })
  const triage = dispatched.find(step => step.nodeId === 'triage')
  const state = triage.outputs.find(port => port.name === 'state')
  assert.ok(state, 'the gate-read OUTPUT reaches the step even though the node declares none')
  assert.deepEqual(state.values, ['ready'], 'and it carries the value the edge tests')
})

test('#2669: the handoff names the OUTPUT and the values it may take', async () => {
  const sent = []
  const roster = [
    { id: 'bot-main', name: 'Chief', role: 'lead', isMain: true, remote: false },
    { id: 'bot-worker', name: 'Worker', remote: false },
  ]
  const fb = {
    bot: {
      list: () => roster,
      async create() { return 'bot-step-1' },
      async remove() { return true },
      async send(message) { sent.push(message); return { action: 'allow' } },
    },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tools: { register() { return () => {} } },
    warn() {},
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  started.service.define({ name: 'Fast line', ...fastLineGraph() })
  await started.service.runNamed({ workflow: 'Fast line', brief: 'i2669-impl' })

  const text = sent.map(message => message.text).join('\n')
  assert.match(text, /OUTPUT state/, 'the node is told which OUTPUT line the gate reads')
  assert.match(text, /one of: ready/, 'and which value satisfies the edge')
})

test('#2669: declared outputs are kept once, with the values their edges read', async () => {
  const graph = {
    nodes: [
      {
        id: 'triage',
        name: 'Triage',
        prompt: 'Triage the issue.',
        outputs: [{ name: 'state', type: 'text' }, { name: 'summary', type: 'text' }],
      },
      { id: 'claim', name: 'Claim', prompt: 'Claim the issue.' },
      { id: 'escalate', name: 'Escalate', prompt: 'Report where it stopped.' },
    ],
    edges: [
      { from: 'triage', to: 'claim', when: { output: 'state', eq: 'ready' } },
      { from: 'triage', to: 'escalate', when: { output: 'verdict', eq: 'PASS' } },
    ],
  }
  const { svc, dispatched } = serviceHarness(graph)
  await svc.runNamed({ workflow: 'Fast line', brief: 'i2669-impl' })
  const triage = dispatched.find(step => step.nodeId === 'triage')
  assert.deepEqual(triage.outputs.map(port => port.name), ['state', 'summary', 'verdict'], 'no declared port is lost or repeated')
  assert.equal(triage.outputs.find(port => port.name === 'summary').type, 'text', 'a declared port keeps its own shape')
  assert.deepEqual(triage.outputs.find(port => port.name === 'state').values, ['ready'], 'a declared port gains the values its edge reads')
  assert.deepEqual(triage.outputs.find(port => port.name === 'verdict').values, ['PASS'])
})

test('#2669: the run walks the branch once the node prints the OUTPUT it was told about', async () => {
  const { svc, id, dispatched } = serviceHarness()
  let views = await svc.runNamed({ workflow: 'Fast line', brief: 'i2669-impl' })
  views = await svc.stepResult({ botId: dispatched[0].botId, text: 'OUTPUT state: ready' })
  const run = laneOf(views, id).run
  assert.equal(run.nodeStatus.triage, 'done', 'the gate the node now knows about is satisfied')
  assert.equal(run.nodeStatus.claim, 'running', 'the ready branch starts')
  assert.equal(run.nodeStatus.escalate, 'skipped', 'the else route is not taken')
  assert.equal(run.status, 'running')
})
