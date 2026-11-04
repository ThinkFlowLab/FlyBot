import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconcileGithubMerge } from '../src/host/project-github-merge.js'
import { projectMergePolicy } from '../src/host/project-merge-policy.js'
const candidate = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40)
const intent = { id: 'intent', repository: 'example/demo', number: 7, candidateSha: candidate, branch: 'flybot/task', creatorLogin: 'automation', publicationMarker: '<!-- flybot-publication:original -->' }
const policy = projectMergePolicy({ mergePolicy: { enabled: true, branches: ['delivery'], method: 'squash', requiredChecks: ['tests-ok'] } }, 'delivery')
function fixture(changes = {}) {
  const contexts = [{ databaseId: 1, name: 'tests-ok', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { app: { databaseId: 12 } } }]
  const row = { id: 'pr-node', number: 7, headRefOid: candidate, headRefName: intent.branch, headRepository: { nameWithOwner: intent.repository }, baseRefName: 'delivery', baseRefOid: base, state: 'OPEN', isDraft: false, merged: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, author: { login: 'automation' }, body: intent.publicationMarker, labels: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [{ commit: { oid: candidate, statusCheckRollup: { contexts: { nodes: contexts, pageInfo: { hasNextPage: false } } } } }] }, ...changes }
  const writes = [], fences = []
  let lost = false
  return { row, contexts, writes, fences, loseNextWrite() { lost = true }, ports: { async beforeWrite(value) { fences.push(value) }, async graphql(query, variables, write) {
    if (!write) return { repository: { nameWithOwner: intent.repository, pullRequest: structuredClone(row) } }
    writes.push({ query, input: variables.input })
    if (query.includes('markPullRequestReadyForReview')) row.isDraft = false
    else if (query.includes('enqueuePullRequest')) row.isInMergeQueue = true
    else { row.merged = true; row.state = 'MERGED'; row.mergeCommit = { oid: merged } }
    if (lost) { lost = false; throw Error('lost response') }
    return {}
  } } }
}
test('approved Draft moves through ready, expected-head merge and observed actual commit without assuming mutation success', async () => {
  const f = fixture({ isDraft: true })
  assert.equal((await reconcileGithubMerge(intent, policy, f.ports)).reason, 'draft-marked-ready')
  assert.equal((await reconcileGithubMerge(intent, policy, f.ports)).reason, 'merge-requested-awaiting-observation')
  const result = await reconcileGithubMerge(intent, policy, f.ports)
  assert.equal(result.status, 'merged'); assert.equal(result.mergeCommitSha, merged)
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1].input.expectedHeadOid, candidate)
  assert.equal(f.writes[1].input.mergeMethod, 'SQUASH'); assert.equal(f.writes[1].input.admin, undefined)
  await reconcileGithubMerge(intent, policy, f.ports); assert.equal(f.writes.length, 2)
})
test('scope changes, hold, missing human review, conflict and incomplete label reads produce no write', async () => {
  for (const change of [{ headRefOid: base }, { headRefName: 'foreign' }, { headRepository: { nameWithOwner: 'foreign/repo' } }, { baseRefName: 'main' }, { author: { login: 'foreign' } }, { body: 'another Task' }, { labels: { nodes: [{ name: 'hold' }] } }, { labels: { nodes: [], pageInfo: { hasNextPage: true } } }, { reviewDecision: 'REVIEW_REQUIRED' }, { reviewDecision: 'CHANGES_REQUESTED' }, { mergeable: 'CONFLICTING' }, { state: 'CLOSED' }]) {
    const f = fixture(change), result = await reconcileGithubMerge(intent, policy, f.ports)
    assert.equal(result.status, 'blocked', JSON.stringify(change)); assert.equal(f.writes.length, 0)
  }
})
test('latest configured checks and App identity decide readiness; old green cannot mask a new failure', async () => {
  const f = fixture()
  f.contexts.push({ ...f.contexts[0], databaseId: 2, conclusion: 'FAILURE' })
  assert.match((await reconcileGithubMerge(intent, policy, f.ports)).reason, /check-failed/)
  f.contexts[1].conclusion = null; f.contexts[1].status = 'IN_PROGRESS'
  assert.match((await reconcileGithubMerge(intent, policy, f.ports)).reason, /check-pending/)
  f.contexts[1].conclusion = 'SUCCESS'; f.contexts[1].status = 'COMPLETED'
  const pinned = { ...policy, requiredChecks: [{ name: 'tests-ok', appId: 99 }] }
  assert.match((await reconcileGithubMerge(intent, pinned, f.ports)).reason, /check-missing/)
  assert.equal(f.writes.length, 0)
  await reconcileGithubMerge(intent, policy, f.ports); assert.equal(f.writes.length, 1)
})
test('required queue uses expected-head enqueue without jump, observes its entry, and never directly merges', async () => {
  const f = fixture({ isMergeQueueEnabled: true, mergeStateStatus: 'BLOCKED' })
  assert.equal((await reconcileGithubMerge(intent, policy, f.ports)).status, 'queued')
  assert.equal(f.writes[0].input.expectedHeadOid, candidate); assert.equal(f.writes[0].input.jump, false)
  assert.match(f.writes[0].query, /enqueuePullRequest/)
  await reconcileGithubMerge(intent, policy, f.ports); assert.equal(f.writes.length, 1)
})
test('lost merge response is reconciled from the same PR rather than issuing another write', async () => {
  const f = fixture(); f.loseNextWrite()
  await assert.rejects(reconcileGithubMerge(intent, policy, f.ports), /lost response/)
  const result = await reconcileGithubMerge(intent, policy, f.ports)
  assert.equal(result.status, 'merged'); assert.equal(f.writes.length, 1)
})
test('light private policy is explicit and does not import another repository CI requirements', async () => {
  assert.equal(projectMergePolicy({}, 'delivery'), null)
  for (const value of [{ enabled: true, branches: ['main'], method: 'squash' }, { enabled: true, branches: ['delivery'], method: 'admin' }, { enabled: true, branches: ['delivery'], method: 'squash', pollIntervalMs: 1 }]) assert.throws(() => projectMergePolicy({ mergePolicy: value }, 'delivery'))
  const minimal = projectMergePolicy({ mergePolicy: { enabled: true, branches: ['delivery'], method: 'squash', requiredChecks: [] } }, 'delivery')
  const f = fixture(); f.contexts.length = 0
  await reconcileGithubMerge(intent, minimal, f.ports); assert.equal(f.writes.length, 1)
})

test('gh-cli and App merge operations reuse verified selected identity without ambient-token fallback', async t => {
  const { githubPublisher } = await import('../src/host/project-github.js')
  const { githubCredentialBinding } = await import('../src/host/project-github-app.js')
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path'), { generateKeyPairSync } = await import('node:crypto')
  const root = await mkdtemp(join(tmpdir(), 'flybot-merge-identities-')); t.after(() => rm(root, { recursive: true, force: true }))
  for (const provider of ['gh-cli', 'github-app']) {
    const settings = provider === 'gh-cli' ? { credential: 'gh-cli', configDir: root, login: 'automation' } : { credential: 'github-app', appId: 7, installationId: 12, privateKeyFile: join(root, 'app.pem') }
    if (provider === 'github-app') await writeFile(settings.privateKeyFile, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const login = provider === 'gh-cli' ? 'automation' : 'automation[bot]', f = fixture({ author: { login } })
    let verified = 0
    const request = async (url, options = {}) => {
      if (url.endsWith('/user')) { ++verified; return Response.json({ login }) }
      if (url.endsWith('/installation')) { ++verified; return Response.json({ id: 12, app_id: 7, app_slug: 'automation', account: { login: 'example' }, permissions: { contents: 'write', pull_requests: 'write', checks: 'read' } }) }
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_fixture_credential', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: JSON.parse(options.body).permissions, repositories: [{ full_name: intent.repository }] })
      assert.equal(url, 'https://api.github.com/graphql')
      const { query, variables } = JSON.parse(options.body)
      return Response.json({ data: await f.ports.graphql(query, variables, query.startsWith('mutation')) })
    }
    const publisher = githubPublisher(settings, { request, run: async (command, _args, options) => { assert.equal(command, 'gh'); assert.equal(options.env.GH_CONFIG_DIR, root); assert.equal(options.env.GH_TOKEN, undefined); assert.equal(options.env.GITHUB_TOKEN, undefined); return { stdout: 'fixture-token' } } })
    const bound = { ...intent, creatorLogin: login, identity: { provider, login, appId: provider === 'github-app' ? 7 : null, installationId: provider === 'github-app' ? 12 : null, credentialIdentity: githubCredentialBinding(settings, intent.repository) } }
    await publisher.merge(bound, policy, async () => {})
    const observed = await publisher.merge(bound, policy, async () => {})
    assert.equal(observed.status, 'merged'); assert.equal(f.writes.length, 1); assert.ok(verified >= 2)
    const changed = { ...bound, identity: { ...bound.identity, login: 'another-user' } }
    await assert.rejects(publisher.merge(changed, policy, async () => {}), /identity changed/)
    assert.equal(f.writes.length, 1)
  }
})
