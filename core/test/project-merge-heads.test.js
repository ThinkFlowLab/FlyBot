import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseMergeHeads, readMergeHeads } from '../src/host/project-merge-heads.js'

const a = 'a'.repeat(40), b = 'b'.repeat(40)
const git = (path, args) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'flybot-merge-metadata-')), repository = join(directory, 'repository'), path = join(directory, 'workspace')
  git(directory, ['init', '-b', 'main', repository])
  git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Base'])
  git(repository, ['worktree', 'add', '--detach', path, 'HEAD'])
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = { path, repository, kind: 'local-worktree' }
  const ports = { workspaceGit: (row, args) => git(row.path, args), hostGit: git }
  return { directory, repository, workspace, ports, metadata: join(git(path, ['rev-parse', '--absolute-git-dir']), 'MERGE_HEAD') }
}

test('merge metadata parses every bounded distinct parent and rejects ambiguous or oversized data', () => {
  assert.deepEqual(parseMergeHeads(''), [])
  assert.deepEqual(parseMergeHeads(a + '\r\n' + b + '\r\n'), [a, b])
  for (const text of [a + '\n\n', a + '\n' + a, ' '+a, a.slice(1), a.toUpperCase(), 'x'.repeat(4097), Array.from({ length: 21 }, (_, i) => i.toString(16).padStart(40, '0')).join('\n')]) assert.throws(() => parseMergeHeads(text))
})

test('registered local worktree reads every parent; symlinked and foreign Git metadata are refused', async t => {
  const f = await fixture(t)
  assert.deepEqual(await readMergeHeads({}, f.workspace, f.ports), [])
  await writeFile(f.metadata, a + '\n' + b + '\n')
  assert.deepEqual(await readMergeHeads({}, f.workspace, f.ports), [a, b])
  await rm(f.metadata)
  const foreign = join(f.directory, 'foreign-data')
  await writeFile(foreign, a + '\n')
  await symlink(foreign, f.metadata)
  await assert.rejects(readMergeHeads({}, f.workspace, f.ports), /metadata/)
  await rm(f.metadata)
  await assert.rejects(readMergeHeads({}, { ...f.workspace, repository: f.directory }, f.ports))
  const foreignGit = git(f.repository, ['rev-parse', '--absolute-git-dir'])
  await assert.rejects(readMergeHeads({}, f.workspace, { ...f.ports, workspaceGit: (row, args) => args.includes('--absolute-git-dir') ? foreignGit : f.ports.workspaceGit(row, args) }), /metadata/)
})

test('resource-clone merge inspection verifies the live binding and bounded file without following links', async t => {
  const f = await fixture(t), clone = join(f.directory, 'clone')
  git(f.directory, ['clone', f.repository, clone])
  let checks = 0, commands = 0
  const rt = { projectResources: {
    requireBinding(projectId, lease) { ++checks; assert.equal(projectId, 'p'); assert.equal(lease.id, 'lease') },
    async command(projectId, resourceId, request) { ++commands; assert.equal(projectId, 'p'); assert.equal(resourceId, 'r'); return { stdout: execFileSync(request.argv[0], request.argv.slice(1), { cwd: request.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } },
  } }
  const workspace = { kind: 'resource-clone', projectId: 'p', resourceId: 'r', resourceLease: { id: 'lease' }, path: clone }
  assert.deepEqual(await readMergeHeads(rt, workspace, {}), [])
  const file = join(clone, '.git', 'MERGE_HEAD')
  await writeFile(file, a + '\n' + b + '\n')
  assert.deepEqual(await readMergeHeads(rt, workspace, {}), [a, b])
  await rm(file)
  await symlink(f.metadata, file)
  await assert.rejects(readMergeHeads(rt, workspace, {}))
  assert.equal(checks, 3); assert.equal(commands, 3)
  rt.projectResources.requireBinding = () => { throw new Error('fixture revoked lease') }
  await assert.rejects(readMergeHeads(rt, workspace, {}), /revoked lease/)
  assert.equal(commands, 3)
})
