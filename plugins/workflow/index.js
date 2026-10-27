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
  const liveNames = new Set()
  const lifecycle = typeof fb.bot?.create === 'function' ? {
    async spawn(spec) {
      const tools = Array.isArray(spec.tools) ? spec.tools : []
      const notes = []
      if (tools.length > 0) notes.push(`You can use these tools: ${tools.join(', ')}.`)
      if (tools.includes('github')) notes.push('GitHub (mcp__github__*) is granted for this step: issues, pull requests, reviews and comments.')
      const prompt = [spec.prompt, ...notes].filter(Boolean).join('\n\n')
      let last
      for (let n = 0; n < 4; n += 1) {
        const taken = new Set([...(fb.bot.list?.() ?? []).map(bot => bot.name), ...liveNames])
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
            tools,
            permission: permissionFor(tools),
            fields: { nodeId: spec.nodeId, tools },
          })
          liveNames.add(name)
          return id
        } catch (error) {
          last = error
          if (!/already exists/.test(String(error?.message ?? error))) throw error
        }
      }
      throw last
    },
    release(id) {
      if (typeof fb.bot.remove !== 'function') return undefined
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
  const service = createWorkflowService({
    dir: persist ? (config.dir ?? join(dshHome, 'bot', 'flybot-workflow')) : undefined,
    persist,
    bots: () => fb.bot?.list?.() ?? [],
    readOnly: () => fb.readOnly?.() === true,
    warn: (...args) => fb.warn?.(...args),
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
    fb.api.handle('workflow/advance', body => service.advance(body)),
    fb.api.handle('workflow/demo-step', body => service.demoStep(body)),
    fb.api.handle('workflow/reset', body => service.reset(body)),
    fb.api.handle('workflow/say', body => service.say(body)),
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
      execute: args => service.runNamed(args ?? {}),
    }))
    offs.push(fb.tools.register({
      name: 'define_workflow',
      description: 'Create or replace a Workflow graph. nodes are { id, name, prompt?, role?, model?, tools?, botId?, inputs?, outputs?, x?, y? } and edges are { from, to, when?, loop?, max?, until? }. prompt is that node\'s Bot system prompt. tools name what the ephemeral run Bot may use (github grants mcp__github__*; bash grants a shell). A node does not need a permanent botId. inputs and outputs are { name, type?, required? }. A required input must be produced upstream, or be task, title, or brief on a root. when chooses an edge; loop with max (and optional until) is the only cycle. The Settings page and the flowchart edit the same graph. A friend\'s Bot is refused.',
      parameters: {
        name: { type: 'string', required: true, description: 'Workflow name' },
        workflow: { type: 'string', description: 'Existing id or name to replace. Omit to create.' },
        nodes: { type: 'array', required: true, description: 'Nodes. Each may carry prompt (system prompt), role, model, tools (github, bash, read, edit, …), inputs, outputs, and an optional local botId. Real work uses an ephemeral Bot per run, not a seated botId.' },
        edges: { type: 'array', required: true, description: 'Hand-offs { from, to }. A fork is two edges out; a join is two edges in. A condition is when: { output, eq } or { else: true }. A loop is loop: true with max (1–8, default 3) and optional until: { output, eq }.' },
      },
      execute: args => service.define(args ?? {}),
    }))
  }
  if (typeof fb.bot?.send?.use === 'function') {
    const off = fb.bot.send.use({
      name: 'workflow-step',
      priority: fb.bot.send.priority?.ROUTING,
      handle(msg) {
        const from = typeof msg.from === 'string' ? msg.from : ''
        if (msg.role !== 'reply' || !from || service.ownsBot(from) !== true) return undefined
        const text = String(msg.text ?? '')
        const failed = /could not answer your message|model call failed/i.test(text)
        // The reply is the step result. Let it deliver, and move the node from it.
        void Promise.resolve(service.stepResult({ botId: from, text, ok: !failed })).catch(error => {
          fb.warn?.('flybot-workflow: step result failed: %s', error)
        })
        return undefined
      },
    })
    if (typeof off === 'function') offs.push(off)
  }
  if (typeof fb.tasks?.onWrite === 'function') {
    offs.push(fb.tasks.onWrite(task => {
      const result = service.ingest(task ?? {})
      if (result?.matched === true && result.already !== true && result.decision?.kind === 'bot') {
        return { ownerBotId: result.decision.id }
      }
      return null
    }))
  }
  const dispose = () => { service.dispose(); for (const off of offs.splice(0)) off() }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'flybot-workflow')
  else ctx.on?.('dispose', dispose)
  return { service, enabled: true, dispose }
}
