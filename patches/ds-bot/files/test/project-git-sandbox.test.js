import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitWritableRoots } from '../src/host/project-git-sandbox.js'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
test('a registered developer receives only its Git index and objects, never shared refs or config', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-git-sandbox-')); t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), worker = join(root, 'worker'); await mkdir(repo)
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@localhost')
  await writeFile(join(repo, 'code'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Base'); git(repo, 'worktree', 'add', '--detach', worker, 'HEAD')
  const roots = await gitWritableRoots({ cwd: worker, repository: repo, developer: true })
  assert.deepEqual(roots, [await realpath(git(worker, 'rev-parse', '--git-dir')), await realpath(join(repo, '.git', 'objects'))])
  assert.ok(!roots.includes(join(repo, '.git')) && !roots.includes(repo))
  await writeFile(join(worker, 'new-code'), 'change'); git(worker, 'add', 'new-code')
  assert.match(git(worker, 'diff', '--cached', '--name-only'), /new-code/)
  const foreign = join(root, 'foreign'); await mkdir(foreign); git(foreign, 'init', '-q')
  await assert.rejects(gitWritableRoots({ cwd: worker, repository: foreign, developer: true }), /registered/)
})
test('read-only roles gain no extra writable roots, including missing or unrelated paths', async () => {
  assert.deepEqual(await gitWritableRoots({ cwd: '/not-a-workspace', repository: '/private', developer: false }), [])
})
test('only opt-in App developers can write their owned standalone clone Git metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-app-git-sandbox-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  assert.deepEqual(await gitWritableRoots({ cwd: root, repository: root, developer: true }), [])
  assert.deepEqual(await gitWritableRoots({ cwd: root, repository: root, developer: true, appMode: true }), [await realpath(join(root, '.git'))])
  assert.deepEqual(await gitWritableRoots({ cwd: root, repository: root, developer: false, appMode: true }), [])
})
