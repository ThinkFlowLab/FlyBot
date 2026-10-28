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
// `tools` with them; the graph cannot raise its own ceiling.
export function runCaps(callerBotId, authorBotId) {
  const ids = [callerBotId, authorBotId].filter(id => typeof id === 'string' && id !== '')
  return [...new Set(ids)]
}

export async function spawnAll(nodes, roster, spawn, workflowModel = '', caps = {}) {
  const made = []
  const capping = runCaps(caps.callerBotId, caps.authorBotId)
  const caller = typeof caps.callerBotId === 'string' && caps.callerBotId !== '' ? caps.callerBotId : undefined
  try {
    const ephemeral = {}
    for (const node of nodes) {
      const spec = nodeConfig(node, roster, workflowModel)
      if (caller !== undefined) spec.createdBy = caller
      if (capping.length > 0) spec.cappedBy = capping
      const id = await spawn(spec)
      if (typeof id !== 'string' || id === '') throw new Error('The run could not start a Bot')
      made.push(id)
      ephemeral[node.id] = id
    }
    return ephemeral
  } catch (error) {
    error.spawned = made
    throw error
  }
}

export async function releaseAll(ids, release, warn = () => {}) {
  if (typeof release !== 'function') return
  for (const id of ids) {
    if (!id) continue
    try {
      await release(id)
    } catch (error) {
      // The instance may already be gone. The run record still drops the id.
      warn(`flybot-workflow: could not remove ${id}: ${error?.message ?? error}`)
    }
  }
}
