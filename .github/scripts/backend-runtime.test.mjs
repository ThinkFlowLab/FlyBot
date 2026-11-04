// Exercise the production launcher in an isolated persistent home. Inference is a test double.
import assert from 'node:assert/strict'
import { spawn, fork } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { backendConfig, callApi, connection, prepareBackend, readJson, root } from '../../scripts/backend-lib.mjs'
import { mockModel } from '../../dev/demo/mock.mjs'
import { inboxModel } from '../../dev/demo/agent-inbox-model.mjs'
import { openSqliteState } from '../../core/src/host/project-state-sqlite.js'
import { readSpec, validateExchange, validate } from '../../scripts/api-contract-validation.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
async function run(args, env) {
  const child = spawn(process.execPath, [join(root, 'scripts/backend.mjs'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`CLI refused: ${stderr}`)
  return stdout
}
async function launch(home, env) {
  const child = spawn(process.execPath, [join(root, 'scripts/backend.mjs'), 'start', '--home', home], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const exited = once(child, 'exit')
  const close = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited }
  try {
    for (let pass = 0; pass < 300; ++pass) {
      if (output.includes('Backend ready:')) return { child, close, output: () => output }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Production launcher failed: ${output}`)
      await pause(100)
    }
    throw new Error('Production launcher readiness timed out')
  } catch (error) { await close(); throw error }
}

test('production backend retains canonical Tasks/auth across restart, keeps consultation private and serves scoped SSE', { timeout: 150000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-backend-runtime-')), port = await freePort()
  const inboxDriver = inboxModel({ correctOnce: true })
  let holdInspection = true, releaseInspection, inspectionRequests = 0
  const inspectionMarker = 'INSPECTION_RECOVERY_ACCEPTANCE_2330'
  const model = mockModel([], { reply(options) {
    if (JSON.stringify(options.body.messages).includes(inspectionMarker) && JSON.stringify(options.body.system).includes('For each configured Chief job')) {
      ++inspectionRequests
      const response = [{ type: 'text', text: JSON.stringify({ summary: 'Actual isolated empty-project inspection', decisions: [] }) }]
      if (holdInspection) return new Promise(resolve => { releaseInspection = () => resolve(response) })
      return response
    }
    return inboxDriver.reply(options)
  } })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const env = { ...process.env, DEEPSEEK_API_KEY: 'isolated-test-provider', DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}/v1` }
  const profile = prepareBackend(home, backendConfig({ port }))
  // Offline test dependency provision; the separate fresh-home acceptance runs the real init installer.
  const modules = join(profile, 'node_modules'), installed = join(root, 'core/dev/harness/node_modules')
  mkdirSync(modules)
  for (const entry of readdirSync(installed)) if (!entry.startsWith('.') && !['@flybot', 'ds-bot'].includes(entry)) symlinkSync(join(installed, entry), join(modules, entry))
  symlinkSync(join(root, 'core'), join(modules, 'ds-bot'))
  mkdirSync(join(modules, '@flybot'), { recursive: true })
  for (const name of ['social', 'tree', 'timeline', 'workflow']) symlinkSync(join(root, 'plugins', name), join(modules, '@flybot', name))
  let host
  t.after(async () => { await host?.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); rmSync(home, { recursive: true, force: true }) })
  host = await launch(home, env)
  await assert.rejects(run(['init', '--home', home], env), /already active/)
  const login = await run(['login', '--home', home], env)
  assert.match(login, /Authenticated/); assert.doesNotMatch(login + host.output(), /\?token=|sessionToken|isolated-test-provider/)
  const token = readJson(join(home, 'private/backend-session.json')).sessionToken
  const transport = await connection(home), spec = readSpec()
  const api = async (endpoint, body = {}, who = token) => {
    const value = await callApi(transport, endpoint, body, who)
    validateExchange(spec, endpoint, body, { ok: true, value })
    return value
  }
  const dev = (kind, name, projectId, payload = {}, requestId) => api('project-development', { version: 'project-development/v1', kind, name, projectId, payload, ...(requestId ? { requestId } : {}) })
  const { project } = await api('project-create', { name: 'Persistent service' })
  await api('auth-mode')
  await api('auth-whoami')
  assert.equal(await api('auth-whoami', {}, ''), null)
  assert.equal(await api('auth-whoami', {}, 'invalid-example-token'), null)
  await api('workbench-state')
  await api('project-read', { id: project.id })
  await api('project-detail', { id: project.id, view: 'summary' })
  await api('project-members', { id: project.id })
  await api('project-repositories', { projectId: project.id })
  await api('personal-space', { operation: 'list' })
  for (const name of ['roles', 'role.proposals', 'project.snapshot', 'events', 'chief.state', 'pools', 'effects', 'compatibility']) await dev('query', name, project.id)
  const room = await api('project-room-create', { projectId: project.id, name: 'Contract room', roles: ['chief'], memberIds: [] })
  await api('project-room-read', { projectId: project.id, roomId: room.id })
  await api('project-rooms', { projectId: project.id })
  await api('project-agents', { projectId: project.id, view: 'summary' })
  await api('project-knowledge-write', { projectId: project.id, text: 'Contract fixture fact' })
  await api('project-role-memory-write', { projectId: project.id, role: 'developer', text: 'Bounded role fact', source: { kind: 'human', reference: 'isolated-contract-test' } })
  await api('project-agent-memory-write', { projectId: project.id, text: 'Private fixture note' })
  await api('project-agent-history', { projectId: project.id, visibility: 'private' })
  await api('project-resources', { projectId: project.id, view: 'summary' })
  const proposed = await dev('command', 'task.propose', project.id, { title: 'Project change', criteria: 'Result checked', impact: 'Keep project history' }, 'one-original-intent')
  const taskId = proposed.result.id
  assert.ok(taskId)
  await dev('query', 'task.detail', project.id, { taskId })
  await dev('query', 'handoff.list', project.id, { taskId })
  await dev('query', 'task.history', project.id, { taskId, section: 'requirements' })
  await dev('query', 'command.receipt', project.id, { commandRequestId: 'one-original-intent' })
  await dev('query', 'command.result', project.id, { commandRequestId: 'one-original-intent', limit: 100 })
  assert.equal((await dev('query', 'task', project.id, { taskId })).result.task.phase, 'awaiting-chief')
  const inquiry = await dev('command', 'consultation.ask', project.id, { text: 'Explain the Project status without creating work' }, 'ordinary-question')
  assert.equal(inquiry.result.consultation.initiativeTransferred, false)
  let answer
  for (let pass = 0; pass < 100; ++pass) {
    answer = (await dev('query', 'consultation.get', project.id, { consultationId: inquiry.result.consultation.id })).result.consultation
    if (answer.state === 'completed' && answer.replyCount > 0) break
    await pause(100)
  }
  assert.equal(answer.state, 'completed')
  assert.ok(answer.replyCount > 0)
  assert.equal((await dev('query', 'tasks', project.id)).result.tasks.length, 1)
  const external = await api('personal-agent-create', { name: 'External protocol caller', kind: 'external', provider: 'http-contract', endpoint: 'https://agent.example.invalid/callback' })
  await api('personal-agent-join', { agentId: external.agent.id, projectId: project.id })
  const credential = await api('personal-agent-token-create', { agentId: external.agent.id, projectIds: [project.id] })
  await api('personal-agent-token-list', { agentId: external.agent.id })
  await api('personal-agent-read', { agentId: external.agent.id })
  await api('personal-agent-list')
  await api('personal-agent-participations')
  await api('auth-whoami', {}, credential.token)
  await api('project-development', { version: 'project-development/v1', kind: 'query', name: 'roles', projectId: project.id, payload: {} }, credential.token)
  const refused = await fetch(`${transport.baseUrl}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flybot-member-session': credential.token }, body: JSON.stringify({ endpoint: 'project-development', payload: { version: 'project-development/v1', kind: 'command', name: 'task.propose', projectId: project.id, requestId: 'safe-must-not-publish', payload: { title: 'Refused shared publication' } } }) })
  assert.equal(refused.status, 200)
  const denial = await refused.json()
  validate(spec.components.schemas.DomainError, denial, spec)
  assert.equal(denial.ok, false)
  const privateProposal = await api('personal-agent-propose-task', { projectId: project.id, title: 'Proposed by the independent agent', criteria: 'Owner reviews the proposal', impact: 'Retain explicit Project impact', scope: 'Transport mapping only', projectTaskKind: 'code', requestId: 'external-safe-proposal' }, credential.token)
  assert.equal(privateProposal.proposal.fields.impact, 'Retain explicit Project impact')
  assert.equal(privateProposal.proposal.fields.scope, 'Transport mapping only')
  assert.equal((await dev('query', 'tasks', project.id)).result.tasks.length, 1)
  const publication = await dev('command', 'proposal.publish', project.id, { proposalId: privateProposal.proposal.id }, 'human-approved-agent-proposal')
  assert.equal(publication.result.task.projectTask.requirements.impact, 'Retain explicit Project impact')
  await api('personal-agent-delegation-set', { agentId: external.agent.id, projectId: project.id, mode: 'watch' })
  const watched = await api('project-development', { version: 'project-development/v1', kind: 'command', name: 'task.propose', projectId: project.id, requestId: 'external-watch-intent', payload: { title: 'Delegated Project work', criteria: 'Current authority checked', impact: 'Exercise the delegated publish boundary' } }, credential.token)
  assert.ok(watched.result.id)
  await api('personal-agent-token-revoke', { credentialId: credential.credential.id })
  assert.equal(await api('auth-whoami', {}, credential.token), null)
  await assert.rejects(api('project-read', { id: project.id }, credential.token), /unauthorized|forbidden/)
  const invitation = await api('auth-invite'), bob = await api('auth-redeem', { token: invitation.token, displayName: 'Bob' })
  await assert.rejects(api('project-read', { id: project.id }, bob.sessionToken), /forbidden/)
  const projectInvitation = await api('project-invite', { id: project.id })
  await api('project-join', { token: projectInvitation.token }, bob.sessionToken)
  await assert.rejects(api('project-development', { version: 'project-development/v1', kind: 'query', name: 'consultation.get', projectId: project.id, payload: { consultationId: inquiry.result.consultation.id } }, bob.sessionToken), /unavailable|forbidden|consultation/i)
  const stream = await fetch(`${transport.baseUrl}/api/project-events?projectId=${project.id}`, { headers: { 'x-flybot-member-session': bob.sessionToken }, signal: AbortSignal.timeout(10000) })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  const firstFrame = new TextDecoder().decode((await reader.read()).value)
  assert.match(firstFrame, /event: snapshot/)
  validate(spec.components.schemas.Snapshot, JSON.parse(/^data: (.*)$/m.exec(firstFrame)[1]), spec)
  await api('project-member-remove', { id: project.id, memberId: bob.memberId })
  let revoked = ''
  while (!revoked.includes('access-revoked')) { const next = await reader.read(); if (next.done) break; revoked += new TextDecoder().decode(next.value) }
  assert.match(revoked, /access-revoked/)
  await reader.cancel()
  // Prepare two real service Projects before enabling their Chief authority. The
  // deterministic driver will ask the actual native/external personal agents.
  const cases = []
  const inboxOwnerId = (await api('auth-whoami')).memberId
  const receiverKey = join(home, 'private/inbox-notification-key'), receiverClient = join(home, 'private/inbox-client.json')
  writeFileSync(receiverKey, 'isolated-webhook-fixture-key-'.repeat(3), { mode: 0o600 })
  for (const kind of ['native', 'external']) {
    const marker = `INBOX_${kind.toUpperCase()}_PROTOCOL_ACCEPTANCE`
    const { project: scoped } = await api('project-create', { name: marker })
    let identity
    if (kind === 'native') {
      const agents = await api('project-agents', { projectId: scoped.id })
      identity = { id: agents.mine.personalAgentId }
    } else {
      identity = (await api('personal-agent-create', { name: 'Independent inbox client', kind: 'external', provider: 'isolated-process-fixture', endpoint: 'https://receiver.example.invalid/descriptor-only' })).agent
      await api('personal-agent-join', { agentId: identity.id, projectId: scoped.id })
    }
    await api('personal-agent-default', { agentId: identity.id, projectId: scoped.id })
    await api('personal-agent-delegation-set', { agentId: identity.id, projectId: scoped.id, mode: 'watch' })
    const issued = await api('personal-agent-token-create', { agentId: identity.id, projectIds: [scoped.id] })
    const proposed = await dev('command', 'task.propose', scoped.id, { title: marker, criteria: 'The scoped reply is read by Chief', impact: 'Verify the same inbox processing contract', projectTaskKind: 'decision' }, `propose-${kind}-inbox`)
    inboxDriver.register(marker, proposed.result.id)
    cases.push({ kind, projectId: scoped.id, agentId: identity.id, token: issued.token, taskId: proposed.result.id })
  }
  const externalCase = cases.find(row => row.kind === 'external')
  writeFileSync(receiverClient, JSON.stringify({ origin: transport.baseUrl, projectId: externalCase.projectId, agentId: externalCase.agentId, token: externalCase.token }), { mode: 0o600 })
  const receiver = fork(join(root, 'core/test/fixtures/agent-webhook-receiver.mjs'), [receiverKey, receiverClient], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } })
  const receiverExited = once(receiver, 'exit')
  t.after(async () => { receiver.kill(); await receiverExited })
  const [receiverReady] = await once(receiver, 'message')
  await host.close(); host = null
  assert.equal(existsSync(join(home, 'bot/state.sqlite')), true)
  prepareBackend(home, backendConfig({ port, bot: { projectAgentWebhooks: { receiver: { ownerId: inboxOwnerId, agentId: externalCase.agentId, projectId: externalCase.projectId, endpoint: `http://127.0.0.1:${receiverReady.port}/notify`, allowLoopback: true, signingKeyFile: receiverKey } } } }))
  host = await launch(home, env)
  assert.match(await run(['login', '--home', home], env), /existing private local session/)
  const nextTransport = await connection(home)
  const apiNext = async (endpoint, payload = {}, who = token) => {
    const value = await callApi(nextTransport, endpoint, payload, who)
    validateExchange(spec, endpoint, payload, { ok: true, value }); return value
  }
  const devNext = (kind, name, projectId, payload, requestId, who = token) => apiNext('project-development', { version: 'project-development/v1', kind, name, projectId, payload, ...(requestId ? { requestId } : {}) }, who)
  await devNext('command', 'inbox.connection.configure', externalCase.projectId, { agentId: externalCase.agentId, enabled: true, connectionId: 'receiver' }, 'enable-fixture-receiver')
  const received = []
  receiver.on('message', message => { if (message.event) received.push(message) })
  for (const row of cases) {
    await devNext('command', 'chief.configure', row.projectId, { enabled: true, inspection: { enabled: false } }, `enable-${row.kind}-chief`)
    let completed = false
    for (let pass = 0; pass < 100; pass++) {
      const task = (await devNext('query', 'task', row.projectId, { taskId: row.taskId })).result.task
      const inbox = (await devNext('query', 'inbox.list', row.projectId, {}, undefined, row.token)).result.items
      const inputs = (await devNext('query', 'inputs', row.projectId, { taskId: row.taskId })).result.inputs
      if (task.contract?.admission.status === 'accepted' && task.phase !== 'awaiting-owner' && inbox.some(message => message.phase === 'handled') && inputs.some(input => input.phase === 'handled')) { completed = true; break }
      await pause(100)
    }
    assert.equal(completed, true, `${row.kind}: Chief advice must return through one inbox to the original Task`)
    await devNext('command', 'chief.configure', row.projectId, { enabled: false }, `disable-${row.kind}-chief`)
  }
  assert.ok(inboxDriver.observed.nativeClaims > 0 && inboxDriver.observed.nativeCompletions > 0)
  assert.ok(inboxDriver.observed.chiefResumptions >= 2)
  assert.equal(inboxDriver.observed.invalidChiefResponses, 2)
  assert.equal(inboxDriver.observed.chiefCorrections, 2)
  assert.ok(received.some(message => message.handled && message.verified && !message.authorization && !message.ownerCookie))
  const after = await callApi(nextTransport, 'project-development', { version: 'project-development/v1', kind: 'command', name: 'task.propose', projectId: project.id, requestId: 'one-original-intent', payload: { title: 'Project change', criteria: 'Result checked', impact: 'Keep project history' } }, token)
  assert.equal(after.replayed, true)
  assert.equal(after.result.id, taskId)
  await assert.rejects(callApi(nextTransport, 'project-read', { id: project.id }, bob.sessionToken), /forbidden/)
  // Insert only a queued reminder in this disposable stopped home. All execution,
  // cancellation, exit proof, restart recovery and result persistence below are real.
  const { project: recoveryProject } = await apiNext('project-create', { name: inspectionMarker })
  const configured = await devNext('command', 'chief.configure', recoveryProject.id, { enabled: true, inspection: { lifecycle: { runTimeoutMs: 3000, recoveryDelayMs: 3000 }, enabled: true } }, 'configure-inspection-recovery')
  const scheduleId = configured.result.policy.scheduleId
  await host.close(); host = null
  const database = openSqliteState({ path: join(home, 'bot/state.sqlite') })
  try {
    const state = database.read(), schedule = state.projectScheduledTasks[scheduleId]
    schedule.deliveries['fixture-inspection-occurrence'] = { id: 'fixture-inspection-occurrence', scheduleId: schedule.scheduleId, revision: schedule.revision, occurrenceAt: new Date().toISOString(), at: Date.now(), status: 'queued' }
    database.write(state)
  } finally { database.close() }
  host = await launch(home, env)
  let interruptedRun
  for (let pass = 0; pass < 150; pass++) {
    const chief = await devNext('query', 'chief.state', recoveryProject.id, {})
    interruptedRun = chief.result.runs.find(row => row.source?.occurrenceId === 'fixture-inspection-occurrence')
    if (interruptedRun?.status === 'interrupted' && releaseInspection) break
    await pause(100)
  }
  assert.equal(interruptedRun?.status, 'interrupted'); assert.ok(inspectionRequests >= 1)
  holdInspection = false; releaseInspection()
  let confirmed = false
  for (let pass = 0; pass < 100; pass++) {
    const chief = await devNext('query', 'chief.state', recoveryProject.id, {})
    const run = chief.result.runs.find(row => row.id === interruptedRun.id)
    if (run?.exitProof?.confirmed) { confirmed = true; break }
    await pause(50)
  }
  assert.equal(confirmed, true, 'Actual native whenIdle/stop must confirm exit before restart recovery')
  await host.close(); host = null
  host = await launch(home, env)
  let recovered
  for (let pass = 0; pass < 150; pass++) {
    const chief = await devNext('query', 'chief.state', recoveryProject.id, {})
    const run = chief.result.runs.find(row => row.id === interruptedRun.id)
    if (run?.status === 'done' && chief.result.schedule.deliveries.some(row => row.runId === run.id && row.status === 'completed')) { recovered = chief.result; break }
    await pause(100)
  }
  assert.ok(recovered, 'Taskless scheduled inspection must reconcile and complete after actual backend restart')
  assert.equal(recovered.runs.filter(row => row.source?.occurrenceId === 'fixture-inspection-occurrence').length, 1)
  assert.equal(recovered.runs.find(row => row.id === interruptedRun.id).invocation, 2)
  assert.ok(recovered.health.lastSuccessAt); assert.equal(recovered.health.lastAppliedDecisionAt, null)
  assert.equal((await devNext('query', 'tasks', recoveryProject.id, {})).result.tasks.length, 0)
  await host.close(); host = null
  const statePath = join(home, 'bot/state.json'), future = JSON.stringify({ version: 99, note: 'Preserve this unsupported guard' })
  writeFileSync(statePath, future)
  await assert.rejects(launch(home, env), /read-only/)
  assert.equal(readFileSync(statePath, 'utf8'), future)
})
