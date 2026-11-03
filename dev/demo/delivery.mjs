import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export function deliveryReply({ body, result, tools }) {
  const system = JSON.stringify(body.system ?? '')
  const developer = system.includes('Implement the task in your assigned worktree')
  const tester = system.includes('Inspect the implementation in your assigned worktree')
  const reviewer = system.includes('Independently review the candidate diff')
  if (!developer && !tester && !reviewer) return undefined
  if (JSON.stringify(body.messages).includes('M71_CONTEXT_CHECK')) {
    assert.ok(system.includes('Published role memory marker'), 'Actual model request must include explicit role memory')
    assert.ok(system.includes('Repository instructions marker'), 'Actual model request must include repository instructions')
    assert.ok(system.includes('project-role-context'), 'Actual model request must include versioned assembled context')
  }
  if (tools && !result) {
    const command = developer
      ? `node --input-type=module -e 'import {writeFileSync} from "node:fs"; writeFileSync("code.mjs","export const add = (a,b) => a+b;\\n"); console.log("implemented")'`
      : tester ? 'node --test code.test.mjs' : 'git rev-parse HEAD && git show --stat HEAD'
    return [{ type: 'tool_use', id: `delivery-${developer ? 'dev' : tester ? 'test' : 'review'}`, name: 'bash', input: { description: 'Inspect the isolated delivery worktree', command } }]
  }
  if (developer) return [{ type: 'text', text: 'OUTPUT implementation: addition now computes a+b.' }]
  if (tester) return [{ type: 'text', text: 'OUTPUT tests: checked the configured addition test in the sealed candidate worktree.' }]
  const last = JSON.stringify(body.messages?.at(-1)?.content ?? '')
  const sha = last.match(/\b[a-f0-9]{40}\b/)?.[0] ?? ''
  return [{ type: 'text', text: `OUTPUT review: ${JSON.stringify({ commit: sha, verdict: 'approve', summary: 'The isolated candidate implements addition and the test covers the reported regression.' })}` }]
}

export function provisionDeliveryFixture(directory, githubRepository) {
  if (githubRepository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) throw new Error('Invalid explicit GitHub repository')
    execFileSync('git', ['clone', '--depth', '1', '--branch', 'main', `https://github.com/${githubRepository}.git`, directory], { stdio: 'pipe', timeout: 60_000 })
  }
  const run = args => execFileSync('git', args, { cwd: directory, stdio: 'pipe' })
  run(['init', '-b', 'main'])
  run(['config', 'user.name', 'Delivery fixture'])
  run(['config', 'user.email', 'fixture@localhost'])
  writeFileSync(join(directory, 'code.mjs'), 'export const add = (a,b) => a-b;\n')
  writeFileSync(join(directory, 'code.test.mjs'), "import assert from 'node:assert/strict'; import {add} from './code.mjs'; assert.equal(add(2,3),5); assert.equal(add(-7,2),-5); assert.equal(add(11,13),24);\n")
  if (!githubRepository) writeFileSync(join(directory, 'AGENTS.md'), 'Repository instructions marker: verify addition in the assigned worktree.')
  run(['add', '.']); run(['commit', '-m', 'Delivery fixture base'])
}

export async function checkDelivery({ api, call, saved, waitFor, repository, githubRepository }) {
  const invitation = await api('auth-invite')
  const alice = await api('auth-redeem', { token: invitation.token, displayName: 'Alice' })
  const ownerCall = (endpoint, body = {}) => api(endpoint, body, alice.sessionToken)
  const state = await ownerCall('state')
  const model = state.models.find(row => /deepseek-flash/.test(row.ref))?.ref ?? state.models.at(-1)?.ref
  const { project } = await ownerCall('project-create', { name: 'Delivery acceptance', repository: githubRepository ?? 'example/delivery-fixture' })
  const botId = saved().projects[project.id].chief.botId
  await ownerCall('project-agent-definition', { projectId: project.id, role: 'chief', model })
  for (const role of ['developer', 'tester', 'reviewer']) {
    const { memory } = await ownerCall('project-role-memory-write', { projectId: project.id, role, text: 'Published role memory marker: record actual evidence', source: { kind: 'human', reference: 'runtime fixture publication' } })
    await ownerCall('project-agent-definition', { projectId: project.id, role, memoryRefs: [memory.id] })
  }
  const task = await ownerCall('task-create', { botId, projectId: project.id, title: githubRepository ? '[Demo artifact M3] Fix addition in isolated worktrees' : 'Fix addition', criteria: githubRepository ? 'Addition must pass the provisioned cases. Integration artifact: deterministic model transport, no independent code-review PASS and no production deployment.' : 'add(2,3) must equal 5. M71_CONTEXT_CHECK' })
  const started = await ownerCall('project-task-run', { taskId: task.id, requestId: 'delivery-runtime-1' })
  assert.equal(started.attempt.status, 'running', started.attempt.failure?.message)
  const id = started.attempt.id
  const attempt = await waitFor(() => {
    const row = saved().projectAttempts[id]
    return row && (row.status === 'failed' || row.status === 'waiting-acceptance') ? row : null
  }, 'delivery evidence/credential gate')
  assert.equal(attempt.evidence.tests.passed, true)
  await waitFor(() => Object.values(saved().projectAttempts[id].roleSessions).every(row => row.status === 'released'), 'temporary role Session release')
  const sessions = Object.values(saved().projectAttempts[id].roleSessions)
  assert.equal(new Set(sessions.map(row => row.sessionId)).size, 3)
  for (const session of sessions) {
    const native = saved().projectNativeWorkers?.[session.botId]
    assert.equal(native?.status, 'quiescent', 'Actual DSH must settle before native worker deletion')
    assert.equal(native.releaseProof.kind, 'native-agent-quiescent')
    assert.equal(native.releaseProof.sessionId, session.sessionId)
    assert.equal(saved().bots[session.botId], undefined)
  }
  assert.ok(sessions.every(row => row.context.text.includes('Published role memory marker')))
  assert.equal(attempt.evidence.review.verdict, 'approve')
  assert.equal(attempt.evidence.tests.sha, attempt.evidence.review.sha)
  assert.equal(attempt.evidence.implementation.sha, attempt.candidateSha)
  if (githubRepository) {
    assert.equal(attempt.status, 'waiting-acceptance', attempt.failure?.message)
    assert.equal(attempt.pr.sha, attempt.candidateSha)
    await waitFor(() => saved().projectExecutions[attempt.runId]?.status === 'done', 'published delivery Run completion')
    await ownerCall('project-task-accept', { attemptId: id })
    assert.equal(saved().tasks[task.id].status, 'accepted')
  } else {
    assert.match(attempt.failure.message, /credential/)
    assert.equal(attempt.pr, undefined)
    assert.equal(saved().tasks[task.id].status, 'failed')
    assert.equal((await call('project-task-accept', { attemptId: id }, alice.sessionToken)).ok, false)
  }
  assert.match(readFileSync(join(repository, 'code.mjs'), 'utf8'), /a-b/, 'base repository is unchanged')
  if (!githubRepository) {
    const duplicate = await ownerCall('project-task-run', { taskId: task.id, requestId: 'delivery-runtime-1' })
    assert.equal(duplicate.already, true)
    await waitFor(() => saved().projectExecutions[attempt.runId]?.status === 'failed', 'failed canonical delivery Run')
  }
  await ownerCall('project-attempt-cleanup', { attemptId: id })
  const remaining = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repository, encoding: 'utf8' })
  assert.equal((remaining.match(/^worktree /gm) ?? []).length, 1)
  return { milestone: 'M3', runtime: 'actual DSH', model: 'deterministic mock',
    checks: ['actual native quiescence proof before removal', 'model-visible role memory and repository context', 'temporary role Sessions released', 'isolated role worktrees', 'actual code edit', 'independent configured tests', 'commit-specific reviewer output',
      ...(githubRepository ? ['real GitHub PR head verified', 'authorized human acceptance'] : ['missing GitHub credential blocks publication/acceptance', 'duplicate start idempotent']), 'registered worktrees cleaned'],
    ...(githubRepository ? { pr: attempt.pr } : {}),
    notRun: ['real model', ...(!githubRepository ? ['real GitHub publication'] : []), 'browser acceptance'] }
}
