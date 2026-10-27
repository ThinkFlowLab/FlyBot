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
  assert.equal(cancelled.workflows.find(item => item.id === retry.id).run.status, 'idle')
  assert.equal(cancelled.workflows.find(item => item.id === retry.id).run.ephemeral, undefined)
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
  assert.equal(created[0].permission, 'workspace-write')
  assert.deepEqual(created[0].tools, [])
  assert.match(created[0].systemPrompt, /Write the plan\./)
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
  handle({ from: run.ephemeral.plan, role: 'request', text: 'not a reply' })
  handle({ from: run.ephemeral.plan, role: 'reply', text: 'Noted a rate limit (429) in the log.\nOUTPUT plan: two lines' })
  const mid = await waitFor(() => {
    const row = started.service.state().workflows.find(item => item.id === made.id)
    return row.run?.nodeStatus?.code === 'running' ? row : null
  })
  assert.equal(mid.run.nodeStatus.plan, 'done')
  handle({ from: run.ephemeral.code, role: 'reply', text: 'could not answer your message' })
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
  handle({ from: second.ephemeral.plan, role: 'reply', text: 'The model call failed.' })
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

    // A run record whose ephemeral map is already gone (the shape the restart
    // leaves when it lost the map) is outside this fix: reap must not rewrite it.
    const idle = svc.define({ name: 'Idle', nodes: [{ id: 'one', name: 'Planner', role: 'plan', prompt: 'Wait.' }], edges: [] })
      .workflows.find(item => item.name === 'Idle')
    const store = readStore(dir)
    const lane = store.lanes[idle.id] ?? { active: [], queue: [], last: null, history: [] }
    lane.active = [...(lane.active ?? []), {
      id: 'run-bare',
      workflowId: idle.id,
      task: null,
      status: 'running',
      nodeStatus: {},
      steps: 0,
      stepBudget: 1,
      failedOnce: {},
      history: [],
      startedAt: 5,
      updatedAt: 6,
    }]
    store.lanes[idle.id] = lane
    const written = JSON.stringify(store)
    writeFileSync(join(dir, 'workflows.json'), written)

    clock += 60_000
    const after = persistent(dir, released, () => clock)
    await after.reap()
    assert.deepEqual(released, [])
    const kept = after.state().workflows.find(item => item.id === quick.id).run
    assert.equal(kept.status, 'done')
    assert.equal(kept.updatedAt, finishedAt)
    const bare = after.state().workflows.find(item => item.id === idle.id).run
    assert.equal(bare.status, 'running')
    assert.equal(bare.updatedAt, 6)
    // Nothing to release means nothing is written: the file it loaded is intact.
    assert.equal(readFileSync(join(dir, 'workflows.json'), 'utf8'), written)
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(released, ['eph-plan'])
    const run = loaded.service.state().workflows.find(item => item.id === made.id).run
    assert.equal(run.status, 'failed')
    assert.equal(run.ephemeral, undefined)
    loaded.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
