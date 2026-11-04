import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRoleGithub } from '../src/host/project-role-github.js'
import { createGithubRoleArtifacts } from '../src/host/project-github-role-artifacts.js'
import { githubCredentialBinding } from '../src/host/project-github-app.js'
async function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'app-artifact-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG)/.test(key))), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Original human']); git(['config', 'user.email', 'human@example.invalid'])
  writeFileSync(join(cwd, 'code'), 'base'); git(['add', '.']); git(['commit', '-m', 'Original human history'])
  const baseSha = git(['rev-parse', 'HEAD'])
  const project = { id: 'p', repository: 'org/repo', defaultBranch: 'main' }
  const connection = appId => ({ credential: 'github-app', appId, installationId: appId * 10, privateKeyFile: '/private/not-read-by-fixture', repositories: ['org/repo'], projectIds: ['p'] })
  const attempt = { id: 'a', projectId: 'p', taskId: 't', branch: 'flybot/delivery-one', baseSha, requirement: { repository: 'org/repo' }, roleSessions: {} }
  const rt = { config: { projectRepositories: { 'org/repo': { roleGithub: { enabled: true, revision: 1, branches: ['main'], roles: { developer: { connectionId: 'dev' }, reviewer: { connectionId: 'review' }, tester: { connectionId: 'tester' } } }, github: connection(99) } }, projectGithubConnections: { dev: connection(7), review: connection(8), tester: connection(9) } }, state: { projectAttempts: { a: attempt }, projectHarnessWorkers: {} }, readProject: () => project, save: async () => {} }
  const identity = async (settings, options) => ({ provider: 'github-app', token: `ghs_test_role_${settings.appId}`, login: `app-${settings.appId}[bot]`, appId: settings.appId, installationId: settings.installationId, expiresAt: Date.now() + 3600000, credentialIdentity: githubCredentialBinding(settings, options.repository) })
  let pr, pulls, reviews = [], check, mutate
  const request = async (url, options) => {
    if (url.includes('/users/')) { const id = Number(/app-(\d+)/.exec(url)[1]); return Response.json({ id: id + 100, type: 'Bot', login: `app-${id}[bot]` }) }
    assert.ok(options.headers.authorization.startsWith('Bearer ghs_test_role_'))
    let data
    if (url.includes('/reviews?')) data = reviews
    else if (url.includes('/pulls?')) data = pulls ?? [pr]
    else if (url.includes('/check-runs/')) data = check
    else data = pr
    mutate?.(); return Response.json(data)
  }
  const roleGithub = createRoleGithub(rt, { identity, request }), artifacts = createGithubRoleArtifacts(rt, { roleGithub, request, identity })
  async function bind(role) {
    const session = { id: 'session-' + role, projectId: 'p', taskId: 't', attemptId: 'a', role, botId: 'worker-' + role, resourceLease: { id: 'lease-' + role, resourceId: 'r', generation: 1 }, generation: 1 }
    attempt.roleSessions[role] = session
    const worker = { id: session.botId, role, projectId: 'p', taskId: 't', attemptId: 'a', sessionKey: session.id, generation: 1, status: 'released' }
    rt.state.projectHarnessWorkers[worker.id] = worker
    return roleGithub.bind(session, worker)
  }
  const dev = await bind('developer')
  writeFileSync(join(cwd, 'code'), 'actual SDK change'); git(['add', '.']); git(['-c', `user.name=${dev.author.name}`, '-c', `user.email=${dev.author.email}`, 'commit', '-m', 'SDK candidate'])
  assert.equal(git(['log', '-1', '--format=%an|%ae|%cn|%ce']), `${dev.author.name}|${dev.author.email}|${dev.author.name}|${dev.author.email}`)
  const sha = git(['rev-parse', 'HEAD']); attempt.candidateSha = sha
  pr = { number: 12, html_url: 'https://github.com/org/repo/pull/12', state: 'open', head: { ref: attempt.branch, sha, repo: { full_name: 'org/repo' } }, base: { ref: 'main', repo: { full_name: 'org/repo' } }, user: { login: dev.identity.login }, body: dev.publicationMarker }
  const adopt = () => artifacts.publication(attempt, { sha, role: 'developer', git: async args => git(args) })
  return { rt, cwd, attempt, dev, pr, git, sha, bind, artifacts, adopt, pulls: value => { pulls = value }, reviews: value => { reviews = value }, check: value => { check = value }, mutate: value => { mutate = value } }
}
test('host observes original SDK SHA/Dev PR and records a separately selected App merge identity', async t => {
  const f = await fixture(t), original = f.git(['rev-parse', 'HEAD'])
  const pr = await f.adopt(); assert.equal(pr.sha, original); assert.equal(pr.identity.appId, 7); assert.equal(pr.mergeIdentity.appId, 99)
  assert.equal(pr.creatorLogin, 'app-7[bot]'); assert.equal(pr.operation, 'sdk-observed-publication')
  assert.equal(f.git(['log', '--format=%an', '--reverse']).split('\n')[0], 'Original human', 'Existing real human authors are not rewritten')
})
test('dirty/uncommitted history and wrong commit author are rejected without resealing', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.cwd, 'code'), 'dirty'); await assert.rejects(f.adopt(), /committed and clean/)
  f.git(['add', '.']); f.git(['commit', '-m', 'Wrong human committer'])
  await assert.rejects(f.artifacts.publication(f.attempt, { sha: f.git(['rev-parse', 'HEAD']), role: 'developer', git: async args => f.git(args) }), /author\/committer/)
})
test('wrong head/base/repository/creator/marker, closed PR and ambiguous candidates cannot be adopted', async t => {
  for (const change of ['head', 'base', 'repo', 'creator', 'marker', 'closed', 'ambiguous']) await t.test(change, async sub => {
    const f = await fixture(sub)
    if (change === 'head') f.pr.head.sha = 'f'.repeat(40)
    if (change === 'base') f.pr.base.ref = 'unauthorized'
    if (change === 'repo') f.pr.head.repo.full_name = 'foreign/repo'
    if (change === 'creator') f.pr.user.login = 'owner-personal'
    if (change === 'marker') f.pr.body = 'Not this delivery'
    if (change === 'closed') f.pr.state = 'closed'
    if (change === 'ambiguous') f.pulls([f.pr, { ...f.pr, number: 13 }])
    await assert.rejects(f.adopt(), /match|ambiguous/)
    assert.equal(f.git(['rev-parse', 'HEAD']), f.sha)
  })
})
test('App Review requires the same candidate, latest actual approval and independent App identity', async t => {
  const f = await fixture(t); f.attempt.pr = await f.adopt(); const reviewer = await f.bind('reviewer')
  const review = { body: reviewer.reviewMarker, id: 1, user: { login: 'app-8[bot]' }, commit_id: f.sha, submitted_at: '2026-11-04T00:00:00Z', state: 'APPROVED' }
  f.reviews([review]); assert.equal((await f.artifacts.review(f.attempt, 'reviewer', 'approve')).independent, true)
  f.reviews([review, { ...review, id: 2, state: 'CHANGES_REQUESTED' }]); await assert.rejects(f.artifacts.review(f.attempt, 'reviewer', 'approve'), /missing/)
  f.reviews([{ ...review, commit_id: 'f'.repeat(40) }]); await assert.rejects(f.artifacts.review(f.attempt, 'reviewer', 'approve'), /missing/)
  f.rt.config.projectGithubConnections.review.appId = 7; const shared = await f.bind('reviewer')
  f.reviews([{ ...review, body: shared.reviewMarker, user: { login: 'app-7[bot]' } }]); await assert.rejects(f.artifacts.review(f.attempt, 'reviewer', 'approve'), /independent/)
})
test('Tester checks are observed facts rather than host-test PASS and connection changes fence read results', async t => {
  const f = await fixture(t), scope = await f.bind('tester')
  f.check({ id: 15, head_sha: f.sha, app: { id: 9 }, external_id: scope.sha256, status: 'completed', conclusion: 'success' })
  assert.equal((await f.artifacts.check(f.attempt, 'tester', 15)).scope, 'remote-check-observation-not-host-test-pass')
  f.check({ id: 15, head_sha: f.sha, app: { id: 7 } }); await assert.rejects(f.artifacts.check(f.attempt, 'tester', 15), /match/)
  f.mutate(() => { f.rt.config.projectRepositories['org/repo'].roleGithub.revision++ })
  await assert.rejects(f.adopt(), /changed/)
})
