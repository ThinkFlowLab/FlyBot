// #2741: a step the host stopped before it answered is recorded as done, and a one-line
// answer in the notice shape is recorded as a failure. Both come from the same table of
// shapes the plugin falls back to when the host marked no failure on the reply.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'

const roster = [{ id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false }]

function harness() {
  let handle
  const created = []
  const removed = []
  async function send(message) { return { action: 'allow', text: message.text } }
  send.use = (spec) => { handle = spec.handle; return () => {} }
  send.priority = { ROUTING: 10 }
  const fb = {
    bot: {
      list: () => roster,
      async create() {
        const id = `bot-${++created.length}`
        created.push(id)
        return id
      },
      async remove(id) { removed.push(id); return true },
      send,
    },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tools: { register() { return () => {} } },
    warn() {},
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  return { svc: started.service, handle: (msg) => handle(msg) }
}

async function twoNodeLane(svc, name) {
  const defined = await svc.define({
    name,
    nodes: [
      { id: 'plan', name: 'Planner', prompt: 'Plan.', outputs: [{ name: 'plan', type: 'text' }] },
      { id: 'code', name: 'Coder', prompt: 'Code.', inputs: [{ name: 'plan', type: 'text', required: true }], outputs: [{ name: 'patch', type: 'text' }] },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  })
  const made = defined.workflows.find(item => item.name === name)
  await svc.runNamed({ workflow: name, brief: 'Ship the note' })
  return svc.state().workflows.find(item => item.id === made.id)
}

async function waitFor(read) {
  for (let n = 0; n < 200; n += 1) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('the reply did not move the run')
}

function rowOf(svc, id) {
  return svc.state().workflows.find(item => item.id === id)
}

test('a one-line answer in the notice shape is not a failed step', async () => {
  const { svc, handle } = harness()
  const made = await twoNodeLane(svc, 'One line lane')
  await handle({ from: made.run.ephemeral.plan, role: 'reply', text: 'Log shows the model call failed.' })
  const after = await waitFor(() => {
    const row = rowOf(svc, made.id)
    return row.run?.nodeStatus?.plan !== 'running' ? row : null
  })
  assert.equal(after.run.nodeStatus.plan, 'done', 'a sentence inside an answer is not a step failure')
  assert.equal(after.run.status, 'running', 'the run keeps going')
  assert.equal(after.run.nodeStatus.code, 'running', 'the next node receives the answer')
})

test('a turn the host stopped before it could answer fails the step with its reason', async () => {
  const { svc, handle } = harness()
  const made = await twoNodeLane(svc, 'Stopped lane')
  await handle({ from: made.run.ephemeral.plan, role: 'reply', text: 'Planner 3 was stopped before it could answer your message.' })
  const after = await waitFor(() => {
    const row = rowOf(svc, made.id)
    return row.run?.nodeStatus?.plan !== 'running' ? row : null
  })
  assert.equal(after.run.nodeStatus.plan, 'failed', 'a stopped turn is not a finished step')
  assert.equal(after.run.status, 'failed')
  assert.equal(after.run.failure?.code, 'step-failed')
  assert.match(String(after.run.failure?.text ?? ''), /stopped before it could answer/i)
  assert.equal(after.run.nodeStatus.code, 'queued', 'nothing downstream consumed the stop notice')
})

test('the marked failure notice still fails the step and keeps its reason', async () => {
  const { svc, handle } = harness()
  const made = await twoNodeLane(svc, 'Marked lane')
  await handle({
    from: made.run.ephemeral.plan,
    role: 'reply',
    text: 'Planner 3 could not answer your message: its model call failed (rate limit). Tell the user if it matters; do not retry right away.',
    deliverArgs: { failure: true },
  })
  const after = await waitFor(() => {
    const row = rowOf(svc, made.id)
    return row.run?.nodeStatus?.plan !== 'running' ? row : null
  })
  assert.equal(after.run.nodeStatus.plan, 'failed')
  assert.equal(after.run.status, 'failed')
  assert.match(String(after.run.failure?.text ?? ''), /model call failed/i)
})

test('a marked success is never a failed step', async () => {
  const { svc, handle } = harness()
  const made = await twoNodeLane(svc, 'Marked ok lane')
  await handle({ from: made.run.ephemeral.plan, role: 'reply', text: 'Log shows the model call failed.', deliverArgs: { failure: false } })
  const after = await waitFor(() => {
    const row = rowOf(svc, made.id)
    return row.run?.nodeStatus?.plan !== 'running' ? row : null
  })
  assert.equal(after.run.nodeStatus.plan, 'done')
  assert.equal(after.run.status, 'running')
})
