// Placeholder requests, validated against their exact dispatch schemas by CI.
const native = (endpoint, payload) => ({ endpoint, payload })
const development = (kind, name, payload, requestId) => native('project-development', { version: 'project-development/v1', kind, name, projectId: 'PROJECT_ID', payload, ...(requestId ? { requestId } : {}) })
export const integrationExamples = [
  { id: 'read-warning-summaries', actor: 'project-manager', request: development('query', 'warnings', { offset: 0, limit: 10 }) },
  { id: 'discover-login-mode', actor: 'anonymous', request: native('auth-mode', {}) },
  { id: 'existing-platform-login', actor: 'human', request: native('platform-login', { email: 'user@example.invalid', password: 'REPLACE_PRIVATELY' }), secretHandling: 'Never commit or log the substituted password or response.sessionToken.' },
  { id: 'redeem-native-human-invitation', actor: 'anonymous', request: native('auth-redeem', { token: 'PRIVATE_OPERATOR_INVITATION', displayName: 'Example member' }) },
  { id: 'create-external-agent', actor: 'human', request: native('personal-agent-create', { name: 'My grok-bot', kind: 'external', provider: 'grok-bot', endpoint: 'https://bot.example.invalid/callback' }), note: 'Descriptor only; callback is not called or verified by FlyBot.' },
  { id: 'join-agent-to-project', actor: 'human', request: native('personal-agent-join', { agentId: 'AGENT_ID', projectId: 'PROJECT_ID' }) },
  { id: 'issue-scoped-token', actor: 'human', request: native('personal-agent-token-create', { agentId: 'AGENT_ID', projectIds: ['PROJECT_ID'], ttlSeconds: 604800 }), secretHandling: 'Privately provision returned value.token to the bot, then use X-Flybot-Member-Session.' },
  { id: 'identify-agent', actor: 'personal-agent-safe', request: native('auth-whoami', {}) },
  { id: 'consult-chief-without-task', actor: 'personal-agent-safe', request: development('command', 'consultation.ask', { text: 'Explain current Project status without publishing work.' }, 'ask-001') },
  { id: 'read-private-consultation', actor: 'personal-agent-safe', request: development('query', 'consultation.get', { consultationId: 'CONSULTATION_ID', offset: 0, limit: 20 }) },
  { id: 'propose-private-change-in-safe-mode', actor: 'personal-agent-safe', request: native('personal-agent-propose-task', { projectId: 'PROJECT_ID', requestId: 'proposal-001', title: 'Fix calculation', criteria: 'Regression reproduces and passes after fix.', impact: 'Restore calculation correctness.', projectTaskKind: 'code' }) },
  { id: 'human-approves-publication', actor: 'human', request: development('command', 'proposal.publish', { proposalId: 'PROPOSAL_ID' }, 'publish-001') },
  { id: 'human-grants-watch', actor: 'human', request: native('personal-agent-delegation-set', { agentId: 'AGENT_ID', projectId: 'PROJECT_ID', mode: 'watch' }) },
  { id: 'watch-agent-publishes-task', actor: 'personal-agent-watch', request: development('command', 'task.propose', { title: 'Fix calculation', criteria: 'Regression reproduces and passes after fix.', impact: 'Restore calculation correctness.', projectTaskKind: 'code' }, 'change-001') },
  { id: 'start-original-task', actor: 'personal-agent-watch', request: development('command', 'task.run', { taskId: 'TASK_ID', targetRole: 'developer' }, 'run-001') },
  { id: 'recover-original-receipt', actor: 'original-command-principal', request: development('query', 'command.receipt', { commandRequestId: 'run-001', commandName: 'task.run' }) },
  { id: 'read-task-progress', actor: 'personal-agent-safe', request: development('query', 'task', { taskId: 'TASK_ID' }) },
  { id: 'read-role-memory-and-persona-source', actor: 'personal-agent-safe', request: development('query', 'roles', { role: 'developer', offset: 0, limit: 4000 }) },
  { id: 'read-durable-handoff', actor: 'personal-agent-safe', request: development('query', 'handoff.get', { taskId: 'TASK_ID', handoffId: 'HANDOFF_ID' }) },
  { id: 'fresh-snapshot', actor: 'personal-agent-safe', request: development('query', 'project.snapshot', { limit: 50 }) },
  { id: 'revoke-agent-token', actor: 'human', request: native('personal-agent-token-revoke', { credentialId: 'CREDENTIAL_ID' }) },
]
