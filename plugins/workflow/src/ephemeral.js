// Run-scoped Bots. One instance per graph node, built from that node's
// prompt, role, model and tools. The host hides it from the sidebar and
// deletes it when the run finishes, fails for good, or is cancelled.
import { cleanLine, cleanPrompt, cleanTools } from './graph.js'

const SHELL = new Set(['bash', 'shell', 'danger-full-access'])

// A node with no explicit tools list inherits the full tool grant a normal Bot gets,
// limited only by EPHEMERAL_DENIED_TOOLS at the guard/approval layer (#1466). An
// explicit list restricts to those tools. Permission is 'danger-full-access' when the
// node names a shell, otherwise 'workspace-write'.
export function permissionFor(tools) {
  const names = cleanTools(tools)
  if (names.some(name => SHELL.has(name))) return 'danger-full-access'
  return 'workspace-write'
}

export function nodeConfig(node, roster = [], workflowModel = '') {
  const seated = node?.botId
    ? roster.find(bot => bot && bot.id === node.botId && bot.remote !== true)
    : undefined
  const prompt = cleanPrompt(node?.prompt)
    || cleanPrompt(seated?.systemPrompt || seated?.instructions || '')
    || cleanPrompt(node?.instructions)
  // An explicit tools list is kept; no list (or an empty one) is returned as undefined
  // so the spawn inherits all tools a normal Bot gets, limited by EPHEMERAL_DENIED_TOOLS.
  const explicit = cleanTools(node.tools)
  return {
    nodeId: node.id,
    name: node.name,
    role: cleanLine(node.role || seated?.role, 80),
    prompt,
    model: cleanLine(workflowModel || node.model || seated?.model, 80),
    tools: explicit.length > 0 ? explicit : undefined,
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
