// Explicit opt-in: writes only unique disposable branches in the authenticated user's own repository.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { githubPublisher, resolveGithubIdentity } from '../../core/src/host/project-github.js'
import { projectMergePolicy } from '../../core/src/host/project-merge-policy.js'
const exec = promisify(execFile)
const { values } = parseArgs({ options: { repository: { type: 'string' }, 'gh-config-dir': { type: 'string' }, 'expected-login': { type: 'string' } }, strict: true })
const repository = values.repository, login = values['expected-login']
assert.ok(login && repository?.toLowerCase().startsWith(login.toLowerCase() + '/'), 'Only the selected user’s own repository is permitted')
const settings = { credential: 'gh-cli', configDir: values['gh-config-dir'], login }
const identity = await resolveGithubIdentity(settings, { repository })
assert.equal(identity.login.toLowerCase(), login.toLowerCase())
const root = new URL('../../', import.meta.url).pathname
const git = async (args, cwd = root) => (await exec('git', args, { cwd, timeout: 120000, maxBuffer: 65536 })).stdout.trim()
const sourceSha = await git(['rev-parse', 'HEAD']), nonce = randomUUID(), prefix = `verify/2331-${nonce}`
const base = prefix + '-base', branch = prefix + '-head', directory = await mkdtemp(join(tmpdir(), 'flybot-merge-'))
const path = join(directory, 'tree'), check = 'flybot-host-merge-probe', filename = '.flybot-2331-merge-probe.txt'
let pr, candidateSha, observed, baseCreated = false, worktreeCreated = false
async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${identity.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw Error(`Disposable probe API refused (${response.status})`)
  return response.status === 204 ? null : response.json()
}
try {
  await api('/git/refs', 'POST', { ref: 'refs/heads/' + base, sha: sourceSha }); baseCreated = true
  await git(['worktree', 'add', '--detach', path, sourceSha]); worktreeCreated = true
  await writeFile(join(path, filename), nonce + '\n')
  await git(['add', filename], path)
  await git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=FlyBot merge verification', '-c', 'user.email=flybot-probe@users.noreply.github.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test: disposable host merge verification'], path)
  candidateSha = await git(['rev-parse', 'HEAD'], path)
  assert.equal(await git(['show', `${candidateSha}:${filename}`], path), nonce)
  const publisher = githubPublisher(settings, { authorize: async () => { assert.ok(branch.startsWith(prefix)); assert.ok(base.startsWith(prefix)) } })
  pr = await publisher.publish({ id: nonce, taskId: 'isolated-host-probe', initiatedBy: login, branch, candidateSha, publicationRepository: path, requirement: { title: 'Disposable #2331 host merge verification', criteria: 'Actual local Git assertion; host status is not an independent Reviewer or GitHub Actions check.' } }, { repository, defaultBranch: base })
  const intent = { id: nonce, ...pr, branch, candidateSha }, policy = projectMergePolicy({ mergePolicy: { enabled: true, branches: [base], method: 'squash', requiredChecks: [check], pollIntervalMs: 5000, maxWaitMs: 240000 } }, base), writes = []
  const reconcile = () => publisher.merge(intent, policy, async row => { assert.equal(row.baseBranch, base); assert.equal(row.candidateSha, candidateSha); writes.push(row.operation) })
  const ready = await reconcile(); assert.equal(ready.reason, 'draft-marked-ready')
  await api(`/statuses/${candidateSha}`, 'POST', { state: 'pending', context: check, description: 'Host fixture assertion pending; not GitHub Actions or independent review' })
  const pending = await reconcile(); assert.equal(pending.status, 'waiting'); assert.ok(!writes.includes('merge'))
  await api(`/statuses/${candidateSha}`, 'POST', { state: 'success', context: check, description: 'Actual host assertion verified disposable candidate content' })
  const deadline = Date.now() + 240000
  do { observed = await reconcile(); if (observed.status === 'merged') break; if (observed.status === 'blocked') throw Error('Probe merge blocked: ' + observed.reason); await new Promise(resolve => setTimeout(resolve, 2000)) } while (Date.now() < deadline)
  assert.equal(observed.status, 'merged')
  const read = await publisher.read(pr, { repository }); assert.equal(read.merged, true); assert.equal(read.mergeCommitSha, observed.mergeCommitSha)
  const content = await api(`/contents/${filename}?ref=${encodeURIComponent(base)}`)
  assert.equal(Buffer.from(content.content, 'base64').toString(), nonce + '\n')
  console.log(JSON.stringify({ sourceSha, candidateSha, repository, pr: pr.url, mergeCommitSha: observed.mergeCommitSha, writes, provider: 'actual selected gh-cli / GitHub', checks: ['Draft marked Ready', 'pending host check prevents merge', 'current candidate merged', 'actual merge commit observed', 'remote target content verified'], notRun: ['paid model Reviewer', 'live GitHub App installation', 'merge queue installation', 'production project', 'deployment'] }, null, 2))
} finally {
  // Never delete a branch changed by another actor. Preserve unexpected state for inspection.
  if (pr && observed?.status !== 'merged') await api(`/pulls/${pr.number}`, 'PATCH', { state: 'closed' }).catch(() => {})
  for (const [name, allowed] of [[branch, [candidateSha]], [base, [sourceSha, observed?.mergeCommitSha]]]) {
    if (name === base && !baseCreated) continue
    try { const ref = await api('/git/ref/heads/' + encodeURIComponent(name)); if (allowed.filter(Boolean).includes(ref.object?.sha)) await api('/git/refs/heads/' + encodeURIComponent(name), 'DELETE') } catch { /* preserve unknown remote outcome */ }
  }
  if (worktreeCreated) await git(['worktree', 'remove', '--force', path]).catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
