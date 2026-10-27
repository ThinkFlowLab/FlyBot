// Run-scoped Bots. One instance per graph node, built from that node's
// prompt, role, model and tools. The host hides it from the sidebar and
// deletes it when the run finishes, fails for good, or is cancelled.
import { cleanLine, cleanPrompt, cleanTools } from './graph.js'

const SHELL = new Set(['bash', 'shell', 'danger-full-access'])

// A step that names a shell gets full access. Anything else can still write
// the workspace. A node with no tools is not left on a read-only default.
export function permissionFor(tools) {
  const names = cleanTools(tools)
  if (names.some(name => SHELL.has(name))) return 'danger-full-access'
  return 'workspace-write'
}

export function nodeConfig(node, roster = []) {
  const seated = node?.botId
    ? roster.find(bot => bot && bot.id === node.botId && bot.remote !== true)
    : undefined
  const prompt = cleanPrompt(node?.prompt)
    || cleanPrompt(seated?.systemPrompt || seated?.instructions || '')
    || cleanPrompt(node?.instructions)
  return {
    nodeId: node.id,
    name: node.name,
    role: cleanLine(node.role || seated?.role, 80),
    prompt,
    model: cleanLine(node.model || seated?.model, 80),
    tools: cleanTools(node.tools),
    hidden: true,
    ephemeral: true,
  }
}

export async function spawnAll(nodes, roster, spawn) {
  const made = []
  try {
    const ephemeral = {}
    for (const node of nodes) {
      const spec = nodeConfig(node, roster)
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
