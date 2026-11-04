import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveGithubIdentity } from '../src/host/project-github.js'
import { createProjectCredentials } from '../src/host/project-credentials.js'

test('explicit GitHub sources ignore ambient tokens and verify their configured login', async () => {
  let options
  const source = { credential: 'gh-cli', configDir: '/private/alice-gh', login: 'alice' }
  const run = async (_command, _args, given) => { options = given; return { stdout: 'selected-token\n' } }
  const request = async () => Response.json({ login: 'Alice' })
  const previous = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'ambient-other-user-token'
  try {
    const result = await resolveGithubIdentity(source, { run, request })
    assert.equal(result.login, 'Alice')
    assert.equal(options.env.GH_TOKEN, undefined)
    assert.equal(options.env.GH_CONFIG_DIR, '/private/alice-gh')
    await assert.rejects(resolveGithubIdentity({ ...source, login: 'bob' }, { run, request }), /does not match/)
    await assert.rejects(resolveGithubIdentity({ credential: 'gh-cli' }, { run, request }), /explicitly configured/)
  } finally { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous }
})

test('personal operations never borrow Project automation or another human/project credential', async () => {
  const alice = { memberId: 'alice' }, bob = { memberId: 'bob' }
  const project = { id: 'p1', repository: 'example/repo' }
  let externalCalls = 0
  const rt = { state: {}, config: { personalGithub: { alice: { p1: { credential: 'gh-cli', configDir: '/private/alice-gh', login: 'alice-gh' } } },
    projectRepositories: { 'example/repo': { github: { credential: 'gh-cli', configDir: '/automation', login: 'app' } } } },
    requireProjectAccess(actor, id) { assert.ok(['alice', 'bob'].includes(actor.memberId)); assert.ok(['p1', 'p2'].includes(id)); return { ...project, id } }, save: async () => {} }
  const service = createProjectCredentials(rt, { identity: async settings => ({ login: settings.login, token: 'private-token' }),
    request: async () => { externalCalls++; return Response.json({ user: { login: 'alice-gh' }, html_url: 'https://github.com/example/repo/issues/1#issuecomment-1' }) } })
  const body = { projectId: 'p1', issueNumber: 1, text: 'Explicit public comment', memberId: 'alice', credentialRef: '/private/alice-gh' }
  await assert.rejects(service.endpoint('project-github-comment', body, bob), /not configured/)
  await assert.rejects(service.endpoint('project-github-comment', { ...body, projectId: 'p2' }, alice), /not configured/)
  assert.equal(externalCalls, 0)
  const result = await service.endpoint('project-github-comment', body, alice)
  assert.equal(result.audit.initiatedBy, 'alice')
  assert.equal(result.audit.executorLogin, 'alice-gh')
  assert.equal(result.audit.scope, 'personal')
  assert.equal(JSON.stringify(rt.state).includes('private-token'), false)
  assert.equal(JSON.stringify(rt.state).includes(body.text), false)
  const bobStatus = await service.endpoint('project-credential-status', { projectId: 'p1', memberId: 'alice' }, bob)
  assert.equal(bobStatus.personal.configured, false)
  assert.equal(bobStatus.automation.configured, true)
  await assert.rejects(service.endpoint('project-github-comment', { ...body, scope: 'project' }, alice), /only uses your own/)
})

test('revoked platform access or mismatched personal login refuses the external write', async () => {
  let calls = 0
  const rt = { state: {}, platformIdentityEnabled: true, validatePlatformActor: async () => false,
    config: { personalGithub: { alice: { p1: { login: 'alice-gh' } } } },
    requireProjectAccess: () => ({ id: 'p1', repository: 'example/repo' }), save: async () => {} }
  const body = { projectId: 'p1', issueNumber: 1, text: 'Do not post' }
  const service = createProjectCredentials(rt, { identity: async () => ({ login: 'alice-gh', token: 'token' }), request: async () => { calls++ } })
  await assert.rejects(service.endpoint('project-github-comment', body, { memberId: 'alice' }), /session was revoked/)
  const wrong = createProjectCredentials(rt, { identity: async () => ({ login: 'bob-gh', token: 'token' }), request: async () => { calls++ } })
  await assert.rejects(wrong.endpoint('project-github-comment', body, { memberId: 'alice' }), /identity mismatch/)
  assert.equal(calls, 0)
})

test('malformed credential output is refused without reflecting it or sending a request', async () => {
  let called = false
  await assert.rejects(resolveGithubIdentity({ credential: 'gh-cli', configDir: '/private/selected' }, {
    run: async () => ({ stdout: 'private-value\ninvalid-value' }), request: async () => { called = true },
  }), error => /unavailable/.test(error.message) && !error.message.includes('private-value'))
  assert.equal(called, false)
})

test('project App credentials cannot be selected for personal comments', async () => {
  let calls = 0
  const rt = { state: {}, config: { personalGithub: { alice: { p: { credential: 'github-app', appId: 7, installationId: 12, login: 'app[bot]' } } } }, requireProjectAccess: () => ({ id: 'p', repository: 'org/repo' }) }
  const service = createProjectCredentials(rt, { identity: async () => { calls++; return { token: 'never', login: 'app[bot]' } } })
  await assert.rejects(service.endpoint('project-github-comment', { projectId: 'p', issueNumber: 1, text: 'As user' }, { memberId: 'alice' }), /independent user/)
  assert.equal(calls, 0)
})
