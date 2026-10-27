// @flybot/workflow host plugin. Stores workflow graphs and runs under
// $DSH_HOME/bot/flybot-workflow and answers the chat surface on workflow/*.
import { join } from 'node:path'
import { createWorkflowService } from './src/service.js'

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
  const service = createWorkflowService({
    dir: persist ? (config.dir ?? join(dshHome, 'bot', 'flybot-workflow')) : undefined,
    persist,
    bots: () => fb.bot?.list?.() ?? [],
    readOnly: () => fb.readOnly?.() === true,
    warn: (...args) => fb.warn?.(...args),
  })
  const offs = [
    fb.api.handle('workflow/state', () => service.state(), { read: true }),
    fb.api.handle('workflow/create', body => service.create(body)),
    fb.api.handle('workflow/assign', body => service.assign(body)),
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
      description: 'Create or replace a Workflow graph of local Bots. nodes are { id, name, botId?, x?, y? } and edges are { from, to }. The flowchart canvas edits this same graph.',
      parameters: {
        name: { type: 'string', required: true, description: 'Workflow name' },
        workflow: { type: 'string', description: 'Existing id or name to replace. Omit to create.' },
        nodes: { type: 'array', required: true, description: 'Local Bots seated on the graph' },
        edges: { type: 'array', required: true, description: 'Hand-offs { from, to }. A fork is two edges out; a join is two edges in.' },
      },
      execute: args => service.define(args ?? {}),
    }))
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
