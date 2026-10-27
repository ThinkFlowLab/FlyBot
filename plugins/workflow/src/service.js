// Workflow records and the run that a board task starts. The graph rules live
// in graph.js; this file stores workflows, appends the chat, and refuses a
// remote Bot or a read-only host. A task id is recorded on the run. Progress
// lines stay scripted. With a spawn hook, each node also gets a run Bot.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseAll, spawnAll } from './ephemeral.js'
import {
  chainLabel, cleanLine, cleanPrompt, cleanTools, completeNode, doneCount, failNode, freshStatus, layerMarks,
  nextDemoOp, nodeById, normalizeGraph, orderedIds, retryNode, rowPreview, startFrontier, validateGraph,
} from './graph.js'
import { matchTask } from './match.js'
import { linesFor } from './narrate.js'
import { DELIVERY_ID, DELIVERY_STEPS, WEEKLY_ID, deliveryWorkflow, fixtureTask, templateById, templateCatalog, weeklyWorkflow } from './template.js'

const MAX_WORKFLOWS = 24
const MAX_MESSAGES = 200
const FILE = 'workflows.json'

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
    x: node.x,
    y: node.y,
  }
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
    history,
    startedAt: now,
    updatedAt: now,
  }
}

export function createWorkflowService({ dir, persist = true, now = () => Date.now(), bots = () => [], readOnly = () => false, warn = () => {}, spawn, release, dispatch } = {}) {
  const file = dir ? join(dir, FILE) : null
  let state = load(file, warn) ?? seed(now())
  state.routes ??= {}
  let seq = state.seq ?? 1

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
        edges: (item.edges ?? []).map(edge => ({ from: edge.from, to: edge.to })),
        layers: item.layers.map(layer => [...layer]),
        triggers: [...(item.triggers ?? [])],
        chain: chainLabel(item),
        preview: rowPreview(item, state.runs[item.id]),
        run: publicRun(item, state.runs[item.id]),
        messages: state.logs[item.id] ?? [],
      }) }),
    }
  }

  function refuse(error) {
    return { ok: false, error: error?.message ?? String(error) }
  }

  function applyOp(item, run, op) {
    let result
    if (op.type === 'start') result = { ...startFrontier(item, run.nodeStatus), joined: false, layerSize: 0 }
    else if (op.type === 'complete') result = completeNode(item, run.nodeStatus, op.nodeId)
    else if (op.type === 'fail') result = failNode(item, run.nodeStatus, op.nodeId)
    else if (op.type === 'retry') result = retryNode(item, run.nodeStatus, op.nodeId)
    else throw new Error(`Unknown step ${op.type}`)
    const failedOnce = { ...run.failedOnce }
    if (op.type === 'fail') failedOnce[op.nodeId] = true
    const finished = result.finished === true
    // A node marked failOnce is retried by the demo player. Any other failure
    // stops the run, which is what releases its ephemeral Bots.
    const stopped = op.type === 'fail' && nodeById(item, op.nodeId)?.failOnce !== true
    const steps = finished ? run.stepBudget : run.steps + 1
    const history = finished || stopped
      ? [...(run.history ?? []), { task: run.task, status: finished ? 'done' : 'failed', at: now() }].slice(-20)
      : (run.history ?? [])
    const handed = { ...run.handed }
    if (op.type === 'fail') delete handed[op.nodeId]
    const next = {
      ...run,
      status: finished ? 'done' : stopped ? 'failed' : 'running',
      nodeStatus: result.status,
      steps,
      failedOnce,
      history,
      updatedAt: now(),
      ...(Object.keys(handed).length > 0 ? { handed } : {}),
    }
    if (Object.keys(handed).length === 0) delete next.handed
    const event = {
      type: op.type,
      nodeId: op.nodeId,
      started: result.started ?? [],
      joined: result.joined === true,
      finished,
      layerSize: result.layerSize ?? 0,
    }
    return { run: next, lines: linesFor(item, run.task, event) }
  }

  async function handOff(item, run) {
    if (typeof dispatch !== 'function' || !run?.ephemeral) return
    const running = orderedIds(item, run.nodeStatus, 'running')
    let wrote = false
    for (const nodeId of running) {
      if (run.handed?.[nodeId]) continue
      const node = nodeById(item, nodeId)
      const botId = run.ephemeral[nodeId]
      if (!botId || !node) continue
      const answer = await dispatch({
        botId,
        nodeId,
        name: node.name,
        role: node.role ?? '',
        prompt: node.prompt ?? node.instructions ?? '',
        model: node.model ?? '',
        tools: node.tools ?? [],
        brief: run.task?.title ?? '',
        taskId: run.task?.id ?? '',
      })
      // A refused step is not handed over: leave it unmarked so the next settle
      // tries again, and say why in one line — otherwise the run stalls silently.
      if (answer?.ok === false) {
        warn(`flybot-workflow: step ${nodeId} was not handed over: ${answer.code ?? 'dispatch refused'}`)
        continue
      }
      run.handed = { ...run.handed, [nodeId]: true }
      wrote = true
    }
    if (wrote) write()
  }

  async function settle(workflowId) {
    const item = workflow(workflowId)
    const run = item ? state.runs[workflowId] : undefined
    if (!item || !run || typeof spawn !== 'function') return present()
    try {
      await handOff(item, run)
    } catch (error) {
      await releaseAll(Object.values(run.ephemeral ?? {}), release, warn)
      delete run.ephemeral
      delete run.handed
      run.status = 'failed'
      run.updatedAt = now()
      write()
      return refuse(error)
    }
    if (run.status === 'done' || run.status === 'failed') {
      await releaseAll(Object.values(run.ephemeral ?? {}), release, warn)
      delete run.ephemeral
      delete run.handed
      write()
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
        state.workflows.push(item)
        const memberNames = item.nodes.map(node => node.name).join('、')
        push(item.id, [{ kind: 'system', text: `Workflow「${item.name}」已创建 · 成员 ${memberNames}` }], now())
        write()
        return present()
      } catch (error) {
        return refuse(error)
      }
    },
    // A board task starts a run at the first layer and posts the claim line.
    // With a spawn hook, each node gets an ephemeral Bot before the first step.
    assign(body = {}) {
      if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
      const workflowId = String(body.workflowId ?? '')
      const item = workflow(workflowId)
      if (!item) return { ok: false, error: 'No such workflow' }
      const task = { id: cleanLine(body.taskId ?? body.id, 80), title: cleanLine(body.title, 300) }
      if (!task.id || !task.title) return { ok: false, error: 'A task needs an id and a title' }
      const go = (ephemeral) => mutate(workflowId, (row) => {
        const previous = state.runs[row.id]
        const history = previous ? [...(previous.history ?? []), { task: previous.task, status: previous.status, at: previous.updatedAt }].slice(-20) : []
        let run = blankRun(row, task, now(), history)
        if (ephemeral) run.ephemeral = ephemeral
        const at = now()
        push(row.id, [
          { kind: 'time', text: '刚刚' },
          { kind: 'system', text: `来自 Tasks 看板：${task.id} ${task.title} → 分配给 Workflow「${row.name}」` },
        ], at)
        const stepped = applyOp(row, run, { type: 'start' })
        run = stepped.run
        push(row.id, stepped.lines, at)
        state.runs[row.id] = run
      })
      if (typeof spawn !== 'function') return go(undefined)
      return (async () => {
        const previousIds = Object.values(state.runs[workflowId]?.ephemeral ?? {})
        let ephemeral
        try {
          ephemeral = await spawnAll(item.nodes, bots() ?? [], spawn)
        } catch (error) {
          await releaseAll(error.spawned ?? [], release, warn)
          return refuse(error)
        }
        const saved = go(ephemeral)
        if (saved.ok === false) {
          await releaseAll(Object.values(ephemeral), release, warn)
          return saved
        }
        await releaseAll(previousIds, release, warn)
        return settle(workflowId)
      })()
    },
    advance(body = {}) {
      const workflowId = String(body.workflowId ?? '')
      const outcome = body.outcome === 'failed' ? 'fail' : 'complete'
      const nodeId = String(body.nodeId ?? '')
      const step = () => mutate(workflowId, (item) => {
        const run = state.runs[item.id]
        if (!run || run.status === 'idle') throw new Error('This workflow has no running task')
        if (run.status === 'done' || run.status === 'failed') throw new Error('This run is already finished')
        const stepped = applyOp(item, run, { type: outcome, nodeId })
        state.runs[item.id] = stepped.run
        push(item.id, stepped.lines, now())
      })
      if (typeof spawn !== 'function') return step()
      return (async () => {
        const saved = step()
        if (saved.ok === false) return saved
        return settle(workflowId)
      })()
    },
    demoStep(body = {}) {
      const workflowId = String(body.workflowId ?? '')
      const step = (ephemeral) => mutate(workflowId, (item) => {
        let run = state.runs[item.id]
        if (!run) throw new Error('This workflow has no task')
        if (run.status === 'failed') throw new Error('This run is already finished')
        const op = nextDemoOp(item, run.nodeStatus, { failedOnce: run.failedOnce })
        if (op.type === 'restart') {
          run = blankRun(item, run.task, now(), run.history)
          if (ephemeral) run.ephemeral = ephemeral
          push(item.id, [{ kind: 'time', text: '重新演示' }], now())
        } else if (ephemeral && op.type === 'start') {
          run = { ...run, ephemeral }
        }
        const stepped = applyOp(item, run, op.type === 'restart' ? { type: 'start' } : op)
        state.runs[item.id] = stepped.run
        push(item.id, stepped.lines, now())
      })
      if (typeof spawn !== 'function') return step(undefined)
      return (async () => {
        if (readOnly()) return { ok: false, code: 'read-only', error: 'The host is read-only' }
        const item = workflow(workflowId)
        if (!item) return { ok: false, error: 'No such workflow' }
        const run = state.runs[item.id]
        if (!run) return { ok: false, error: 'This workflow has no task' }
        if (run.status === 'failed') return { ok: false, error: 'This run is already finished' }
        const op = nextDemoOp(item, run.nodeStatus, { failedOnce: run.failedOnce })
        let ephemeral
        let previousIds = []
        if (op.type === 'restart' || op.type === 'start') {
          previousIds = Object.values(run.ephemeral ?? {})
          try {
            ephemeral = await spawnAll(item.nodes, bots() ?? [], spawn)
          } catch (error) {
            await releaseAll(error.spawned ?? [], release, warn)
            return refuse(error)
          }
        }
        const saved = step(ephemeral)
        if (saved.ok === false) {
          if (ephemeral) await releaseAll(Object.values(ephemeral), release, warn)
          return saved
        }
        await releaseAll(previousIds, release, warn)
        return settle(workflowId)
      })()
    },
    reset(body = {}) {
      const workflowId = String(body.workflowId ?? '')
      const step = () => mutate(workflowId, (item) => {
        const run = state.runs[item.id]
        if (!run) throw new Error('This workflow has no task')
        const kept = { ...blankRun(item, run.task, now(), run.history), id: run.id, startedAt: run.startedAt }
        state.runs[item.id] = kept
        push(item.id, linesFor(item, run.task, { type: 'reset' }), now())
      })
      if (typeof spawn !== 'function') return step()
      return (async () => {
        const ids = Object.values(state.runs[workflowId]?.ephemeral ?? {})
        const saved = step()
        if (saved.ok === false) return saved
        await releaseAll(ids, release, warn)
        return present()
      })()
    },
    say(body = {}) {
      return mutate(String(body.workflowId ?? ''), (item) => {
        const text = cleanLine(body.text, 2000)
        if (!text) throw new Error('A message needs text')
        const at = now()
        const lines = [{ kind: 'user', text }]
        const run = state.runs[item.id]
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
        const run = state.runs[item.id]
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
      const decision = matchTask(task, { workflows: state.workflows, bots: bots() ?? [] })
      if (!decision) return { ok: true, matched: false }
      const taskId = cleanLine(task.id, 80)
      if (!taskId) return { ok: false, error: 'A task needs an id' }
      const key = `${decision.kind}:${decision.id}`
      const prev = state.routes[taskId]
      if (prev?.key === key) return { ok: true, matched: true, already: true, decision }
      if (decision.kind === 'workflow') {
        const run = state.runs[decision.id]
        const live = run && run.task?.id === taskId && run.status === 'running'
        if (live) {
          state.routes[taskId] = { key, kind: decision.kind, id: decision.id, at: now() }
          write()
          return { ok: true, matched: true, already: true, decision }
        }
        const title = cleanLine(task.title, 300)
        if (!title) return { ok: false, error: 'A task needs a title' }
        const assigned = this.assign({ workflowId: decision.id, taskId, title })
        const finish = (value) => {
          if (value?.ok === false) return value
          state.routes[taskId] = { key, kind: decision.kind, id: decision.id, at: now() }
          write()
          return { ...present(), matched: true, already: false, decision }
        }
        if (typeof assigned?.then === 'function') return assigned.then(finish)
        return finish(assigned)
      }
      state.routes[taskId] = { key, kind: decision.kind, id: decision.id, at: now() }
      write()
      return { ok: true, matched: true, already: false, decision }
    },
    reap() {
      if (typeof release !== 'function') return Promise.resolve()
      const stale = []
      for (const run of Object.values(state.runs)) {
        if (!run?.ephemeral) continue
        if (run.status === 'running') continue
        stale.push(...Object.values(run.ephemeral))
        delete run.ephemeral
        delete run.handed
      }
      if (stale.length === 0) return Promise.resolve()
      return releaseAll(stale, release, warn).then(() => { write() })
    },
    dispose() {
      const ids = Object.values(state.runs).flatMap(run => Object.values(run?.ephemeral ?? {}))
      for (const run of Object.values(state.runs)) {
        if (!run) continue
        delete run.ephemeral
        delete run.handed
      }
      if (ids.length > 0) write()
      void releaseAll(ids, release, warn)
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
    return {
      id: cleanLine(node.id, 40).toLowerCase(),
      name: cleanLine(node.name || bot?.name, 80),
      role: cleanLine(node.role || bot?.role, 80),
      instructions: cleanLine(node.instructions || bot?.instructions, 500),
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(tools.length ? { tools } : {}),
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
  return { version: 1, workflows: [delivery, weekly], runs, logs, seq }
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
