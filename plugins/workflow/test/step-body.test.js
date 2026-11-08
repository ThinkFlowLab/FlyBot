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

// #2677: a step's answer is its own text, so an audit that quotes the host's failure
// sentence, a pasted log, or a retold failure must not fail the node. The host marks the
// real notice on the message; only an old host falls back to the sentence, and only when
// it is the shape at the start of the text.
function replyMiddleware() {
  let handle
  const seen = []
  const fb = {
    bot: {
      list: () => [],
      send: Object.assign(async () => ({ action: 'allow' }), {
        use(spec) {
          handle = spec.handle
          return () => {}
        },
        priority: { ROUTING: 10 },
      }),
    },
    readOnly: () => false,
    api: { handle: () => () => {} },
    tools: { register: () => () => {} },
    warn: () => {},
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  started.service.ownsBot = () => true
  started.service.stepResult = async body => { seen.push(body); return {} }
  return { handle, seen }
}

async function stepOk(message) {
  const { handle, seen } = replyMiddleware()
  const verdict = await handle({ from: 'bot-step', role: 'reply', text: '', ...message })
  assert.equal(verdict?.action, 'deny')
  assert.equal(seen.length, 1)
  return seen[0].ok
}

const QUOTED_FAILURE = '候选 3：turns.js:709 的正文是 `<name> could not answer your message: its model call failed (…)`'

test('#2677: an answer that quotes the failure sentence still advances the step', async () => {
  assert.equal(await stepOk({ text: QUOTED_FAILURE }), true, 'a quoted failure inside the answer is not the step failing')
  assert.equal(await stepOk({ text: '查完了，3 条候选。' }), true, 'an ordinary answer advances the step')
})

test('#2677: the host marks a real failure notice, and the marker decides', async () => {
  assert.equal(await stepOk({ text: 'Scout abc could not answer your message: its model call failed (RATE_LIMIT 429).', failed: true }), false)
  assert.equal(await stepOk({ text: 'anything at all', ok: false }), false)
  // `rt.deliver` hands the middleware its own args under `deliverArgs`, which is where
  // the host's notice carries the marker on a live run.
  assert.equal(await stepOk({ text: 'Scout abc could not answer your message: its model call failed (RATE_LIMIT 429).', deliverArgs: { failed: true } }), false)
  // A marker that says the answer is fine wins over text that looks like the notice.
  assert.equal(await stepOk({ text: 'Scout abc could not answer your message: its model call failed (RATE_LIMIT 429).', failed: false }), true)
})

test('#2677: an old host without the marker is read only at the start of the text', async () => {
  assert.equal(await stepOk({ text: 'Scout abc could not answer your message:' }), false, 'the notice shape at the start still fails')
  assert.equal(await stepOk({ text: 'Scout abc could not answer your message: its model call failed (RATE_LIMIT 429).' }), false)
  // These two are what the middleware caught before #2677; the anchored fallback keeps them.
  assert.equal(await stepOk({ text: 'could not answer your message' }), false)
  assert.equal(await stepOk({ text: 'The model call failed.' }), false)
  assert.equal(await stepOk({ text: 'The log said "`<name> could not answer your message: its model call failed`".' }), true, 'a quoted notice after the start is not the step failing')
})
