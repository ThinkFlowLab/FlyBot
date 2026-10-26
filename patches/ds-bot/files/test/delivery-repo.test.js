// Which repository the delivery board reads, and where that name came from (#1250): the instance
// setting, then the workspace's git remote, then the package's own repository. The host and
// `core/scripts/delivery-probe.mjs` both call this one resolver, so the two cannot drift. The knife
// for each level is one test here, so a level that silently stops being tried turns its own test red.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitConfigPath, gitOriginRepo, NO_REPO_MESSAGE, originUrlIn, parseRepoName, resolveRepo } from '../src/host/delivery-repo.js'

const scratch = () => mkdtempSync(join(tmpdir(), 'delivery-repo-'))
const cleanup = dir => rmSync(dir, { recursive: true, force: true })

// A folder that is a git checkout with one `origin` url.
function workspaceWith(url, text = `[remote "origin"]\n\turl = ${url}\n`) {
  const dir = scratch()
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'config'), text)
  return dir
}

test('delivery.repo in the instance setting answers first, and says so (#1250)', () => {
  const dir = workspaceWith('https://github.com/remote/other.git')
  try {
    // The remote disagrees on purpose: an explicit setting beats anything inferred.
    assert.deepEqual(
      resolveRepo({ setting: 'acme/widget', workspace: dir, packageSlug: 'ThinkFlowLab/FlyBot' }),
      { repo: 'acme/widget', source: 'config' })
    // A URL copied from the page, or a name with the `.git` left on, is the same setting.
    assert.deepEqual(resolveRepo({ setting: 'https://github.com/acme/widget.git', workspace: dir, packageSlug: 'x/y' }),
      { repo: 'acme/widget', source: 'config' })
  } finally { cleanup(dir) }
})

test('the workspace origin answers when there is no setting (#1250)', () => {
  const dir = workspaceWith('https://github.com/acme/widget.git')
  try {
    assert.deepEqual(
      resolveRepo({ workspace: dir, packageSlug: 'ThinkFlowLab/FlyBot' }),
      { repo: 'acme/widget', source: 'remote' })
  } finally { cleanup(dir) }
})

test('an origin written as a URL, an scp path or a name with no .git reads the same (#1250)', () => {
  for (const [url, expected] of [
    ['https://github.com/acme/widget.git', 'acme/widget'],
    ['git@github.com:acme/widget.git', 'acme/widget'],
    ['https://github.com/acme/widget', 'acme/widget'],
    ['ssh://git@github.com/acme/widget.git', 'acme/widget'],
  ]) {
    const dir = workspaceWith(url)
    try {
      assert.deepEqual(resolveRepo({ workspace: dir }), { repo: expected, source: 'remote' }, url)
    } finally { cleanup(dir) }
  }
})

test('a .git file is followed through its gitdir, and git is never spawned (#1250)', () => {
  // A worktree (or a submodule) keeps its config elsewhere and `.git` is a pointer file.
  const root = scratch()
  try {
    const store = join(root, 'main.git', 'worktrees', 'wt')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'config'), '[remote "origin"]\n\turl = git@github.com:acme/worktree.git\n')
    const dir = join(root, 'checkout')
    mkdirSync(dir)
    writeFileSync(join(dir, '.git'), `gitdir: ${join('..', 'main.git', 'worktrees', 'wt')}\n`)
    assert.equal(gitConfigPath(dir), join(store, 'config'))
    assert.deepEqual(resolveRepo({ workspace: dir }), { repo: 'acme/worktree', source: 'remote' })
  } finally { cleanup(root) }
})

test('only `origin` counts: another remote is not a union of guesses (#1250)', () => {
  const both = workspaceWith('https://github.com/acme/widget.git',
    '[remote "upstream"]\n\turl = https://github.com/other/place.git\n\n[remote "origin"]\n\turl = https://github.com/acme/widget.git\n')
  try { assert.deepEqual(resolveRepo({ workspace: both }), { repo: 'acme/widget', source: 'remote' }) } finally { cleanup(both) }
  const upstreamOnly = workspaceWith('https://github.com/other/place.git', '[remote "upstream"]\n\turl = https://github.com/other/place.git\n')
  try {
    assert.deepEqual(resolveRepo({ workspace: upstreamOnly }), { repo: null, source: null })
    assert.equal(gitOriginRepo(upstreamOnly), null)
  } finally { cleanup(upstreamOnly) }
  // A folder that is not a git checkout at all answers null instead of throwing.
  assert.equal(gitOriginRepo('/nonexistent/folder/for/this/test'), null)
  assert.equal(gitOriginRepo(null), null)
})

test('the package repository answers last, and is labelled a default (#1250)', () => {
  // A real package's `repository.url` arrives with the `git+` prefix and the `.git` suffix.
  assert.deepEqual(resolveRepo({ packageSlug: 'git+https://github.com/ThinkFlowLab/FlyBot.git' }),
    { repo: 'ThinkFlowLab/FlyBot', source: 'package' })
  assert.deepEqual(resolveRepo({ packageSlug: 'ThinkFlowLab/FlyBot' }),
    { repo: 'ThinkFlowLab/FlyBot', source: 'package' })
})

test('nothing answering is null, never a name invented from nothing (#1250)', () => {
  assert.deepEqual(resolveRepo({}), { repo: null, source: null })
  assert.deepEqual(resolveRepo(), { repo: null, source: null })
  assert.deepEqual(resolveRepo({ setting: '', workspace: '', packageSlug: '' }), { repo: null, source: null })
  // The failure message is one constant, so the view, the host and the CLI cannot disagree on it.
  assert.equal(NO_REPO_MESSAGE, 'no repository — set delivery.repo')
})

test('a value that is not a GitHub repository is refused, not mined for its last two segments (#1250)', () => {
  for (const value of ['not a repo', 'https://gitlab.com/acme/widget.git', 'https://github.com/acme', 'acme/widget/extra', 12]) {
    assert.equal(parseRepoName(value), null, String(value))
  }
  assert.equal(originUrlIn('[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'), null)
})

test('the probe is a shell over this resolver, and refuses before it asks (#1250)', () => {
  const source = readFileSync(new URL('../scripts/delivery-probe.mjs', import.meta.url), 'utf8')
  // One resolver, imported — a second copy in the CLI is how the two drift.
  assert.match(source, /import \{ NO_REPO_MESSAGE, resolveRepo \} from '\.\.\/src\/host\/delivery-repo\.js'/)
  assert.match(source, /resolveRepo\(\{/)
  // The same refusal the host gives, with a non-zero exit and no request before it.
  assert.match(source, /if \(found\.repo === null\) \{[\s\S]{0,240}process\.exit\(2\)/)
  assert.match(source, /NO_REPO_MESSAGE/)
  // Its order is --repo, then --workspace, then the package: no third source.
  assert.match(source, /setting: argOf\('--repo'\)/)
  assert.match(source, /workspace: argOf\('--workspace', process\.cwd\(\)\)/)
  assert.match(source, /packageSlug: repoSlug\(\)/)
})
