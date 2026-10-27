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
    const saved = readStore(dir).runs[made.id]
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
    const settled = readStore(dir).runs[made.id]
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
    const finished = readStore(dir).runs[quick.id]
    assert.equal(finished.status, 'done')
    assert.equal(finished.ephemeral, undefined)
    const finishedAt = finished.updatedAt

    // A run record whose ephemeral map is already gone (the shape the restart
    // leaves when it lost the map) is outside this fix: reap must not rewrite it.
    const idle = svc.define({ name: 'Idle', nodes: [{ id: 'one', name: 'Planner', role: 'plan', prompt: 'Wait.' }], edges: [] })
      .workflows.find(item => item.name === 'Idle')
    const store = readStore(dir)
    store.runs[idle.id] = {
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
    }
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
    assert.equal(readStore(dir).runs[made.id].status, 'running')

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

// #1390: with a spawn hook the assign body awaits before it writes, so two calls
// for one workflow used to read the same previous set, both spawn a full set, and
// the second write replaced the run — the first set, referenced by no run, was
// released by nobody. `spawn` here yields a macrotask, so bodies started together
// interleave the way they do on a host whose spawn is not instant.
function racer(control = {}) {
  const spawned = []
  const released = []
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => roster,
    spawn: async (spec) => {
      const id = `race-${++seq}`
      spawned.push({ id, spec })
      if (control.fail?.(spec)) throw new Error('spawn failed')
      if (control.gate?.[spec.nodeId]) await control.gate[spec.nodeId]
      else await new Promise((resolve) => setImmediate(resolve))
      return id
    },
    release: async (id) => { released.push(id) },
    dispatch: async () => ({ ok: true }),
    warn: () => {},
  })
  return { svc, spawned, released }
}

function racePair(svc, name) {
  return svc.define({
    name,
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  }).workflows.find(item => item.name === name)
}

test('two assigns started together leave one set of run Bots and release the other (#1390)', async () => {
  const { svc, spawned, released } = racer()
  const made = racePair(svc, 'Race')
  const first = svc.assign({ workflowId: made.id, taskId: 'T1', title: 'First task' })
  const second = svc.assign({ workflowId: made.id, taskId: 'T2', title: 'Second task' })
  const [one, two] = await Promise.all([first, second])
  assert.equal(one.ok, true)
  assert.equal(two.ok, true)

  const run = svc.state().workflows.find(item => item.id === made.id).run
  assert.equal(run.task.id, 'T2')
  const survivors = new Set(Object.values(run.ephemeral))
  assert.equal(survivors.size, 2)
  assert.deepEqual(Object.keys(run.ephemeral).sort(), ['code', 'plan'])
  // Every Bot either serves the surviving run or was released, and none twice.
  const expected = spawned.map(entry => entry.id).filter(id => !survivors.has(id))
  assert.deepEqual([...released].sort(), [...expected].sort())
  assert.equal(new Set(released).size, released.length)
  // The replaced task is recorded once, in the shape the history already uses.
  const replaced = run.history.filter(entry => entry.task?.id === 'T1')
  assert.equal(replaced.length, 1)
  assert.equal(replaced[0].status, 'running')
})

test('a demo restart racing an assign leaves no orphaned set either (#1390)', async () => {
  const { svc, spawned, released } = racer()
  const made = racePair(svc, 'Demo')
  await svc.assign({ workflowId: made.id, taskId: 'T1', title: 'First task' })
  await svc.demoStep({ workflowId: made.id })
  const finished = await svc.demoStep({ workflowId: made.id })
  const done = finished.workflows.find(item => item.id === made.id).run
  assert.equal(done.status, 'done')
  assert.equal(done.ephemeral, undefined)

  const restart = svc.demoStep({ workflowId: made.id })
  const assigned = svc.assign({ workflowId: made.id, taskId: 'T2', title: 'Second task' })
  const [re, as] = await Promise.all([restart, assigned])
  assert.equal(re.ok, true)
  assert.equal(as.ok, true)

  const run = svc.state().workflows.find(item => item.id === made.id).run
  assert.equal(run.task.id, 'T2')
  const survivors = new Set(Object.values(run.ephemeral))
  const expected = spawned.map(entry => entry.id).filter(id => !survivors.has(id))
  assert.deepEqual([...released].sort(), [...expected].sort())
  assert.equal(new Set(released).size, released.length)
})

test('a slow spawn on one workflow does not hold up an assign on another (#1390)', async () => {
  let openSlow
  const slowGate = new Promise((resolve) => { openSlow = resolve })
  const { svc } = racer({ gate: { slow: slowGate } })
  const slow = svc.define({ name: 'Slow', nodes: [{ id: 'slow', name: 'Coder', role: 'code', prompt: 'Take your time.' }], edges: [] })
    .workflows.find(item => item.name === 'Slow')
  const quick = svc.define({ name: 'Quick', nodes: [{ id: 'quick', name: 'Planner', role: 'plan', prompt: 'Just start.' }], edges: [] })
    .workflows.find(item => item.name === 'Quick')

  const waiting = svc.assign({ workflowId: slow.id, taskId: 'S1', title: 'Slow task' })
  const started = svc.assign({ workflowId: quick.id, taskId: 'Q1', title: 'Quick task' })
  let timer
  const stuck = new Promise((resolve) => { timer = setTimeout(() => resolve('stuck'), 2000) })
  const outcome = await Promise.race([started.then(() => 'started'), stuck])
  clearTimeout(timer)
  openSlow()
  assert.equal(outcome, 'started')
  const [slowDone, quickDone] = await Promise.all([waiting, started])
  assert.equal(slowDone.ok, true)
  assert.equal(quickDone.ok, true)
  assert.equal(svc.state().workflows.find(item => item.id === quick.id).run.task.id, 'Q1')
})

test('a spawn that throws halfway releases what it made and leaves the workflow usable (#1390)', async () => {
  let failOn = 'code'
  const { svc, spawned, released } = racer({ fail: (spec) => spec.nodeId === failOn })
  const made = racePair(svc, 'Broken')
  const failed = await svc.assign({ workflowId: made.id, taskId: 'T1', title: 'Broken task' })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /spawn failed/)
  assert.deepEqual(released, [spawned[0].id])
  assert.equal(svc.state().workflows.find(item => item.id === made.id).run, null)

  failOn = ''
  const again = await svc.assign({ workflowId: made.id, taskId: 'T2', title: 'Second try' })
  assert.equal(again.ok, true)
  const run = again.workflows.find(item => item.id === made.id).run
  assert.equal(run.task.id, 'T2')
  assert.equal(Object.keys(run.ephemeral).length, 2)
})
