// Run-scoped Bots. One instance per graph node, built from that node's
// prompt, role, model and tools. The host hides it from the sidebar and
// deletes it when the run finishes, fails for good, or is cancelled.
import { cleanLine, cleanPrompt, cleanTools } from './graph.js'

// A Workflow node Bot has the file and shell rights a normal sidebar Bot has: the same
// 'danger-full-access' preset. node.tools selects connectors only (see nodeConfig); the team
// tools stay refused by EPHEMERAL_DENIED_TOOLS at the guard/approval layer (#1466).
export function permissionFor() {
  return 'danger-full-access'
}

export function nodeConfig(node, roster = [], workflowModel = '') {
  const seated = node?.botId
    ? roster.find(bot => bot && bot.id === node.botId && bot.remote !== true)
    : undefined
  const prompt = cleanPrompt(node?.prompt)
    || cleanPrompt(seated?.systemPrompt || seated?.instructions || '')
    || cleanPrompt(node?.instructions)
  // node.tools names the connectors this node may call: spawn passes it to the host, which records
  // it as stepTools, and connector-access.js allows only a connector a node declared. A node that
  // names none reaches none. File and shell access comes from permissionFor(), not from here.
  return {
    nodeId: node.id,
    name: node.name,
    role: cleanLine(node.role || seated?.role, 80),
    prompt,
    model: cleanLine(workflowModel || node.model || seated?.model, 80),
    tools: cleanTools(node.tools),
    hidden: true,
    ephemeral: true,
  }
}

// #1544: a connector a Bot switched off is not reopened by a Workflow. The run carries the Bots whose
// switches cap it — the Bot that started the run (a tool call), and the Bot that saved the graph, which
// is the ceiling when the board, the canvas or the API started it. The host intersects the node's
// `tools` with them; the graph cannot raise its own ceiling. Both ids travel in `cappedBy` only: a run
// Bot must not carry `createdBy`, because the roster reads that field as "a Bot made this Bot" and
// starts such a Bot on its maker's model (#1582). The caller is a ceiling, not a parent.
export function runCaps(callerBotId, authorBotId) {
  const ids = [callerBotId, authorBotId].filter(id => typeof id === 'string' && id !== '')
  return [...new Set(ids)]
}

// #3286: a host answers a spawn in about ten seconds, so a six-node lane created one
// Bot at a time needs ~66s and cannot fit the 60s batch deadline around a start. Four
// at a time finishes the same lane in two waves (~20s); a caller may pass a narrower
// or wider width as the last argument (tests use it to hold the waves still).
export const SPAWN_CONCURRENCY = 4

export async function spawnAll(nodes, roster, spawn, workflowModel = '', caps = {}, concurrency = SPAWN_CONCURRENCY) {
  const list = Array.isArray(nodes) ? nodes : []
  const width = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : SPAWN_CONCURRENCY
  const capping = runCaps(caps.callerBotId, caps.authorBotId)
  // `made` is the order the host answered in: it is what `error.spawned` reports, so a
  // failed start releases in the order the Bots came up, not the order they were asked for.
  const made = []
  const byIndex = new Map()
  let next = 0
  let failure = null

  const create = async () => {
    for (;;) {
      // Checked before taking the next index, so a refusal stops new spawns at once; the
      // ones already in flight are still awaited below and still land in `made`.
      if (failure !== null) return
      const index = next
      next += 1
      if (index >= list.length) return
      const node = list[index]
      const spec = nodeConfig(node, roster, workflowModel)
      if (capping.length > 0) spec.cappedBy = capping
      let id
      try {
        id = await spawn(spec)
        if (typeof id !== 'string' || id === '') throw new Error('The run could not start a Bot')
      } catch (error) {
        if (failure === null) failure = error
        return
      }
      made.push(id)
      byIndex.set(index, id)
    }
  }

  const workers = []
  for (let i = 0; i < Math.min(width, list.length); i += 1) workers.push(create())
  await Promise.all(workers)
  if (failure !== null) {
    failure.spawned = made.slice()
    throw failure
  }
  // Keys follow the graph's nodes, whatever order the host answered in.
  const ephemeral = {}
  for (let i = 0; i < list.length; i += 1) ephemeral[list[i].id] = byIndex.get(i)
  return ephemeral
}

// Returns the ids whose release failed: that Bot is still there, so the caller
// must keep naming it and let a later attempt retry the release (#1476).
export async function releaseAll(ids, release, warn = () => {}) {
  const failed = []
  if (typeof release !== 'function') return failed
  for (const id of ids) {
    if (!id) continue
    try {
      await release(id)
    } catch (error) {
      failed.push(id)
      warn(`flybot-workflow: could not remove ${id}: ${error?.message ?? error}`)
    }
  }
  return failed
}
