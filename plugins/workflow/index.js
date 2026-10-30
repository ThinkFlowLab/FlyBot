// @flybot/workflow host plugin. Stores workflow graphs and runs under
// $DSH_HOME/bot/flybot-workflow and answers the chat surface on workflow/*.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { permissionFor } from './src/ephemeral.js'
import { createWorkflowService } from './src/service.js'

function runnerName(base, taken) {
  const stem = String(base ?? 'Workflow').replace(/[@`\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Workflow'
  for (let n = 0; n < 6; n += 1) {
    const name = `${stem} ${randomBytes(2).toString('hex')}`.slice(0, 40)
    if (!taken.has(name)) return name
  }
  return `${stem} ${randomBytes(3).toString('hex')}`.slice(0, 40)
}

export const name = 'flybot-workflow'
export const inject = ['flybot']

export function apply(ctx, config = {}) {
  if (config?.enabled === false) return { enabled: false, dispose() {} }
  if (!ctx?.flybot || typeof ctx.flybot.scope !== 'function') {
    throw new Error('@flybot/workflow needs ctx.flybot.scope (flybot API v1)')
  }
  const fb = ctx.flybot.scope('flybot-workflow')
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  const persist = config.persist !== false
  // The runner names held by the ephemeral Bots this plugin spawned, keyed by
  // Bot id, so a release gives its name back instead of keeping it for the
  // lifetime of the process (#1387).
  const liveNames = new Map()
  const lifecycle = typeof fb.bot?.create === 'function' ? {
    async spawn(spec) {
      // A node Bot keeps the file and shell rights a normal sidebar Bot has (permissionFor()).
      // spec.tools only selects connectors: the host records it as stepTools, and connector-access.js
      // then allows mcp__github__*/mcp__composio__* only for a connector the node named, refusing
      // every other one, so a node that declares nothing reaches no connector. EPHEMERAL_DENIED_TOOLS
      // still refuses the team tools whatever the node declares.
      const prompt = spec.prompt
      let last
      for (let n = 0; n < 4; n += 1) {
        const taken = new Set([...(fb.bot.list?.() ?? []).map(bot => bot.name), ...liveNames.keys()])
        const name = runnerName(spec.name, taken)
        try {
          const id = await fb.bot.create({
            name,
            role: spec.role || '',
            instructions: prompt,
            systemPrompt: prompt,
            ...(spec.model ? { model: spec.model } : {}),
            hidden: true,
            ephemeral: true,
            permission: permissionFor(),
            tools: spec.tools,
            // #1544/#1582: whose switches cap the run's connectors. The caller is in `cappedBy` with
            // the graph's author; the run Bot carries no `createdBy`, which the roster reads as a maker.
            ...(spec.cappedBy ? { cappedBy: spec.cappedBy } : {}),
            fields: { nodeId: spec.nodeId, tools: spec.tools ?? null },
          })
          liveNames.set(name, id)
          return id
        } catch (error) {
          last = error
          if (!/already exists/.test(String(error?.message ?? error))) throw error
        }
      }
      throw last
    },
    release(id) {
      // The instance is going away, so its name is free again. Without this the
      // allocator treats every name this process ever handed out as taken.
      for (const [name, owner] of liveNames) if (owner === id) liveNames.delete(name)
      if (typeof fb.bot.remove !== 'function') return undefined
      // Tombstoning now happens in removeBot (hooks.js) before deleteBot (#1524)
      return fb.bot.remove(id)
    },
    async dispatch(step) {
      const from = (fb.bot.list?.() ?? []).find(bot => bot.isMain)?.id
      if (!from || typeof fb.bot.send !== 'function') return { ok: false, code: 'no-sender' }
      const lines = [`Task ${step.taskId}: ${step.brief}`]
      for (const [name, value] of Object.entries(step.inputs ?? {})) {
        if (value) lines.push(`Input ${name}: ${value}`)
      }
      const outputs = (step.outputs ?? []).map(port => port.name).filter(Boolean)
      if (outputs.length > 0) lines.push(`When you finish, add one line per output: OUTPUT <name>: <value> (${outputs.join(', ')}).`)
      lines.push('Reply with the result of this step.')
      return fb.bot.send({ from, to: step.botId, text: lines.join('\n'), role: 'request' })
    },
  } : {}
  // A host that does not hand board writes over cannot start a run from a card (#1462).
  const tasksWired = typeof fb.tasks?.onWrite === 'function'
  const service = createWorkflowService({
    dir: persist ? (config.dir ?? join(dshHome, 'bot', 'flybot-workflow')) : undefined,
    persist,
    bots: () => fb.bot?.list?.() ?? [],
    readOnly: () => fb.readOnly?.() === true,
    warn: (...args) => fb.warn?.(...args),
    tasksWired,
    // #1856: the host owns the Project record and the run binding; a host without the seam answers
    // undefined and the service leaves the run unbound.
    readProject: id => fb.projects?.read?.(id),
    bindRun: (runId, projectId) => fb.projects?.bindRun?.(runId, projectId),
    ...lifecycle,
  })
  void service.reap?.().catch(error => fb.warn?.('flybot-workflow: reap failed: %s', error))
  const offs = [
    fb.api.handle('workflow/state', () => service.state(), { read: true }),
    fb.api.handle('workflow/create', body => service.create(body)),
    fb.api.handle('workflow/rename', body => service.rename(body)),
    fb.api.handle('workflow/delete', body => service.delete(body)),
    fb.api.handle('workflow/assign', body => service.assign(body)),
    fb.api.handle('workflow/concurrency', body => service.setConcurrency(body)),
    fb.api.handle('workflow/step-timeout', body => service.setStepTimeout(body)),
    fb.api.handle('workflow/set-model', body => service.setModel(body)),
    fb.api.handle('workflow/advance', body => service.advance(body)),
    fb.api.handle('workflow/reset', body => service.reset(body)),
    fb.api.handle('workflow/pause', body => service.pause(body)),
    fb.api.handle('workflow/resume', body => service.resume(body)),
    fb.api.handle('workflow/graph', body => service.saveGraph(body)),
    fb.api.handle('workflow/templates', () => ({ ok: true, templates: service.state().templates }), { read: true }),
    fb.api.handle('workflow/ingest', body => service.ingest(body)),
  ]
  if (typeof fb.tools?.register === 'function') {
    offs.push(fb.tools.register({
      name: 'run_workflow',
      description: 'Start a saved Workflow by name or id. The brief is the task the run carries. This is the same run the Workflow chat shows.',
      parameters: {
        workflow: { type: 'string', required: true, description: 'Workflow id or exact name' },
        brief: { type: 'string', required: true, description: 'What the run should do' },
        task: { type: 'string', description: 'Task id, such as #1280. Omitted ids are generated.' },
      },
      // fb.tools.register hands the calling Bot to execute() as the second argument's botId (#1544).
      execute: (args, ctx) => service.runNamed({ ...(args ?? {}), ...(ctx?.botId ? { callerBotId: ctx.botId } : {}) }),
    }))
    offs.push(fb.tools.register({
      name: 'define_workflow',
      description: 'Create or replace a Workflow graph. nodes are { id, name, prompt?, role?, model?, tools?, botId?, inputs?, outputs?, x?, y? } and edges are { from, to, when?, loop?, max?, until? }. prompt is that node\'s Bot system prompt. tools names the connectors the ephemeral run Bot may call (github grants mcp__github__*, composio grants mcp__composio__*); the file and shell rights are a normal Bot\'s, and a node that names no connector gets none. A node does not need a permanent botId. inputs and outputs are { name, type?, required? }. A required input must be produced upstream, or be task, title, or brief on a root. when chooses an edge; loop with max (and optional until) is the only cycle. stepTimeoutMinutes (an integer from 1 to 120) is how long one step may wait for its Bot before the run fails; omit it for the 45-minute default. The Settings page and the flowchart edit the same graph. A friend\'s Bot is refused.',
      parameters: {
        name: { type: 'string', required: true, description: 'Workflow name' },
        workflow: { type: 'string', description: 'Existing id or name to replace. Omit to create.' },
        nodes: { type: 'array', required: true, description: 'Nodes. Each may carry prompt (system prompt), role, model, tools (the connectors it may call: github, composio), inputs, outputs, and an optional local botId. Real work uses an ephemeral Bot per run, not a seated botId.' },
        edges: { type: 'array', required: true, description: 'Hand-offs { from, to }. A fork is two edges out; a join is two edges in. A condition is when: { output, eq } or { else: true }. A loop is loop: true with max (1–8, default 3) and optional until: { output, eq }.' },
        stepTimeoutMinutes: { type: 'number', description: 'How long one step may wait for its Bot before the run fails, 1–120. Omit for the 45-minute default.' },
      },
      execute: (args, ctx) => service.define({ ...(args ?? {}), ...(ctx?.botId ? { callerBotId: ctx.botId } : {}) }),
    }))
  }
  if (typeof fb.bot?.send?.use === 'function') {
    const off = fb.bot.send.use({
      name: 'workflow-step',
      priority: fb.bot.send.priority?.ROUTING,
      async handle(msg) {
        const from = typeof msg.from === 'string' ? msg.from : ''
        if (msg.role !== 'reply' || !from) return undefined
        // Check if this bot is owned by a workflow run
        const owned = service.ownsBot(from)
        if (owned !== true) return undefined
        const text = String(msg.text ?? '')
        const failed = /could not answer your message|model call failed/i.test(text)
        // The reply advances the run only. It must not land in a persistent Bot chat (e.g. Chief).
        try {
          await Promise.resolve(service.stepResult({ botId: from, text, ok: !failed }))
        } catch (error) {
          fb.warn?.('flybot-workflow: step result failed: %s', error)
        }
        return { action: 'deny', reason: 'workflow step result stays on the run surface' }
      },
    })
    if (typeof off === 'function') offs.push(off)
  } else {
    fb.warn?.('flybot-workflow: send middleware not available; ephemeral bot replies may leak')
  }
  if (tasksWired) {
    // #1696: the host's Project board asks for the run that holds a card. A host without the
    // seam simply reads the core boards alone, so this stays quiet.
    if (typeof fb.tasks.onProjectProvider === 'function') {
      offs.push(fb.tasks.onProjectProvider(({ hasTask } = {}) => service.projectTasks({ hasTask })))
    }
    offs.push(fb.tasks.onWrite(task => {
      const result = service.ingest(task ?? {})
      if (result?.matched === true && result.already !== true && result.decision?.kind === 'bot') {
        return { ownerBotId: result.decision.id }
      }
      return null
    }))
  } else {
    fb.warn?.('flybot-workflow: tasks.onWrite is not available, so a board card cannot start a run')
  }
  // The hooks come off at once; the Bot release is behind a promise, so hand it
  // back instead of dropping it (#1387).
  const dispose = () => {
    const released = service.dispose()
    for (const off of offs.splice(0)) off()
    return released
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'flybot-workflow')
  else ctx.on?.('dispose', dispose)
  return { service, enabled: true, dispose }
}
