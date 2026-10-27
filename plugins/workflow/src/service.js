// Workflow records and the run that a board task starts. The graph rules live
// in graph.js; this file stores workflows, appends the chat, and refuses a
// remote Bot or a read-only host. A task id is recorded on the run. v1 does
// not start a model turn: each step posts the progress line and moves the node.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chainLabel, cleanLine, completeNode, doneCount, failNode, freshStatus, layerMarks,
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

export function createWorkflowService({ dir, persist = true, now = () => Date.now(), bots = () => [], readOnly = () => false, warn = () => {} } = {}) {
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
    const steps = finished ? run.stepBudget : run.steps + 1
    const history = finished
      ? [...(run.history ?? []), { task: run.task, status: 'done', at: now() }].slice(-20)
      : (run.history ?? [])
    const next = {
      ...run,
      status: finished ? 'done' : 'running',
      nodeStatus: result.status,
      steps,
      failedOnce,
      history,
      updatedAt: now(),
    }
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
        const roster = bots() ?? []
        const nodes = (body.nodes ?? []).map(node => {
          const botId = node?.botId ? String(node.botId) : ''
          const bot = botId ? roster.find(item => item.id === botId) : undefined
          if (botId && !bot) throw new Error('No such Bot')
          if (bot?.remote === true) throw new Error('A workflow seats local Bots only')
          return {
            id: cleanLine(node.id, 40).toLowerCase(),
            name: cleanLine(node.name || bot?.name, 80),
            role: cleanLine(node.role || bot?.role, 80),
            instructions: cleanLine(node.instructions || bot?.instructions, 500),
            ...(botId ? { botId } : {}),
            ...(node.failOnce === true ? { failOnce: true } : {}),
          }
        })
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
    assign(body = {}) {
      return mutate(String(body.workflowId ?? ''), (item) => {
        const task = { id: cleanLine(body.taskId ?? body.id, 80), title: cleanLine(body.title, 300) }
        if (!task.id || !task.title) throw new Error('A task needs an id and a title')
        const previous = state.runs[item.id]
        const history = previous ? [...(previous.history ?? []), { task: previous.task, status: previous.status, at: previous.updatedAt }].slice(-20) : []
        let run = blankRun(item, task, now(), history)
        const at = now()
        push(item.id, [
          { kind: 'time', text: '刚刚' },
          { kind: 'system', text: `来自 Tasks 看板：${task.id} ${task.title} → 分配给 Workflow「${item.name}」` },
        ], at)
        const stepped = applyOp(item, run, { type: 'start' })
        run = stepped.run
        push(item.id, stepped.lines, at)
        state.runs[item.id] = run
      })
    },
    advance(body = {}) {
      return mutate(String(body.workflowId ?? ''), (item) => {
        const run = state.runs[item.id]
        if (!run || run.status === 'idle') throw new Error('This workflow has no running task')
        if (run.status === 'done') throw new Error('This run is already finished')
        const outcome = body.outcome === 'failed' ? 'fail' : 'complete'
        const stepped = applyOp(item, run, { type: outcome, nodeId: String(body.nodeId ?? '') })
        state.runs[item.id] = stepped.run
        push(item.id, stepped.lines, now())
      })
    },
    demoStep(body = {}) {
      return mutate(String(body.workflowId ?? ''), (item) => {
        let run = state.runs[item.id]
        if (!run) throw new Error('This workflow has no task')
        const op = nextDemoOp(item, run.nodeStatus, { failedOnce: run.failedOnce })
        if (op.type === 'restart') {
          run = blankRun(item, run.task, now(), run.history)
          push(item.id, [{ kind: 'time', text: '重新演示' }], now())
        }
        const stepped = applyOp(item, run, op.type === 'restart' ? { type: 'start' } : op)
        state.runs[item.id] = stepped.run
        push(item.id, stepped.lines, now())
      })
    },
    reset(body = {}) {
      return mutate(String(body.workflowId ?? ''), (item) => {
        const run = state.runs[item.id]
        if (!run) throw new Error('This workflow has no task')
        const kept = { ...blankRun(item, run.task, now(), run.history), id: run.id, startedAt: run.startedAt }
        state.runs[item.id] = kept
        push(item.id, linesFor(item, run.task, { type: 'reset' }), now())
      })
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
        if (assigned.ok === false) return assigned
        state.routes[taskId] = { key, kind: decision.kind, id: decision.id, at: now() }
        write()
        return { ...present(), matched: true, already: false, decision }
      }
      state.routes[taskId] = { key, kind: decision.kind, id: decision.id, at: now() }
      write()
      return { ok: true, matched: true, already: false, decision }
    },
    dispose() {},
  }
}

function seat(nodes, roster) {
  return (nodes ?? []).map(node => {
    const botId = node?.botId ? String(node.botId) : ''
    const bot = botId ? roster.find(item => item.id === botId) : undefined
    if (botId && !bot) throw new Error('No such Bot')
    if (bot?.remote === true) throw new Error('A workflow seats local Bots only')
    return {
      id: cleanLine(node.id, 40).toLowerCase(),
      name: cleanLine(node.name || bot?.name, 80),
      role: cleanLine(node.role || bot?.role, 80),
      instructions: cleanLine(node.instructions || bot?.instructions, 500),
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
