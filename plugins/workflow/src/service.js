// Workflow records and the runs a board task starts. The graph rules live in
// graph.js. A workflow keeps a FIFO queue and up to maxConcurrent live runs
// (default 2). A live node stays running until its Bot replies. The demo
// player is a separate script and does not move a live run.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseAll, spawnAll } from './ephemeral.js'
import {
  chainLabel, cleanLine, cleanPorts, cleanPrompt, cleanTools, completeNode, doneCount, failNode, freshStatus, layerMarks,
  missingProviders, nextDemoOp, nodeById, normalizeGraph, orderedIds, readStepResult, resolveInputs, retryNode,
  rowPreview, startFrontier, unmetRequired, validateGraph,
} from './graph.js'
import { matchTask } from './match.js'
import { linesFor } from './narrate.js'
import { DELIVERY_ID, DELIVERY_STEPS, WEEKLY_ID, deliveryWorkflow, fixtureTask, templateById, templateCatalog, weeklyWorkflow } from './template.js'

const MAX_WORKFLOWS = 24
const MAX_MESSAGES = 200
const FILE = 'workflows.json'
const DEFAULT_CONCURRENT = 2
const MAX_CONCURRENT = 8
const HOST_CAP = 6

function idOf(prefix) {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}

function publicNode(node, bots) {
  const local = (bots ?? []).filter(bot => bot && bot.remote !== true && bot.id && bot.name)
  const seated = node.botId
    ? local.find(bot => bot.id === node.botId)
    : local.find(bot => bot.name === node.name)
  return {
    id: node.id,
    name: node.name,
    role: node.role ?? '',
    instructions: node.instructions ?? '',
    prompt: node.prompt ?? '',
    model: node.model ?? '',
    tools: Array.isArray(node.tools) ? [...node.tools] : [],
    failOnce: node.failOnce === true,
    botId: seated?.id ?? null,
    ...(Array.isArray(node.inputs) && node.inputs.length ? { inputs: node.inputs.map(port => ({ ...port })) } : {}),
    ...(Array.isArray(node.outputs) && node.outputs.length ? { outputs: node.outputs.map(port => ({ ...port })) } : {}),
    x: node.x,
    y: node.y,
  }
}

function publicEdge(edge) {
  const out = { from: edge.from, to: edge.to }
  if (edge.loop === true) {
    out.loop = true
    out.max = edge.max
    if (edge.until) out.until = { output: edge.until.output, eq: edge.until.eq }
  } else if (edge.when?.else === true) out.when = { else: true }
  else if (edge.when) out.when = { output: edge.when.output, eq: edge.when.eq }
  return out
}

function publicRun(workflow, run) {
  if (!run) return null
  return {
    id: run.id,
    workflowId: run.workflowId,
    task: run.task,
    status: run.status,
    nodeStatus: { ...run.nodeStatus },
    steps: run.steps,
    stepBudget: run.stepBudget,
    doneCount: doneCount(run.nodeStatus),
    nodeCount: workflow.nodes.length,
    marks: layerMarks(workflow, run.nodeStatus),
    running: orderedIds(workflow, run.nodeStatus, 'running'),
    history: run.history ?? [],
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.live === true ? { live: true } : {}),
    ...(run.ephemeral && Object.keys(run.ephemeral).length > 0 ? { ephemeral: { ...run.ephemeral } } : {}),
  }
}

function blankRun(workflow, task, now, history = []) {
  return {
    id: idOf('run'),
    workflowId: workflow.id,
    task,
    status: 'idle',
    nodeStatus: freshStatus(workflow),
    steps: 0,
    stepBudget: workflow.id === DELIVERY_ID ? DELIVERY_STEPS : workflow.nodes.length + 1,
    failedOnce: {},
    produced: {},
    history,
    startedAt: now,
    updatedAt: now,
  }
}

export function createWorkflowService({ dir, persist = true, now = () => Date.now(), bots = () => [], readOnly = () => false, warn = () => {}, spawn, release, dispatch } = {}) {
  const file = dir ? join(dir, FILE) : null
  let state = load(file, warn) ?? seed(now())
  state.routes ??= {}
  state.claims ??= {}
  state.lanes ??= {}
  state.demos ??= {}
  if (!state.laneFormat) migrateRuns(state)
  let seq = state.seq ?? 1
  // One lock for every start and release. The host cap is read and updated
  // only while this is held, so two workflows cannot both pass it.
  let hostTail = Promise.resolve()
  function hostSerial(fn) {
    const run = hostTail.then(() => fn())
    hostTail = run.then(() => {}, () => {})
    return run
  }

  function write() {
    if (!persist || !file) return
    state.seq = seq
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  }

  function workflow(id) {
    return state.workflows.find(item => item.id === id)
  }

  function readyWorkflow(item) {
    if (Array.isArray(item.edges) && Array.isArray(item.layers) && item.nodes.every(node => Number.isFinite(node.x))) return item
    const next = normalizeGraph(item)
    item.nodes = next.nodes
    item.edges = next.edges
    item.layers = next.layers
    return item
  }

  function findWorkflow(name) {
    const wanted = cleanLine(name, 80).toLowerCase()
    if (!wanted) return undefined
    return state.workflows.find(item => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted)
  }

  function push(workflowId, lines, at) {
    const log = state.logs[workflowId] ?? []
    for (const line of lines) {
      seq += 1
      log.push({ id: `m${seq}`, at, ...line })
    }
    state.logs[workflowId] = log.slice(-MAX_MESSAGES)
  }

  function present() {
    const roster = bots() ?? []
    return {
      ok: true,
      version: 1,
      templates: templateCatalog(),
      workflows: state.workflows.map(raw => {
        const item = readyWorkflow(raw)
        return ({
        id: item.id,
        name: item.name,
        description: item.description ?? '',
        trigger: item.trigger ?? 'manual',
        scheduleLabel: item.scheduleLabel ?? '',
        nodes: item.nodes.map(node => publicNode(node, roster)),
        edges: (item.edges ?? []).map(publicEdge),
        layers: item.layers.map(layer => [...layer]),
        triggers: [...(item.triggers ?? [])],
        chain: chainLabel(item),
        maxConcurrent: maxOf(item),
        activeCount: runningOf(laneOf(item.id)).length,
        queueDepth: (laneOf(item.id).queue ?? []).length,
        queue: (laneOf(item.id).queue ?? []).map(task => ({ id: task.id, title: task.title })),
        history: [...(laneOf(item.id).history ?? [])],
        runs: runningOf(laneOf(item.id)).map(run => publicRun(item, run)),
        preview: rowPreview(item, primaryRun(item.id)),
        run: publicRun(item, primaryRun(item.id)),
        messages: state.logs[item.id] ?? [],
      }) }),
    }
  }

  function laneOf(id) {
    state.lanes[id] ??= { active: [], queue: [], last: null, history: [] }
    const lane = state.lanes[id]
    lane.active ??= []
    lane.queue ??= []
    lane.history ??= []
    return lane
  }

  function runningOf(lane) {
    return (lane?.active ?? []).filter(run => run && run.status === 'running')
  }

  function globalRunning() {
    let count = 0
    for (const lane of Object.values(state.lanes)) count += runningOf(lane).length
    return count
  }

  function maxOf(item) {
    const value = Number(item?.maxConcurrent)
    if (!Number.isInteger(value) || value < 1) return DEFAULT_CONCURRENT
    return Math.min(MAX_CONCURRENT, value)
  }

  function primaryRun(id) {
    const live = runningOf(laneOf(id))
    if (live.length > 0) return live[0]
    // A finished lane.last stays up until Replay. demoStep marks the script
    // as the run on stage; otherwise the graph stays on that finished lane
    // while the canned lines append to the demo.
    const demo = state.demos[id]
    if (state.demoOnTop?.[id] === true && demo) return demo
    if (laneOf(id).last) return laneOf(id).last
    return demo ?? null
  }

  function storeRun(workflowId, run) {
    const lane = laneOf(workflowId)
    const index = lane.active.findIndex(item => item.id === run.id)
    if (index >= 0) lane.active[index] = run
    else if (state.demos[workflowId]?.id === run.id) state.demos[workflowId] = run
  }

  function sentOk(result) {
    if (result == null) return true
    if (result.ok === false) return false
    if (result.action === 'deny' || result.action === 'hold') return false
    return true
  }

  function findEphemeral(botId) {
    if (!botId) return null
    for (const [workflowId, lane] of Object.entries(state.lanes)) {
      for (const run of lane.active ?? []) {
        const nodeId = Object.entries(run.ephemeral ?? {}).find(([, id]) => id === botId)?.[0]
        if (!nodeId) continue
        const item = workflow(workflowId)
        if (item) return { item, run, nodeId }
      }
    }
    return null
  }

  function refuse(error) {
    return { ok: false, error: error?.message ?? String(error) }
  }

  function gateStarted(item, run, result) {
    // A run with Bots waits for each node's outputs. A host that cannot spawn
    // still walks the graph when advance() is called directly.
    if (run.live !== true || !run.ephemeral) return { result, blocked: [] }
    const status = { ...result.status }
    const started = []
    const blocked = []
    for (const id of result.started ?? []) {
      const missing = unmetRequired(item, id, run.produced, run.task)
      if (missing.length === 0) { started.push(id); continue }
      const preds = item.edges.filter(edge => edge.to === id && edge.loop !== true).map(edge => edge.from)
      const stuck = preds.length === 0 || preds.every(pred => status[pred] === 'done' || status[pred] === 'failed' || status[pred] === 'skipped')
      if (stuck) {
        status[id] = 'failed'
        blocked.push({ id, missing })
      } else status[id] = 'queued'
    }
    const finished = item.nodes.every(node => status[node.id] === 'done' || status[node.id] === 'skipped')
    return { result: { ...result, status, started, finished }, blocked }
  }

  function applyOp(item, run, op) {
    let working = run
    if (op.type === 'complete' && op.outputs && typeof op.outputs === 'object') {
      working = { ...run, produced: { ...(run.produced ?? {}), [op.nodeId]: op.outputs } }
    }
    let result
    if (op.type === 'start') result = { ...startFrontier(item, working.nodeStatus, working.fired), joined: false, layerSize: 0 }
    else if (op.type === 'complete') result = completeNode(item, working.nodeStatus, op.nodeId, {
      outputs: working.produced?.[op.nodeId] ?? {},
      loops: working.loops ?? {},
      fired: working.fired ?? {},
    })
    else if (op.type === 'fail') result = failNode(item, working.nodeStatus, op.nodeId)
    else if (op.type === 'retry') result = retryNode(item, working.nodeStatus, op.nodeId)
    else throw new Error(`Unknown step ${op.type}`)
    const gated = gateStarted(item, working, result)
    result = gated.result
    const failedOnce = { ...working.failedOnce }
    if (op.type === 'fail') failedOnce[op.nodeId] = true
    const blocked = gated.blocked.length > 0
    const finished = result.finished === true && !blocked
    // A node marked failOnce is retried. Any other failure stops the run,
    // which is what releases its ephemeral Bots. A missing required input
    // stops the run the same way: the successor can never start.
    const failOnce = op.type === 'fail' && nodeById(item, op.nodeId)?.failOnce === true
    const stopped = blocked || (op.type === 'fail' && !failOnce)
    const steps = finished ? working.stepBudget : working.steps + 1
    const handed = { ...working.handed }
    if (op.type === 'fail' || op.type === 'retry') delete handed[op.nodeId]
    if (Array.isArray(result.reset)) for (const id of result.reset) delete handed[id]
    const next = {
      ...working,
      status: finished ? 'done' : stopped ? 'failed' : 'running',
      nodeStatus: result.status,
      steps,
      failedOnce,
      updatedAt: now(),
      ...(result.loops ? { loops: result.loops } : {}),
      ...(result.fired ? { fired: result.fired } : {}),
      ...(Object.keys(handed).length > 0 ? { handed } : {}),
    }
    if (Object.keys(handed).length === 0) delete next.handed
    const lines = linesFor(item, working.task, {
      type: op.type,
      nodeId: op.nodeId,
      started: result.started ?? [],
      joined: result.joined === true,
      finished,
      layerSize: result.layerSize ?? 0,
      live: working.live === true,
      text: op.text ?? '',
    })
    for (const hole of gated.blocked) {
      const node = nodeById(item, hole.id)
      lines.push({ kind: 'system', tone: 'bad', text: `${node?.name ?? hole.id} 不能开始：缺少输入 ${hole.missing.join(', ')}。` })
    }
    return { run: next, lines }
  }

  function stepBody(item, run, node) {
    const inputs = resolveInputs(item, node.id, run.produced, run.task)
    return {
      botId: run.ephemeral[node.id],
      nodeId: node.id,
      name: node.name,
      role: node.role ?? '',
      prompt: node.prompt ?? node.instructions ?? '',
      model: node.model ?? '',
      tools: node.tools ?? [],
      brief: run.task?.title ?? '',
      taskId: run.task?.id ?? '',
      inputs,
      outputs: node.outputs ?? [],
    }
  }

  // A dispatch that does not land is not "handed". Say so in the chat and
  // leave the node open: the next hand-off tries again. No second send in
  // this call — a 429 must not be hammered.
  async function handOff(item, run) {
    if (typeof dispatch !== 'function' || !run?.ephemeral) return run
    let current = run
    const running = orderedIds(item, current.nodeStatus, 'running')
    for (const nodeId of running) {
      if (current.handed?.[nodeId]) continue
      if (current.status === 'failed' || current.status === 'done') break
      const node = nodeById(item, nodeId)
      const botId = current.ephemeral?.[nodeId]
      if (!botId || !node) continue
      const body = stepBody(item, current, node)
      let result
      try {
        result = await dispatch(body)
      } catch (error) {
        result = { ok: false, code: 'dispatch-failed', error: error?.message ?? String(error) }
      }
      if (!sentOk(result)) {
        const code = result?.code || result?.action || 'dispatch-failed'
        warn(`flybot-workflow: step ${nodeId} was not handed over: ${code}`)
        push(item.id, [{ kind: 'system', tone: 'bad', text: `${node.name} 没有接到这一步（${code}）。` }], now())
        continue
      }
      current = { ...current, handed: { ...current.handed, [nodeId]: true }, inputs: { ...(current.inputs ?? {}), [nodeId]: body.inputs } }
      storeRun(item.id, current)
    }
    write()
    return current
  }

  async function releaseRun(workflowId, run) {
    const ids = Object.values(run.ephemeral ?? {})
    delete run.ephemeral
    delete run.handed
    const lane = laneOf(workflowId)
    lane.active = lane.active.filter(item => item.id !== run.id)
    lane.last = run
    if (run.status === 'done' || run.status === 'failed') {
      lane.history = [...lane.history, { task: run.task, status: run.status, at: run.updatedAt }].slice(-20)
    }
    await releaseAll(ids, release, warn)
    write()
  }

  // The oldest queued task whose own workflow still has a slot, or null.
  function takeNext() {
    let best = null
    for (const item of state.workflows) {
      const lane = laneOf(item.id)
      if (lane.queue.length === 0) continue
      if (runningOf(lane).length >= maxOf(item)) continue
      const task = lane.queue[0]
      const at = Number(task.enqueuedAt) || 0
      const order = Number(task.queueSeq) || 0
      if (!best || at < best.at || (at === best.at && order < best.order)) best = { item, at, order }
    }
    if (!best) return null
    const task = laneOf(best.item.id).queue.shift()
    return { item: best.item, task: { id: task.id, title: task.title } }
  }

  function noteUnstarted(item, error) {
    push(item.id, [{ kind: 'system', tone: 'bad', text: error ?? 'The queued task could not start' }], now())
    write()
  }

  // After a slot frees, start the oldest parked task on any workflow that
  // still has room, and stop at the host cap.
  function drainSync() {
    let guard = 0
    while (globalRunning() < HOST_CAP && guard < 48) {
      guard += 1
      const next = takeNext()
      if (!next) return
      const begun = beginRun(next.item, next.task)
      if (begun.ok === false) {
        noteUnstarted(next.item, begun.error)
        return
      }
    }
  }

  async function drainAll() {
    if (typeof spawn !== 'function') {
      drainSync()
      return
    }
    let guard = 0
    while (globalRunning() < HOST_CAP && guard < 48) {
      guard += 1
      const next = takeNext()
      if (!next) return
      const started = await startLive(next.item, next.task)
      if (started?.ok === false) {
        noteUnstarted(next.item, started.error)
        return
      }
    }
  }

  function rememberClaim(taskId, decision) {
    state.claims[taskId] = decision
    state.routes[taskId] = { key: `${decision.kind}:${decision.id}`, kind: decision.kind, id: decision.id, at: now() }
  }

  function routeBot(body) {
    const botId = cleanLine(body.botId, 80)
    const bot = (bots() ?? []).find(item => item && item.id === botId && item.remote !== true)
    if (!bot) return { ok: false, error: 'No such Bot' }
    const taskId = cleanLine(body.taskId ?? body.id, 80)
    const title = cleanLine(body.title, 300)
    if (!taskId || !title) return { ok: false, error: 'A task needs an id and a title' }
    rememberClaim(taskId, { kind: 'bot', id: bot.id })
    write()
    return { ok: true, matched: true, decision: { kind: 'bot', id: bot.id }, ownerBotId: bot.id }
  }

  function queuedOrRunning(workflowId, taskId) {
    const lane = laneOf(workflowId)
    return runningOf(lane).some(run => run.task?.id === taskId) || lane.queue.some(task => task.id === taskId)
  }

  function beginRun(item, task, ephemeral) {
    const holes = missingProviders(item)
    if (holes.length > 0) return { ok: false, error: `Node ${holes[0].nodeId} input ${holes[0].name} has no upstream provider` }
    delete state.demoOnTop?.[item.id]
    let run = { ...blankRun(item, task, now(), []), live: true }
    if (ephemeral) run.ephemeral = ephemeral
    const at = now()
    push(item.id, [
      { kind: 'time', text: '刚刚' },
      { kind: 'system', text: `来自 Tasks 看板：${task.id} ${task.title} → 分配给 Workflow「${item.name}」` },
    ], at)
    const stepped = applyOp(item, run, { type: 'start' })
    run = stepped.run
    laneOf(item.id).active.push(run)
    push(item.id, stepped.lines, at)
    write()
    return { ok: true, run }
  }

  async function startLive(item, task) {
    let ephemeral
    if (typeof spawn === 'function') {
      const holes = missingProviders(item)
      if (holes.length > 0) return { ok: false, error: `Node ${holes[0].nodeId} input ${holes[0].name} has no upstream provider` }
      try {
        ephemeral = await spawnAll(item.nodes, bots() ?? [], spawn)
      } catch (error) {
        await releaseAll(error.spawned ?? [], release, warn)
        return refuse(error)
      }
    }
    const begun = beginRun(item, task, ephemeral)
    if (begun.ok === false) {
      if (ephemeral) await releaseAll(Object.values(ephemeral), release, warn)
      return begun
    }
    let run = begun.run
    if (typeof spawn === 'function') {
      try {
        run = await handOff(item, run)
      } catch (error) {
        await releaseRun(item.id, { ...run, status: 'failed', updatedAt: now() })
        return refuse(error)
      }
    }
    if (run.status === 'done' || run.status === 'failed') await releaseRun(item.id, run)
    return present()
  }

  function park(item, task) {
    const lane = laneOf(item.id)
    state.queueSeq = (state.queueSeq ?? 0) + 1
    lane.queue.push({ id: task.id, title: task.title, enqueuedAt: now(), queueSeq: state.queueSeq })
    push(item.id, [{ kind: 'system', text: `排队：${task.id} ${task.title}（前面 ${lane.queue.length - 1} 个，同时运行上限 ${maxOf(item)}）` }], now())
    write()
  }

  function hasRoom(item) {
    return runningOf(laneOf(item.id)).length < maxOf(item) && globalRunning() < HOST_CAP
  }

  // A non-empty queue is joined at the tail, then the oldest task starts.
  // A newer assign never runs ahead of one already parked.
  function enqueue(item, task) {
    if (queuedOrRunning(item.id, task.id)) return { ...present(), already: true }
    const lane = laneOf(item.id)
    const behind = lane.queue.length > 0
    if (behind || !hasRoom(item)) {
      park(item, task)
      if (typeof spawn !== 'function') {
        drainSync()
        return present()
      }
      return drainAll().then(() => present())
    }
    if (typeof spawn !== 'function') {
      const begun = beginRun(item, task)
      if (begun.ok === false) return begun
      drainSync()
      return present()
    }
    return startLive(item, task).then(async (started) => {
      if (started?.ok === false) return started
      await drainAll()
      return present()
    })
  }

  function runFor(workflowId, runId, nodeId) {
    const lane = laneOf(workflowId)
    if (runId) return lane.active.find(run => run.id === runId) ?? null
    const live = lane.active.find(run => run.status === 'running' && (!nodeId || run.nodeStatus?.[nodeId] === 'running'))
    if (live) return live
    return state.demos[workflowId] ?? null
  }

  function commitAdvance(workflowId, op) {
    const item = workflow(workflowId)
    if (!item) return { ok: false, error: 'No such workflow' }
    const run = runFor(workflowId, op.runId, op.nodeId)
    if (!run || run.status === 'idle') return { ok: false, error: 'This workflow has no running task' }
    if (run.status === 'done' || run.status === 'failed') return { ok: false, error: 'This run is already finished' }
    try {
      let stepped = applyOp(item, run, op)
      if (op.type === 'fail' && nodeById(item, op.nodeId)?.failOnce === true && stepped.run.status === 'running') {
        const again = applyOp(item, stepped.run, { type: 'retry', nodeId: op.nodeId })
        stepped = { run: again.run, lines: [...stepped.lines, ...again.lines] }
      }
      storeRun(workflowId, stepped.run)
      push(workflowId, stepped.lines, now())
      write()
      return { ok: true, runId: stepped.run.id }
    } catch (error) {
      return refuse(error)
    }
  }

  async function afterStep(workflowId, runId) {
    const item = workflow(workflowId)
    const lane = laneOf(workflowId)
    const run = lane.active.find(itemRun => itemRun.id === runId)
    if (item && run && run.status === 'running' && typeof spawn === 'function') await handOff(item, run)
    const latest = lane.active.find(itemRun => itemRun.id === runId)
    if (latest && (latest.status === 'done' || latest.status === 'failed')) {
      await releaseRun(workflowId, latest)
      await drainAll()
    }
    return present()
  }

  function mutate(workflowId, fn) {
    if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
    const item = workflow(workflowId)
    if (!item) return { ok: false, error: 'No such workflow' }
    try {
      fn(item)
      write()
      return present()
    } catch (error) {
      return refuse(error)
    }
  }

  return {
    state() { return present() },
    rename(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const workflowId = String(body.workflowId ?? '')
      const item = workflow(workflowId)
      if (!item) return { ok: false, error: 'No such workflow' }
      const template = templateById(item.id)
      if (template) return { ok: false, error: 'Cannot rename a factory preset' }
      const name = cleanLine(body.name, 80)
      if (!name) return { ok: false, error: 'A workflow needs a name' }
      item.name = name
      if (body.description !== undefined) {
        item.description = cleanLine(body.description, 400)
      }
      write()
      return present()
    },
    delete(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const workflowId = String(body.workflowId ?? '')
      const item = workflow(workflowId)
      if (!item) return { ok: false, error: 'No such workflow' }
      const template = templateById(item.id)
      if (template) return { ok: false, error: 'Cannot delete a factory preset' }
      const run = state.runs[workflowId]
      const releasing = run ? Object.values(run.ephemeral ?? {}) : []
      const finish = () => {
        state.workflows = state.workflows.filter(workflow => workflow.id !== workflowId)
        delete state.runs[workflowId]
        delete state.logs[workflowId]
        Object.keys(state.routes).forEach(taskId => {
          if (state.routes[taskId]?.id === workflowId) delete state.routes[taskId]
        })
        write()
        return present()
      }
      if (typeof release !== 'function' || releasing.length === 0) return finish()
      return (async () => {
        await releaseAll(releasing, release, warn)
        return finish()
      })()
    },
    create(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      try {
        if (body.template) {
          const template = templateById(body.template)
          if (!template) throw new Error('No such template')
          const base = cleanLine(body.name || template.name, 80)
          const name = state.workflows.some(item => item.name === base) ? cleanLine(`${base} 副本`, 80) : base
          body = {
            ...body,
            name,
            description: body.description || template.description,
            trigger: body.trigger || template.trigger,
            scheduleLabel: body.scheduleLabel || template.scheduleLabel,
            nodes: template.nodes,
            layers: template.layers,
            triggers: template.triggers,
          }
        }
        if (state.workflows.length >= MAX_WORKFLOWS) throw new Error('Too many workflows')
        const nodes = seat(body.nodes, bots() ?? [])
        const seenBots = new Set()
        for (const node of nodes) {
          if (!node.botId) continue
          if (seenBots.has(node.botId)) throw new Error('That Bot is already in this workflow')
          seenBots.add(node.botId)
        }
        const item = validateGraph({
          id: idOf('wf'),
          name: cleanLine(body.name, 80),
          description: cleanLine(body.description, 400),
          trigger: body.trigger === 'schedule' ? 'schedule' : 'manual',
          ...(body.trigger === 'schedule' || body.scheduleLabel ? { scheduleLabel: cleanLine(body.scheduleLabel, 40) } : {}),
          ...(Array.isArray(body.triggers) ? { triggers: body.triggers.map(word => cleanLine(word, 40)).filter(Boolean).slice(0, 8) } : {}),
          nodes,
          ...(Array.isArray(body.edges) ? { edges: body.edges } : { layers: body.layers }),
        })
        if (!item.name) throw new Error('A workflow needs a name')
        const cap = Number(body.maxConcurrent)
        if (Number.isInteger(cap) && cap >= 1 && cap <= MAX_CONCURRENT) item.maxConcurrent = cap
        state.workflows.push(item)
        const memberNames = item.nodes.map(node => node.name).join('、')
        push(item.id, [{ kind: 'system', text: `Workflow「${item.name}」已创建 · 成员 ${memberNames}` }], now())
        write()
        return present()
      } catch (error) {
        return refuse(error)
      }
    },
    // A board task joins the workflow's FIFO queue. A free slot starts it.
    // A live run is never replaced. `botId` routes the card to that Bot and
    // does not start a run.
    assign(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      if (body.botId) return routeBot(body)
      const workflowId = String(body.workflowId ?? '')
      const item = workflow(workflowId)
      if (!item) return { ok: false, error: 'No such workflow' }
      const task = { id: cleanLine(body.taskId ?? body.id, 80), title: cleanLine(body.title, 300) }
      if (!task.id || !task.title) return { ok: false, error: 'A task needs an id and a title' }
      if (typeof spawn !== 'function') return enqueue(item, task)
      return hostSerial(() => enqueue(item, task))
    },
    setConcurrency(body = {}) {
      const workflowId = String(body.workflowId ?? '')
      const value = Number(body.maxConcurrent)
      const saved = mutate(workflowId, (item) => {
        if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENT) throw new Error('maxConcurrent is an integer from 1 to 8')
        item.maxConcurrent = value
      })
      if (saved.ok === false) return saved
      if (typeof spawn !== 'function') {
        drainSync()
        return present()
      }
      return hostSerial(async () => {
        await drainAll()
        return present()
      })
    },
    advance(body = {}) {
      const workflowId = String(body.workflowId ?? '')
      const outcome = body.outcome === 'failed' ? 'fail' : 'complete'
      const nodeId = String(body.nodeId ?? '')
      const step = () => commitAdvance(workflowId, { type: outcome, nodeId, text: body.text, outputs: body.outputs, runId: body.runId })
      if (typeof spawn !== 'function') {
        const saved = step()
        if (saved?.ok === false) return saved
        const lane = laneOf(workflowId)
        const run = lane.active.find(item => item.id === saved.runId)
        if (run && (run.status === 'done' || run.status === 'failed')) {
          lane.active = lane.active.filter(item => item.id !== run.id)
          lane.last = run
          lane.history = [...lane.history, { task: run.task, status: run.status, at: run.updatedAt }].slice(-20)
          drainSync()
          write()
        }
        return present()
      }
      return hostSerial(async () => {
        const saved = step()
        if (saved?.ok === false) return saved
        return afterStep(workflowId, saved.runId)
      })
    },
    // The Bot's reply is the step result. A node that is no longer running
    // has already moved; a second report does not move it again.
    stepResult(body = {}) {
      const found = findEphemeral(String(body.botId ?? ''))
      if (!found) return present()
      if (found.run.nodeStatus?.[found.nodeId] !== 'running') return present()
      const node = nodeById(found.item, found.nodeId)
      const parsed = readStepResult(body.text ?? '', node)
      const text = parsed.text || cleanLine(body.text, 2000)
      return this.advance({
        workflowId: found.item.id,
        runId: found.run.id,
        nodeId: found.nodeId,
        outcome: body.ok === false ? 'failed' : 'done',
        text,
        outputs: parsed.outputs,
      })
    },
    ownsBot(botId) {
      return findEphemeral(botId) !== null
    },
    // Replay the scripted demo. It never moves a live run.
    demoStep(body = {}) {
      const workflowId = String(body.workflowId ?? '')
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const item = workflow(workflowId)
      if (!item) return { ok: false, error: 'No such workflow' }
      if (runningOf(laneOf(workflowId)).length > 0) return { ok: false, error: 'A live run is in progress' }
      try {
        let run = state.demos[item.id]
        if (!run) throw new Error('This workflow has no task')
        state.demoOnTop ??= {}
        state.demoOnTop[item.id] = true
        if (run.status === 'failed') throw new Error('This run is already finished')
        const op = nextDemoOp(item, run.nodeStatus, { failedOnce: run.failedOnce })
        if (op.type === 'restart') {
          run = blankRun(item, run.task, now(), run.history)
          push(item.id, [{ kind: 'time', text: '重新演示' }], now())
        }
        const stepped = applyOp(item, run, op.type === 'restart' ? { type: 'start' } : op)
        state.demos[item.id] = stepped.run
        push(item.id, stepped.lines, now())
        write()
        return present()
      } catch (error) {
        return refuse(error)
      }
    },
    reset(body = {}) {
      const workflowId = String(body.workflowId ?? '')
      const take = () => {
        const item = workflow(workflowId)
        if (!item) return { ok: false, error: 'No such workflow' }
        const lane = laneOf(workflowId)
        const ids = lane.active.flatMap(run => Object.values(run.ephemeral ?? {}))
        const live = lane.active[0] ?? lane.last
        lane.active = []
        lane.queue = []
        if (live) {
          const kept = { ...blankRun(item, live.task, now(), lane.history), id: live.id, startedAt: live.startedAt }
          lane.last = kept
          push(item.id, linesFor(item, live.task, { type: 'reset' }), now())
        }
        const demo = state.demos[item.id]
        if (demo) {
          state.demos[item.id] = { ...blankRun(item, demo.task, now(), demo.history), id: demo.id, startedAt: demo.startedAt }
          if (!live) push(item.id, linesFor(item, demo.task, { type: 'reset' }), now())
        }
        if (!live && !demo) return { ok: false, error: 'This workflow has no task' }
        write()
        return { ok: true, ids }
      }
      if (typeof spawn !== 'function') {
        const saved = take()
        return saved.ok === false ? saved : present()
      }
      return hostSerial(async () => {
        const saved = take()
        if (saved.ok === false) return saved
        await releaseAll(saved.ids, release, warn)
        await drainAll()
        return present()
      })
    },
    say(body = {}) {
      return mutate(String(body.workflowId ?? ''), (item) => {
        const text = cleanLine(body.text, 2000)
        if (!text) throw new Error('A message needs text')
        const at = now()
        const lines = [{ kind: 'user', text }]
        const run = primaryRun(item.id)
        const running = run ? orderedIds(item, run.nodeStatus, 'running')[0] : undefined
        if (running) {
          const node = nodeById(item, running)
          lines.push({ kind: 'bot', botId: running, step: '进行中', text: `${node?.name ?? running}：收到。我继续处理「${run.task?.title ?? ''}」。` })
        }
        push(item.id, lines, at)
      })
    },
    // Replace the graph the canvas and the run share. Positions and edges
    // persist; a node that remains keeps its run status, a new one waits.
    saveGraph(body = {}) {
      return mutate(String(body.workflowId ?? ''), (item) => {
        const seated = seat(body.nodes, bots() ?? [])
        const seenBots = new Set()
        for (const node of seated) {
          if (!node.botId) continue
          if (seenBots.has(node.botId)) throw new Error('That Bot is already in this workflow')
          seenBots.add(node.botId)
        }
        const next = validateGraph({
          ...item,
          nodes: seated,
          edges: body.edges,
          layers: undefined,
        })
        item.nodes = next.nodes
        item.edges = next.edges
        item.layers = next.layers
        const run = primaryRun(item.id)
        if (run) {
          const ids = new Set(item.nodes.map(node => node.id))
          const nodeStatus = {}
          for (const id of ids) nodeStatus[id] = run.nodeStatus?.[id] ?? 'queued'
          run.nodeStatus = nodeStatus
          run.updatedAt = now()
        }
      })
    },
    // A Bot (or the owner) writes a graph. A name that already exists is replaced.
    define(body = {}) {
      const existing = body.workflow ? findWorkflow(body.workflow) : undefined
      if (existing) {
        const saved = this.saveGraph({ workflowId: existing.id, nodes: body.nodes, edges: body.edges ?? [] })
        if (saved.ok === false) return saved
        const name = cleanLine(body.name, 80)
        if (name) {
          existing.name = name
          write()
        }
        return present()
      }
      return this.create({ name: body.name, nodes: body.nodes, edges: body.edges ?? [], description: body.description })
    },
    // Start a named workflow. `brief` is the task title; `task` is its id.
    runNamed(body = {}) {
      const item = findWorkflow(body.workflow)
      if (!item) return { ok: false, error: 'No such workflow' }
      const title = cleanLine(body.brief || body.title, 300)
      if (!title) return { ok: false, error: 'A run needs a brief' }
      const taskId = cleanLine(body.task || body.taskId, 80) || `task-${now().toString(36)}`
      return this.assign({ workflowId: item.id, taskId, title })
    },
    // Auto-assign an open board task. A miss leaves the task untouched.
    ingest(task = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const taskId = cleanLine(task.id, 80)
      if (!taskId) return { ok: false, error: 'A task needs an id' }
      const claimed = state.claims[taskId]
      const decision = claimed?.kind === 'bot' || claimed?.kind === 'workflow'
        ? claimed
        : matchTask(task, { workflows: state.workflows, bots: bots() ?? [] })
      if (!decision) return { ok: true, matched: false }
      const key = `${decision.kind}:${decision.id}`
      const prev = state.routes[taskId]
      if (prev?.key === key) return { ok: true, matched: true, already: true, decision }
      if (decision.kind === 'bot') {
        rememberClaim(taskId, decision)
        write()
        return { ok: true, matched: true, already: false, decision }
      }
      const demo = state.demos[decision.id]
      if (demo && demo.task?.id === taskId && demo.status === 'running') {
        state.routes[taskId] = { key, kind: decision.kind, id: decision.id, at: now() }
        write()
        return { ok: true, matched: true, already: true, decision }
      }
      if (queuedOrRunning(decision.id, taskId)) {
        state.routes[taskId] = { key, kind: decision.kind, id: decision.id, at: now() }
        write()
        return { ok: true, matched: true, already: true, decision }
      }
      const title = cleanLine(task.title, 300)
      if (!title) return { ok: false, error: 'A task needs a title' }
      const assigned = this.assign({ workflowId: decision.id, taskId, title })
      const finish = (value) => {
        if (value?.ok === false) return value
        rememberClaim(taskId, decision)
        write()
        return { ...present(), matched: true, already: false, decision }
      }
      if (typeof assigned?.then === 'function') return assigned.then(finish)
      return finish(assigned)
    },
    reap() {
      if (typeof release !== 'function') return Promise.resolve()
      const stale = []
      const abandoned = []
      for (const [workflowId, lane] of Object.entries(state.lanes ?? {})) {
        const seen = new Set()
        for (const run of [...(lane.active ?? []), lane.last].filter(Boolean)) {
          if (!run?.ephemeral || seen.has(run)) continue
          seen.add(run)
          // A run still marked running here was cut off with the host that ran it,
          // and nothing resumes it: its instances are abandoned, not in progress.
          // Release them and end the run, or they stay hidden with no way to remove
          // them. A run that already ended keeps its own status (#1388).
          if (run.status === 'running') {
            abandoned.push({ workflowId, run })
            continue
          }
          stale.push(...Object.values(run.ephemeral))
          delete run.ephemeral
          delete run.handed
        }
      }
      for (const { workflowId, run } of abandoned) {
        stale.push(...Object.values(run.ephemeral))
        const ended = { ...run, status: 'failed', updatedAt: now() }
        delete ended.ephemeral
        delete ended.handed
        const lane = laneOf(workflowId)
        lane.active = lane.active.filter(item => item.id !== run.id)
        lane.last = ended
        lane.history = [...lane.history, { task: ended.task, status: ended.status, at: ended.updatedAt }].slice(-20)
      }
      if (stale.length === 0 && abandoned.length === 0) return Promise.resolve()
      return releaseAll(stale, release, warn).then(() => { write() })
    },
    dispose() {
      const runs = Object.values(state.lanes).flatMap(lane => [...(lane.active ?? []), lane.last].filter(Boolean))
      const ids = runs.flatMap(run => Object.values(run?.ephemeral ?? {}))
      // Release first, then forget the ids (#1387). A record that drops an id
      // before its Bot is gone leaves a hidden Bot that no state names, so
      // nothing can ever find it again. releaseAll reports a failed id through
      // `warn` instead of rejecting, so one bad release cannot skip the write.
      // The caller awaits this: a disposer that returns before the Bots are
      // gone is not a cleanup.
      return releaseAll(ids, release, warn).then(() => {
        for (const run of runs) {
          delete run.ephemeral
          delete run.handed
        }
        if (ids.length > 0) write()
      })
    },
  }
}

function seat(nodes, roster) {
  return (nodes ?? []).map(node => {
    const botId = node?.botId ? String(node.botId) : ''
    const bot = botId ? roster.find(item => item.id === botId) : undefined
    if (botId && !bot) throw new Error('No such Bot')
    if (bot?.remote === true) throw new Error('A workflow seats local Bots only')
    const prompt = cleanPrompt(node.prompt)
    const model = cleanLine(node.model, 80)
    const tools = cleanTools(node.tools)
    const inputs = cleanPorts(node.inputs, 'in')
    const outputs = cleanPorts(node.outputs, 'out')
    return {
      id: cleanLine(node.id, 40).toLowerCase(),
      name: cleanLine(node.name || bot?.name, 80),
      role: cleanLine(node.role || bot?.role, 80),
      instructions: cleanLine(node.instructions || bot?.instructions, 500),
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(tools.length ? { tools } : {}),
      ...(inputs.length ? { inputs } : {}),
      ...(outputs.length ? { outputs } : {}),
      ...(botId ? { botId } : {}),
      ...(node.failOnce === true ? { failOnce: true } : {}),
      ...(Number.isFinite(Number(node.x)) ? { x: Number(node.x) } : {}),
      ...(Number.isFinite(Number(node.y)) ? { y: Number(node.y) } : {}),
    }
  })
}

function seed(now) {
  const delivery = normalizeGraph(deliveryWorkflow())
  const weekly = normalizeGraph(weeklyWorkflow())
  const task = fixtureTask()
  const logs = { [DELIVERY_ID]: [], [WEEKLY_ID]: [] }
  const runs = {}
  let seq = 0
  const push = (workflowId, lines) => {
    for (const line of lines) {
      seq += 1
      logs[workflowId].push({ id: `m${seq}`, at: now, ...line })
    }
  }
  push(DELIVERY_ID, [
    { kind: 'time', text: 'Today 9:07 PM' },
    { kind: 'system', text: 'Workflow「发布交付流水线」已创建 · 成员 Planner、Writer、Coder、Reviewer、Tester、Deployer' },
    { kind: 'user', text: '@发布交付流水线 #1280 今天要上，notice 太长了，帮我缩短并发布。' },
  ])
  let run = blankRun(delivery, task, now)
  for (const op of [{ type: 'start' }, { type: 'complete', nodeId: 'planner' }, { type: 'complete', nodeId: 'writer' }]) {
    const result = op.type === 'start'
      ? { ...startFrontier(delivery, run.nodeStatus), joined: false, layerSize: 0 }
      : completeNode(delivery, run.nodeStatus, op.nodeId)
    run = { ...run, status: 'running', nodeStatus: result.status, steps: run.steps + 1, updatedAt: now }
    push(DELIVERY_ID, linesFor(delivery, task, {
      type: op.type, nodeId: op.nodeId, started: result.started ?? [],
      joined: result.joined === true, finished: false, layerSize: result.layerSize ?? 0,
    }))
  }
  runs[DELIVERY_ID] = run
  const weeklyTask = { id: 'W42', title: '周报' }
  const done = freshStatus(weekly)
  for (const id of Object.keys(done)) done[id] = 'done'
  runs[WEEKLY_ID] = {
    ...blankRun(weekly, weeklyTask, now),
    status: 'done',
    nodeStatus: done,
    steps: 4,
    stepBudget: 4,
    history: [{ task: weeklyTask, status: 'done', at: now }],
  }
  push(WEEKLY_ID, [
    { kind: 'time', text: '上周五 17:00' },
    { kind: 'system', tone: 'accent', text: '定时触发：周报 W42' },
    { kind: 'bot', botId: 'researcher', step: '1/3', text: '本周行业动态 12 条已整理。' },
    { kind: 'bot', botId: 'analyst', step: '2/3', text: '核心指标周环比：DAU +4.1%，留存 +0.6pt。' },
    { kind: 'bot', botId: 'writer', step: '3/3', text: '周报已发布。' },
    { kind: 'system', tone: 'ok', text: '✓ 运行完成' },
  ])
  return {
    version: 1, workflows: [delivery, weekly], runs: {}, demos: runs, lanes: {}, claims: {}, routes: {},
    logs, seq, laneFormat: true,
  }
}

function migrateRuns(state) {
  state.lanes ??= {}
  state.demos ??= {}
  state.claims ??= {}
  if (state.laneFormat === true) return
  for (const [id, run] of Object.entries(state.runs ?? {})) {
    if (!run || typeof run !== 'object' || state.lanes[id]) continue
    const history = Array.isArray(run.history) ? run.history.filter(item => item?.status === 'done' || item?.status === 'failed') : []
    const bots = run.ephemeral && typeof run.ephemeral === 'object' ? Object.keys(run.ephemeral) : []
    // Only a run that still has its Bots occupies a slot. The seeded script
    // has none, so it stays a demo and replay can move it.
    if (bots.length > 0 && run.status === 'running') {
      state.lanes[id] = { active: [{ ...run, live: true }], queue: [], last: null, history }
      continue
    }
    const demo = { ...run }
    delete demo.live
    state.demos[id] = demo
    const finished = run.status === 'done' || run.status === 'failed'
    state.lanes[id] = { active: [], queue: [], last: finished ? { ...demo } : null, history }
  }
  state.runs = {}
  state.laneFormat = true
}

function load(file, warn) {
  if (!file) return null
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    warn(`flybot-workflow: could not read ${file}`)
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed?.version !== 1 || !Array.isArray(parsed.workflows) || typeof parsed.runs !== 'object') {
      warn('flybot-workflow: the store is not a workflow file; starting from the fixture')
      return null
    }
    return parsed
  } catch (error) {
    // A file that does not parse is not a workflow store. Keep the plugin up
    // on the fixture instead of failing every endpoint.
    warn(`flybot-workflow: the store did not parse (${error?.message ?? error}); starting from the fixture`)
    return null
  }
}
