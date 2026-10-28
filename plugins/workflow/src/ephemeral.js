// Run-scoped Bots. One instance per graph node, built from that node's
// prompt, role, model and tools. The host hides it from the sidebar and
// deletes it when the run finishes, fails for good, or is cancelled.
import { cleanLine, cleanPrompt, cleanTools } from './graph.js'

// Every Workflow node Bot gets the full tool/connector grant a normal sidebar Bot gets
// (GitHub, Composio, file/shell tools, team tools), limited only by EPHEMERAL_DENIED_TOOLS
// at the guard/approval layer (#1466). The node.tools field does not restrict this grant;
// it is treated as documentation only. All node Bots get 'danger-full-access' to match
// normal Bots with shell access.
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
  // node.tools is kept as documentation only; spawn always omits the tools field so every
  // node Bot inherits the full grant a normal Bot gets, limited by EPHEMERAL_DENIED_TOOLS.
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

export async function spawnAll(nodes, roster, spawn, workflowModel = '') {
  const made = []
  try {
    const ephemeral = {}
    for (const node of nodes) {
      const spec = nodeConfig(node, roster, workflowModel)
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
