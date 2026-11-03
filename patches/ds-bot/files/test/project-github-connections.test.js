import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGithubConnections, projectGithubSettings } from '../src/host/project-github-connections.js'
function fixture() {
  const project = { id: 'p', repository: 'example/demo' }, actor = { memberId: 'owner' }
  const settings = { credential: 'github-app', appId: 7, installationId: 12, privateKeyFile: '/private/test.pem', projectIds: ['p'], repositories: ['example/demo'] }
  let fail = false, calls = 0, during = () => {}
  const rt = { state: {}, config: { projectGithubConnections: { app: settings }, projectRepositories: { 'example/demo': { github: { credential: 'gh-cli', configDir: '/owner' } } } }, requireProjectAccess(a, id, permission) { assert.equal(id, 'p'); if (permission === 'configure' && a.memberId !== 'owner') throw Error('Forbidden'); return project }, save: async () => { if (fail) throw Error('Disk failure') }, validateHumanActor: async () => true }
  const service = createGithubConnections(rt, { identity: async () => { calls++; during(); return { provider: 'github-app', appId: 7, installationId: 12, login: 'test[bot]', token: 'PRIVATE-SENTINEL' } } })
  const configure = (body, a = actor) => service.endpoint('configure', { projectId: 'p', connectionId: 'app', expectedRevision: 0, requestId: 'select', ...body }, a)
  return { rt, project, service, configure, settings, calls: () => calls, fail() { fail = true }, during(fn) { during = fn } }
}
test('human selection binds repository/install identity; disable and changed selection never fall back', async () => {
  const f = fixture()
  const result = await f.configure({})
  assert.equal(result.connection.provider, 'github-app'); assert.equal(result.connection.revision, 1)
  assert.equal(projectGithubSettings(f.rt, f.project).installationId, 12)
  f.settings.privateKeyFile = '/private/rotated.pem'
  assert.equal(projectGithubSettings(f.rt, f.project).privateKeyFile, '/private/rotated.pem')
  assert(!JSON.stringify(result).includes('/private/')); assert(!JSON.stringify(f.project).includes('SENTINEL'))
  f.settings.installationId = 99
  assert.throws(() => projectGithubSettings(f.rt, f.project), /changed/)
  await f.configure({ expectedRevision: 1, connectionId: null })
  assert.throws(() => projectGithubSettings(f.rt, f.project), /disabled/)
  assert.equal((await f.service.endpoint('status', { projectId: 'p' }, { memberId: 'member' })).connection.configured, false)
})
test('models, external full-watch agents, foreign projects/repositories and stale revisions cannot select credentials', async () => {
  const f = fixture()
  for (const extra of [{ agentId: 'a' }, { watchGrantId: 'w' }, { personalAgentCredentialId: 'c' }, { chiefJobId: 'j' }]) await assert.rejects(f.configure({}, { memberId: 'owner', ...extra }), /human/)
  await assert.rejects(f.configure({}, { memberId: 'member' }), /Forbidden/)
  await assert.rejects(f.configure({ repository: 'other/repo' }), /associated/)
  f.settings.repositories = ['other/repo']; await assert.rejects(f.configure({}), /provisioned/)
  assert.equal(f.calls(), 0)
})
test('failed save and mid-verification change cannot commit selection', async () => {
  const f = fixture(); f.fail(); await assert.rejects(f.configure({}), /Disk/)
  assert.equal(f.project.githubConnections['example/demo'], undefined)
  const g = fixture(); g.during(() => { g.settings.installationId = 99 }); await assert.rejects(g.configure({}), /changed/)
  assert.equal(g.project.githubConnections, undefined)
})

test('real runtime v1 receipts persist human connection selection and survive restart without credentials', async t => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { createRuntime } = await import('../index.js'), { fakeContext } = await import('./fake-ctx.js')
  const home = mkdtempSync(join(tmpdir(), 'flybot-app-selection-'))
  const config = { home, projectWorkbench: true, projectGithubConnections: { app: { credential: 'github-app', appId: 7, installationId: 12, privateKeyFile: '/private/not-read.pem', projectIds: ['p'], repositories: ['org/repo'] } } }
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, members: { 'owner-1': { id: 'owner-1' }, member: { id: 'member' } }, projects: { p: { id: 'p', ownerUserId: 'owner-1', repository: 'org/repo', status: 'active', roles: { maintainers: [], members: ['member'] } } }, bots: {}, rooms: {}, mainBotIds: [], tasks: {} }))
  const contexts = []; t.after(async () => { for (const ctx of contexts) await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const ctx = fakeContext(); contexts.push(ctx); const rt = createRuntime(ctx, config); await rt.load()
  let calls = 0
  rt.projectGithubConnections = createGithubConnections(rt, { identity: async () => { calls++; return { provider: 'github-app', appId: 7, installationId: 12, login: 'app[bot]', token: 'PRIVATE-INSTALLATION-SENTINEL' } } })
  const body = { version: 'project-development/v1', kind: 'command', projectId: 'p', name: 'github.connection.configure', requestId: 'select-one', payload: { connectionId: 'app', expectedRevision: 0 } }
  const result = await rt.projectEndpoint('project-development', body, { memberId: 'owner-1' })
  assert.equal(result.result.connection.revision, 1)
  assert.equal((await rt.projectEndpoint('project-development', body, { memberId: 'owner-1' })).replayed, true); assert.equal(calls, 1)
  await assert.rejects(rt.projectEndpoint('project-development', { ...body, requestId: 'member-try' }, { memberId: 'member' }), /denied/)
  const stored = readFileSync(join(home, 'state.json'), 'utf8'); assert(!stored.includes('SENTINEL')); assert(!stored.includes('not-read.pem'))
  await ctx.dispose(); contexts.pop()
  const next = fakeContext(); contexts.push(next); const restarted = createRuntime(next, config); await restarted.load()
  assert.equal(projectGithubSettings(restarted, restarted.requireProjectAccess({ memberId: 'owner-1' }, 'p')).installationId, 12)
  const status = await restarted.projectEndpoint('project-development', { version: 'project-development/v1', kind: 'query', projectId: 'p', name: 'github.connection', payload: {} }, { memberId: 'member' })
  assert.equal(status.result.connection.identity.installationId, 12)
})
