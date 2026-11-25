// Official per-user import bundle (flybot_workspace/dsbot_bundle.py). Conversations
// and messages are included so workspace-agent history is not lost at cutover.
// Public homepages stay on the platform until phase C.
import { createHash } from 'node:crypto'

export const DOCUMENTATION = {
  format: 'flybot-workspace-dsbot-import',
  version: 1,
  feature: 'agents',
  tables: {
    workspace_agents: 'agents in workspaces this account owns',
    workspace_agent_categories: 'optional category per agent_id',
    workspace_agent_quick_starts: 'optional quick starts (position, text)',
    agent_conversations: 'optional; conversations of those agents',
    agent_messages: 'optional; messages (body mapped to text; queued/running become skipped)',
  },
}

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

export function verifyOfficial(bundle) {
  if (!bundle || bundle.format !== 'flybot-workspace-dsbot-import' || bundle.version !== 1) throw Object.assign(new Error('unsupported bundle format'), { code: 'agents/invalid', status: 400 })
  if (bundle.feature !== 'agents') throw Object.assign(new Error('bundle feature mismatch'), { code: 'agents/invalid', status: 400 })
  const tables = {}, manifest = bundle.manifest ?? {}, raw = bundle.tables ?? {}
  for (const [name, text] of Object.entries(raw)) {
    if (typeof text !== 'string' || manifest[name]?.sha256 !== sha256(text)) throw Object.assign(new Error(`table ${name} digest mismatch`), { code: 'agents/invalid', status: 400 })
    const rows = JSON.parse(text)
    if (!Array.isArray(rows) || rows.length !== manifest[name].rows) throw Object.assign(new Error(`table ${name} row count mismatch`), { code: 'agents/invalid', status: 400 })
    tables[name] = rows
  }
  return tables
}

export async function importOfficialBundle(endpoints, bundle) {
  const tables = verifyOfficial(bundle)
  const agentsById = new Map((tables.workspace_agents ?? []).map(row => [row.id, row]))
  const conversations = new Map((tables.agent_conversations ?? []).map(row => [row.id, row]))
  for (const row of tables.agent_conversations ?? []) {
    if (agentsById.get(row.agent_id)?.workspace_id !== row.workspace_id) throw new Error('conversation ownership mismatch')
  }
  for (const row of tables.agent_messages ?? []) {
    const conversation = conversations.get(row.conversation_id)
    if (!conversation || conversation.workspace_id !== row.workspace_id || conversation.agent_id !== row.agent_id) throw new Error('message ownership mismatch')
  }
  const categories = new Map((tables.workspace_agent_categories ?? []).map((row) => [row.agent_id, row.category]))
  const starts = new Map()
  for (const row of tables.workspace_agent_quick_starts ?? []) {
    const list = starts.get(row.agent_id) ?? []
    list[row.position] = row.text
    starts.set(row.agent_id, list)
  }
  const agents = (tables.workspace_agents ?? []).map((row) => ({
    id: row.id, workspace_id: row.workspace_id, name: row.name, summary: row.summary, instructions: row.instructions,
    category: categories.get(row.id) ?? null, quick_starts: (starts.get(row.id) ?? []).filter((t) => typeof t === 'string'),
    revision: row.revision, created: row.created, updated: row.updated, archived: !!row.archived,
  }))
  const result = await endpoints.import({ agents })
  if (typeof endpoints.importHistory === 'function') {
    await endpoints.importHistory({ conversations: tables.agent_conversations ?? [], messages: tables.agent_messages ?? [] })
  }
  for (const binding of tables.personal_agents || []) {
    if (agentsById.get(binding.agent_id)?.workspace_id !== binding.workspace_id) throw new Error('personal agent ownership mismatch')
    await endpoints['adopt-personal-chat']({workspace_id:binding.workspace_id,id:binding.agent_id}, false)
  }
  return result
}
