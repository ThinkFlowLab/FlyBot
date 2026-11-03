// Exercise the production launcher in an isolated persistent home. Inference is a test double.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { backendConfig, callApi, connection, prepareBackend, readJson, root } from '../../scripts/backend-lib.mjs'
import { mockModel } from '../../dev/demo/mock.mjs'
import { agentReply } from '../../dev/demo/agents.mjs'

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

test('production backend retains canonical Tasks/auth across restart, keeps consultation private and serves scoped SSE', { timeout: 90000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-backend-runtime-')), port = await freePort()
  const model = mockModel([], { reply: agentReply })
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
  const transport = await connection(home), api = (endpoint, body = {}, who = token) => callApi(transport, endpoint, body, who)
  const dev = (kind, name, projectId, payload = {}, requestId) => api('project-development', { version: 'project-development/v1', kind, name, projectId, payload, ...(requestId ? { requestId } : {}) })
  const { project } = await api('project-create', { name: 'Persistent service' })
  const proposed = await dev('command', 'task.propose', project.id, { title: 'Project change', criteria: 'Result checked', impact: 'Keep project history' }, 'one-original-intent')
  const taskId = proposed.result.id
  assert.ok(taskId)
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
  await assert.rejects(api('project-read', { id: project.id }, credential.token), /unauthorized|forbidden/)
  const invitation = await api('auth-invite'), bob = await api('auth-redeem', { token: invitation.token, displayName: 'Bob' })
  await assert.rejects(api('project-read', { id: project.id }, bob.sessionToken), /forbidden/)
  const projectInvitation = await api('project-invite', { id: project.id })
  await api('project-join', { token: projectInvitation.token }, bob.sessionToken)
  await assert.rejects(api('project-development', { version: 'project-development/v1', kind: 'query', name: 'consultation.get', projectId: project.id, payload: { consultationId: inquiry.result.consultation.id } }, bob.sessionToken), /unavailable|forbidden|consultation/i)
  const stream = await fetch(`${transport.baseUrl}/api/project-events?projectId=${project.id}`, { headers: { 'x-flybot-member-session': bob.sessionToken }, signal: AbortSignal.timeout(10000) })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/)
  await api('project-member-remove', { id: project.id, memberId: bob.memberId })
  let revoked = ''
  while (!revoked.includes('access-revoked')) { const next = await reader.read(); if (next.done) break; revoked += new TextDecoder().decode(next.value) }
  assert.match(revoked, /access-revoked/)
  await reader.cancel()
  await host.close(); host = null
  assert.equal(existsSync(join(home, 'bot/state.sqlite')), true)
  host = await launch(home, env)
  assert.match(await run(['login', '--home', home], env), /existing private local session/)
  const nextTransport = await connection(home)
  const after = await callApi(nextTransport, 'project-development', { version: 'project-development/v1', kind: 'command', name: 'task.propose', projectId: project.id, requestId: 'one-original-intent', payload: { title: 'Project change', criteria: 'Result checked', impact: 'Keep project history' } }, token)
  assert.equal(after.replayed, true)
  assert.equal(after.result.id, taskId)
  await assert.rejects(callApi(nextTransport, 'project-read', { id: project.id }, bob.sessionToken), /forbidden/)
  await host.close(); host = null
  const statePath = join(home, 'bot/state.json'), future = JSON.stringify({ version: 99, note: 'Preserve this unsupported guard' })
  writeFileSync(statePath, future)
  await assert.rejects(launch(home, env), /read-only/)
  assert.equal(readFileSync(statePath, 'utf8'), future)
})
