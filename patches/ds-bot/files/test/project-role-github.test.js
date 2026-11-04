import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRoleGithub, roleGithubSelection, roleGithubStatus } from '../src/host/project-role-github.js'
import { roleGithubRuntime } from '../src/host/project-role-github-runtime.mjs'
import { credential, validateRoleCommand } from '../src/host/project-role-github-cli.mjs'
import { githubCredentialBinding } from '../src/host/project-github-app.js'
const exec = promisify(execFile)
function fixture() {
  const project = { id: 'p', ownerUserId: 'owner', repository: 'org/repo', defaultBranch: 'main' }
  const session = { id: 's', projectId: 'p', taskId: 't', attemptId: 'a', role: 'developer', botId: 'worker', execution: { harness: 'codex' }, poolClaimId: 'claim', generation: 2, resourceLease: { id: 'lease', resourceId: 'r', generation: 7 } }
  const task = { id: 't', projectId: 'p', deliveryAttemptId: 'a', collaboration: { initiatedBy: 'owner', generation: 2, claim: { id: 'claim', botId: 'p:developer', generation: 2, status: 'active' } } }
  const rt = { state: { tasks: { t: task }, projectAttempts: { a: { id: 'a', projectId: 'p', taskId: 't', branch: 'flybot/delivery-original', baseSha: 'a'.repeat(40), requirement: { repository: 'org/repo' } } } }, config: { projectRepositories: { 'org/repo': { roleGithub: { enabled: true, revision: 1, branches: ['main'], roles: { developer: { connectionId: 'dev' }, reviewer: { connectionId: 'review' } } } } }, projectGithubConnections: { dev: { credential: 'github-app', appId: 7, installationId: 70, privateKeyFile: '/private/dev', repositories: ['org/repo'], projectIds: ['p'] }, review: { credential: 'github-app', appId: 8, installationId: 80, privateKeyFile: '/private/review', repositories: ['org/repo'], projectIds: ['p'] } } }, readProject: () => project, readOnly: () => undefined, requireProjectAccess() { if (revoked) throw Error('revoked') }, projects: { requireActive() {} }, save: async () => {}, projectResources: { requireBinding() { return { harnesses: ['codex'] } } } }
  let revoked = false, serial = 0
  const identity = async (settings, options) => ({ provider: 'github-app', token: 'ghs_fixture_short_lived_' + ++serial, login: `app-${settings.appId}[bot]`, appId: settings.appId, installationId: settings.installationId, expiresAt: Date.now() + 3600000, credentialIdentity: githubCredentialBinding(settings, options.repository) })
  const request = async url => { const id = /app-(\d+)/.exec(url)?.[1]; return Response.json({ id: Number(id) + 100, type: 'Bot', login: `app-${id}[bot]` }) }
  const github = createRoleGithub(rt, { identity, request })
  const worker = { id: 'worker', projectId: 'p', taskId: 't', attemptId: 'a', sessionKey: 's', role: 'developer', resourceId: 'r', leaseId: 'lease', generation: 7, status: 'running' }
  rt.state.projectHarnessWorkers = { worker }
  return { rt, project, session, worker, github, revoke() { revoked = true } }
}
test('role Apps are explicit, repository scoped, distinct by App and never downgrade to gh-cli', () => {
  const f = fixture()
  assert.equal(roleGithubSelection(f.rt, f.project, 'developer').settings.appId, 7)
  assert.equal(roleGithubStatus(f.rt, f.project).identityReuse, false)
  f.rt.config.projectGithubConnections.review.appId = 7
  assert.equal(roleGithubStatus(f.rt, f.project).identityReuse, true)
  assert.equal(roleGithubSelection(f.rt, f.project, 'tester'), null, 'Unassigned optional role gets no credentials')
  f.rt.config.projectGithubConnections.dev.credential = 'gh-cli'
  assert.throws(() => roleGithubSelection(f.rt, f.project, 'developer'), /explicitly provisioned/)
  f.rt.config.projectRepositories['org/repo'].roleGithub.branches = ['other']
  assert.throws(() => roleGithubSelection(f.rt, f.project, 'developer'), /base branch/)
})
test('every credential request rechecks current claim, resource, role connection and verified App author', async () => {
  const f = fixture(), metadata = await f.github.bind(f.session, f.worker)
  assert.equal(metadata.author.email, '107+app-7[bot]@users.noreply.github.com')
  assert.equal(metadata.claimId, 'claim'); assert.equal(metadata.leaseGeneration, 7)
  const first = await f.github.issue(f.session, f.worker, metadata.sha256), next = await f.github.issue(f.session, f.worker, metadata.sha256)
  assert.notEqual(first.token, next.token); assert.equal(first.metadata.sha256, next.metadata.sha256)
  assert.ok(!JSON.stringify(f.rt.state).includes(first.token))
  assert.equal(f.github.redact({ output: next.token }).output, '[REDACTED]')
  f.rt.state.tasks.t.collaboration.generation++
  await assert.rejects(f.github.issue(f.session, f.worker, metadata.sha256), /claim/)
  f.rt.state.tasks.t.collaboration.generation--
  f.rt.config.projectRepositories['org/repo'].roleGithub.revision++
  await assert.rejects(f.github.issue(f.session, f.worker, metadata.sha256), /connection|changed/)
  f.rt.config.projectRepositories['org/repo'].roleGithub.revision--
  f.revoke(); await assert.rejects(f.github.issue(f.session, f.worker, metadata.sha256), /revoked/)
})
test('inactive/unknown execution cannot renew; completed grant metadata cannot be mistaken for token revocation', async () => {
  const f = fixture(), metadata = await f.github.bind(f.session, f.worker)
  f.worker.status = 'unreachable'
  await assert.rejects(f.github.issue(f.session, f.worker, metadata.sha256), /inactive|stale/)
  assert.ok(f.worker.githubAccess.expiresAt > Date.now())
  assert.ok(!JSON.stringify(f.worker).includes('ghs_'))
})
test('resource-local credential FIFO channel isolates runtime files, actual Git author and gh output, then closes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'role-app-runtime-')), repo = join(root, 'repo'), scratch = join(root, 'scratch'), tools = join(root, 'tools')
  await mkdir(repo); await mkdir(scratch); await mkdir(tools)
  const f = fixture(), metadata = await f.github.bind(f.session, f.worker)
  let issues = 0
  await writeFile(join(tools, 'gh'), `#!${process.execPath}\nconsole.log(process.argv[3]==='list'?'[]':JSON.stringify({token:process.env.GH_TOKEN,repo:process.env.GH_REPO,args:process.argv.slice(2)}))\n`, { mode: 0o700 })
  const runtime = await roleGithubRuntime({ metadata, scratchDirectory: scratch, env: { HOME: root, PATH: tools + ':' + dirname(process.execPath) + ':/usr/bin:/bin' }, credential: () => { issues++; return f.github.issue(f.session, f.worker, metadata.sha256) } })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  const run = (args, env = runtime.env) => exec('git', args, { cwd: repo, env, timeout: 10000 })
  await run(['init', '-q']); await writeFile(join(repo, 'code'), 'scoped')
  await run(['add', '.']); await run(['commit', '-m', 'actual App identity fixture'])
  assert.equal((await run(['log', '-1', '--format=%an <%ae> / %cn <%ce>'])).stdout.trim(), `${metadata.author.name} <${metadata.author.email}> / ${metadata.author.name} <${metadata.author.email}>`)
  assert.equal(issues, 0, 'Local Git commands do not mint or contact GitHub')
  const response = await exec('gh', ['pr', 'create', '--title', 'Scoped fixture', '--body', metadata.publicationMarker], { env: runtime.env, cwd: repo })
  const output = JSON.parse(response.stdout)
  assert.equal(output.token, '[REDACTED]'); assert.equal(output.repo, metadata.repository); assert.ok(output.args.includes('--draft')); assert.ok(output.args.includes(metadata.branch))
  assert.ok(!JSON.stringify(runtime.env).includes('ghs_'))
  assert.ok(!await readFile(join(repo, '.git/config'), 'utf8').then(text => text.includes('ghs_')))
  const file = join(runtime.authDirectory, 'scope.json'), original = await readFile(file, 'utf8')
  await writeFile(file, JSON.stringify({ ...JSON.parse(original), policyRole: 'reviewer' }))
  await assert.rejects(exec('gh', ['api', 'repos/org/repo/pulls'], { env: runtime.env, cwd: repo }), /command failed/)
  await writeFile(file, original)
  f.worker.status = 'stopping'; await assert.rejects(credential(runtime.authDirectory), /refused/)
})
test('command scope refuses cross-role pushes, foreign repositories, direct credential dumping and merge bypass', () => {
  const scope = { policyRole: 'developer', branch: 'flybot/one', repository: 'org/repo', baseBranch: 'main', number: null }
  assert.equal(validateRoleCommand(scope, 'git', ['push', 'https://github.com/org/repo.git', 'HEAD:refs/heads/flybot/one']), 'git')
  for (const args of [['push', 'origin', 'HEAD:main'], ['push', 'https://github.com/org/repo.git', '--force'], ['credential', 'fill']]) assert.throws(() => validateRoleCommand(scope, 'git', args), /refused/)
  for (const args of [['pr', 'merge'], ['pr', 'create', '--base', 'main-other'], ['pr', 'create', '--repo', 'foreign/repo'], ['api', '-X', 'PUT', 'repos/org/repo/pulls/1/merge']]) assert.throws(() => validateRoleCommand(scope, 'gh', args), /refused/)
  assert.throws(() => validateRoleCommand({ ...scope, policyRole: 'reviewer' }, 'git', ['push', 'https://github.com/org/repo.git', 'HEAD:refs/heads/flybot/one']), /refused/)
})

test('credential transport queues concurrent readers, handles multi-buffer frames and leaves no regular token file', async t => {
  const f = fixture(), metadata = await f.github.bind(f.session, f.worker)
  const root = await mkdtemp(join(tmpdir(), 'role-app-concurrent-')), scratch = join(root, 'scratch')
  await mkdir(scratch)
  const token = 'ghs_' + 'x'.repeat(8100)
  let count = 0
  const runtime = await roleGithubRuntime({ metadata, scratchDirectory: scratch, env: { PATH: process.env.PATH }, credential: async () => { count++; return { token, metadata, expiresAt: Date.now() + 60000 } } })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  const values = await Promise.all(Array.from({ length: 9 }, () => credential(runtime.authDirectory)))
  assert.equal(count, 9); assert.ok(values.every(value => value.token === token))
  assert.ok(!(await readFile(join(runtime.authDirectory, 'scope.json'), 'utf8')).includes(token))
  assert.equal(runtime.redact(undefined), undefined)
  assert.equal(runtime.redact({ text: token }).text, '[REDACTED]')
  await runtime.close()
  await assert.rejects(credential(runtime.authDirectory), /mkfifo|No such file/)
})
test('role grants reject changed physical resource, role, execution identity, lease and missing resource binding', async () => {
  const f = fixture(), metadata = await f.github.bind(f.session, f.worker)
  for (const [key, value] of [['id', 'another-worker'], ['role', 'reviewer'], ['resourceId', 'another-resource'], ['leaseId', 'another-lease'], ['generation', 8], ['sessionKey', 'another-session']]) {
    const original = f.worker[key]; f.worker[key] = value
    await assert.rejects(f.github.issue(f.session, f.worker, metadata.sha256), /inactive|stale/)
    f.worker[key] = original
  }
  f.rt.state.projectHarnessWorkers.worker = { ...f.worker }
  await assert.rejects(f.github.issue(f.session, f.worker, metadata.sha256), /inactive|stale/)
  delete f.session.resourceLease
  await assert.rejects(f.github.bind(f.session, f.worker), /explicit execution resource/)
})
test('REST writes pin exact original candidate, marker and role; input-file overrides cannot bypass inspected fields', () => {
  const scope = { policyRole: 'reviewer', repository: 'org/repo', number: 12, candidateSha: 'a'.repeat(40), reviewMarker: '<!-- original session -->' }
  const args = ['api', 'repos/org/repo/pulls/12/reviews', '-X', 'POST', '-f', 'commit_id=' + scope.candidateSha, '-f', 'event=APPROVE', '-f', 'body=' + scope.reviewMarker]
  assert.equal(validateRoleCommand(scope, 'gh', args), 'gh')
  for (const extra of [['--input=/private/payload'], ['-f', 'commit_id=' + 'b'.repeat(40)], ['-f', 'body=@/private/payload']]) assert.throws(() => validateRoleCommand(scope, 'gh', [...args, ...extra]), /refused/)
  assert.throws(() => validateRoleCommand({ ...scope, candidateSha: 'b'.repeat(40) }, 'gh', args), /refused/)
  assert.throws(() => validateRoleCommand({ ...scope, policyRole: 'developer' }, 'gh', args), /refused/)
})

test('Reviewer wrapper pins the actual candidate and reconciles a submitted Session Review before repeating a write', async t => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'app-review-retry-')), scratch = join(root, 'scratch'), tools = join(root, 'tools'), observed = join(root, 'reviews.json')
  await mkdir(scratch); await mkdir(tools)
  f.session.role = 'reviewer'; f.worker.role = 'reviewer'
  f.rt.state.projectAttempts.a.pr = { number: 12 }; f.rt.state.projectAttempts.a.candidateSha = 'b'.repeat(40)
  const metadata = await f.github.bind(f.session, f.worker)
  await writeFile(observed, '[]')
  const pr = { number: 12, state: 'open', head: { sha: metadata.candidateSha, repo: { full_name: metadata.repository } }, base: { ref: metadata.baseBranch } }
  const row = { number: 12, state: 'OPEN', headRefName: metadata.branch, baseRefName: metadata.baseBranch, headRefOid: metadata.candidateSha }
  await writeFile(join(tools, 'gh'), `#!${process.execPath}
import{readFileSync,writeFileSync}from'node:fs';
const args=process.argv.slice(2),path=${JSON.stringify(observed)},scope=${JSON.stringify(metadata)},rows=JSON.parse(readFileSync(path,'utf8'));
if(args[0]==='pr'&&args[1]==='list')console.log(JSON.stringify([${JSON.stringify(row)}]));
else if(args[1]==='repos/org/repo/pulls/12')console.log(JSON.stringify(${JSON.stringify(pr)}));
else if(args[1].includes('/reviews?'))console.log(JSON.stringify(rows));
else if(args.includes('POST')){const review={id:23,user:{login:scope.identity.login},state:'APPROVED',commit_id:scope.candidateSha,body:scope.reviewMarker,submitted_at:'2026-11-04T12:00:00Z'};rows.push(review);writeFileSync(path,JSON.stringify(rows));console.log(JSON.stringify(review));}
else process.exit(9);
`, { mode: 0o700 })
  const runtime = await roleGithubRuntime({ metadata, scratchDirectory: scratch, env: { PATH: tools + ':' + process.env.PATH }, credential: () => f.github.issue(f.session, f.worker, metadata.sha256) })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  const command = () => exec('gh', ['pr', 'review', '12', '--approve', '--body', 'Reviewed exact candidate'], { cwd: root, env: runtime.env })
  assert.equal(JSON.parse((await command()).stdout).id, 23)
  assert.equal(JSON.parse((await command()).stdout).id, 23)
  assert.equal(JSON.parse(await readFile(observed, 'utf8')).length, 1)
})

test('a stop or connection revocation during grant audit commit prevents late credential delivery', async () => {
  for (const kind of ['stop', 'rebind']) {
    const f = fixture(), metadata = await f.github.bind(f.session, f.worker)
    f.rt.save = async () => { if (kind === 'stop') f.worker.status = 'stopping'; else f.rt.config.projectRepositories['org/repo'].roleGithub.revision++ }
    await assert.rejects(f.github.issue(f.session, f.worker, metadata.sha256), /revoked/)
  }
})
