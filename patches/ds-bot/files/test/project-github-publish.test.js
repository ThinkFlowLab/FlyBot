import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { githubPublisher } from '../src/host/project-github.js'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function fixture(t, provider = 'gh-cli') {
  const path = mkdtempSync(join(tmpdir(), 'flybot-publish-'))
  git(path, 'init', '-b', 'main'); git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@localhost')
  writeFileSync(join(path, 'code.txt'), 'first'); git(path, 'add', '.'); git(path, 'commit', '-m', 'Published candidate')
  const previous = git(path, 'rev-parse', 'HEAD'), remote = join(path, 'remote.git')
  git(path, 'init', '--bare', remote); git(path, 'push', remote, `${previous}:refs/heads/existing`)
  writeFileSync(join(path, 'code.txt'), 'second'); git(path, 'commit', '-am', 'Rework candidate')
  const candidate = git(path, 'rev-parse', 'HEAD')
  const attempt = { candidateSha: candidate, branch: 'new-attempt', taskId: 'same-task', requirement: { title: 'Repair', criteria: 'Keep one PR' }, workspaces: { developer: { path } }, publicationBinding: { number: 48, repository: 'example/demo', branch: 'existing', previousSha: previous, upstreamSha: previous, upstreamRef: 'main' } }
  const calls = []; let pushes = 0, creates = 0
  let override = {}, postPushOverride = {}, beforePush = () => {}, upstream = previous, unbound = [], loseReply = false
  const request = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' })
    if (url.endsWith('/installation')) return Response.json({ id: 12, app_id: 7, app_slug: 'automation', account: { login: 'example' }, suspended_at: null, permissions: { contents: 'write', pull_requests: 'write' } })
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_7_fixture.token', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: JSON.parse(options.body).permissions, repositories: [{ full_name: 'example/demo' }] })
    if (url.endsWith('/user')) return Response.json({ login: 'automation' })
    if (options.method === 'POST') {
      creates++
      const pr = { user: { login: 'automation[bot]' }, number: 99, state: 'open', head: { sha: candidate }, html_url: 'https://example.invalid/pr/99', body: JSON.parse(options.body).body }
      unbound = [pr]
      if (loseReply) { loseReply = false; throw Error('Lost response after PR creation') }
      return Response.json(pr)
    }
    if (url.includes('/git/ref/heads/')) return Response.json({ object: { type: 'commit', sha: upstream } })
    if (url.includes('/pulls?')) return Response.json(unbound)
    return Response.json({ user: { login: 'automation[bot]' }, number: 48, state: 'open', draft: true, base: { ref: 'main', sha: 'f'.repeat(40), repo: { full_name: 'example/demo' } }, head: { ref: 'existing', repo: { full_name: 'example/demo' }, sha: git(path, '--git-dir', remote, 'rev-parse', 'existing') }, html_url: 'https://example.invalid/pr/48', ...(pushes ? postPushOverride : override) })
  }
  const run = async (command, args, options) => {
    if (command === 'gh') return { stdout: 'fixture-token' }
    if (args.includes('push')) { beforePush(); pushes++; const rewritten = args.map(arg => arg.startsWith('https://github.com/') ? remote : arg); return { stdout: git(options.cwd, ...rewritten) } }
    return { stdout: git(options.cwd, ...args) }
  }
  const keyFile = join(path, 'app.pem')
  if (provider === 'github-app') writeFileSync(keyFile, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const settings = provider === 'github-app' ? { credential: 'github-app', appId: 7, installationId: 12, privateKeyFile: keyFile } : { credential: 'gh-cli', configDir: '/fixture/explicit-gh', login: 'automation' }
  const publisher = githubPublisher(settings, { request, run })
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return { publisher, attempt, previous, candidate, remote, path, calls, counters: () => ({ pushes, creates }), override(value) { override = value }, postPushOverride(value) { postPushOverride = value }, beforePush(value) { beforePush = value }, upstream(value) { upstream = value }, loseReply() { loseReply = true }, unbound(value) { unbound = value } }
}

test('published rework advances the same PR branch and retains the old candidate without creating a PR', async t => {
  const f = fixture(t)
  f.attempt.publicationRepository = f.path
  const result = await f.publisher.publish(f.attempt, { repository: 'example/demo', defaultBranch: 'main' })
  assert.equal(result.number, 48); assert.equal(result.sha, f.candidate)
  assert.equal(git(f.path, '--git-dir', f.remote, 'rev-parse', 'existing'), f.candidate)
  assert.equal(git(f.path, '--git-dir', f.remote, 'merge-base', '--is-ancestor', f.previous, 'existing'), '')
  assert.deepEqual(f.counters(), { pushes: 1, creates: 0 })
  assert(!f.calls.some(call => call.url.includes('/pulls?')))
  assert.equal((await f.publisher.publish(f.attempt, { repository: 'example/demo' })).number, 48, 'response-loss retry reuses the same PR')
  assert.equal(f.counters().creates, 0)
})

test('existing PR binding refuses stale, closed, wrong-repository and wrong-branch records before a push', async t => {
  for (const change of [{ state: 'closed' }, { number: 49 }, { head: { ref: 'other', repo: { full_name: 'example/demo' }, sha: 'f'.repeat(40) } }, { head: { ref: 'existing', repo: { full_name: 'other/repo' }, sha: 'f'.repeat(40) } }, { head: { ref: 'existing', repo: { full_name: 'example/demo' }, sha: 'f'.repeat(40) } }]) {
    const f = fixture(t); f.override(change)
    await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /changed/)
    assert.deepEqual(f.counters(), { pushes: 0, creates: 0 })
  }
})

test('malformed bindings and candidates that discard published history never publish', async t => {
  for (const change of [{ repository: 'other/repo' }, { number: 0 }, { number: 1.5 }, { branch: null }, { previousSha: 'invalid' }]) {
    const f = fixture(t); Object.assign(f.attempt.publicationBinding, change)
    await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /binding is invalid/)
    assert.deepEqual(f.counters(), { pushes: 0, creates: 0 })
  }
  const f = fixture(t); f.attempt.candidateSha = git(f.path, 'hash-object', '-w', '--stdin')
  await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /does not retain/)
  assert.deepEqual(f.counters(), { pushes: 0, creates: 0 })
})

test('publication checks the actual post-push PR head and never falls back to a new PR', async t => {
  for (const change of [{ number: 49 }, { state: 'closed' }, { head: { ref: 'other', repo: { full_name: 'example/demo' }, sha: 'f'.repeat(40) } }, { head: { ref: 'existing', repo: { full_name: 'other/repo' }, sha: 'f'.repeat(40) } }, { head: { ref: 'existing', repo: { full_name: 'example/demo' }, sha: 'f'.repeat(40) } }]) {
    const f = fixture(t); f.postPushOverride(change)
    await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /changed during publication|does not match/)
    assert.deepEqual(f.counters(), { pushes: 1, creates: 0 })
  }
})

test('a first publication still uses its new Attempt branch', async t => {
  const f = fixture(t); delete f.attempt.publicationBinding
  const pr = await f.publisher.publish(f.attempt, { repository: 'example/demo', defaultBranch: 'main' })
  assert.equal(pr.number, 99); assert.deepEqual(f.counters(), { pushes: 1, creates: 1 })
  assert.equal(git(f.path, '--git-dir', f.remote, 'rev-parse', 'new-attempt'), f.candidate)
})

test('first-PR response loss reuses its marker/branch receipt; closed or changed PRs never create a replacement', async t => {
  const f = fixture(t); delete f.attempt.publicationBinding
  f.attempt.publicationEffectId = 'effect-stable'
  f.loseReply()
  await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo', defaultBranch: 'main' }), /outcome is unavailable/)
  assert.equal(f.counters().creates, 1)
  const recovered = await f.publisher.publish(f.attempt, { repository: 'example/demo', defaultBranch: 'main' })
  assert.equal(recovered.number, 99)
  assert.equal(f.counters().creates, 1)
  assert.ok(f.calls.some(row => row.url.includes('state=all')))
  for (const prior of [[{ state: 'closed', head: { sha: f.candidate } }], [{ state: 'open', head: { sha: 'f'.repeat(40) } }], [{ state: 'open' }, { state: 'closed' }]]) {
    f.unbound(prior)
    const before = f.counters()
    await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /reconcile/)
    assert.deepEqual(f.counters(), before)
  }
})


test('a concurrent remote commit is preserved when the ordinary fast-forward push refuses rework', async t => {
  const f = fixture(t)
  const sibling = git(f.path, 'commit-tree', f.candidate + '^{tree}', '-p', f.previous, '-m', 'Concurrent contributor commit')
  f.beforePush(() => git(f.path, 'push', f.remote, `${sibling}:refs/heads/existing`))
  await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /could not be pushed/)
  assert.equal(git(f.path, '--git-dir', f.remote, 'rev-parse', 'existing'), sibling)
  assert.equal(f.counters().creates, 0)
})


test('PR reads use the same explicitly selected identity and actual recorded head', async t => {
  const f = fixture(t)
  const read = await f.publisher.read({ repository: 'example/demo', number: 48 })
  assert.equal(read.sha, f.previous); assert.equal(read.state, 'open')
  assert.deepEqual(f.counters(), { pushes: 0, creates: 0 })
})


test('trusted upstream uses the live target ref and rejects advanced, malformed or missing targets before push', async t => {
  const f = fixture(t)
  const read = await f.publisher.read({ repository: 'example/demo', number: 48 }, { includeBase: true })
  assert.equal(read.baseSha, f.previous, 'cached PR base.sha must not replace the live ref')
  assert.equal(read.baseRef, 'main')
  for (const target of [f.candidate, 'invalid']) {
    f.upstream(target)
    await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /upstream changed|upstream is unavailable/)
    assert.equal(f.counters().pushes, 0)
  }
  f.upstream(f.previous); f.override({ base: undefined })
  await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /upstream is unavailable/)
  assert.equal(f.counters().creates, 0)
})

test('same-PR continuation requires trusted upstream ancestry and rechecks target movement after push', async t => {
  const f = fixture(t)
  const sibling = git(f.path, 'commit-tree', f.candidate + '^{tree}', '-p', f.previous, '-m', 'Advanced upstream')
  f.upstream(sibling); f.attempt.publicationBinding.upstreamSha = sibling
  await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /trusted upstream/)
  assert.deepEqual(f.counters(), { pushes: 0, creates: 0 })
  f.upstream(f.previous); f.attempt.publicationBinding.upstreamSha = f.previous
  f.beforePush(() => f.upstream(f.candidate))
  await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /upstream changed during publication/)
  assert.deepEqual(f.counters(), { pushes: 1, creates: 0 })
})

for (const provider of ['gh-cli', 'github-app']) test(provider + ' shares push, existing PR, read and lost-create-response reconciliation', async t => {
  const f = fixture(t, provider)
  const pr = await f.publisher.publish(f.attempt, { repository: 'example/demo' })
  assert.equal(pr.identity.provider, provider); assert.equal(pr.sha, f.candidate)
  assert.equal((await f.publisher.read(pr)).sha, f.candidate)
  delete f.attempt.publicationBinding; f.loseReply()
  await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /outcome is unavailable/)
  assert.equal((await f.publisher.publish(f.attempt, { repository: 'example/demo' })).number, 99)
  assert.equal(f.counters().creates, 1)
})

test('App publication rejects a different PR creator before any push', async t => {
  const f = fixture(t, 'github-app'); f.override({ user: { login: 'another-app[bot]' } })
  await assert.rejects(f.publisher.publish(f.attempt, { repository: 'example/demo' }), /creator does not match/)
  assert.deepEqual(f.counters(), { pushes: 0, creates: 0 })
})
