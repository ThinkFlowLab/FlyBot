// The generated patch format (scripts/ds-bot-patches.mjs): header lines carry no per-edit data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { applyPatchText, normalizeDiff } from '../../scripts/ds-bot-patches.mjs'

const gitAvailable = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

const lines = (n, edits = {}) => Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

// What generate does for one file: `git diff --no-index` of ds-bot/x against core/x, then normalize.
function diffOf(before, after, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'patch-fmt-'))
  try {
    mkdirSync(join(dir, 'ds-bot'))
    mkdirSync(join(dir, 'core'))
    writeFileSync(join(dir, 'ds-bot', 'x.js'), before)
    writeFileSync(join(dir, 'core', 'x.js'), after)
    let raw
    try { raw = execFileSync('git', ['diff', '--no-index', '--no-color', '--', 'ds-bot/x.js', 'core/x.js'], { cwd: dir, encoding: 'utf8' }) } catch (error) { raw = error.stdout }
    return normalizeDiff(raw, opts)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

function applies(before, patch) {
  const dir = mkdtempSync(join(tmpdir(), 'patch-fmt-'))
  try {
    writeFileSync(join(dir, 'x.js'), before)
    writeFileSync(join(dir, 'p.patch'), patch)
    execFileSync('git', ['apply', '--whitespace=nowarn', '-p1', 'p.patch'], { cwd: dir, stdio: 'pipe' })
    return readFileSync(join(dir, 'x.js'), 'utf8')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const base = lines(200)
const top = { 3: 'line 3\nadded at the top\nand a second line' }
const bottom = { 190: 'line 190\nadded at the bottom' }

// The format cases ask git for the diff, so they run where git exists (CI); the applier cases below
// are git-free on purpose, because that is the machine #978 is for.
if (gitAvailable) {
  test('no index line, no ds-bot/ or core/ prefix, no per-file counts of other edits', () => {
    const patch = diffOf(base, lines(200, top))
    assert.doesNotMatch(patch, /^index /m)
    assert.match(patch, /^diff --git a\/x\.js b\/x\.js$/m)
    assert.match(patch, /^--- a\/x\.js$/m)
    assert.match(patch, /^\+\+\+ b\/x\.js$/m)
  })

  test('a hunk header does not depend on edits in other hunks', () => {
    const both = { ...top, ...bottom }
    const hunks = text => text.split('\n').filter(l => l.startsWith('@@'))
    const alone = hunks(diffOf(base, lines(200, bottom)))
    const withTop = hunks(diffOf(base, lines(200, both)))
    assert.equal(alone.length, 1)
    assert.ok(withTop.includes(alone[0]), `${alone[0]} not in ${withTop}`)
    // the exact form shifts the new-side start, which is what made two branches conflict
    const exact = diffOf(base, lines(200, both), { exact: true }).split('\n').filter(l => l.startsWith('@@'))
    assert.ok(!exact.includes(alone[0]))
  })

  test('the stored form still applies, and gives the new file', () => {
    const both = { ...top, ...bottom }
    assert.equal(applies(base, diffOf(base, lines(200, both))), lines(200, both))
    assert.equal(applies(base, diffOf(base, lines(200, both), { exact: true })), lines(200, both))
  })

  test('hunk bodies are never rewritten, even when they look like headers', () => {
    const tricky = ['--- a/ds-bot/x.js', '+++ b/core/x.js', 'index abc..def 100644', '@@ -1,2 +9,9 @@', 'ctx']
    const before = tricky.join('\n') + '\n'
    const after = ['ctx', ...tricky.slice(0, 4)].join('\n') + '\n'
    const patch = diffOf(before, after)
    for (const l of tricky.slice(0, 4)) assert.ok(patch.includes(l), `lost: ${l}`)
    assert.equal(applies(before, patch), after)
  })
}

// The git-free applier (#978). Two review cycles were lost to shapes only CI's git apply caught, so
// both are fixtures: a hunk body with more lines than its header declares (#934) and a hunk header
// that runs past the last line of the file (#966).
function applyTo(files, patch) {
  const dir = mkdtempSync(join(tmpdir(), 'patch-apply-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    applyPatchText(patch, dir)
    const out = {}
    const walk = abs => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const path = join(abs, entry.name)
        if (entry.isDirectory()) { walk(path); continue }
        out[relative(dir, path).split(sep).join('/')] = { text: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 }
      }
    }
    walk(dir)
    return out
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('#978: a hunk that runs past the end of the file fails, naming the hunk and both numbers', () => {
  const before = lines(661)
  const patch = [
    'diff --git a/src/client/sidebar.js b/src/client/sidebar.js',
    '--- a/src/client/sidebar.js',
    '+++ b/src/client/sidebar.js',
    '@@ -658,5 +658,5 @@',
    ...['line 658', 'line 659', 'line 660', 'line 661', ''].map(line => ` ${line}`),
    '',
  ].join('\n')
  assert.throws(() => applyTo({ 'src/client/sidebar.js': before }, patch), /sidebar\.js hunk 1 \(@@ -658,5 \+658,5 @@\): runs past the end of the file \(661 lines\)/)
})

test('#978: a hunk body with one line too many fails instead of landing the extra line', () => {
  const patch = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -2,2 +2,3 @@',
    ' line 2',
    ' line 3',
    ' ',
    '',
  ].join('\n')
  assert.throws(() => applyTo({ 'x.js': lines(10) }, patch), /hunk 1 \(@@ -2,2 \+2,3 @@\): the body has 3 old and 3 new line\(s\), the header declares 2 and 3/)
})

test('#978: a hunk that only matches somewhere else is refused, not moved to fit', () => {
  // The context sits on line 7; a searching applier finds it there and writes the file 4 lines off,
  // which is how #966's phantom line got through. The header says 3, so it fails at 3.
  const before = ['pad', 'pad', 'pad', 'pad', 'pad', 'pad', 'alpha', 'beta', 'pad'].join('\n') + '\n'
  const patch = [
    'diff --git a/x.txt b/x.txt',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -3,2 +3,2 @@',
    ' alpha',
    '-beta',
    '+gamma',
    '',
  ].join('\n')
  assert.throws(() => applyTo({ 'x.txt': before }, patch), /hunk 1 \(@@ -3,2 \+3,2 @@\): context at 3 is "pad", the hunk has "alpha"/)
})

test('#978: a missing final newline is kept on both sides, and a false marker is refused', () => {
  const patch = [
    'diff --git a/x.txt b/x.txt',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,2 +1,2 @@',
    ' one',
    '-two',
    '\\ No newline at end of file',
    '+two!',
    '\\ No newline at end of file',
    '',
  ].join('\n')
  assert.equal(applyTo({ 'x.txt': 'one\ntwo' }, patch)['x.txt'].text, 'one\ntwo!')
  assert.throws(() => applyTo({ 'x.txt': 'one\ntwo\n' }, patch), /says "No newline at end of file" after a line that has one/)
})

test('#978: -p1 strips the path, a whole file is created with its mode, and /dev/null deletes one', () => {
  const created = [
    'diff --git a/lib/new.js b/lib/new.js',
    'new file mode 100755',
    '--- /dev/null',
    '+++ b/lib/new.js',
    '@@ -0,0 +1,2 @@',
    '+#!/usr/bin/env node',
    '+console.log(1)',
    '',
  ].join('\n')
  const out = applyTo({}, created)
  assert.equal(out['lib/new.js'].text, '#!/usr/bin/env node\nconsole.log(1)\n')
  assert.equal(out['lib/new.js'].mode, 0o755)
  const deleted = [
    'diff --git a/lib/old.js b/lib/old.js',
    '--- a/lib/old.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    '',
  ].join('\n')
  assert.deepEqual(Object.keys(applyTo({ 'lib/old.js': 'gone\n', 'keep.js': 'kept\n' }, deleted)), ['keep.js'])
})

if (gitAvailable) {
  test('#978: the git-free applier and git apply produce the same tree on every stored patch', () => {
    const root = join(import.meta.dirname, '..', '..')
    const patchesDir = join(root, 'patches', 'ds-bot')
    const stored = readdirSync(patchesDir).filter(name => /^\d{4}-.*\.patch$/.test(name)).sort()
    // 10: `0017-task-pool-role-queues.patch` only edited whole-file mirrors
    // (`src/host/tasks.js`, `src/host/hooks.js`) plus one `tools.js` line that lives in `0002`, so
    // the generator folds it away instead of storing a patch that applies nothing. `0018` (#1883)
    // goes the same way once the generator runs: its `client.js` hunk moves into `0008` and its
    // other edits into their own topics, so a regenerated series stores 10 patches.
    assert.equal(stored.length, 10)
    const viaGit = mkdtempSync(join(tmpdir(), 'patch-git-'))
    const viaOurs = mkdtempSync(join(tmpdir(), 'patch-ours-'))
    try {
      for (const dir of [viaGit, viaOurs]) {
        cpSync(join(root, 'ds-bot'), dir, { recursive: true })
        cpSync(join(patchesDir, 'files'), dir, { recursive: true })
      }
      for (const name of stored) {
        execFileSync('git', ['apply', '--whitespace=nowarn', '-p1', join(patchesDir, name)], { cwd: viaGit, stdio: 'pipe' })
        applyPatchText(readFileSync(join(patchesDir, name), 'utf8'), viaOurs)
      }
      const list = dir => {
        const out = []
        const walk = abs => {
          for (const entry of readdirSync(abs, { withFileTypes: true })) {
            const path = join(abs, entry.name)
            if (entry.isDirectory()) { walk(path); continue }
            out.push(relative(dir, path).split(sep).join('/'))
          }
        }
        walk(dir)
        return out.sort()
      }
      const files = list(viaGit)
      assert.deepEqual(list(viaOurs), files, 'both appliers produced the same file list')
      for (const file of files) {
        assert.equal(readFileSync(join(viaOurs, file)).equals(readFileSync(join(viaGit, file))), true, file)
        assert.equal(statSync(join(viaOurs, file)).mode & 0o777, statSync(join(viaGit, file)).mode & 0o777, `${file} mode`)
      }
    } finally {
      rmSync(viaGit, { recursive: true, force: true })
      rmSync(viaOurs, { recursive: true, force: true })
    }
  })
}
