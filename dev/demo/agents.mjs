import assert from 'node:assert/strict'

export function agentReply({ body, result }) {
  const system = JSON.stringify(body.system ?? '')
  const privateAgent = system.includes('personal agent participating in this Project through an isolated context') || system.includes('private Project agent. Your identity is one human')
  const chief = system.includes('public Chief of this Project. All messages')
  if (!privateAgent && !chief) return undefined
  if (!result) return [{ type: 'tool_use', id: 'scoped-context', name: 'project_agent_context', input: {} }]
  const conversation = JSON.stringify(body.messages ?? [])
  const taskRequested = conversation.includes('Propose a shared task privately') || conversation.includes('Create a shared Task from this public request')
  const taskCalled = conversation.includes('"name":"project_agent_task"')
  if (taskRequested && !taskCalled) return [{ type: 'tool_use', id: 'scoped-task', name: 'project_agent_task', input: { title: privateAgent ? 'A privately proposed shared Task' : 'A public Chief Task', criteria: 'The current requester must be recorded by the host' } }]
  return [{ type: 'text', text: privateAgent ? 'Your private Project agent read the current scoped facts.' : 'The public Chief read the shared Project facts.' }]
}

export async function checkAgents({ api, call, saved, waitFor }) {
  const invite = await api('auth-invite')
  const alice = await api('auth-redeem', { token: invite.token, displayName: 'Alice' })
  const a = (name, body = {}) => api(name, body, alice.sessionToken)
  await a('state')
  const second = await a('auth-invite')
  const bob = await api('auth-redeem', { token: second.token, displayName: 'Bob' })
  const b = (name, body = {}) => api(name, body, bob.sessionToken)
  const { project } = await a('project-create', { name: 'Scoped agents' })
  const join = await a('project-invite', { id: project.id })
  await b('project-join', { token: join.token })
  const first = await a('project-agents', { projectId: project.id })
  const other = await b('project-agents', { projectId: project.id })
  assert.notEqual(first.mine.botId, other.mine.botId)
  assert.equal(first.public.botId, other.public.botId)
  await a('project-agent-memory-write', { projectId: project.id, text: 'Alice-only private thought' })
  assert.equal(JSON.stringify(await b('project-agents', { projectId: project.id })).includes('Alice-only private thought'), false)
  await a('project-agent-message', { projectId: project.id, text: 'Read my scoped Project context.' })
  await b('project-agent-message', { projectId: project.id, text: 'Read my own scoped Project context.' })
  await waitFor(async () => {
    const history = await a('project-agent-history', { projectId: project.id })
    return history.messages.some(row => row.kind === 'agent') && !history.busy
  }, 'Alice private agent response')
  await waitFor(async () => {
    const history = await b('project-agent-history', { projectId: project.id })
    return history.messages.some(row => row.kind === 'agent') && !history.busy
  }, 'Bob private agent response')
  await b('project-agent-message', { projectId: project.id, text: 'Propose a shared task privately. Do not publish my private context.' })
  const proposal = await waitFor(async () => {
    const row = await b('project-agents', { projectId: project.id })
    const history = await b('project-agent-history', { projectId: project.id })
    return row.proposals[0] && !history.busy ? row.proposals[0] : null
  }, 'private Task proposal')
  assert.equal((await b('project-board', { id: project.id })).tasks.length, 0)
  const approved = await b('project-agent-proposal-apply', { proposalId: proposal.id })
  assert.equal(approved.task.requesterId, bob.memberId)
  await b('project-agent-message', { projectId: project.id, visibility: 'public', publicationApproved: true, text: 'Create a shared Task from this public request. Read current Project facts first.' })
  await waitFor(async () => {
    const history = await b('project-agent-history', { projectId: project.id, visibility: 'public' })
    return history.messages.some(row => row.kind === 'agent') && !history.busy
  }, 'Public Chief response')
  assert.ok(Object.values(saved().tasks).some(task => task.title === 'A public Chief Task' && task.requesterId === bob.memberId))
  const publicHistory = await a('project-agent-history', { projectId: project.id, visibility: 'public' })
  assert.equal(JSON.stringify(publicHistory).includes('Alice-only private thought'), false)
  const privateHistory = await b('project-agent-history', { projectId: project.id, agentId: first.mine.id, memberId: alice.memberId })
  assert.equal(privateHistory.agent.id, other.mine.id)
  assert.equal((await b('project-credential-status', { projectId: project.id })).personal.configured, false)
  assert.equal((await call('project-github-comment', { projectId: project.id, issueNumber: 1, text: 'Do not borrow Owner credentials' }, bob.sessionToken)).ok, false)
  await a('project-member-remove', { id: project.id, memberId: bob.memberId })
  assert.equal((await call('project-agent-history', { projectId: project.id }, bob.sessionToken)).ok, false)
  assert.equal((await call('earlier', { sessionId: other.mine.sessionId }, bob.sessionToken)).ok, false)
  assert.equal((await call('send', { sessionId: other.mine.sessionId, text: 'Stale private page' }, bob.sessionToken)).ok, false)
  assert.ok(saved().projectAgentMemory[first.mine.id].some(row => row.text === 'Alice-only private thought'))
  return { milestone: 'M4', runtime: 'actual DSH', model: 'deterministic mock',
    checks: ['distinct per-user Project agents', 'scoped context tool execution', 'private memory isolated', 'shared public Chief history', 'private proposal explicitly published', 'public Chief creates Task as requester',
      'forged agent id ignored', 'no personal credential fallback', 'removed member old Session denied'],
    notRun: ['real model', 'two personal GitHub identities', 'browser acceptance'] }
}
