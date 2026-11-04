import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Controlled verification gates make quota assertions independent of model/host
// speed. This fixture runs only inside the disposable runtime test directory.
export function provisionQueueGate(directory) {
  const script = join(directory, 'queue-verifier.mjs')
  writeFileSync(script, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path'; import {pathToFileURL} from 'node:url';
const root=process.argv[2], ledger=join(root,'queue-verifications.json');
const key=process.cwd().match(/attempt-[a-z0-9-]+/i)?.[0];
if(!key) throw Error('Verifier requires a registered Attempt workspace');
const rows=existsSync(ledger)?JSON.parse(readFileSync(ledger,'utf8')):[];
if(!rows.includes(key)){rows.push(key);writeFileSync(ledger,JSON.stringify(rows));}
const gate=join(root,'queue-release-'+(rows.indexOf(key)+1));
const deadline=Date.now()+30000;
while(!existsSync(gate)){if(Date.now()>deadline)throw Error('Fixture verification gate was not released');await new Promise(r=>setTimeout(r,25));}
await import(pathToFileURL(resolve('code.test.mjs')));
`)
  return { command: [process.execPath, script, directory], release: index => writeFileSync(join(directory, `queue-release-${index}`), 'fixture release') }
}

export async function checkQueue({ api, call, saved, waitFor, releaseVerification }) {
  const invitation = await api('auth-invite')
  const alice = await api('auth-redeem', { token: invitation.token, displayName: 'Alice' })
  const owner = (endpoint, body = {}) => api(endpoint, body, alice.sessionToken)
  const state = await owner('state')
  const second = await owner('auth-invite')
  const bob = await api('auth-redeem', { token: second.token, displayName: 'Bob' })
  const member = (endpoint, body = {}) => api(endpoint, body, bob.sessionToken)
  const { project } = await owner('project-create', { name: 'Queued delivery', repository: 'example/delivery-fixture' })
  const invite = await owner('project-invite', { projectId: project.id })
  await member('project-join', { token: invite.token })
  await owner('project-quota', { projectId: project.id, maxConcurrent: 1 })
  const { public: chief } = await owner('project-agents', { projectId: project.id })
  const tasks = []
  for (let index = 0; index < 2; index++) tasks.push(await member('task-create', { projectId: project.id, botId: chief.botId, title: `Fix addition ${index}`, impact: 'Repair Project addition', criteria: 'add(2,3) equals 5' }))
  const service = (actor, kind, name, payload, requestId) => actor('project-development', { version: 'project-development/v1', projectId: project.id, kind, name, payload, ...(requestId ? { requestId } : {}) })
  const published = await service(member, 'query', 'task', { taskId: tasks[0].id })
  assert.equal(published.result.task.phase, 'awaiting-chief')
  const original = await member('project-task-detail', { taskId: tasks[0].id })
  // Independent HTTP reads are not an atomic snapshot of background Effect retries.
  const { effects: originalEffects, ...originalTask } = original.view
  const { effects: publishedEffects, ...publishedTask } = published.result.task
  assert.deepEqual(originalTask, publishedTask)
  const identities = rows => rows.map(({ id, kind, projectId, taskId }) => ({ id, kind, projectId, taskId }))
  assert.deepEqual(identities(originalEffects), identities(publishedEffects))
  const pending = (await service(member, 'command', 'task.run', { taskId: tasks[0].id }, 'queue-first')).result
  assert.equal(pending.waitingFor, 'chief')
  assert.equal(Object.values(saved().projectAttempts).length, 0)
  const model = state.models.find(row => /deepseek-flash/.test(row.ref))?.ref ?? state.models.at(-1)?.ref
  await owner('project-agent-definition', { projectId: project.id, role: 'chief', model })
  await owner('project-chief-configure', { projectId: project.id, enabled: true, inspection: { enabled: false } })
  const entry = await waitFor(() => Object.values(saved().projectQueue ?? {}).find(row => row.taskId === tasks[1].id && row.status === 'waiting'), 'Chief-admitted second Task queues before allocation')
  const queued = { queue: entry }
  assert.equal(Object.values(saved().projectAttempts).length, 1, 'queue must not allocate an Attempt or worktree')
  const duplicate = await member('project-task-run', { taskId: tasks[1].id, requestId: entry.requestId })
  assert.equal(duplicate.queue.id, queued.queue.id)
  releaseVerification(1)
  await waitFor(() => saved().projectQueue[queued.queue.id]?.status === 'started', 'real Workflow release drains queued delivery')
  assert.equal(Object.values(saved().projectAttempts).length, 2)
  tasks.push(await member('task-create', { projectId: project.id, botId: chief.botId, title: 'Revoked queued request', impact: 'Independent Project check', criteria: 'Addition remains correct' }))
  const third = { queue: await waitFor(() => Object.values(saved().projectQueue ?? {}).find(row => row.taskId === tasks[2].id && row.status === 'waiting'), 'third admitted Task waits while second executes') }
  await owner('project-member-remove', { projectId: project.id, memberId: bob.memberId })
  releaseVerification(2)
  assert.equal(saved().projectQueue[third.queue.id].status, 'cancelled')
  assert.equal((await call('project-resources', { projectId: project.id }, bob.sessionToken)).ok, false)
  assert.equal((await call('project-development', { version: 'project-development/v1', kind: 'query', name: 'tasks', projectId: project.id, payload: {} }, bob.sessionToken)).ok, false)
  await waitFor(() => Object.values(saved().projectAttempts).every(row => row.status === 'failed'), 'credential gate finishes both actual delivery Attempts')
  // Workflow status is saved before its asynchronous worker release finishes.
  // Cleanup deliberately refuses workspaces while a worker can still use them.
  await waitFor(() => {
    const state = saved()
    const attempts = new Set(Object.keys(state.projectAttempts))
    return !Object.values(state.bots).some(bot => bot.ephemeral && attempts.has(bot.attemptId)) &&
      !Object.values(state.projectResourceLeases ?? {}).some(lease => attempts.has(lease.attemptId) && lease.status !== 'released')
  }, 'confirmed worker release before workspace cleanup')
  for (const attempt of Object.values(saved().projectAttempts)) await owner('project-attempt-cleanup', { attemptId: attempt.id })
  const resources = await owner('project-resources', { projectId: project.id })
  assert.equal(resources.activeSlots, 0)
  assert.equal(resources.metrics.acceptedTasks, 0)
  assert.equal(resources.metrics.duration.medianMs, null)
  return { milestone: 'M5', runtime: 'actual DSH', model: 'deterministic mock', checks: ['actual Chief admission precedes allocation', 'versioned service and legacy views agree', 'service command uses original execution', 'revoked member service query denied', 'quota queues before worktree allocation', 'duplicate queue request idempotent', 'Workflow release drains queue', 'revoked member queued request cancelled', 'confirmed worker release before workspace cleanup', 'no invented acceptance metrics'], notRun: ['real model', 'real GitHub publication'] }
}
