// Workflow records and the runs a board task starts. The graph rules live in
// graph.js. A workflow keeps a FIFO queue and up to maxConcurrent live runs
// (default 2). A live node stays running until its Bot replies.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseAll, spawnAll } from './ephemeral.js'
import {
  chainLabel, cleanLine, cleanPorts, cleanPrompt, cleanTools, completeNode, doneCount, failNode, freshStatus, layerMarks,
  missingProviders, missingVerdicts, nodeById, normalizeGraph, orderedIds, readStepResult, resolveInputs, retryNode,
  rowPreview, startFrontier, summarizeTask, unmetRequired, validateGraph,
} from './graph.js'
import { matchTask, namedTarget } from './match.js'
import { linesFor } from './narrate.js'
import { DELIVERY_ID, DELIVERY_STEPS, WEEKLY_ID, deliveryWorkflow, templateById, templateCatalog, weeklyWorkflow } from './template.js'

const MAX_WORKFLOWS = 24
const MAX_MESSAGES = 200
const FILE = 'workflows.json'
const DEFAULT_CONCURRENT = 2
const MAX_CONCURRENT = 8
const MAX_ORPHANS = 50
// How many held task ids a workflow lists in `workflow/state`; the count beside
// them is always the whole truth (#1647).
const MAX_HELD_TASKS = 20
// A live step waits for its Bot's reply, and nothing else bounds that wait
// (#1530). These are the only two numbers a stuck run depends on: how long one
// step may stay unanswered, and how long a hand-off that did not land waits
// before it is tried again. Both are cleared with the step they belong to.
// Ten minutes was shorter than the work a node is asked to do — implementing or
// reviewing a change takes twenty to forty — so every step that did real work
// was killed mid-flight (#1580). The default covers one such step now, and a
// workflow may set its own within these bounds.
export const DEFAULT_STEP_TIMEOUT_MINUTES = 45
export const MIN_STEP_TIMEOUT_MINUTES = 1
export const MAX_STEP_TIMEOUT_MINUTES = 120
export const STEP_DEADLINE_MS = DEFAULT_STEP_TIMEOUT_MINUTES * 60 * 1000
export const HANDOFF_RETRY_DELAYS_MS = [1000, 2000]

function stepTimeoutValue(raw) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_STEP_TIMEOUT_MINUTES || value > MAX_STEP_TIMEOUT_MINUTES) {
    throw new Error(`stepTimeoutMinutes is an integer from ${MIN_STEP_TIMEOUT_MINUTES} to ${MAX_STEP_TIMEOUT_MINUTES}`)
  }
  return value
}

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
  } else if (edge.onFail === true) {
    out.onFail = true
    out.max = edge.max
  } else if (edge.when?.else === true) out.when = { else: true }
  else if (edge.when) out.when = { output: edge.when.output, eq: edge.when.eq }
  return out
}

// #1706: the two fields the Inbox needs to place a run in time. A paused run is
// still `status: 'running'` with `paused: true` (the engine keeps the status and
// only deletes `paused` on resume), so both fields follow the status the engine
// keeps instead of a second reading of `paused`.
function finishedAtOf(run) {
  if (run.status !== 'done' && run.status !== 'failed') return null
  if (typeof run.finishedAt === 'number') return run.finishedAt
  return typeof run.updatedAt === 'number' ? run.updatedAt : null
}

function currentStepOf(workflow, run) {
  if (run.status !== 'running') return null
  // The same ordered walk the stage's "Running now" strip uses, so the two cannot
  // name different nodes.
  const id = orderedIds(workflow, run.nodeStatus, 'running')[0]
  if (id === undefined) return null
  const node = workflow.nodes.find(candidate => candidate.id === id)
  return { id, name: node?.name ?? id }
}

function publicRun(workflow, run) {
  if (!run) return null
  return {
    id: run.id,
    workflowId: run.workflowId,
    task: run.task,
    taskSummary: summarizeTask(run.task),
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
    finishedAt: finishedAtOf(run),
    currentStep: currentStepOf(workflow, run),
    ...(run.live === true ? { live: true } : {}),
    ...(run.paused === true ? { paused: true } : {}),
    ...(run.failure ? { failure: { ...run.failure } } : {}),
    ...(run.earlyEnd ? { earlyEnd: run.earlyEnd } : {}),
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

export function createWorkflowService({
  dir, persist = true, now = () => Date.now(), bots = () => [], readOnly = () => false, warn = () => {}, tasksWired = false, spawn, release, dispatch,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle),
} = {}) {
  const file = dir ? join(dir, FILE) : null
  let state = load(file, warn) ?? seed()
  state.routes ??= {}
  // migrateRuns() also normalizes the orphan list a deleted workflow left
  // (#1621), so a store written by an older version keeps those ids.
  migrateRuns(state)
  purgeDemos(state, historyRow)
  let seq = state.seq ?? 1
  // One lock for every start and release to serialize drain operations.
  let hostTail = Promise.resolve()
  function hostSerial(fn) {
    const run = hostTail.then(() => fn())
    hostTail = run.then(() => {}, () => {})
    return run
  }

  // Every wait a live step can sit in is bounded (#1530): one timer per step
  // for its deadline, one per hand-off that is being retried. The key carries
  // the run and the node so a step that moves, a run that ends, and dispose()
  // clear exactly their own timers.
  const timers = new Map()
  const warned = new Set()
  const handOffTries = new Map()

  function warnOnce(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  function clearTimerAt(key) {
    const entry = timers.get(key)
    if (!entry) return
    timers.delete(key)
    clearTimer(entry.handle)
  }

  function clearRunTimers(runId) {
    for (const [key, entry] of [...timers]) {
      if (entry.runId === runId) clearTimerAt(key)
    }
    for (const key of [...warned]) {
      if (key.endsWith(`:${runId}`)) warned.delete(key)
    }
    for (const key of [...handOffTries.keys()]) {
      if (key.startsWith(`${runId}:`)) handOffTries.delete(key)
    }
  }

  function setTimerAt(kind, runId, nodeId, delay, fn) {
    const key = `${kind}:${runId}:${nodeId}`
    clearTimerAt(key)
    const handle = setTimer(() => {
      timers.delete(key)
      return fn()
    }, delay)
    // A deadline must never hold the host process open by itself.
    handle?.unref?.()
    timers.set(key, { runId, nodeId, handle })
  }

  function armDeadline(item, run, nodeId) {
    if (timers.has(`deadline:${run.id}:${nodeId}`)) return
    setTimerAt('deadline', run.id, nodeId, stepTimeoutMsOf(item), () => expireStep(item.id, run.id, nodeId))
  }

  // Give every running step the deadline it started with and drop the timers of
  // steps that moved. A hand-off retry does not push a deadline out: the wait
  // the owner saw is the wait the deadline measures.
  function syncTimers(item, run) {
    // Arm deadlines for every live running step. Ephemeral maps are usual on
    // production runs, but a host that cannot spawn still walks the graph via
    // advance(); without this the step could sit unanswered forever (#1530).
    if (run?.live !== true) return
    const running = new Set(orderedIds(item, run.nodeStatus, 'running'))
    for (const [key, entry] of [...timers]) {
      if (entry.runId !== run.id) continue
      if (run.status !== 'running' || run.paused === true || !running.has(entry.nodeId)) clearTimerAt(key)
    }
    if (run.status !== 'running' || run.paused === true) return
    for (const nodeId of running) armDeadline(item, run, nodeId)
  }

  // A step nobody answers is not progress. Fail the run, free its Bots and say
  // which step timed out, so a dead Bot cannot hold a lane slot forever.
  function expireStep(workflowId, runId, nodeId) {
    return hostSerial(async () => {
      const item = workflow(workflowId)
      const minutes = stepTimeoutMinutesOf(item)
      const lane = laneOf(workflowId)
      const run = lane.active.find(candidate => candidate.id === runId)
      if (!item || !run || run.status !== 'running' || run.paused === true) return
      if (run.nodeStatus?.[nodeId] !== 'running') return
      const node = nodeById(item, nodeId)
      warn(`flybot-workflow: step ${nodeId} timed out after ${minutes} minutes`)
      push(workflowId, [{
        kind: 'system',
        tone: 'bad',
        key: '{node} timed out: no reply for {minutes} minutes, the run was marked failed.',
        params: { node: node?.name ?? nodeId, minutes },
        text: `${node?.name ?? nodeId} 超时：${minutes} 分钟没有回包，run 已标记失败。`,
      }], now())
      endRun(item, run, { code: 'step-failed', nodeName: node?.name, text: `no reply for ${minutes} minutes` })
      await releaseRun(workflowId, run)
      await drainAll()
      return present()
    }).catch(error => warn(`flybot-workflow: step ${nodeId} could not be timed out: ${error?.message ?? error}`))
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
    if (Array.isArray(item.edges) && Array.isArray(item.layers) && item.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))) return item
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

  // Task ids each workflow holds, sorted. `heldTaskCount` is the whole truth and
  // the list beside it is capped (#1647); a Bot claim is not a workflow claim.
  function heldTaskIds() {
    const held = new Map()
    for (const [taskId, claim] of Object.entries(state.claims ?? {})) {
      if (claim?.kind !== 'workflow') continue
      const list = held.get(claim.id)
      if (list) list.push(taskId)
      else held.set(claim.id, [taskId])
    }
    for (const list of held.values()) list.sort()
    return held
  }

  function present() {
    const roster = bots() ?? []
    const held = heldTaskIds()
    return {
      ok: true,
      version: 1,
      tasksWired,
      templates: templateCatalog(),
      workflows: state.workflows.map(raw => {
        const item = readyWorkflow(raw)
        return ({
        id: item.id,
        name: item.name,
        description: item.description ?? '',
        trigger: item.trigger ?? 'manual',
        scheduleLabel: item.scheduleLabel ?? '',
        model: item.model ?? '',
        nodes: item.nodes.map(node => publicNode(node, roster)),
        edges: (item.edges ?? []).map(publicEdge),
        layers: item.layers.map(layer => [...layer]),
        triggers: [...(item.triggers ?? [])],
        chain: chainLabel(item),
        maxConcurrent: maxOf(item),
        stepTimeoutMinutes: stepTimeoutMinutesOf(item),
        activeCount: runningOf(laneOf(item.id)).length,
        queueDepth: (laneOf(item.id).queue ?? []).length,
        queue: (laneOf(item.id).queue ?? []).map(task => ({ id: task.id, title: task.title })),
        history: [...(laneOf(item.id).history ?? [])],
        runs: [...runningOf(laneOf(item.id)), ...failedSiblings(laneOf(item.id))].map(run => publicRun(item, run)),
        preview: rowPreview(item, previewRun(item.id)),
        run: publicRun(item, displayRun(item.id)),
        messages: state.logs[item.id] ?? [],
        heldTasks: (held.get(item.id) ?? []).slice(0, MAX_HELD_TASKS),
        heldTaskCount: (held.get(item.id) ?? []).length,
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
    return (lane?.active ?? []).filter(run => run && run.live === true && run.status === 'running')
  }

  // A failed run is still the room's business: the stage and the Runs tab show it
  // beside whatever is running now, naming what ended it (#1493). A failure of the
  // task that is live again is a retry, not a sibling, so the live run keeps the
  // row and the older attempt stays in history (#1507).
  function failedSiblings(lane) {
    const failed = lane?.last
    if (failed?.live !== true || failed.status !== 'failed' || !failed.task) return []
    const running = runningOf(lane)
    if (running.some(run => run.task?.id && run.task.id === failed.task.id)) return []
    return [failed]
  }

  function maxOf(item) {
    const value = Number(item?.maxConcurrent)
    if (!Number.isInteger(value) || value < 1) return DEFAULT_CONCURRENT
    return Math.min(MAX_CONCURRENT, value)
  }

  // How long this workflow lets one live step stay unanswered (#1580). A stored
  // value outside the bounds can only come from a file edited by hand, so it
  // falls back to the default instead of ending the run early.
  function stepTimeoutMinutesOf(item) {
    const value = Number(item?.stepTimeoutMinutes)
    if (!Number.isInteger(value) || value < MIN_STEP_TIMEOUT_MINUTES || value > MAX_STEP_TIMEOUT_MINUTES) return DEFAULT_STEP_TIMEOUT_MINUTES
    return value
  }

  function stepTimeoutMsOf(item) {
    return stepTimeoutMinutesOf(item) * 60_000
  }

  function displayRun(id) {
    const live = runningOf(laneOf(id))
    if (live.length > 0) return live[0]
    const last = laneOf(id).last
    if (last?.live === true) return last
    return null
  }

  function previewRun(id) {
    const live = runningOf(laneOf(id))
    return live.length > 0 ? live[0] : null
  }

  function storeRun(workflowId, run) {
    const lane = laneOf(workflowId)
    const index = lane.active.findIndex(item => item.id === run.id)
    if (index >= 0) lane.active[index] = run
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
      text: op.text ?? '',
    })
    else if (op.type === 'fail') result = failNode(item, working.nodeStatus, op.nodeId, {
      failAttempts: working.failAttempts ?? {},
      outputs: op.outputs ?? working.produced?.[op.nodeId] ?? {},
      text: op.text ?? '',
    })
    else if (op.type === 'retry') result = retryNode(item, working.nodeStatus, op.nodeId)
    else throw new Error(`Unknown step ${op.type}`)
    const gated = gateStarted(item, working, result)
    result = gated.result
    const failedOnce = { ...working.failedOnce }
    if (op.type === 'fail') failedOnce[op.nodeId] = true
    const blocked = gated.blocked.length > 0
    // Early end takes precedence over normal finish — needs-human, already-claimed,
    // tip-unchanged, or open-pr end the run even if not all nodes are done (#1537, #1538).
    const earlyEnded = result.earlyEnd != null
    const finished = earlyEnded || (result.finished === true && !blocked)
    // A node marked failOnce is retried. Any other failure stops the run,
    // unless a failure recovery edge exists: then reset to the recovery target.
    // A missing required input stops the run the same way: the successor can never start.
    const failOnce = op.type === 'fail' && nodeById(item, op.nodeId)?.failOnce === true
    const recovered = op.type === 'fail' && result.recovered === true
    const stopped = blocked || (op.type === 'fail' && !failOnce && !recovered) || earlyEnded
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
      ...(result.failAttempts ? { failAttempts: result.failAttempts } : {}),
      ...(Object.keys(handed).length > 0 ? { handed } : {}),
      ...(earlyEnded ? { earlyEnd: result.earlyEnd } : {}),
    }
    if (Object.keys(handed).length === 0) delete next.handed
    if (next.status === 'failed') {
      const hole = blocked ? gated.blocked[0] : null
      const node = nodeById(item, hole ? hole.id : op.nodeId)
      const text = hole
        ? `Missing input ${hole.missing.join(', ')}`
        : String(op.text ?? '').replace(/\s+/g, ' ').trim()
      next.failure = {
        code: 'step-failed',
        at: next.updatedAt,
        ...(node ? { nodeName: node.name } : {}),
        ...(text ? { text: text.length > 200 ? `${text.slice(0, 197)}…` : text } : {}),
      }
    }
    const lines = linesFor(item, working.task, {
      type: op.type,
      nodeId: op.nodeId,
      started: result.started ?? [],
      joined: result.joined === true,
      finished,
      layerSize: result.layerSize ?? 0,
      live: working.live === true,
      text: op.text ?? '',
      recovered: result.recovered === true,
      earlyEnd: result.earlyEnd,
    })
    for (const hole of gated.blocked) {
      const node = nodeById(item, hole.id)
      const missing = hole.missing.join(', ')
      lines.push({
        kind: 'system',
        tone: 'bad',
        key: '{node} cannot start: missing input {missing}.',
        params: { node: node?.name ?? hole.id, missing },
        text: `${node?.name ?? hole.id} 不能开始：缺少输入 ${missing}。`,
      })
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

  // A dispatch that does not land is not "handed". A small backoff retries it a
  // bounded number of times; when it still does not land the step is not
  // progress, so the run fails and the chat says why (#1530). A 429 is never
  // hammered: the retries are spaced, not immediate.
  async function handOff(item, run) {
    if (typeof dispatch !== 'function' || !run?.ephemeral || run.paused === true) return run
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
        const key = `${current.id}:${nodeId}`
        const tries = (handOffTries.get(key) ?? 0) + 1
        handOffTries.set(key, tries)
        warn(`flybot-workflow: step ${nodeId} was not handed over: ${code}`)
        if (tries <= HANDOFF_RETRY_DELAYS_MS.length) {
          const delay = HANDOFF_RETRY_DELAYS_MS[tries - 1]
          const seconds = delay / 1000
          push(item.id, [{
            kind: 'system',
            tone: 'bad',
            key: '{node} did not take this step ({code}); retrying in {seconds}s ({tries}/{total}).',
            params: { node: node.name, code, seconds, tries, total: HANDOFF_RETRY_DELAYS_MS.length },
            text: `${node.name} 没有接到这一步（${code}），${seconds} 秒后重试（${tries}/${HANDOFF_RETRY_DELAYS_MS.length}）。`,
          }], now())
          setTimerAt('retry', current.id, nodeId, delay, () => hostSerial(() => afterStep(item.id, current.id))
            .catch(error => warn(`flybot-workflow: the retry for step ${nodeId} failed: ${error?.message ?? error}`)))
          continue
        }
        push(item.id, [{
          kind: 'system',
          tone: 'bad',
          key: '{node} did not take this step ({code}); {total} retries did not land, the run failed.',
          params: { node: node.name, code, total: HANDOFF_RETRY_DELAYS_MS.length },
          text: `${node.name} 没有接到这一步（${code}），重试 ${HANDOFF_RETRY_DELAYS_MS.length} 次仍未落地，run 已标记失败。`,
        }], now())
        // The run cannot finish without this step: end it the way every other
        // abandoned run ends (#1424), then let the caller release the Bots.
        endRun(item, current, { code: 'dispatch-failed' })
        storeRun(item.id, current)
        break
      }
      handOffTries.delete(`${current.id}:${nodeId}`)
      current = { ...current, handed: { ...current.handed, [nodeId]: true }, inputs: { ...(current.inputs ?? {}), [nodeId]: body.inputs } }
      storeRun(item.id, current)
    }
    syncTimers(item, current)
    write()
    return current
  }

  async function releaseRun(workflowId, run) {
    // A released run answers to nothing: its deadline and its pending retries go
    // with the Bots, or a timer fires into a run that no longer exists.
    clearRunTimers(run.id)
    const ids = Object.values(run.ephemeral ?? {})
    delete run.handed
    delete run.paused
    delete run.releasePending
    const lane = laneOf(workflowId)
    lane.active = lane.active.filter(item => item.id !== run.id)
    lane.last = run
    if (run.status === 'done' || run.status === 'failed') {
      lane.history = [...lane.history, historyRow(run)].slice(-20)
    }
    // A Bot the host could not remove keeps its id on the record: the next
    // load's reap() is the only thing that retries the removal (#1616).
    const failed = await releaseAll(ids, release, warn)
    keepUnreleased(run, failed)
    write()
  }

  // End a run the host gave up on: fail the nodes still in flight, then mark the
  // run failed. Every path that abandons a run comes through here — reap() at load,
  // dispose(), the catch around a step that threw, and reset() stopping one run —
  // so run.status and run.nodeStatus cannot drift apart and a client stops painting
  // "Running now" (#1424). A run that already ended keeps its own ending (#1388);
  // ephemeral ids stay on the record until release strips them. `failure` names the
  // ending so the stage and the Runs tab can say why, not only Failed (#1493).
  function endRun(item, run, failure = { code: 'host-ended' }) {
    if (run.status === 'done' || run.status === 'failed') return run
    for (const nodeId of item ? orderedIds(item, run.nodeStatus, 'running') : []) {
      try {
        run.nodeStatus = failNode(item, run.nodeStatus, nodeId).status
      } catch (error) {
        warn(`flybot-workflow: node ${nodeId} kept its status: ${error?.message ?? error}`)
      }
    }
    run.status = 'failed'
    run.updatedAt = now()
    run.failure = { ...failure, at: run.updatedAt }
    delete run.paused
    delete run.releasePending
    return run
  }

  // A run that ended failed says so once in the stage log: the step-failure paths
  // already write their own line, these are the endings that wrote none (#1493).
  function failureLine(run) {
    const label = summarizeTask(run.task)
    if (run.failure?.text) {
      return {
        kind: 'system',
        tone: 'bad',
        key: '✕ Failed · {task} · {detail}',
        params: { task: label, detail: run.failure.text },
        text: `✕ 失败 · ${label} · ${run.failure.text}`,
      }
    }
    return {
      kind: 'system',
      tone: 'bad',
      key: '✕ Failed · {task}',
      params: { task: label },
      text: `✕ 失败 · ${label}`,
    }
  }

  function archiveCutoffRun(workflowId, run) {
    const lane = laneOf(workflowId)
    lane.active = lane.active.filter(item => item.id !== run.id)
    lane.last = run
    lane.history = [...lane.history, historyRow(run)].slice(-20)
  }

  // The Runs tab reads this: a finished run, when it ended, and — for a failure —
  // the reason, so the row says more than "Failed" (#1493).
  function historyRow(run) {
    return {
      id: run.id,
      task: run.task,
      status: run.status,
      at: run.updatedAt,
      ...(run.failure ? { failure: { ...run.failure } } : {}),
    }
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
    return { item: best.item, task: { id: task.id, title: task.title, ...(task.callerBotId ? { callerBotId: task.callerBotId } : {}) } }
  }

  function noteUnstarted(item, error) {
    push(item.id, [{ kind: 'system', tone: 'bad', text: error ?? 'The queued task could not start' }], now())
    write()
  }

  // After a slot frees, start the oldest parked task on any workflow that
  // still has room.
  function drainSync() {
    let guard = 0
    while (guard < 48) {
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
    while (guard < 48) {
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

  // A claim and its route travel together; neither is left behind (#1647).
  function forgetClaim(taskId) {
    const had = Object.hasOwn(state.claims, taskId) || Object.hasOwn(state.routes, taskId)
    delete state.claims[taskId]
    delete state.routes[taskId]
    return had
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
    let run = { ...blankRun(item, task, now(), []), live: true }
    if (ephemeral) run.ephemeral = ephemeral
    const at = now()
    const taskLabel = summarizeTask(task)
    push(item.id, [
      { kind: 'time' },
      {
        kind: 'system',
        key: 'Task assigned · {task} → {workflow}',
        params: { task: taskLabel, workflow: item.name },
        text: `任务已分配 · ${taskLabel} → ${item.name}`,
      },
    ], at)
    const stepped = applyOp(item, run, { type: 'start' })
    run = stepped.run
    laneOf(item.id).active.push(run)
    push(item.id, stepped.lines, at)
    syncTimers(item, run)
    write()
    return { ok: true, run }
  }

  async function startLive(item, task) {
    let ephemeral
    if (typeof spawn === 'function') {
      const holes = missingProviders(item)
      if (holes.length > 0) return { ok: false, error: `Node ${holes[0].nodeId} input ${holes[0].name} has no upstream provider` }
      try {
        // #1544: the caller that started the run and the Bot that saved the graph cap the connectors
        // this run may use; the host intersects them with each node's `tools`.
        ephemeral = await spawnAll(item.nodes, bots() ?? [], spawn, item.model ?? '', {
          callerBotId: task.callerBotId,
          authorBotId: item.authoredBy,
        })
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
        endRun(item, run, { code: 'dispatch-failed', text: String(error?.message ?? error).slice(0, 200) })
        await releaseRun(item.id, run)
        return refuse(error)
      }
    }
    if (run.status === 'done' || run.status === 'failed') await releaseRun(item.id, run)
    return present()
  }

  function park(item, task) {
    const lane = laneOf(item.id)
    state.queueSeq = (state.queueSeq ?? 0) + 1
    lane.queue.push({
      id: task.id,
      title: task.title,
      enqueuedAt: now(),
      queueSeq: state.queueSeq,
      // #1544: a parked run starts later without its caller in hand; keep it, or the ceiling is lost.
      ...(task.callerBotId ? { callerBotId: task.callerBotId } : {}),
    })
    const ahead = lane.queue.length - 1
    push(item.id, [{
      kind: 'system',
      key: 'Queued · {task} ({ahead} ahead)',
      params: { task: summarizeTask(task), ahead },
      text: `排队 · ${summarizeTask(task)}（前面 ${ahead} 个）`,
    }], now())
    write()
  }

  function hasRoom(item) {
    return runningOf(laneOf(item.id)).length < maxOf(item)
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
    return null
  }

  function commitAdvance(workflowId, op) {
    const item = workflow(workflowId)
    if (!item) return { ok: false, error: 'No such workflow' }
    const run = runFor(workflowId, op.runId, op.nodeId)
    if (!run || run.status === 'idle') return { ok: false, error: 'This workflow has no running task' }
    if (run.status === 'done' || run.status === 'failed') return { ok: false, error: 'This run is already finished' }
    // #1773: a step whose gate reads a declared OUTPUT has to deliver it. Completing on
    // silence skips every branch the gate guards and the run still closed as done, so the
    // missing verdict fails the step here — the gate never runs, and the run's `failure`
    // names the node and the OUTPUT it did not print.
    if (op.type === 'complete') {
      const missing = missingVerdicts(item, op.nodeId, op.outputs ?? run.produced?.[op.nodeId] ?? {})
      if (missing.length > 0) op = { ...op, type: 'fail', text: `Missing OUTPUT ${missing.join(', ')}` }
    }
    try {
      let stepped = applyOp(item, run, op)
      if (op.type === 'fail' && nodeById(item, op.nodeId)?.failOnce === true && stepped.run.status === 'running') {
        const again = applyOp(item, stepped.run, { type: 'retry', nodeId: op.nodeId })
        stepped = { run: again.run, lines: [...stepped.lines, ...again.lines] }
      }
      storeRun(workflowId, stepped.run)
      push(workflowId, stepped.lines, now())
      syncTimers(item, stepped.run)
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
    if (item && latest) syncTimers(item, latest)
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
      const lane = laneOf(workflowId)
      for (const run of lane.active ?? []) clearRunTimers(run.id)
      // `lane.last` too: #1616 keeps a failed id on the run it archived there,
      // and the record naming it is what finish() erases (#1621).
      const releasing = [...new Set([...(lane.active ?? []), lane.last]
        .filter(Boolean)
        .flatMap(run => Object.values(run.ephemeral ?? {})))]
      const finish = () => {
        state.workflows = state.workflows.filter(workflow => workflow.id !== workflowId)
        delete state.lanes[workflowId]
        delete state.runs[workflowId]
        delete state.logs[workflowId]
        Object.keys(state.routes).forEach(taskId => {
          if (state.routes[taskId]?.id === workflowId) delete state.routes[taskId]
        })
        // #1632: a claim is judged on its own record. The routes above are gone
        // by now, and a claim and a route do not hold the same keys anyway.
        Object.keys(state.claims ?? {}).forEach(taskId => {
          const claim = state.claims[taskId]
          if (claim?.kind === 'workflow' && claim.id === workflowId) delete state.claims[taskId]
        })
        write()
        return present()
      }
      if (typeof release !== 'function' || releasing.length === 0) return finish()
      return (async () => {
        // Deleting a workflow is the owner's action and a Bot that will not go
        // cannot undo it, but the lane that names that Bot is about to be erased.
        // The id moves to the store's orphan list, so reap() still retries it
        // instead of leaving a hidden Bot no state names (#1621).
        const failed = await releaseAll(releasing, release, warn)
        noteOrphans(state, failed)
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
        // #1544: the Bot that wrote the graph caps the connectors a run may reach from it.
        const authoredBy = cleanLine(body.callerBotId ?? body.authoredBy, 80) || undefined
        if (authoredBy) item.authoredBy = authoredBy
        const cap = Number(body.maxConcurrent)
        if (Number.isInteger(cap) && cap >= 1 && cap <= MAX_CONCURRENT) item.maxConcurrent = cap
        if (body.stepTimeoutMinutes !== undefined && body.stepTimeoutMinutes !== null && body.stepTimeoutMinutes !== '') {
          item.stepTimeoutMinutes = stepTimeoutValue(body.stepTimeoutMinutes)
        }
        state.workflows.push(item)
        const memberNames = item.nodes.map(node => node.name).join('、')
        const members = item.nodes.map(node => node.name).join(', ')
        push(item.id, [{
          kind: 'system',
          key: 'Workflow "{name}" created · members {members}',
          params: { name: item.name, members },
          text: `Workflow「${item.name}」已创建 · 成员 ${memberNames}`,
        }], now())
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
      // #1544: the Bot whose tool call started this run, when a Bot started it. The board, the canvas
      // and the API pass none, and the graph's author is the ceiling there.
      const callerBotId = cleanLine(body.callerBotId, 80)
      if (callerBotId) task.callerBotId = callerBotId
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
    setStepTimeout(body = {}) {
      const workflowId = String(body.workflowId ?? '')
      const raw = body.stepTimeoutMinutes
      const saved = mutate(workflowId, (item) => {
        if (raw === null || raw === '') delete item.stepTimeoutMinutes
        else item.stepTimeoutMinutes = stepTimeoutValue(raw)
      })
      return saved
    },
    setModel(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const workflowId = String(body.workflowId ?? '')
      const model = body.model ? cleanLine(body.model, 80) : null
      const saved = mutate(workflowId, (item) => {
        item.model = model
      })
      if (saved.ok === false) return saved
      return present()
    },
    advance(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
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
          clearRunTimers(run.id)
          lane.active = lane.active.filter(item => item.id !== run.id)
          lane.last = run
          lane.history = [...lane.history, historyRow(run)].slice(-20)
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
      const botId = String(body.botId ?? '')
      const found = findEphemeral(botId)
      if (!found) {
        // A Bot that replies after its run ended (a deadline, a Stop) has nobody
        // listening any more: say so once instead of dropping the reply silently.
        warnOnce(`orphan:${botId}`, `flybot-workflow: a reply from ${botId || 'an unknown Bot'} matches no running step`)
        return present()
      }
      if (found.run.nodeStatus?.[found.nodeId] !== 'running') {
        warnOnce(`moved:${botId}:${found.run.id}`, `flybot-workflow: a reply from ${botId} reached step ${found.nodeId}, which is no longer running`)
        return present()
      }
      const node = nodeById(found.item, found.nodeId)
      const parsed = readStepResult(body.text ?? '', node)
      const text = parsed.text || cleanLine(body.text, 2000)
      const note = (value) => {
        if (value?.ok === false) {
          warnOnce(`advance:${found.run.id}:${found.nodeId}`, `flybot-workflow: the reply for step ${found.nodeId} did not advance the run: ${value?.error ?? 'unknown'}`)
        }
        return value
      }
      const saved = this.advance({
        workflowId: found.item.id,
        runId: found.run.id,
        nodeId: found.nodeId,
        outcome: body.ok === false ? 'failed' : 'done',
        text,
        outputs: parsed.outputs,
      })
      if (saved && typeof saved.then === 'function') return saved.then(note)
      return note(saved)
    },
    ownsBot(botId) {
      return findEphemeral(botId) !== null
    },
    pause(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const workflowId = String(body.workflowId ?? '')
      const item = workflow(workflowId)
      if (!item) return { ok: false, error: 'No such workflow' }
      const lane = laneOf(workflowId)
      const runId = body.runId ? String(body.runId) : ''
      let run = runId ? lane.active.find(itemRun => itemRun.id === runId) : lane.active.find(itemRun => itemRun.live === true && itemRun.status === 'running')
      if (!run || run.live !== true) return { ok: false, error: 'No live run to pause' }
      if (run.paused === true) return present()
      run = { ...run, paused: true, updatedAt: now() }
      storeRun(workflowId, run)
      syncTimers(item, run)
      push(workflowId, [{
        kind: 'system',
        key: '⏸ Paused · {task}',
        params: { task: summarizeTask(run.task) },
        text: `⏸ 已暂停 · ${summarizeTask(run.task)}`,
      }], now())
      write()
      return present()
    },
    resume(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const workflowId = String(body.workflowId ?? '')
      const item = workflow(workflowId)
      if (!item) return { ok: false, error: 'No such workflow' }
      const lane = laneOf(workflowId)
      const runId = body.runId ? String(body.runId) : ''
      let run = runId ? lane.active.find(itemRun => itemRun.id === runId) : lane.active.find(itemRun => itemRun.live === true && itemRun.status === 'running')
      if (!run || run.live !== true) return { ok: false, error: 'No live run to resume' }
      // A failed release leaves the run paused on purpose: its next node has no
      // Bot to hand the step to, so resuming would only move the graph into a
      // silent skip. Stop again is the retry (#1476).
      if (run.releasePending === true) return { ok: false, error: 'This run is still waiting to release a Bot; stop it again to retry' }
      if (run.paused !== true) return present()
      run = { ...run, paused: false, updatedAt: now() }
      storeRun(workflowId, run)
      syncTimers(item, run)
      push(workflowId, [{
        kind: 'system',
        key: '▶ Resumed · {task}',
        params: { task: summarizeTask(run.task) },
        text: `▶ 已继续 · ${summarizeTask(run.task)}`,
      }], now())
      write()
      if (typeof spawn !== 'function') return present()
      return hostSerial(async () => {
        const latest = lane.active.find(itemRun => itemRun.id === run.id) ?? run
        await handOff(item, latest)
        return present()
      })
    },
    reset(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const workflowId = String(body.workflowId ?? '')
      const runId = body.runId ? String(body.runId) : ''
      // Release first, then forget the ids (#1476, #1387). A failed release is
      // reported through `warn` rather than rejected, so a transition written
      // before the release would erase the only name of a Bot that is still
      // alive. Only the failed ids stay named; the ones that did go are dropped
      // because a retry must not ask the host to remove an id it already deleted
      // (that throws), and the next Stop, Reset, dispose() or reload retries.
      const forgetReleased = (runs, released) => {
        const gone = new Set(released)
        for (const run of runs) {
          for (const [nodeId, id] of Object.entries(run?.ephemeral ?? {})) {
            if (!gone.has(id)) continue
            delete run.ephemeral[nodeId]
          }
        }
      }
      if (runId) {
        const stopOne = () => {
          const item = workflow(workflowId)
          if (!item) return { ok: false, error: 'No such workflow' }
          const lane = laneOf(workflowId)
          const run = lane.active.find(itemRun => itemRun.id === runId)
          if (!run || run.live !== true || run.status !== 'running') return { ok: false, error: 'No live run to stop' }
          const ids = Object.values(run.ephemeral ?? {})
          const stop = () => {
            clearRunTimers(run.id)
            // Stopping one run ends it the same way a reap does: the node map settles
            // with the run, or the strip keeps painting the node it was on (#1424).
            const ended = { ...endRun(item, run, { code: 'stopped' }) }
            delete ended.ephemeral
            delete ended.handed
            delete ended.paused
            delete ended.releasePending
            lane.active = lane.active.filter(itemRun => itemRun.id !== runId)
            lane.last = ended
            lane.history = [...lane.history, historyRow(ended)].slice(-20)
            push(workflowId, [{
              kind: 'system',
              tone: 'bad',
              key: '■ Stopped · {task}',
              params: { task: summarizeTask(run.task) },
              text: `■ 已停止 · ${summarizeTask(run.task)}`,
            }], now())
            write()
          }
          // The run stays live with only the failed ids named, and it is paused
          // so handOff() dispatches nothing. Without releasePending a Resume
          // would move the graph to a node that has no Bot and wait forever.
          const hold = (failed) => {
            forgetReleased([run], ids.filter(id => !failed.includes(id)))
            run.paused = true
            run.releasePending = true
            run.updatedAt = now()
            push(workflowId, [{ kind: 'system', tone: 'bad', text: `停止失败：还有 ${failed.length} 个 Bot 没释放，再点一次停止。` }], now())
            write()
          }
          return { ok: true, ids, stop, hold }
        }
        if (typeof spawn !== 'function') {
          const saved = stopOne()
          if (saved.ok === false) return saved
          saved.stop()
          drainSync()
          return present()
        }
        return hostSerial(async () => {
          const saved = stopOne()
          if (saved.ok === false) return saved
          const failed = await releaseAll(saved.ids, release, warn)
          if (failed.length > 0) {
            saved.hold(failed)
            return present()
          }
          saved.stop()
          await drainAll()
          return present()
        })
      }
      const take = () => {
        const item = workflow(workflowId)
        if (!item) return { ok: false, error: 'No such workflow' }
        const lane = laneOf(workflowId)
        const live = lane.active[0] ?? (lane.last?.live === true ? lane.last : null)
        // A reset that cannot keep a task has to be refused before it touches
        // the lane: clearing first drops the queue, and a live run's Bot ids, on
        // a path that never writes or releases them.
        if (!live?.task) return { ok: false, error: 'This workflow has no task' }
        const ids = lane.active.flatMap(run => Object.values(run.ephemeral ?? {}))
        for (const run of lane.active) clearRunTimers(run.id)
        const resetLane = () => {
          lane.active = []
          lane.queue = []
          lane.last = { ...blankRun(item, live.task, now(), lane.history), id: live.id, startedAt: live.startedAt }
          push(item.id, linesFor(item, live.task, { type: 'reset' }), now())
          write()
        }
        // Every live run is left without the Bots that did go, so every one of
        // them is frozen, not just the run that named a failed id (#1476).
        const hold = (failed) => {
          forgetReleased(lane.active, ids.filter(id => !failed.includes(id)))
          for (const run of lane.active) {
            run.paused = true
            run.releasePending = true
            run.updatedAt = now()
          }
          push(item.id, [{ kind: 'system', tone: 'bad', text: `重置失败：还有 ${failed.length} 个 Bot 没释放，再点一次重置。` }], now())
          write()
        }
        return { ok: true, ids, resetLane, hold }
      }
      if (typeof spawn !== 'function') {
        const saved = take()
        if (saved.ok === false) return saved
        saved.resetLane()
        return present()
      }
      return hostSerial(async () => {
        const saved = take()
        if (saved.ok === false) return saved
        const failed = await releaseAll(saved.ids, release, warn)
        if (failed.length > 0) {
          saved.hold(failed)
          return present()
        }
        saved.resetLane()
        await drainAll()
        return present()
      })
    },
    // Replace the graph the canvas and the run share. Positions and edges
    // persist; a node that remains keeps its run status, a new one waits.
    // A node dropped while it is running takes its run with it: the run is
    // ended the way Stop/Reset/dispose end one, so nothing is left `running`
    // with no node to advance it and no way to release the lane (#1549).
    saveGraph(body = {}) {
      const endedRuns = []
      const saved = mutate(String(body.workflowId ?? ''), (item) => {
        // #1544: a save from a Bot records it as the graph's author; a save with no Bot behind it (the
        // canvas, the API, a template copy) is the owner's own edit and lifts the ceiling again.
        const authoredBy = cleanLine(body.callerBotId ?? body.authoredBy, 80) || undefined
        if (authoredBy) item.authoredBy = authoredBy
        else delete item.authoredBy
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
        const lane = laneOf(item.id)
        const liveRuns = lane.active.filter(itemRun => itemRun.live === true)
        if (lane.last?.live === true && !liveRuns.some(itemRun => itemRun.id === lane.last.id)) liveRuns.push(lane.last)
        const ids = new Set(next.nodes.map(node => node.id))
        for (const run of liveRuns) {
          // endRun settles the node map against the graph it ran on, so it must
          // see the old nodes; the next graph is applied after this loop.
          const dropped = orderedIds(item, run.nodeStatus, 'running').filter(id => !ids.has(id))
          const names = dropped.map(id => nodeById(item, id)?.name ?? id)
          const ended = dropped.length > 0
          const settled = ended ? endRun(item, run, { code: 'stopped' }) : run
          // A run that continues settles against the new graph, so a node this edit
          // dropped leaves its map. A run this edit ended keeps its own map — the
          // failed node included — the way reset() and dispose() keep theirs (#1424).
          let nodeStatus = settled.nodeStatus ?? {}
          if (!ended) {
            nodeStatus = {}
            for (const id of ids) nodeStatus[id] = settled.nodeStatus?.[id] ?? 'queued'
          }
          const nextRun = { ...settled, nodeStatus, updatedAt: now() }
          if (ended) endedRuns.push({ run: nextRun, names })
          else if (lane.active.some(itemRun => itemRun.id === run.id)) storeRun(item.id, nextRun)
          else if (lane.last?.id === run.id) lane.last = nextRun
          syncTimers(item, nextRun)
        }
        item.nodes = next.nodes
        item.edges = next.edges
        item.layers = next.layers
        for (const { run, names } of endedRuns) {
          lane.active = lane.active.filter(itemRun => itemRun.id !== run.id)
          lane.last = run
          lane.history = [...lane.history, historyRow(run)].slice(-20)
          push(item.id, [{ kind: 'system', tone: 'bad', text: `■ 已停止 · ${summarizeTask(run.task)}（图编辑删除了正在运行的节点：${names.join('、')}）` }], now())
        }
      })
      if (saved.ok === false || endedRuns.length === 0) return saved
      const releasing = endedRuns.flatMap(({ run }) => Object.values(run.ephemeral ?? {}))
      // Release first, then forget the ids (#1616): a run this edit ended that
      // dropped its Bot before the host really removed it leaves a hidden Bot no
      // record names again. Only a failed id stays on the archived run, and the
      // next load's reap() retries it (#1621).
      const forget = (failed) => {
        for (const { run } of endedRuns) {
          keepUnreleased(run, failed)
          delete run.handed
        }
      }
      if (typeof spawn !== 'function' || typeof release !== 'function' || releasing.length === 0) {
        forget([])
        write()
        drainSync()
        return present()
      }
      return hostSerial(async () => {
        const failed = await releaseAll(releasing, release, warn)
        forget(failed)
        write()
        await drainAll()
        return present()
      })
    },
    // A Bot (or the owner) writes a graph. A name that already exists is replaced.
    define(body = {}) {
      // #1544: the graph remembers the Bot that wrote it, so a run nobody's tool call started is still
      // capped by the switches of the Bot that chose the node's `tools`.
      const authoredBy = cleanLine(body.callerBotId, 80) || undefined
      const existing = body.workflow ? findWorkflow(body.workflow) : undefined
      if (existing) {
        const finish = () => {
          const name = cleanLine(body.name, 80)
          if (name) {
            existing.name = name
            write()
          }
          return present()
        }
        const saved = this.saveGraph({ workflowId: existing.id, nodes: body.nodes, edges: body.edges ?? [], ...(authoredBy ? { authoredBy } : {}) })
        // saveGraph returns a promise when the edit had to end a live run.
        if (typeof saved?.then === 'function') return saved.then(value => (value?.ok === false ? value : finish()))
        if (saved.ok === false) return saved
        return finish()
      }
      return this.create({ name: body.name, nodes: body.nodes, edges: body.edges ?? [], description: body.description, ...(authoredBy ? { authoredBy } : {}) })
    },
    // Start a named workflow. `brief` is the task title; `task` is its id.
    runNamed(body = {}) {
      const item = findWorkflow(body.workflow)
      if (!item) return { ok: false, error: 'No such workflow' }
      const title = cleanLine(body.brief || body.title, 300)
      if (!title) return { ok: false, error: 'A run needs a brief' }
      const taskId = cleanLine(body.task || body.taskId, 80) || `task-${now().toString(36)}`
      return this.assign({ workflowId: item.id, taskId, title, ...(body.callerBotId ? { callerBotId: body.callerBotId } : {}) })
    },
    // Auto-assign an open board task. A miss leaves the task untouched.
    // A stored claim is not a life sentence (#1647): when the card itself now
    // names another live target, the task is matched again and the claim its route
    // travel to the new target together. A trigger, or a card that names nothing,
    // keeps it; a card that names a target it cannot match (it has left `open`)
    // keeps it too, and nothing is written. Passing `rematch: true` drops that one
    // claim first — the panel's per-task action.
    ingest(task = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const taskId = cleanLine(task.id, 80)
      if (!taskId) return { ok: false, error: 'A task needs an id' }
      if (task.rematch === true && forgetClaim(taskId)) write()
      const claimed = state.claims[taskId]
      const held = claimed?.kind === 'bot' || claimed?.kind === 'workflow' ? claimed : undefined
      let decision = held
      if (held !== undefined) {
        const named = namedTarget(task, { workflows: state.workflows, bots: bots() ?? [] })
        if (!named || (named.kind === held.kind && named.id === held.id)) {
          return { ok: true, matched: true, already: true, decision: held }
        }
        // The card names another target. Match it before touching the stored claim:
        // a card that has left `open` matches nothing, and must keep the claim and
        // route it has rather than lose both with no new holder (#1647). The write
        // that attaches the new target replaces the pair in one go.
        const next = matchTask(task, { workflows: state.workflows, bots: bots() ?? [] })
        if (!next) return { ok: true, matched: false }
        decision = next
      }
      if (decision === undefined) {
        decision = matchTask(task, { workflows: state.workflows, bots: bots() ?? [] })
        if (!decision) {
          // A rematch on a task that now names nothing leaves it unassigned, and
          // says so; the claim it dropped is already on disk.
          return { ok: true, matched: false }
        }
      }
      const key = `${decision.kind}:${decision.id}`
      const prev = state.routes[taskId]
      if (prev?.key === key) return { ok: true, matched: true, already: true, decision }
      if (decision.kind === 'bot') {
        rememberClaim(taskId, decision)
        write()
        return { ok: true, matched: true, already: false, decision }
      }
      if (queuedOrRunning(decision.id, taskId)) {
        rememberClaim(taskId, decision)
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
    // #1696: the host's Project board reads the run behind a card through this method. A run
    // names the core card it holds or consumed (`run.task.id`), never a second task; the host
    // supplies `hasTask`, so this side never reads `state.tasks` and a run whose card is gone
    // is dropped instead of becoming a row of its own.
    projectTasks({ hasTask } = {}) {
      const exists = typeof hasTask === 'function' ? hasTask : () => true
      const rows = []
      const seen = new Set()
      for (const [workflowId, lane] of Object.entries(state.lanes ?? {})) {
        for (const run of [...(lane.active ?? []), lane.last].filter(Boolean)) {
          const taskId = typeof run?.task?.id === 'string' ? run.task.id : ''
          if (taskId === '' || seen.has(taskId) || !exists(taskId)) continue
          seen.add(taskId)
          const item = workflow(workflowId)
          const running = item === undefined ? [] : orderedIds(item, run.nodeStatus, 'running')
          const nodeId = running[0] ?? Object.keys(run.handed ?? {})[0]
          rows.push({ taskId, runId: run.id, ...(nodeId === undefined ? {} : { nodeId }) })
        }
      }
      return rows
    },
    reap() {
      if (typeof release !== 'function') return Promise.resolve()
      const stale = []
      const staleRuns = []
      const abandoned = []
      const orphans = orphanIds(state)
      let wrote = false
      for (const [workflowId, lane] of Object.entries(state.lanes ?? {})) {
        const seen = new Set()
        for (const run of [...(lane.active ?? []), lane.last].filter(Boolean)) {
          if (seen.has(run)) continue
          seen.add(run)
          const hasEphemeral = run?.ephemeral && Object.keys(run.ephemeral).length > 0
          const zombie = run?.live === true && run.status === 'running' && !hasEphemeral
          if (!hasEphemeral && !zombie) continue
          // A run still marked running here was cut off with the host that ran it,
          // and nothing resumes it: its instances are abandoned, not in progress.
          // Release them and end the run, or they stay hidden with no way to remove
          // them. A run that already ended keeps its own status (#1388). A zombie
          // is a run dispose() already stripped: heal it on load (#1414).
          if (run.status === 'running') {
            abandoned.push({ workflowId, run })
            continue
          }
          if (hasEphemeral) {
            clearRunTimers(run.id)
            stale.push(...Object.values(run.ephemeral))
            staleRuns.push(run)
            delete run.handed
            wrote = true
          }
        }
      }
      for (const { workflowId, run } of abandoned) {
        try {
          clearRunTimers(run.id)
          if (run.ephemeral) stale.push(...Object.values(run.ephemeral))
          endRun(workflow(workflowId), run, { code: 'host-ended' })
          push(workflowId, [failureLine(run)], now())
          staleRuns.push(run)
          delete run.handed
          archiveCutoffRun(workflowId, run)
          wrote = true
        } catch (error) {
          warn(`flybot-workflow: could not end ${run.id}: ${error?.message ?? error}`)
        }
      }
      if (stale.length === 0 && orphans.length === 0 && !wrote) return Promise.resolve()
      if (stale.length === 0 && orphans.length === 0) {
        write()
        return Promise.resolve()
      }
      return releaseAll([...new Set([...stale, ...orphans])], release, warn).then((failed) => {
        // Only the ids the host really removed leave the record. A failed one
        // stays named so this same path retries it on the next load (#1616).
        for (const run of staleRuns) keepUnreleased(run, failed)
        // #1621: a deleted workflow's Bot has no lane left to name it, so it is
        // the orphan list that keeps a failed id — the same entry, retried until
        // the host really removes it.
        state.orphans = orphans.filter(id => failed.includes(id))
        if (state.orphans.length === 0) delete state.orphans
        write()
      })
    },
    dispose() {
      for (const key of [...timers.keys()]) clearTimerAt(key)
      const ids = []
      const runs = []
      let endedLive = false
      for (const [workflowId, lane] of Object.entries(state.lanes ?? {})) {
        // Collect before archiving: archiveCutoffRun removes the run from
        // `active` and makes it `last`, so a collection after the loop names
        // only the run archived last and leaks every earlier run's Bots (#1472).
        const live = [...(lane.active ?? [])]
        runs.push(...[...live, lane.last].filter(Boolean))
        for (const run of live) {
          if (run?.live === true && run.status === 'running') {
            endRun(workflow(workflowId), run, { code: 'host-ended' })
            archiveCutoffRun(workflowId, run)
            endedLive = true
          }
        }
      }
      for (const run of runs) ids.push(...Object.values(run?.ephemeral ?? {}))
      // Release first, then forget the ids (#1387). End live runs before the
      // record drops ephemeral so nothing is persisted as running without a map
      // (#1414). A record that drops an id before its Bot is gone leaves a hidden
      // Bot that no state names, so nothing can ever find it again. releaseAll
      // reports a failed id through `warn` instead of rejecting, so one bad
      // release cannot skip the write. The caller awaits this: a disposer that
      // returns before the Bots are gone is not a cleanup.
      const shouldWrite = ids.length > 0 || endedLive
      return releaseAll(ids, release, warn).then((failed) => {
        for (const run of runs) {
          keepUnreleased(run, failed)
          delete run.handed
        }
        if (shouldWrite) write()
      })
    },
  }
}

// #1621: an id whose release still failed after the record that named it was
// erased — a workflow delete — has no lane left to retry from. `state.orphans` is
// its only name, so it lives in the store itself and reap() retries it on every
// load. The same id is listed once, and the list has a ceiling: a host that never
// comes back must not grow the store forever.
function orphanIds(state) {
  const ids = []
  for (const id of Array.isArray(state.orphans) ? state.orphans : []) {
    if (typeof id !== 'string' || id === '' || ids.includes(id)) continue
    ids.push(id)
  }
  return ids.slice(-MAX_ORPHANS)
}

function noteOrphans(state, ids) {
  const kept = orphanIds(state)
  for (const id of ids ?? []) {
    if (typeof id !== 'string' || id === '' || kept.includes(id)) continue
    kept.push(id)
  }
  state.orphans = kept.slice(-MAX_ORPHANS)
  if (state.orphans.length === 0) delete state.orphans
}

// releaseAll() reports the ids it could not remove, and those Bots are still
// there. A record that forgets one leaves a hidden Bot that no state can name
// again, so keep exactly those named and drop the ids the host did remove (a
// second remove of a gone id throws, #1476). The next load's reap() retries the
// rest (#1616).
function keepUnreleased(run, failed) {
  if (!run?.ephemeral) return
  for (const [nodeId, id] of Object.entries(run.ephemeral)) {
    if (!failed.includes(id)) delete run.ephemeral[nodeId]
  }
  if (Object.keys(run.ephemeral).length === 0) delete run.ephemeral
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

function emptyLane() {
  return { active: [], queue: [], last: null, history: [] }
}

function seed() {
  const delivery = normalizeGraph(deliveryWorkflow())
  const weekly = normalizeGraph(weeklyWorkflow())
  return {
    version: 1,
    workflows: [delivery, weekly],
    runs: {},
    lanes: { [DELIVERY_ID]: emptyLane(), [WEEKLY_ID]: emptyLane() },
    claims: {},
    routes: {},
    logs: { [DELIVERY_ID]: [], [WEEKLY_ID]: [] },
    seq: 0,
    laneFormat: true,
  }
}

function purgeDemos(state, historyRow) {
  if (!state.demos || typeof state.demos !== 'object') {
    delete state.demos
    return
  }
  for (const [id, run] of Object.entries(state.demos)) {
    if (!run || typeof run !== 'object') continue
    const lane = state.lanes[id] ?? emptyLane()
    const finished = run.status === 'done' || run.status === 'failed'
    if (finished && run.task) {
      lane.history = [...lane.history, historyRow(run)].slice(-20)
    }
    if (lane.last?.live !== true) lane.last = null
    state.lanes[id] = lane
  }
  delete state.demos
}

function migrateRuns(state) {
  state.lanes ??= {}
  state.claims ??= {}
  // #1621: ids of the run Bots a deleted workflow could not release. They are
  // the store's only record of those Bots, so an upgrade keeps them (deduped and
  // capped) and reap() retries them afterwards.
  noteOrphans(state, [])
  // #1632: a store written while delete() left its claims behind holds claims
  // for workflows that no longer exist, and ingest() would trust them forever.
  for (const [taskId, claim] of Object.entries(state.claims)) {
    if (claim?.kind === 'workflow' && !(state.workflows ?? []).some(item => item?.id === claim.id)) {
      delete state.claims[taskId]
    }
  }
  if (state.laneFormat === true) return
  for (const [id, run] of Object.entries(state.runs ?? {})) {
    if (!run || typeof run !== 'object' || state.lanes[id]) continue
    const history = Array.isArray(run.history) ? run.history.filter(item => item?.status === 'done' || item?.status === 'failed') : []
    const bots = run.ephemeral && typeof run.ephemeral === 'object' ? Object.keys(run.ephemeral) : []
    if (bots.length > 0 && run.status === 'running') {
      state.lanes[id] = { active: [{ ...run, live: true }], queue: [], last: null, history }
      continue
    }
    const finished = run.status === 'done' || run.status === 'failed'
    state.lanes[id] = {
      active: [],
      queue: [],
      last: finished && run.live === true ? { ...run, live: true } : null,
      history: finished && run.task
        ? [...history, { task: run.task, status: run.status, at: run.updatedAt ?? 0 }].slice(-20)
        : history,
    }
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
