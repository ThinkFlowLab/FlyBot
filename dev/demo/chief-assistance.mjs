import { sendAgentWebhook } from '../../core/src/host/project-agent-webhook.js'
import { createWorkbenchGateway } from '../../core/src/host/workbench-gateway.js'
// Actual disposable DSH/HTTP/inbox/signed receiver; all reasoning is deterministic.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
export async function checkChiefAssistance({ api, call, saved, waitFor, restart, configure, directory, origin, cookie, model }) {
  const invite = await api('auth-invite'), owner = await api('auth-redeem', { token: invite.token, displayName: 'Operations owner' })
  const a = (name, body = {}) => api(name, body, owner.sessionToken)
  const second = await a('auth-invite'), initiator = await api('auth-redeem', { token: second.token, displayName: 'Task requester' })
  const b = (name, body = {}) => api(name, body, initiator.sessionToken)
  const { project } = await a('project-create', { name: 'Chief assistance fault injection', repository: null })
  const invitation = await a('project-invite', { id: project.id }); await b('project-join', { token: invitation.token })
  const original = await a('project-agents', { projectId: project.id }); await b('project-agents', { projectId: project.id })
  await b('project-agent-memory-write', { projectId: project.id, text: 'PRIVATE_REQUESTER_SECRET_NOT_FOR_OPERATIONS' })
  const { agent } = await a('personal-agent-create', { name: 'External operations receiver', kind: 'external', provider: 'isolated-http-fixture', endpoint: 'https://fixture.invalid/ops' })
  await a('personal-agent-join', { agentId: agent.id, projectId: project.id })
  const issued = await a('personal-agent-token-create', { agentId: agent.id, projectIds: [project.id] })
  const gateway = createWorkbenchGateway({ upstreamOrigin: origin, upstreamCookie: cookie(), request: (url, options) => fetch(url, { ...options, headers: { ...options.headers, cookie: cookie() } }) })
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
  const gatewayOrigin = `http://127.0.0.1:${gateway.address().port}`
  const key = join(directory, 'receiver-key'), client = join(directory, 'receiver-client.json')
  writeFileSync(key, 'disposable-fixture-signing-key-'.repeat(3), { mode: 0o600 })
  writeFileSync(client, JSON.stringify({ origin: gatewayOrigin, projectId: project.id, agentId: agent.id, token: issued.token, failFirst: true }), { mode: 0o600 })
  const receiver = fork(new URL('../../core/test/fixtures/agent-webhook-receiver.mjs', import.meta.url), [key, client], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } })
  const exited = once(receiver, 'exit'), notifications = [], failures = []
  receiver.on('message', message => { if (message.event) notifications.push(message); if (message.injectedFailure) failures.push(message) })
  try {
    const [ready] = await once(receiver, 'message')
    const receiverSettings = { ownerId: owner.memberId, agentId: agent.id, projectId: project.id, endpoint: `http://127.0.0.1:${ready.port}/notify`, signingKeyFile: key, allowLoopback: true }
    configure({ projectAgentWebhooks: { operations: receiverSettings } })
    await restart()
    const connection = { version: 'project-development/v1', projectId: project.id, kind: 'command', name: 'inbox.connection.configure', requestId: 'configure-receiver', payload: { agentId: agent.id, enabled: true, connectionId: 'operations' } }
    await a('project-development', connection)
    await a('project-chief-configure', { projectId: project.id, enabled: true, operationsContact: { memberId: owner.memberId, agentId: agent.id }, autonomy: { maxRecoveryActions: 2, maxRecoveryMs: 60000 }, inspection: { enabled: false } })
    const schedule = await a('project-scheduled-task', { operation: 'save', projectId: project.id, target: { kind: 'project-chief', projectId: project.id }, title: 'Configured hourly compensation', prompt: 'Inspect original inbox delivery and current evidence; do not repeat repairs', when: { kind: 'every', seconds: 3600 }, enabled: true })
    assert.equal(schedule.config.when.seconds, 3600)
    const tasks = []
    for (const kind of ['external', 'internal']) {
      let selected = agent.id
      if (kind === 'internal') {
        selected = original.mine.personalAgentId
        await a('project-agent-mode', { projectId: project.id, mode: 'watch', personalAgentId: selected })
        await a('project-chief-configure', { projectId: project.id, enabled: true, operationsContact: { memberId: owner.memberId, agentId: selected }, inspection: { enabled: false } })
      } else await a('project-agent-mode', { projectId: project.id, mode: 'watch', personalAgentId: agent.id })
      const marker = `operations-assistance-${kind}`
      const task = await b('task-create', { projectId: project.id, botId: original.public.botId, title: marker, criteria: 'Operator input resolves the current Project decision', impact: 'Resolve an environment decision for Project progress', projectTaskKind: 'decision' })
      tasks.push(task.id); model.register(marker, task.id)
      const request = await b('project-task-run', { taskId: task.id, requestId: marker }); assert.equal(request.waitingFor, 'chief')
      if (kind === 'external') { await waitFor(() => failures.length > 0, 'injected receiver offline response'); await restart() }
      await waitFor(() => saved().tasks[task.id]?.projectTask?.admission?.status === 'accepted', 'original Task admitted after operations consultation')
      const state = saved(), current = state.tasks[task.id], recipient = current.chiefQuestion?.recipient
      assert.equal(current.requesterId, initiator.memberId)
      const rows = Object.values(state.projectAgentTranscripts).flat().filter(row => row.linkedTaskId === task.id && row.direction === 'incoming')
      assert.equal(rows.length, 1); assert.equal(rows[0].initiatedBy, owner.memberId)
      assert.equal(rows[0].assistance.requiredPermission, 'Project watch publication only; no host privileges')
      assert.ok(!JSON.stringify(rows).includes('PRIVATE_REQUESTER_SECRET'))
      assert.equal(Object.values(state.projectTaskInputs).filter(row => row.taskId === task.id && row.text === 'Approved fixture option').length, 1)
      if (recipient) assert.equal(recipient.memberId, owner.memberId)
      if (kind === 'external') { await sendAgentWebhook(receiverSettings, notifications[0].event); assert.equal(Object.values(saved().projectTaskInputs).filter(row => row.taskId === task.id && row.text === 'Approved fixture option').length, 1) }
    }
    assert.ok(notifications.some(row => row.verified && row.handled && !row.ownerCookie && !row.authorization))
    assert.ok(model.observed.nativeClaims >= 1); assert.ok(model.observed.nativeCompletions >= 1)
    assert.ok(model.observed.chiefResumptions >= 2)
    const state = await a('project-chief-state', { projectId: project.id })
    assert.ok(state.compensation.some(row => row.id === schedule.id && row.nextCheckAt > Date.now()))
    const denied = await call('project-chief-configure', { projectId: project.id, enabled: true, operationsContact: { memberId: owner.memberId, agentId: agent.id } }, issued.token)
    assert.equal(denied.ok, false)
    return { milestone: '2342-chief-assistance', runtime: 'actual DSH', model: 'deterministic fixture', transport: 'real HTTP and signed independent receiver', tasks: tasks.length, checks: ['explicit operations recipient differs from Task requester', 'external signed notification claim/get/reply publishes original Task input', 'native agent uses the same inbox contract', 'Chief rejudges and admits original Task after input', 'requester private memory not forwarded', 'FBA cannot select operations contact', 'hourly compensation uses original configured schedule', 'receiver offline failure and actual host restart recover the same inbox message', 'duplicate signed notification adds no duplicate Task input'], notRun: ['paid model judgement', 'actual host environment repair', 'production upgrade', 'real hourly timer delay', 'code Task execution after this decision admission'] }
  } finally { receiver.kill(); await exited; gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
}
