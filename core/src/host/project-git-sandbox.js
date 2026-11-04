// Give a registered local developer only its own Git index and shared object store.
import { realpath, readFile } from 'node:fs/promises'
import { isAbsolute, resolve, join, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const inside = (root, path) => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) }
export async function gitWritableRoots({ cwd, repository, developer = false, appMode = false }) {
  if (!developer) return []
  const path = await realpath(cwd), repo = await realpath(repository)
  const gitPath = async (directory, flag) => {
    const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'rev-parse', flag], { cwd: directory, timeout: 5000, maxBuffer: 8192, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0' } })
    return realpath(resolve(directory, stdout.trim()))
  }
  const [gitDir, common, expected] = await Promise.all([gitPath(path, '--git-dir'), gitPath(path, '--git-common-dir'), gitPath(repo, '--git-common-dir')])
  if (gitDir === common && inside(path, gitDir)) return appMode ? [gitDir] : []
  if (common !== expected || !inside(join(expected, 'worktrees'), gitDir)) throw new Error('Developer Git metadata does not belong to its registered repository worktree')
  // The regular gitdir file names the current worktree, not another worker's index.
  const registered = await realpath((await readFile(join(gitDir, 'gitdir'), 'utf8')).trim())
  if (registered !== join(path, '.git')) throw new Error('Developer Git worktree registration changed')
  return [gitDir, await realpath(join(expected, 'objects'))]
}
