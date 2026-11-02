// Context tools read current authorized sources in bounded pages. Their text is
// data, never a publication grant, a role definition, or proof of completed work.
import { ownEntry } from './store.js'
import { contextValuePage, fitContextToolResult, resolveContextBudget } from './project-context-budget.js'
import { readContextArchive } from './project-role-context.js'
const fail = message => Object.assign(new Error(message), { code: 'bot/context-budget' })
const forbidden = message => Object.assign(new Error(message), { code: 'bot/forbidden' })
const taskIndex = row => ({ id: row.id, projectId: row.projectId, title: row.title, status: row.status, criteria: row.criteria ?? '' })
async function budgetFor(rt, agent) {
  if (agent.lastRequest?.context?.budget) return agent.lastRequest.context.budget
  const bot = rt.botOf(agent.botId)
  return resolveContextBudget(rt, { model: bot?.model ?? rt.config.projectModel ?? rt.cachedDefault?.() })
}
export async function exchangeProjectContext(rt, agentId, delegationId, { contextRequests = [], memoryUpdates = [], memoryRequests = [] }, snapshot, { authorize, isDelegationActive }) {
  const agent = ownEntry(rt.state.projectAgents ?? {}, agentId)
  if (!agent || agent.id !== `public-${agent.projectId}` || agent.visibility !== 'public' || !isDelegationActive(agentId, delegationId)) throw forbidden('Chief context delegation is unavailable')
  const authority = await authorize(rt.botOf(agent.botId))
  if (authority.delegation.readOnly && memoryUpdates.length) throw forbidden('Read-only conversations cannot publish memory')
  if (snapshot?.archive?.projectId !== agent.projectId || snapshot.archive.role !== 'chief') throw forbidden('Context belongs to another Project or role')
  if (![contextRequests, memoryUpdates, memoryRequests].every(rows => Array.isArray(rows) && rows.length <= 4)) throw fail('Chief context operations exceed their budget')
  const budget = await budgetFor(rt, agent)
  const reads = contextRequests.length ? readContextArchive(snapshot, contextRequests, { projectId: agent.projectId, role: 'chief' }) : []
  const memories = memoryRequests.map(request => {
    if (!rt.botMemoryRecall) throw forbidden('Bot memory is unavailable')
    const found = rt.botMemoryRecall(agent.botId, { topic: request.topic, query: request.query, offset: request.offset ?? 0, limit: request.limit ?? 4 })
    return { topic: request.topic ?? null, query: request.query ?? null, offset: found.offset, total: found.total, nextOffset: found.nextOffset,
      entries: found.entries.map((entry, index) => ({ ...contextValuePage(entry, budget, { offset: request.charOffset ?? 0, sha256: request.sha256 }), entryOffset: found.offset + index, topic: entry.topic, ...(request.charOffset ? {} : { meta: entry.meta }) })) }
  })
  // A mutation must not succeed and then disappear behind an oversized tool
  // response. Validate the response envelope before writing durable memory.
  fitContextToolResult({ reads, memories, writes: memoryUpdates.map(() => ({ changed: true, message: 'Host-confirmed memory write'.padEnd(512, '.') })) }, budget)
  const writes = []
  for (const request of memoryUpdates) {
    if (!rt.botMemoryRemember) throw forbidden('Bot memory is unavailable')
    const result = await rt.botMemoryRemember(agent.botId, { text: request.text, topic: request.topic, replace: request.replace }, { reference: `Project ${agent.projectId}; Chief request ${agent.lastRequest.id}` })
    writes.push({ changed: result.changed, message: result.message })
  }
  return fitContextToolResult({ reads, memories, writes }, budget)
}
export async function readProjectAgentContext(rt, bot, body, { authorize, contextExchange, privateNotes, logOf, rooms, chiefMemory }) {
  const { agent, actor, delegation } = await authorize(bot)
  if (body.contextRequests || body.memoryRequests || body.memoryUpdates) return contextExchange(agent.id, delegation.id, body, agent.lastRequest.context)
  const budget = await budgetFor(rt, agent)
  const detail = await rt.projectEndpoint('project-detail', { id: agent.projectId }, actor)
  const notes = agent.visibility === 'private' && !agent.returnAgentId ? ownEntry(privateNotes(), agent.id) ?? [] : []
  const messages = agent.roomId ? rooms.requireRoom(agent.projectId, agent.roomId, actor).messages : ownEntry(rt.state.projectAgentTranscripts ?? {}, `public-${agent.projectId}`) ?? []
  const source = body.sourceRequest
  if (source !== undefined) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw forbidden('Invalid scoped context source')
    let value
    if (source.kind === 'project') value = detail.project
    else if (source.kind === 'task-index') value = detail.tasks.filter(row => !source.query || String(row.title ?? '').toLowerCase().includes(String(source.query).toLowerCase())).map(({ id, title, status }) => ({ id, title, status }))
    else if (source.kind === 'task') {
      const task = ownEntry(rt.state.tasks, source.id)
      if (task?.projectId !== agent.projectId) throw forbidden('Task source belongs to another Project')
      value = { ...taskIndex(task), state: rt.projectDevelopment.view(task, actor) }
    } else if (source.kind === 'private-memory') value = notes.find(row => row.id === source.id)
    else if (source.kind === 'public-message') value = messages.find(row => row.id === source.id)
    else if (source.kind === 'knowledge') value = (ownEntry(rt.state.projectKnowledge ?? {}, agent.projectId) ?? []).find(row => row.id === source.id)
    else if (source.kind === 'role-memory') {
      const row = ownEntry(rt.state.projectRoleMemory ?? {}, source.id)
      if (row?.projectId !== agent.projectId) throw forbidden('Role memory source belongs to another Project')
      const { versions = [], ...head } = row
      value = source.revision === undefined || source.revision === row.revision ? head : versions.find(version => version.revision === source.revision)
    } else throw forbidden('Unknown context source kind')
    if (!value) throw forbidden('Context source is unavailable in this scope')
    return fitContextToolResult({ identity: { visibility: agent.visibility, projectId: agent.projectId, memberId: actor.memberId }, contextPage: contextValuePage(value, budget, source) }, budget)
  }
  const sources = agent.lastRequest?.context?.sources
  const result = { permissionMode: delegation.readOnly ? 'conversation' : actor.watchGrantId ? 'watch' : 'safe', project: detail.project,
    tasks: detail.tasks.slice(-20).map(taskIndex), runs: detail.runs.slice(-10).map(({ id, taskId, status }) => ({ id, taskId, status })),
    knowledge: (ownEntry(rt.state.projectKnowledge ?? {}, agent.projectId) ?? []).slice(-10),
    contextSources: sources ? { policy: sources.policy ?? null, counts: { memory: sources.memory?.length ?? 0, knowledge: sources.knowledge?.length ?? 0, repository: sources.repository?.length ?? 0 }, archiveSha256: agent.lastRequest.context.archiveSha256 } : null,
    publicMessages: messages.slice(-10).map(({ id, kind, text, at }) => ({ id, kind, text, at })),
    ...(agent.visibility === 'public' && !agent.roomId ? { chiefMemory: { ...chiefMemory(agent.projectId), topics: chiefMemory(agent.projectId).topics.slice(0, 12) } } : {}),
    ...(agent.visibility === 'private' ? { privateMemory: notes.slice(-20), privateConversation: logOf(agent.id).slice(-10).filter(row => typeof row.text === 'string').map(({ id, kind, text, at }) => ({ id, kind, text, at })) } : {}),
    identity: { visibility: agent.visibility, projectId: agent.projectId, memberId: actor.memberId },
    retrieval: { version: 'project-context-index/v1', omitted: {}, counts: { tasks: detail.tasks.length, privateMemory: notes.length, publicMessages: messages.length },
      instruction: 'This is a bounded index. Use sourceRequest:{kind:project|task-index|task|private-memory|public-message|knowledge|role-memory,id,offset,sha256} for exact authorized sources; source pages retain hashes/cursors. Chief contextRequests reads its immutable archive, including summary sources; memoryRequests reads its own durable topic pages.' } }
  return fitContextToolResult(result, budget)
}
