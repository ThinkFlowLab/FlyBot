// Which repository the delivery board reads, and where that name came from (#1250): the instance
// setting, then the workspace's git remote, then the package's own repository. The host and
// `core/scripts/delivery-probe.mjs` both call this one resolver, so the two cannot drift. The knife
// for each level is one test here, so a level that silently stops being tried turns its own test red.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitConfigPath, gitOriginRepo, instanceRepoSetting, NO_REPO_MESSAGE, originUrlIn, parseRepoName, resolveRepo } from '../src/host/delivery-repo.js'

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

test('a submodule keeps its config in the gitdir the `.git` file names (#1250)', () => {
  // A submodule's `.git` is a pointer file and its own gitdir really does hold `config`.
  const root = scratch()
  try {
    const store = join(root, 'super', '.git', 'modules', 'sub')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'config'), '[remote "origin"]\n\turl = git@github.com:acme/submodule.git\n')
    const dir = join(root, 'super', 'sub')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.git'), `gitdir: ${join('..', '.git', 'modules', 'sub')}\n`)
    assert.equal(gitConfigPath(dir), join(store, 'config'))
    assert.deepEqual(resolveRepo({ workspace: dir }), { repo: 'acme/submodule', source: 'remote' })
  } finally { cleanup(root) }
})

test('a linked worktree follows its `commondir` to the config the shared directory holds (#1258)', () => {
  // `git worktree add` writes `.git` -> `<main>/.git/worktrees/<name>`, and that directory holds no
  // config of its own: only `commondir`, naming the shared directory where git keeps it. Reading
  // `config` beside the pointer finds nothing, so a worktree workspace fell to the package default.
  const root = scratch()
  try {
    const shared = join(root, 'main', '.git')
    mkdirSync(join(shared, 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(shared, 'config'), '[remote "origin"]\n\turl = git@github.com:acme/worktree.git\n')
    writeFileSync(join(shared, 'worktrees', 'wt', 'commondir'), '../..\n')
    const dir = join(root, 'checkout')
    mkdirSync(dir)
    writeFileSync(join(dir, '.git'), `gitdir: ${join('..', 'main', '.git', 'worktrees', 'wt')}\n`)
    assert.equal(gitConfigPath(dir), join(shared, 'config'))
    assert.deepEqual(resolveRepo({ workspace: dir }), { repo: 'acme/worktree', source: 'remote' })
    // A pointer with neither a config nor a commondir answers nothing rather than a wrong path.
    const bare = join(root, 'bare')
    mkdirSync(join(bare, 'gitdir'), { recursive: true })
    mkdirSync(join(root, 'elsewhere'))
    writeFileSync(join(root, 'elsewhere', '.git'), 'gitdir: ../bare/gitdir\n')
    assert.equal(gitConfigPath(join(root, 'elsewhere')), null)
    assert.deepEqual(resolveRepo({ workspace: join(root, 'elsewhere') }), { repo: null, source: null })
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

test('a path step is not a repository name, so `.` and `..` segments are refused (#1258)', () => {
  // `OWNER_NAME` allowed a dot anywhere, so `../..` answered a "repository": the board then built
  // `/repos/../../issues`, which normalises to the API root. Same host, so no token left, but every
  // request it made was meaningless and the "this is a repository name" invariant was gone.
  for (const value of ['../..', './widget', '.a/b', 'acme/.b', 'acme/..']) {
    assert.equal(parseRepoName(value), null, value)
  }
  // A dot inside a segment is a real repository name and stays allowed.
  for (const value of ['acme/widget.js', 'a.b/c-d', 'a1-2_3/b.4']) {
    assert.equal(parseRepoName(value), value, value)
  }
})

test('the instance setting is read in all three spellings a profile can write it (#1258)', () => {
  // The host passes the plugin entry through verbatim and expands no dotted key, so the hint's
  // `delivery.repo` reaches the board as one of three shapes. Reading only the flat one ignored
  // what a user had just written and fell through to the labelled package default.
  assert.equal(instanceRepoSetting({ delivery: { repo: 'acme/widget' } }), 'acme/widget')
  assert.equal(instanceRepoSetting({ 'delivery.repo': 'acme/widget' }), 'acme/widget')
  assert.equal(instanceRepoSetting({ deliveryRepo: 'acme/widget' }), 'acme/widget')
  // The documented spelling wins over the runtime shape when a profile happens to carry both.
  assert.equal(instanceRepoSetting({ delivery: { repo: 'acme/nested' }, deliveryRepo: 'acme/flat' }), 'acme/nested')
  // Nothing written, or an empty value, is "no setting", not the empty string as a repository.
  assert.equal(instanceRepoSetting({}), null)
  assert.equal(instanceRepoSetting({ delivery: {} }), null)
  assert.equal(instanceRepoSetting({ deliveryRepo: '' }), null)
  assert.equal(instanceRepoSetting(null), null)
  assert.equal(instanceRepoSetting(undefined), null)
  // A nested setting is a real setting end to end, not only in the helper.
  assert.deepEqual(resolveRepo({ setting: instanceRepoSetting({ delivery: { repo: 'acme/widget' } }), packageSlug: 'x/y' }),
    { repo: 'acme/widget', source: 'config' })
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
