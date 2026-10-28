// #1373: a run spawns one ephemeral Bot per node from that node's config.
// The instance is hidden (the sidebar predicate rejects it), does the step,
// and is removed when the run finishes, fails for good, or is reset.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isShownRemoteChat } from '../../../core/src/shared/remote-label.js'
import { apply } from '../index.js'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
  { id: 'bot-planner', name: 'Planner', role: '计划', remote: false, systemPrompt: 'Plan from the seated Bot.' },
]

function harness(extra = {}) {
  const spawned = []
  const released = []
  const dispatched = []
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => roster,
    spawn: async (spec) => {
      const id = `eph-${++seq}`
      spawned.push({ id, spec })
      if (extra.failOn === spec.nodeId) throw new Error('spawn failed')
      return id
    },
    release: async (id) => { released.push(id) },
    dispatch: async (step) => { dispatched.push(step); return { ok: true } },
    ...extra.service,
  })
  return { svc, spawned, released, dispatched }
}

function lane(svc) {
  return svc.define({
    name: 'Lane',
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', botId: 'bot-planner', prompt: 'Write the plan.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.', model: 'mock/coder', tools: ['read', 'edit'] },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  })
}

test('define_workflow stores a node prompt, and the graph save edits it', () => {
  const { svc } = harness()
  const defined = lane(svc)
  assert.equal(defined.ok, true)
  const made = defined.workflows.find(item => item.name === 'Lane')
  assert.equal(made.nodes.find(node => node.id === 'plan').prompt, 'Write the plan.')
  assert.equal(made.nodes.find(node => node.id === 'code').model, 'mock/coder')
  assert.deepEqual(made.nodes.find(node => node.id === 'code').tools, ['read', 'edit'])

  const saved = svc.saveGraph({
    workflowId: made.id,
    nodes: made.nodes.map(node => node.id === 'code' ? { ...node, prompt: 'Keep the diff small.' } : node),
    edges: [{ from: 'plan', to: 'code' }, { from: 'code', to: 'plan' }],
  })
  assert.equal(saved.ok, false)

  const edited = svc.saveGraph({
    workflowId: made.id,
    nodes: made.nodes.map(node => node.id === 'code' ? { ...node, prompt: 'Keep the diff small.' } : node),
    edges: made.edges,
  })
  assert.equal(edited.workflows.find(item => item.id === made.id).nodes.find(node => node.id === 'code').prompt, 'Keep the diff small.')
})

test('workflow-level model is passed to all ephemeral Bots when set', async () => {
  const { svc, spawned } = harness()
  const made = svc.define({
    name: 'Workflow with model',
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Plan it.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Code it.', model: 'mock/coder-override' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  }).workflows.find(item => item.name === 'Workflow with model')
  
  const withModel = await svc.setModel({ workflowId: made.id, model: 'mock/workflow-model' })
  assert.equal(withModel.ok, true)
  const updated = withModel.workflows.find(item => item.id === made.id)
  assert.equal(updated.model, 'mock/workflow-model')
  
  await svc.runNamed({ workflow: 'Workflow with model', brief: 'Test workflow model' })
  assert.equal(spawned.length, 2)
  const planSpec = spawned.find(item => item.spec.nodeId === 'plan').spec
  const codeSpec = spawned.find(item => item.spec.nodeId === 'code').spec
  assert.equal(planSpec.model, 'mock/workflow-model')
  assert.equal(codeSpec.model, 'mock/workflow-model')
})

test('workflow model is empty by default and uses seated Bot model', async () => {
  const { svc, spawned } = harness()
  const made = lane(svc).workflows.find(item => item.name === 'Lane')
  assert.equal(made.model, '')
  
  await svc.runNamed({ workflow: 'Lane', brief: 'Test default' })
  const planSpec = spawned.find(item => item.spec.nodeId === 'plan').spec
  assert.equal(planSpec.model, '')
  const codeSpec = spawned.find(item => item.spec.nodeId === 'code').spec
  assert.equal(codeSpec.model, 'mock/coder')
})

test('a run spawns a hidden Bot per node, hands it the step, and removes every one when the run finishes', async () => {
  const { svc, spawned, released, dispatched } = harness()
  const made = lane(svc).workflows.find(item => item.name === 'Lane')
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'Ship the note', task: '#1373' })
  assert.equal(started.ok, true)
  const run = started.workflows.find(item => item.id === made.id).run
  assert.equal(run.status, 'running')
  assert.deepEqual(Object.keys(run.ephemeral).sort(), ['code', 'plan'])
  assert.equal(spawned.length, 2)
  assert.equal(spawned.every(item => item.spec.hidden === true && item.spec.ephemeral === true), true)
  const plan = spawned.find(item => item.spec.nodeId === 'plan')
  assert.equal(plan.spec.prompt, 'Write the plan.')
  assert.equal(plan.spec.role, 'plan')
  const code = spawned.find(item => item.spec.nodeId === 'code')
  assert.equal(code.spec.prompt, 'Implement it.')
  assert.equal(code.spec.model, 'mock/coder')
  assert.deepEqual(code.spec.tools, ['read', 'edit'])
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].botId, run.ephemeral.plan)
  assert.equal(dispatched[0].brief, 'Ship the note')
  for (const item of spawned) {
    assert.equal(isShownRemoteChat({ id: item.id, name: item.spec.name, hidden: item.spec.hidden }), false)
  }
  assert.equal(isShownRemoteChat({ id: 'bot-planner', name: 'Planner' }), true)

  const mid = await svc.advance({ workflowId: made.id, nodeId: 'plan', outcome: 'done' })
  assert.equal(mid.workflows.find(item => item.id === made.id).run.nodeStatus.code, 'running')
  assert.equal(dispatched.at(-1).botId, run.ephemeral.code)
  assert.equal(released.length, 0)

  const done = await svc.advance({ workflowId: made.id, nodeId: 'code', outcome: 'done' })
  const finished = done.workflows.find(item => item.id === made.id).run
  assert.equal(finished.status, 'done')
  assert.equal(finished.ephemeral, undefined)
  assert.deepEqual(released.sort(), spawned.map(item => item.id).sort())
})

test('a failed step tears the instances down, a fail-once step keeps them, and reset cancels them', async () => {
  const { svc, spawned, released } = harness()
  const made = lane(svc).workflows.find(item => item.name === 'Lane')
  await svc.runNamed({ workflow: 'Lane', brief: 'Ship the note' })
  const failed = await svc.advance({ workflowId: made.id, nodeId: 'plan', outcome: 'failed' })
  const stopped = failed.workflows.find(item => item.id === made.id).run
  assert.equal(stopped.status, 'failed')
  assert.equal(stopped.ephemeral, undefined)
  assert.equal(released.length, spawned.length)

  const again = harness()
  const retry = again.svc.define({
    name: 'Retry',
    nodes: [
      { id: 'check', name: 'Tester', role: 'test', prompt: 'Look once.', failOnce: true },
      { id: 'ship', name: 'Deployer', role: 'ship', prompt: 'Publish.' },
    ],
    edges: [{ from: 'check', to: 'ship' }],
  }).workflows.find(item => item.name === 'Retry')
  await again.svc.runNamed({ workflow: 'Retry', brief: 'Try' })
  const held = await again.svc.advance({ workflowId: retry.id, nodeId: 'check', outcome: 'failed' })
  assert.equal(held.workflows.find(item => item.id === retry.id).run.status, 'running')
  assert.equal(again.released.length, 0)
  const cancelled = await again.svc.reset({ workflowId: retry.id })
  const cleared = cancelled.workflows.find(item => item.id === retry.id)
  assert.equal(cleared.run, null)
  assert.equal(cleared.activeCount, 0)
  assert.deepEqual(again.released.sort(), again.spawned.map(item => item.id).sort())
})

test('a spawn that fails halfway removes the instances it already made and does not start the run', async () => {
  const { svc, spawned, released } = harness({ failOn: 'code' })
  const made = lane(svc).workflows.find(item => item.name === 'Lane')
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'Ship the note' })
  assert.equal(started.ok, false)
  assert.equal(spawned.length, 2)
  assert.deepEqual(released, ['eph-1'])
  assert.equal(svc.state().workflows.find(item => item.id === made.id).run, null)
})

test('a node Bot keeps full file/shell rights and passes node.tools as its connector list', async () => {
  const created = []
  const fb = {
    bot: {
      list: () => roster,
      async create(spec) {
        const id = `bot-${created.length + 1}`
        created.push(spec)
        return id
      },
      async remove() { return true },
      async send() { return { action: 'allow' } },
    },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tools: { register() { return () => {} } },
    warn() {},
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  
  // Node with no tools: an empty connector list, so the host writes no stepTools and refuses
  // every connector. File and shell rights still come from the permission preset.
  await started.service.define({
    name: 'NoTools',
    nodes: [{ id: 'worker', name: 'Worker', prompt: 'Do the work.' }],
    edges: [],
  })
  await started.service.runNamed({ workflow: 'NoTools', brief: 'Test no tools' })
  assert.deepEqual(created[0].tools, [], 'a node that names no connector passes an empty list')
  assert.equal(created[0].permission, 'danger-full-access', 'file and shell rights are a normal Bot\'s')
  assert.equal(created[0].systemPrompt, 'Do the work.', 'prompt has no tool-specific notes')
  
  // Node with explicit empty tools: the same empty connector list
  created.length = 0
  await started.service.define({
    name: 'EmptyTools',
    nodes: [{ id: 'worker', name: 'Worker', prompt: 'Do the work.', tools: [] }],
    edges: [],
  })
  await started.service.runNamed({ workflow: 'EmptyTools', brief: 'Test empty' })
  assert.deepEqual(created[0].tools, [], 'tools: [] names no connector')
  assert.equal(created[0].permission, 'danger-full-access')
  
  // Node with explicit tools: the list travels as the connector list
  created.length = 0
  await started.service.define({
    name: 'CustomTools',
    nodes: [{ id: 'reader', name: 'Reader', prompt: 'Just read.', tools: ['read'] }],
    edges: [],
  })
  await started.service.runNamed({ workflow: 'CustomTools', brief: 'Test custom' })
  assert.deepEqual(created[0].tools, ['read'], 'node.tools reaches fb.bot.create')
  assert.equal(created[0].permission, 'danger-full-access', 'the list does not change file/shell rights')
  assert.deepEqual(created[0].fields.tools, ['read'], 'fields.tools keeps the list for the UI')
  assert.equal(created[0].systemPrompt, 'Just read.', 'no tool notes added')
  
  // Node with bash in tools: the list still travels, and the permission preset is unchanged
  created.length = 0
  await started.service.define({
    name: 'ShellTools',
    nodes: [{ id: 'worker', name: 'Worker', prompt: 'Run commands.', tools: ['bash', 'read'] }],
    edges: [],
  })
  await started.service.runNamed({ workflow: 'ShellTools', brief: 'Test shell' })
  assert.deepEqual(created[0].tools, ['bash', 'read'])
  assert.equal(created[0].permission, 'danger-full-access')
})

test('apply wires spawn to a hidden ephemeral create and removes those Bots when the run ends', async () => {
  const created = []
  const removed = []
  const sent = []
  const fb = {
    bot: {
      list: () => roster,
      async create(spec) {
        const id = `bot-${created.length + 1}`
        created.push(spec)
        return id
      },
      async remove(id) { removed.push(id); return true },
      async send(message) { sent.push(message); return { action: 'allow' } },
    },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tools: { register() { return () => {} } },
    warn() {},
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  const defined = await started.service.define({
    name: 'Lane',
    nodes: [{ id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' }],
    edges: [],
  })
  const made = defined.workflows.find(item => item.name === 'Lane')
  const run = await started.service.runNamed({ workflow: 'Lane', brief: 'Ship the note' })
  assert.equal(run.ok, true)
  assert.equal(created.length, 1)
  assert.equal(created[0].ephemeral, true)
  assert.equal(created[0].hidden, true)
  // A node Bot keeps the file/shell preset a normal Bot has and passes its connector list
  // (empty for a node that names none) so the host can record stepTools.
  assert.equal(created[0].permission, 'danger-full-access')
  assert.deepEqual(created[0].tools, [], 'a node that names no connector passes an empty list')
  assert.match(created[0].systemPrompt, /Write the plan\./)
  assert.doesNotMatch(created[0].systemPrompt, /You can use these tools:/, 'no tool-specific notes')
  assert.equal(created[0].name.startsWith('Planner '), true)
  assert.notEqual(created[0].name, 'Planner')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].from, 'main')
  assert.match(sent[0].text, /Ship the note/)
  const done = await started.service.advance({ workflowId: made.id, nodeId: 'plan', outcome: 'done' })
  assert.equal(done.workflows.find(item => item.id === made.id).run.status, 'done')
  assert.deepEqual(removed, ['bot-1'])
})

test('a Bot reply advances a live node; a 429 in the reply does not fail it', async () => {
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
        const id = `bot-${created.length + 1}`
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
  const defined = await started.service.define({
    name: 'Lane',
    nodes: [
      { id: 'plan', name: 'Planner', prompt: 'Plan.', outputs: [{ name: 'plan', type: 'text' }] },
      { id: 'code', name: 'Coder', prompt: 'Code.', inputs: [{ name: 'plan', type: 'text', required: true }], outputs: [{ name: 'patch', type: 'text' }] },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  })
  const made = defined.workflows.find(item => item.name === 'Lane')
  const opened = await started.service.runNamed({ workflow: 'Lane', brief: 'Ship the note' })
  const run = opened.workflows.find(item => item.id === made.id).run
  assert.equal(typeof handle, 'function')
  assert.equal(run.nodeStatus.plan, 'running')
  assert.equal(await handle({ from: run.ephemeral.plan, role: 'request', text: 'not a reply' }), undefined)
  const planReply = await handle({ from: run.ephemeral.plan, role: 'reply', text: 'Noted a rate limit (429) in the log.\nOUTPUT plan: two lines' })
  assert.equal(planReply?.action, 'deny')
  const mid = await waitFor(() => {
    const row = started.service.state().workflows.find(item => item.id === made.id)
    return row.run?.nodeStatus?.code === 'running' ? row : null
  })
  assert.equal(mid.run.nodeStatus.plan, 'done')
  await handle({ from: run.ephemeral.code, role: 'reply', text: 'could not answer your message' })
  const stopped = await waitFor(() => {
    const row = started.service.state().workflows.find(item => item.id === made.id)
    if (row.run?.status !== 'failed' || removed.length !== created.length) return null
    return row
  })
  assert.equal(stopped.run.nodeStatus.code, 'failed')
  assert.equal(stopped.run.ephemeral, undefined)
  assert.deepEqual(removed.sort(), created.sort())

  const again = await started.service.runNamed({ workflow: 'Lane', brief: 'Ship another', task: '#1402b' })
  const second = again.workflows.find(item => item.id === made.id).run
  assert.equal(second.status, 'running')
  await handle({ from: second.ephemeral.plan, role: 'reply', text: 'The model call failed.' })
  const failed = await waitFor(() => {
    const row = started.service.state().workflows.find(item => item.id === made.id)
    return row.run?.task?.id === '#1402b' && row.run?.status === 'failed' ? row : null
  })
  assert.equal(failed.run.nodeStatus.plan, 'failed')
})

async function waitFor(read) {
  for (let n = 0; n < 40; n += 1) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('the reply did not move the run')
}

test('#1389: a step the host refuses is not marked as handed, and a later settle sends it again', async () => {
  let answer = { ok: false, code: 'no-sender' }
  const calls = []
  const warnings = []
  const { svc } = harness({
    service: {
      dispatch: async (step) => { calls.push(step); return answer },
      warn: (...args) => warnings.push(args.join(' ')),
    },
  })
  const made = svc.define({
    name: 'Pair',
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
    ],
    edges: [],
  }).workflows.find(item => item.name === 'Pair')
  const started = await svc.runNamed({ workflow: 'Pair', brief: 'Ship the note' })
  assert.equal(started.ok, true)
  const run = started.workflows.find(item => item.id === made.id).run
  assert.equal(run.status, 'running')
  assert.deepEqual(calls.map(step => step.nodeId).sort(), ['code', 'plan'])

  // A refused step is not welded shut: the next settle sends it again, to the same Bot.
  answer = { ok: true }
  const moved = await svc.advance({ workflowId: made.id, nodeId: 'plan', outcome: 'done' })
  assert.equal(moved.ok, true)
  const after = moved.workflows.find(item => item.id === made.id).run
  assert.equal(after.nodeStatus.code, 'running')
  const codeCalls = calls.filter(step => step.nodeId === 'code')
  assert.equal(codeCalls.length, 2)
  assert.equal(codeCalls[0].botId, codeCalls[1].botId)
  assert.match(warnings.join('\n'), /no-sender/)
})

// #1569: the Bot reply hook calls service.stepResult directly, so it never passes
// through the host channel's read-only check. advance's own guard has to stop it,
// and the refusal is reported once instead of being swallowed.
test('#1569: a read-only host refuses the Bot reply that would advance a run', async () => {
  let readOnly = false
  const warnings = []
  const { svc } = harness({ service: { readOnly: () => readOnly, warn: (...args) => warnings.push(args.join(' ')) } })
  const made = svc.define({
    name: 'Pair',
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
    ],
    edges: [],
  }).workflows.find(item => item.name === 'Pair')
  const started = await svc.runNamed({ workflow: 'Pair', brief: 'Ship the note' })
  const run = started.workflows.find(item => item.id === made.id).run
  const planner = run.ephemeral.plan
  assert.equal(run.nodeStatus.plan, 'running')

  readOnly = true
  await svc.stepResult({ botId: planner, ok: true, text: 'The plan is ready.' })
  const after = svc.state().workflows.find(item => item.id === made.id).run
  assert.equal(after.status, 'running')
  assert.equal(after.nodeStatus.plan, 'running')
  assert.equal(after.doneCount, run.doneCount)
  assert.match(warnings.join('\n'), /read-only/)

  // The same step replies again: still refused, and the warning is not repeated.
  await svc.stepResult({ botId: planner, ok: true, text: 'The plan is ready.' })
  assert.equal(warnings.filter(line => line.includes('read-only')).length, 1)
})

// #1388: reap is the only path that cleans up a run whose host went away, and the
// plugin calls it exactly once, at load. A run still marked `running` at that
// moment is what a restart leaves behind: nothing resumes it, so its ephemeral
// Bots are abandoned. Loading must release them and end the run as failed, or
// they stay hidden in the roster with no way to remove them.
function persistent(dir, released, clock) {
  return createWorkflowService({
    dir,
    persist: true,
    now: () => clock(),
    bots: () => roster,
    spawn: async (spec) => `eph-${spec.nodeId}`,
    release: async (id) => { released.push(id) },
    dispatch: async () => ({ ok: true }),
  })
}

function readStore(dir) {
  return JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
}

// The lane store keeps a live run on `lanes[id].active` and the one that just
// ended on `lanes[id].last`. An older file still has `runs[id]`.
function persistedRun(dir, workflowId) {
  const store = readStore(dir)
  const lane = store.lanes?.[workflowId]
  if (!lane) return store.runs?.[workflowId] ?? null
  const active = (lane.active ?? []).find(run => run && (run.ephemeral || run.status === 'running'))
  return active ?? lane.last ?? null
}

// #1425: the plugin starts reap without awaiting it (index.js:92), so this test waits for the
// state reap writes, never for a fixed wall-clock delay: a 20 ms sleep passes on a fast box and
// flakes on a loaded runner, and the failure it produces looks like the bug the test hunts. The
// deadline only bounds failure, and the message names the state the run was last in.
async function untilRun(dir, workflowId, settled, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = persistedRun(dir, workflowId)
    if (settled(last)) return last
    if (Date.now() >= deadline) throw new Error(`the run was not reaped within ${timeout} ms; last state: ${JSON.stringify(last)}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

test('a load reaps the run a restart left running: its Bots go and the run ends failed (#1388)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reap-'))
  const released = []
  let clock = 1_700_000_000_000
  try {
    const before = persistent(dir, released, () => clock)
    const made = before.define({
      name: 'Lane',
      nodes: [
        { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
        { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
      ],
      edges: [{ from: 'plan', to: 'code' }],
    }).workflows.find(item => item.name === 'Lane')
    await before.runNamed({ workflow: 'Lane', brief: 'Ship the note' })
    const saved = persistedRun(dir, made.id)
    assert.equal(saved.status, 'running')
    assert.deepEqual(Object.values(saved.ephemeral).sort(), ['eph-code', 'eph-plan'])
    assert.equal(released.length, 0)

    // The host restarted here. This load is the only chance to clean up.
    clock += 60_000
    const after = persistent(dir, released, () => clock)
    await after.reap()
    assert.deepEqual(released.sort(), ['eph-code', 'eph-plan'])
    const run = after.state().workflows.find(item => item.id === made.id).run
    assert.equal(run.status, 'failed')
    assert.equal(run.nodeStatus.plan, 'failed')
    assert.deepEqual(run.running, [])
    assert.equal(run.ephemeral, undefined)
    assert.equal(run.handed, undefined)
    assert.equal(run.updatedAt, clock)
    const settled = persistedRun(dir, made.id)
    assert.equal(settled.status, 'failed')
    assert.equal(settled.ephemeral, undefined)
    assert.equal('handed' in settled, false)
    assert.equal(settled.updatedAt, clock)

    // A second load finds nothing left to release.
    released.length = 0
    await persistent(dir, released, () => clock).reap()
    assert.deepEqual(released, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a finished run stays done, and a run with no ephemeral Bots is not touched (#1388)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reap-done-'))
  const released = []
  let clock = 1_700_000_000_000
  try {
    const svc = persistent(dir, released, () => clock)
    const quick = svc.define({
      name: 'Quick',
      nodes: [{ id: 'only', name: 'Planner', role: 'plan', prompt: 'Say it once.' }],
      edges: [],
    }).workflows.find(item => item.name === 'Quick')
    await svc.runNamed({ workflow: 'Quick', brief: 'One step' })
    await svc.advance({ workflowId: quick.id, nodeId: 'only', outcome: 'done' })
    released.length = 0
    const finished = persistedRun(dir, quick.id)
    assert.equal(finished.status, 'done')
    assert.equal(finished.ephemeral, undefined)
    const finishedAt = finished.updatedAt

    // A live run whose ephemeral map is already gone (dispose on an older build)
    // is healed on load: end failed and free capacity (#1414).
    const idle = svc.define({ name: 'Idle', nodes: [{ id: 'one', name: 'Planner', role: 'plan', prompt: 'Wait.' }], edges: [] })
      .workflows.find(item => item.name === 'Idle')
    const store = readStore(dir)
    const lane = store.lanes[idle.id] ?? { active: [], queue: [], last: null, history: [] }
    lane.active = [...(lane.active ?? []), {
      id: 'run-bare',
      workflowId: idle.id,
      task: { id: '#1414', title: 'Zombie' },
      live: true,
      status: 'running',
      nodeStatus: { one: 'running' },
      steps: 0,
      stepBudget: 1,
      failedOnce: {},
      history: [],
      startedAt: 5,
      updatedAt: 6,
    }]
    store.lanes[idle.id] = lane
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(store))

    clock += 60_000
    const after = persistent(dir, released, () => clock)
    await after.reap()
    assert.deepEqual(released, [])
    const kept = after.state().workflows.find(item => item.id === quick.id).run
    assert.equal(kept.status, 'done')
    assert.equal(kept.updatedAt, finishedAt)
    const healed = after.state().workflows.find(item => item.id === idle.id).run
    assert.equal(healed.status, 'failed')
    assert.equal(healed.nodeStatus.one, 'failed')
    assert.deepEqual(healed.running, [])
    assert.equal(after.state().workflows.find(item => item.id === idle.id).activeCount, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the plugin load itself reaps a run the restart left running (#1388)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reap-apply-'))
  const released = []
  const clock = () => 1_700_000_000_000
  try {
    const before = persistent(dir, released, clock)
    const made = before.define({
      name: 'Lane',
      nodes: [{ id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' }],
      edges: [],
    }).workflows.find(item => item.name === 'Lane')
    await before.runNamed({ workflow: 'Lane', brief: 'Ship the note' })
    assert.equal(persistedRun(dir, made.id).status, 'running')

    // Loading the plugin is where the abandoned run is recognised.
    const fb = {
      bot: {
        list: () => roster,
        async create() { return 'bot-1' },
        async remove(id) { released.push(id); return true },
        async send() { return { action: 'allow' } },
      },
      readOnly: () => false,
      api: { handle() { return () => {} } },
      tools: { register() { return () => {} } },
      warn() {},
    }
    const loaded = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { dir })
    // Loading calls reap without awaiting it; wait for what it writes, with a deadline.
    const settled = await untilRun(dir, made.id, (run) => run?.status === 'failed' && run.ephemeral === undefined)
    assert.equal('handed' in settled, false)
    assert.deepEqual(released, ['eph-plan'])
    const run = loaded.service.state().workflows.find(item => item.id === made.id).run
    assert.equal(run.status, 'failed')
    assert.equal(run.ephemeral, undefined)
    loaded.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// #1424: ending a run has to settle the node map with it. `publicRun` exposes
// `running` from `nodeStatus`, and the strip paints "Running now" from that, so a
// run that says `failed` while a node still says `running` is a ghost on screen.
test('stopping a live run settles its node map: no node stays running (#1424)', async () => {
  const { svc, spawned, released } = harness()
  const made = lane(svc).workflows.find(item => item.name === 'Lane')
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'Ship the note' })
  assert.equal(started.ok, true)
  const live = started.workflows.find(item => item.id === made.id).run
  assert.equal(live.status, 'running')
  assert.deepEqual(live.running, ['plan'])

  const stopped = await svc.reset({ workflowId: made.id, runId: live.id })
  assert.equal(stopped.ok, true)
  const run = stopped.workflows.find(item => item.id === made.id).run
  assert.equal(run.status, 'failed')
  assert.deepEqual(run.running, [])
  assert.equal(run.nodeStatus.plan, 'failed')
  assert.equal(run.nodeStatus.code, 'queued')
  assert.deepEqual(released.sort(), spawned.map(entry => entry.id).sort())

  // The ending reaches the list the stage renders, not just the run record.
  const history = stopped.workflows.find(item => item.id === made.id).history
  assert.equal(history.at(-1).status, 'failed')
  assert.equal(history.at(-1).at, run.updatedAt)
})

test('a reaped run whose node map names a node the graph no longer has settles the rest (#1424)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reap-1424-ghost-'))
  const released = []
  const clock = () => 1_700_000_000_000
  try {
    const svc = persistent(dir, released, clock)
    const made = svc.define({
      name: 'Lane',
      nodes: [{ id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' }],
      edges: [],
    }).workflows.find(item => item.name === 'Lane')
    const store = readStore(dir)
    const lane = store.lanes[made.id] ?? { active: [], queue: [], last: null, history: [] }
    lane.active = [...(lane.active ?? []), {
      id: 'run-ghost',
      workflowId: made.id,
      task: null,
      live: true,
      status: 'running',
      nodeStatus: { plan: 'running', gone: 'running' },
      steps: 0,
      stepBudget: 2,
      failedOnce: {},
      history: [],
      startedAt: 4,
      updatedAt: 5,
      ephemeral: { plan: 'eph-plan', gone: 'eph-gone' },
    }]
    store.lanes[made.id] = lane
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(store))

    const after = persistent(dir, released, clock)
    await after.reap()
    assert.deepEqual(released.sort(), ['eph-gone', 'eph-plan'])
    const run = after.state().workflows.find(item => item.id === made.id).run
    assert.equal(run.status, 'failed')
    assert.equal(run.nodeStatus.plan, 'failed')
    // Nothing to move: the graph no longer has that node, so it keeps its record
    // and the strip, which walks the graph, does not paint it.
    assert.equal(run.nodeStatus.gone, 'running')
    assert.deepEqual(run.running, [])
    assert.equal(run.ephemeral, undefined)
    assert.equal(run.handed, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ended run keeps its ending when reap drops the records it still holds (#1424)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reap-1424-done-'))
  const released = []
  const clock = () => 1_700_000_000_000
  try {
    const svc = persistent(dir, released, clock)
    const made = svc.define({
      name: 'Lane',
      nodes: [{ id: 'only', name: 'Planner', role: 'plan', prompt: 'Say it once.' }],
      edges: [],
    }).workflows.find(item => item.name === 'Lane')
    const store = readStore(dir)
    const lane = store.lanes[made.id] ?? { active: [], queue: [], last: null, history: [] }
    lane.last = {
      id: 'run-done',
      workflowId: made.id,
      task: null,
      live: true,
      status: 'done',
      nodeStatus: { only: 'done' },
      steps: 1,
      stepBudget: 2,
      failedOnce: {},
      history: [{ task: null, status: 'done', at: 5 }],
      startedAt: 4,
      updatedAt: 6,
      ephemeral: { only: 'eph-only' },
    }
    store.lanes[made.id] = lane
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(store))

    const after = persistent(dir, released, clock)
    await after.reap()
    assert.deepEqual(released, ['eph-only'])
    const run = after.state().workflows.find(item => item.id === made.id).run
    assert.equal(run.status, 'done')
    assert.equal(run.updatedAt, 6)
    assert.equal(run.nodeStatus.only, 'done')
    assert.deepEqual(run.running, [])
    assert.equal(run.history.length, 1)
    assert.equal(run.history[0].status, 'done')
    assert.equal(run.ephemeral, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the built-in delivery nodes hand their connector list to the host', async () => {
  const created = []
  const fb = {
    bot: {
      list: () => roster,
      async create(spec) {
        created.push(spec)
        return `bot-${created.length}`
      },
      async remove() { return true },
      async send() { return { action: 'allow' } },
    },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tools: { register() { return () => {} } },
    warn() {},
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  assert.equal(started.enabled, true)
  const run = await started.service.assign({ workflowId: DELIVERY_ID, taskId: 'task-1521', title: 'Ship it' })
  assert.equal(run.ok, true)
  // Each edge carries one output, so a step has to produce it for the next node to start.
  const outputs = { planner: { plan: 'the plan' }, writer: { copy: 'the copy' }, coder: { patch: 'the patch' }, reviewer: { review: 'lgtm' }, tester: { report: 'green' } }
  for (const nodeId of ['planner', 'writer', 'coder', 'reviewer', 'tester']) {
    const state = await started.service.advance({ workflowId: DELIVERY_ID, nodeId, outcome: 'done', outputs: outputs[nodeId] })
    assert.notEqual(state?.ok, false, `${nodeId} advanced: ${state?.error ?? ''}`)
  }
  const byNode = new Map(created.map(spec => [spec.fields.nodeId, spec]))
  assert.deepEqual(byNode.get('coder').tools, ['github'], 'Coder names github')
  assert.deepEqual(byNode.get('reviewer').tools, ['github'], 'Reviewer names github')
  assert.deepEqual(byNode.get('deployer').tools, ['github'], 'Deployer names github')
  assert.deepEqual(byNode.get('tester').tools, [], 'Tester names no connector')
  assert.deepEqual(byNode.get('planner').tools, [], 'Planner names no connector')
  for (const spec of created) assert.equal(spec.permission, 'danger-full-access', 'file and shell rights are a normal Bot\'s')
})

// #1544: a connector a Bot switched off must not be reopened by a Workflow. The run records the Bot
// that started it (createdBy) and every Bot whose switches cap its connectors (cappedBy): the caller
// when a Bot's tool call started the run, and the Bot that saved the graph when the board, the canvas
// or the API did. `core/src/host/connector-access.js` intersects the node's `tools` with them.
test('#1544: the run Bot records the Bot that started the run, and the Bot that saved the graph caps it', async () => {
  const { svc, spawned } = harness()
  svc.define({
    name: 'Launder',
    nodes: [{ id: 'code', name: 'Coder', prompt: 'Code.', tools: ['github'] }],
    edges: [],
    callerBotId: 'bot-planner',
  })
  const started = await svc.runNamed({ workflow: 'Launder', brief: 'Ship the note', callerBotId: 'main' })
  assert.equal(started.ok, true)
  const spec = spawned.at(-1).spec
  assert.equal(spec.createdBy, 'main')
  assert.deepEqual(spec.cappedBy, ['main', 'bot-planner'])
  assert.deepEqual(spec.tools, ['github'])
})

test('#1544: a run with no calling Bot is capped by the Bot that saved the graph', async () => {
  const { svc, spawned } = harness()
  const made = svc.define({
    name: 'Board lane',
    nodes: [{ id: 'code', name: 'Coder', prompt: 'Code.', tools: ['github'] }],
    edges: [],
    callerBotId: 'bot-planner',
  }).workflows.find(item => item.name === 'Board lane')
  // The board (ingest) and the canvas have no calling Bot; the graph's author is the ceiling then.
  const started = await svc.assign({ workflowId: made.id, taskId: '#1544', title: 'From the board' })
  assert.equal(started.ok, true)
  const spec = spawned.at(-1).spec
  assert.equal('createdBy' in spec, false, 'no Bot started this run')
  assert.deepEqual(spec.cappedBy, ['bot-planner'])
  // A save with no Bot behind it is the owner's own edit: it lifts the ceiling again.
  svc.saveGraph({ workflowId: made.id, nodes: made.nodes, edges: made.edges })
  await svc.reset({ workflowId: made.id, runId: started.workflows.find(item => item.id === made.id).run.id })
  await svc.assign({ workflowId: made.id, taskId: '#1544b', title: 'After the owner edit' })
  assert.equal('cappedBy' in spawned.at(-1).spec, false, 'the owner own edit leaves no Bot ceiling')
  // The board's own path: a trigger match auto-starts the run from ingest, with no caller in hand.
  const authored = svc.create({
    name: 'Trigger lane',
    nodes: [{ id: 'code', name: 'Coder', prompt: 'Code.', tools: ['github'] }],
    edges: [],
    triggers: ['wash'],
    callerBotId: 'bot-planner',
  }).workflows.find(item => item.name === 'Trigger lane')
  const ingested = await svc.ingest({ id: '#1544c', title: 'please wash this', status: 'open' })
  assert.equal(ingested.matched, true)
  const boardRun = ingested.workflows.find(item => item.id === authored.id)
  assert.equal(boardRun.run.task.id, '#1544c')
  assert.deepEqual(spawned.at(-1).spec.cappedBy, ['bot-planner'], 'the graph author caps a run the board started')
})

test('#1544: a parked run keeps the caller and the author across the queue', async () => {
  const { svc, spawned } = harness()
  const made = svc.define({
    name: 'Parked',
    nodes: [{ id: 'code', name: 'Coder', prompt: 'Code.', tools: ['github'] }],
    edges: [],
    callerBotId: 'bot-planner',
  }).workflows.find(item => item.name === 'Parked')
  svc.setConcurrency({ workflowId: made.id, maxConcurrent: 1 })
  const first = await svc.assign({ workflowId: made.id, taskId: '#a', title: 'First' })
  const parked = await svc.runNamed({ workflow: 'Parked', brief: 'Second', callerBotId: 'main' })
  assert.equal(parked.workflows.find(item => item.id === made.id).queueDepth, 1)
  const before = spawned.length
  await svc.reset({ workflowId: made.id, runId: first.workflows.find(item => item.id === made.id).run.id })
  const drained = spawned.slice(before).map(entry => entry.spec)
  assert.deepEqual(drained.map(spec => spec.createdBy), ['main'])
  assert.deepEqual(drained.map(spec => spec.cappedBy), [['main', 'bot-planner']])
})

test('#1544: the workflow tools hand the calling Bot on to the run they start', async () => {
  const boot = () => {
    const specs = {}
    const created = []
    async function send() { return { action: 'allow' } }
    send.use = () => () => {}
    send.priority = { ROUTING: 10 }
    const fb = {
      bot: {
        list: () => roster,
        async create(spec) { created.push(spec); return `bot-${created.length}` },
        async remove() { return true },
        send,
      },
      readOnly: () => false,
      api: { handle() { return () => {} } },
      tools: { register(spec) { specs[spec.name] = spec; return () => {} } },
      warn() {},
    }
    const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
    return { started, specs, created }
  }
  const one = boot()
  // The host wraps fb.tools.register's execute and passes the caller as the second argument's botId.
  await one.specs.define_workflow.execute({
    name: 'Caller lane',
    nodes: [{ id: 'code', name: 'Coder', prompt: 'Code.', tools: ['github'] }],
    edges: [],
  }, { botId: 'main' })
  await one.specs.run_workflow.execute({ workflow: 'Caller lane', brief: 'Ship the note' }, { botId: 'bot-planner' })
  const spawnedSpec = one.created.at(-1)
  assert.equal(spawnedSpec.createdBy, 'bot-planner')
  assert.deepEqual(spawnedSpec.cappedBy, ['bot-planner', 'main'])
})

// #1476: Stop and Reset persist the run's end before its Bots are released, so
// a release that fails leaves a live Bot whose only id has already been written
// away. Both paths release first and keep the failed id named, so the next Stop,
// Reset, dispose() or reload can retry it.
function resettable(dir, log) {
  let seq = 0
  return createWorkflowService({
    dir,
    persist: true,
    now: () => 1_700_000_000_000,
    bots: () => roster,
    spawn: async (spec) => `eph-${spec.nodeId}-${++seq}`,
    release: async (id) => {
      log.attempted.push(id)
      if (log.fail.has(id)) {
        log.fail.delete(id)
        throw new Error('bot remove failed')
      }
      log.done.push(id)
    },
    warn: (line) => { log.warned.push(line) },
    dispatch: async (step) => {
      log.dispatched?.push(`${step.nodeId}:${step.botId}`)
      return { ok: true }
    },
  })
}

function twoNodes(svc, name = 'Lane') {
  return svc.define({
    name,
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  }).workflows.find(item => item.name === name)
}

test('a release that fails during Stop keeps the id, and a second Stop retries it (#1476)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-1476-stop-'))
  const log = { attempted: [], done: [], warned: [], fail: new Set(['eph-plan-1']) }
  try {
    const svc = resettable(dir, log)
    const made = twoNodes(svc)
    svc.setConcurrency({ workflowId: made.id, maxConcurrent: 2 })
    await svc.assign({ workflowId: made.id, taskId: '#a', title: 'First' })
    const both = await svc.assign({ workflowId: made.id, taskId: '#b', title: 'Second' })
    const lane = both.workflows.find(item => item.id === made.id)
    const victim = lane.runs.find(run => run.task.id === '#a')
    const survivor = lane.runs.find(run => run.task.id === '#b')
    const victimIds = Object.values(victim.ephemeral)

    const stopped = await svc.reset({ workflowId: made.id, runId: victim.id })
    assert.equal(stopped.ok, true)
    assert.match(log.warned.join('\n'), /could not remove eph-plan-1/)
    // The release failed, so the run is still live and the record still names it.
    const during = readStore(dir)
    assert.equal(JSON.stringify(during).includes('eph-plan-1'), true, 'a failed release erased the only id')
    const kept = (during.lanes[made.id].active ?? []).find(run => run.id === victim.id)
    assert.ok(kept, 'Stop ended the run although its Bot could not be released')
    assert.equal(kept.status, 'running')
    assert.deepEqual(kept.ephemeral, { plan: 'eph-plan-1' })
    // The run is halted on purpose, and the marker says why: resuming it would
    // move the graph to a node whose Bot is already gone (#1476).
    assert.equal(kept.paused, true)
    assert.equal(kept.releasePending, true)
    // The id whose release did go is forgotten, so no retry asks for it again.
    assert.equal(JSON.stringify(during).includes('eph-code-2'), false)
    assert.equal(stopped.workflows.find(item => item.id === made.id).runs.some(run => run.id === victim.id), true)

    // A second Stop retries the one id that is still there and then ends the run.
    const retried = await svc.reset({ workflowId: made.id, runId: victim.id })
    assert.equal(retried.ok, true)
    assert.equal(log.warned.length, 1)
    assert.deepEqual([...new Set(log.done)].sort(), [...victimIds].sort())
    assert.equal(log.attempted.filter(id => id === 'eph-plan-1').length, 2)
    assert.equal(log.attempted.includes('eph-code-2'), true)
    assert.equal(log.attempted.filter(id => id === 'eph-code-2').length, 1)
    const after = readStore(dir)
    assert.deepEqual((after.lanes[made.id].active ?? []).map(run => run.id), [survivor.id])
    assert.equal(after.lanes[made.id].last.id, victim.id)
    assert.equal(after.lanes[made.id].last.status, 'failed')
    assert.equal(after.lanes[made.id].last.ephemeral, undefined)
    assert.equal(after.lanes[made.id].last.paused, undefined)
    assert.equal(after.lanes[made.id].last.releasePending, undefined)
    const text = readFileSync(join(dir, 'workflows.json'), 'utf8')
    for (const id of victimIds) assert.equal(text.includes(id), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed Stop freezes the run as Paused, so nothing more is handed and the queue waits (#1476)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-1476-freeze-'))
  const log = { attempted: [], done: [], warned: [], dispatched: [], fail: new Set(['eph-plan-1']) }
  try {
    const svc = resettable(dir, log)
    const made = twoNodes(svc)
    svc.setConcurrency({ workflowId: made.id, maxConcurrent: 2 })
    await svc.assign({ workflowId: made.id, taskId: '#a', title: 'First' })
    const both = await svc.assign({ workflowId: made.id, taskId: '#b', title: 'Second' })
    const lane = both.workflows.find(item => item.id === made.id)
    const victim = lane.runs.find(run => run.task.id === '#a')
    const survivor = lane.runs.find(run => run.task.id === '#b')
    const handedBefore = [...log.dispatched]

    const stopped = await svc.reset({ workflowId: made.id, runId: victim.id })
    assert.equal(stopped.ok, true)
    const during = readStore(dir)
    const kept = during.lanes[made.id].active.find(run => run.id === victim.id)
    assert.equal(kept.status, 'running')
    assert.equal(kept.paused, true)
    assert.equal(kept.releasePending, true)
    const shown = stopped.workflows.find(item => item.id === made.id).runs.find(run => run.id === victim.id)
    assert.equal(shown.paused, true, 'the UI must show the run as Paused')
    const note = stopped.workflows.find(item => item.id === made.id).messages.at(-1)
    assert.equal(note.tone, 'bad')
    assert.match(note.text, /停止失败：还有 1 个 Bot 没释放，再点一次停止/)

    // The last reply still moves the graph, but the next node has no Bot id and
    // handOff() must send nothing: before the freeze it stayed running forever.
    await svc.stepResult({ botId: 'eph-plan-1', text: 'plan done' })
    assert.deepEqual(log.dispatched, handedBefore)
    assert.equal(log.dispatched.some(line => line.startsWith('code:')), false)

    // The wedged run holds its slot, so a queued task is not drained into it.
    const third = await svc.assign({ workflowId: made.id, taskId: '#c', title: 'Third' })
    assert.deepEqual(readStore(dir).lanes[made.id].queue.map(task => task.id), ['#c'])
    assert.deepEqual(third.workflows.find(item => item.id === made.id).runs.map(run => run.id).sort(), [victim.id, survivor.id].sort())
    assert.deepEqual(log.dispatched, handedBefore)

    // A person's own Pause and Resume on a healthy run are unchanged.
    assert.equal(svc.pause({ workflowId: made.id, runId: survivor.id }).ok, true)
    assert.equal((await svc.resume({ workflowId: made.id, runId: survivor.id })).ok, true)
    assert.equal(readStore(dir).lanes[made.id].active.find(run => run.id === survivor.id).paused, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resume refuses a run whose failed Stop still waits to release a Bot (#1476)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-1476-resume-'))
  const log = { attempted: [], done: [], warned: [], dispatched: [], fail: new Set(['eph-plan-1']) }
  try {
    const svc = resettable(dir, log)
    const made = twoNodes(svc)
    await svc.assign({ workflowId: made.id, taskId: '#a', title: 'Only' })
    const run = svc.state().workflows.find(item => item.id === made.id).run
    await svc.reset({ workflowId: made.id, runId: run.id })
    const before = readStore(dir)
    const frozen = before.lanes[made.id].active.find(item => item.id === run.id)
    assert.equal(frozen.paused, true)
    assert.equal(frozen.releasePending, true)
    const messagesBefore = (before.logs?.[made.id] ?? []).length

    const refused = await svc.resume({ workflowId: made.id, runId: run.id })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /release|stop/i)
    // Nothing moved: not a flag, not a timestamp, not a log line.
    const after = readStore(dir)
    assert.deepEqual(after.lanes[made.id].active.find(item => item.id === run.id), frozen)
    assert.equal((after.logs?.[made.id] ?? []).length, messagesBefore)
    assert.equal(after.logs?.[made.id]?.at(-1)?.text?.includes('已继续') ?? false, false)
    // The name-less form the UI may send is refused the same way.
    assert.equal((await svc.resume({ workflowId: made.id })).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reload reaps a run a failed Stop froze, and the markers go with it (#1476)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-1476-reap-'))
  const log = { attempted: [], done: [], warned: [], dispatched: [], fail: new Set(['eph-plan-1']) }
  try {
    const svc = resettable(dir, log)
    const made = twoNodes(svc)
    await svc.assign({ workflowId: made.id, taskId: '#a', title: 'Only' })
    const run = svc.state().workflows.find(item => item.id === made.id).run
    await svc.reset({ workflowId: made.id, runId: run.id })
    assert.equal(readStore(dir).lanes[made.id].active[0].releasePending, true)

    log.attempted.length = 0
    log.done.length = 0
    const reloaded = createWorkflowService({
      dir,
      persist: true,
      now: () => 1_700_000_001_000,
      bots: () => roster,
      spawn: async (spec) => `eph-${spec.nodeId}-reload`,
      release: async (id) => { log.attempted.push(id); log.done.push(id) },
      warn: (line) => { log.warned.push(line) },
    })
    await reloaded.reap()
    const after = readStore(dir)
    assert.equal((after.lanes[made.id].active ?? []).length, 0)
    assert.equal(after.lanes[made.id].last.status, 'failed')
    assert.equal(after.lanes[made.id].last.ephemeral, undefined)
    assert.equal(after.lanes[made.id].last.paused, undefined)
    assert.equal(after.lanes[made.id].last.releasePending, undefined)
    assert.deepEqual(log.done, ['eph-plan-1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a release that fails during Stop leaves the id for a following dispose() to retry (#1476)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-1476-dispose-'))
  const log = { attempted: [], done: [], warned: [], fail: new Set(['eph-plan-1']) }
  try {
    const svc = resettable(dir, log)
    const made = twoNodes(svc)
    await svc.assign({ workflowId: made.id, taskId: '#a', title: 'Only' })
    const run = svc.state().workflows.find(item => item.id === made.id).run
    const ids = Object.values(run.ephemeral)

    const stopped = await svc.reset({ workflowId: made.id, runId: run.id })
    assert.equal(stopped.ok, true)
    assert.match(log.warned.join('\n'), /could not remove eph-plan-1/)
    const during = readStore(dir)
    assert.equal((during.lanes[made.id].active ?? []).length, 1)
    assert.deepEqual(during.lanes[made.id].active[0].ephemeral, { plan: 'eph-plan-1' })

    // dispose() is the next path that reaches the retained id, and it releases it.
    await svc.dispose()
    assert.deepEqual([...new Set(log.done)].sort(), [...ids].sort())
    assert.equal(log.attempted.filter(id => id === 'eph-plan-1').length, 2)
    const after = readStore(dir)
    assert.equal((after.lanes[made.id].active ?? []).length, 0)
    assert.equal(after.lanes[made.id].last.ephemeral, undefined)
    // The run ended, so the frozen markers are gone with it.
    assert.equal(after.lanes[made.id].last.paused, undefined)
    assert.equal(after.lanes[made.id].last.releasePending, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a release that fails during a whole-workflow Reset keeps that id, and a second Reset retries it (#1476)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-1476-reset-'))
  const log = { attempted: [], done: [], warned: [], fail: new Set(['eph-plan-1']) }
  try {
    const svc = resettable(dir, log)
    const made = twoNodes(svc)
    svc.setConcurrency({ workflowId: made.id, maxConcurrent: 2 })
    await svc.assign({ workflowId: made.id, taskId: '#a', title: 'First' })
    const both = await svc.assign({ workflowId: made.id, taskId: '#b', title: 'Second' })
    const lane = both.workflows.find(item => item.id === made.id)
    const allIds = lane.runs.flatMap(run => Object.values(run.ephemeral))

    const reset = await svc.reset({ workflowId: made.id })
    assert.equal(reset.ok, true)
    assert.match(log.warned.join('\n'), /could not remove eph-plan-1/)
    // Nothing was reset: the lanes are still live, and the failed id still has a name.
    const during = readStore(dir)
    assert.equal((during.lanes[made.id].active ?? []).length, 2)
    assert.equal(JSON.stringify(during).includes('eph-plan-1'), true)
    // Every live run lost the ids that did go, so every one of them is frozen.
    for (const run of during.lanes[made.id].active) {
      assert.equal(run.paused, true)
      assert.equal(run.releasePending, true)
    }
    for (const id of allIds.filter(id => id !== 'eph-plan-1')) {
      assert.equal(JSON.stringify(during).includes(id), false)
    }
    assert.equal((during.lanes[made.id].queue ?? []).length, 0)

    // The next Reset is the retry: the same endpoint releases and then resets.
    const retried = await svc.reset({ workflowId: made.id })
    assert.equal(retried.ok, true)
    assert.deepEqual([...new Set(log.done)].sort(), [...new Set(allIds)].sort())
    const after = readStore(dir)
    assert.equal((after.lanes[made.id].active ?? []).length, 0)
    assert.equal(after.lanes[made.id].last.ephemeral, undefined)
    assert.equal(after.lanes[made.id].last.paused, undefined)
    assert.equal(after.lanes[made.id].last.releasePending, undefined)
    const text = readFileSync(join(dir, 'workflows.json'), 'utf8')
    for (const id of allIds) assert.equal(text.includes(id), false)
    assert.equal(log.warned.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Stop and Reset still forget every id and archive the run when no release fails (#1476)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-1476-ok-'))
  const log = { attempted: [], done: [], warned: [], fail: new Set() }
  try {
    const svc = resettable(dir, log)
    const made = twoNodes(svc)
    svc.setConcurrency({ workflowId: made.id, maxConcurrent: 2 })
    await svc.assign({ workflowId: made.id, taskId: '#a', title: 'First' })
    const both = await svc.assign({ workflowId: made.id, taskId: '#b', title: 'Second' })
    const lane = both.workflows.find(item => item.id === made.id)
    const victim = lane.runs.find(run => run.task.id === '#a')
    const survivor = lane.runs.find(run => run.task.id === '#b')
    const victimIds = Object.values(victim.ephemeral)

    const stopped = await svc.reset({ workflowId: made.id, runId: victim.id })
    assert.equal(stopped.ok, true)
    assert.deepEqual(log.warned, [])
    const afterStop = readStore(dir)
    const archived = afterStop.lanes[made.id].last
    assert.equal(archived.id, victim.id)
    assert.equal(archived.status, 'failed')
    assert.equal(archived.ephemeral, undefined)
    assert.equal('handed' in archived, false)
    assert.deepEqual((afterStop.lanes[made.id].active ?? []).map(run => run.id), [survivor.id])
    const text = readFileSync(join(dir, 'workflows.json'), 'utf8')
    for (const id of victimIds) assert.equal(text.includes(id), false)
    const presented = stopped.workflows.find(item => item.id === made.id)
    assert.equal(presented.history.at(-1).status, 'failed')
    assert.match(presented.messages.at(-1).text, /已停止/)

    // The whole-workflow Reset still blanks the lane and keeps the record clean.
    const reset = await svc.reset({ workflowId: made.id })
    assert.equal(reset.ok, true)
    const afterReset = readStore(dir)
    assert.equal((afterReset.lanes[made.id].active ?? []).length, 0)
    assert.equal((afterReset.lanes[made.id].queue ?? []).length, 0)
    assert.equal(afterReset.lanes[made.id].last.ephemeral, undefined)
    assert.equal(afterReset.lanes[made.id].last.status, 'idle')
    assert.match(reset.workflows.find(item => item.id === made.id).messages.at(-1).text, /重置|reset/i)
    const finalText = readFileSync(join(dir, 'workflows.json'), 'utf8')
    for (const id of Object.values(survivor.ephemeral)) assert.equal(finalText.includes(id), false)
    assert.deepEqual([...new Set(log.done)].sort(), [...new Set([...victimIds, ...Object.values(survivor.ephemeral)])].sort())
    assert.equal(log.warned.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

