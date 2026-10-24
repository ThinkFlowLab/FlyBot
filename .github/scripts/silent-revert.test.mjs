// #914: the silent revert. A pull request built on an old copy of `main` re-uploads whole files and
// the work `main` merged after the branch was cut disappears — with `mergeable: true` and `tests-ok`
// green, because the deletion is part of the pull request. `#887` deleted `#869`'s 84 test lines the
// same hour; `#907` deleted `#909`'s whole fix 40 minutes after it merged.
//
// The fixtures under `fixtures/silent-revert/` are the real trees, recorded through the GitHub API on
// 2026-10-24 (`A` = the added side of `git diff <merge-base> origin/main`, `D` = the removed side of
// `git diff origin/main HEAD`, line text only, as the rule compares them). Each file says what it is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  collect,
  diffLines,
  findSilentReverts,
  intersect,
  isTestPath,
  parseArgs,
  reportLines,
  significant,
} from './silent-revert.mjs'

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/silent-revert/${name}.json`, import.meta.url), 'utf8'))
const paths = (report) => report.findings.map((finding) => finding.path)
const finding = (report, path) => report.findings.find((f) => f.path === path)

test('the arguments are read wherever they stand, including first position', () => {
  // The live run showed this: --repo-dir was the first argument, was read as absent, and the check
  // ran git in the job work directory instead of the head checkout.
  assert.deepEqual(parseArgs(['--repo-dir', 'head']), { dir: 'head', pr: undefined, main: undefined })
  assert.deepEqual(parseArgs(['--pr', '915', '--repo-dir', 'head', '--main', 'origin/main']), {
    dir: 'head',
    pr: '915',
    main: 'origin/main',
  })
  assert.deepEqual(parseArgs([]), { dir: undefined, pr: undefined, main: undefined })
  assert.deepEqual(parseArgs(['--pr']), { dir: undefined, pr: undefined, main: undefined })
})

test('the two sides are read off a unified diff: no +++/--- headers, blank lines are not evidence', () => {
  const text = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,3 @@', '-old', '+new', '+', '+added'].join('\n')
  assert.deepEqual(diffLines(text, '+'), ['new', 'added'])
  assert.deepEqual(diffLines(text, '-'), ['old'])
  assert.deepEqual(significant(['a', '', '  ', 'a', 'b\t']), ['a', 'b'])
})

test('a file is marked test or source, so one noisy class cannot hide the other', () => {
  for (const path of [
    'plugins/social/test/social.test.js',
    'core/test/remote-room.test.js',
    '.github/scripts/silent-revert.test.mjs',
    'plugins/social/__tests__/a.js',
    '.github/scripts/fixtures/silent-revert/907-b8b582bd.json',
  ]) {
    assert.equal(isTestPath(path), true, path)
  }
  for (const path of ['core/src/host/room-membership.js', 'plugins/social/client.js', 'docs/subsystems/social.md']) {
    assert.equal(isTestPath(path), false, path)
  }
})

test('#907 @ b8b582bd: red — the branch never saw #909, so main fix is deleted here', () => {
  const report = findSilentReverts(fixture('907-b8b582bd'))
  const wanted = paths(report)
  assert.ok(wanted.includes('core/src/host/room-membership.js'), wanted.join(', '))
  assert.ok(wanted.includes('core/test/remote-room.test.js'), wanted.join(', '))
  const source = finding(report, 'core/src/host/room-membership.js')
  assert.ok(source.count >= 40, `count ${source.count}`)
  assert.equal(source.kind, 'source')
  assert.match(source.lines.join('\n'), /#909/, 'the finding names the work that was merged')
  const tests = finding(report, 'core/test/remote-room.test.js')
  assert.ok(tests.count >= 50, `count ${tests.count}`)
  assert.equal(tests.kind, 'test')
  assert.match(tests.lines.join('\n'), /#909: an inbound envelope/)
  const lines = reportLines(report)
  assert.match(
    lines[0],
    /^#907 @b8b582b: core\/src\/host\/room-membership\.js: 40 line\(s\) main added after cbad5e5 are deleted here$/,
  )
  assert.match(lines.at(-1), /^silent-revert: 5 finding\(s\) on 16 file\(s\) — source 3, test 2$/)
})

test('#886 @ cf907be7: red on the source file and on its tests', () => {
  const report = findSilentReverts(fixture('886-cf907be7'))
  assert.deepEqual(paths(report).sort(), ['plugins/social/src/social.js', 'plugins/social/test/social.test.js'])
  assert.equal(finding(report, 'plugins/social/src/social.js').kind, 'source')
  assert.equal(finding(report, 'plugins/social/test/social.test.js').kind, 'test')
  assert.ok(finding(report, 'plugins/social/test/social.test.js').count >= 270)
  assert.match(reportLines(report).at(-1), /^silent-revert: 2 finding\(s\) on 2 file\(s\) — source 1, test 1$/)
})

test('#910 @ 07dee97d: the negative control stays zero — A was empty at its base', () => {
  const report = findSilentReverts(fixture('910-07dee97d'))
  assert.deepEqual(report.findings, [], 'its 18 replaced lines are its own, and main had not moved past its base')
  // The clean line names how many files were read: a run that read nothing must not look the same as
  // a run that read the pull request and found nothing (#912's first live run was that green tick).
  assert.equal(reportLines(report).join('\n'), `silent-revert: 0 finding(s) on ${report.scanned} file(s)`)
  assert.equal(report.scanned, 5)
})

test('a pull request already rebased onto main reports nothing: base = origin/main makes A empty', () => {
  const main = '79aa6128b6e0ef013e41c07f44815754c4e4684a'
  const report = findSilentReverts({
    pr: 1,
    head: 'a'.repeat(40),
    base: main,
    // A merged copy of the file the pull request rewrites: every deleted line is main's own, and main
    // added nothing after itself, so the intersection is empty by construction.
    files: [{ path: 'core/src/host/room-membership.js', status: 'M', addedByMain: [], deletedByHead: ['- gone'] }],
  })
  assert.deepEqual(report.findings, [])
  assert.match(reportLines(report).at(-1), /^silent-revert: 0 finding\(s\) on 1 file\(s\)$/)
})

test('a pull request that only adds lines reports nothing, and says it read nothing', () => {
  const report = findSilentReverts({ pr: 1, head: 'b'.repeat(40), base: 'c'.repeat(40), files: [] })
  assert.deepEqual(report.findings, [])
  assert.equal(reportLines(report).at(-1), 'silent-revert: 0 finding(s) on 0 file(s)')
})

test('a whole-file deletion is one finding with the count, not one report per line', () => {
  const hit = intersect({ path: 'core/src/host/channel.js', status: 'D', addedByMain: ['a', 'b', 'c', 'b'] })
  assert.equal(hit.whole, true)
  assert.equal(hit.count, 3)
  const report = findSilentReverts({ pr: 7, head: 'd'.repeat(40), base: 'e'.repeat(40), files: [{ ...hit, path: hit.path, status: 'D', addedByMain: ['a', 'b', 'c', 'b'] }] })
  assert.match(reportLines(report)[0], /deleted whole, 3 line\(s\) main added after eeeeeee are gone$/)
})

test('A ∩ D is a set: the same line on both sides counts once', () => {
  const hit = intersect({ path: 'core/src/host/channel.js', status: 'M', addedByMain: ['x', 'x', 'y'], deletedByHead: ['y', 'y', 'x', 'x'] })
  assert.equal(hit.count, 2)
  assert.deepEqual(hit.lines.sort(), ['x', 'y'])
})

// ---- collect(): the git side, which the seven recorded fixtures never touch. #915's INC found this
// the hard way: every case fed pre-recorded A/D, so flipping the A side (a change that makes the
// check permanently silent in production) left 11/11 green.
const SHA = { head: 'h'.repeat(40), main: 'm'.repeat(40), base: 'b'.repeat(40) }

function fakeGit({ nameStatus = '', addedByFile = {}, deletedByFile = {} } = {}) {
  const calls = []
  const run = (dir, args) => {
    const line = args.join(' ')
    calls.push({ dir, args })
    if (line === 'rev-parse --verify origin/main^{commit}') return 'ok'
    if (line === 'rev-parse HEAD') return SHA.head
    if (line === 'rev-parse origin/main^{commit}') return SHA.main
    if (line === 'merge-base origin/main HEAD') return SHA.base
    if (line === 'diff --name-status ' + SHA.base + ' HEAD') return nameStatus
    const diff = /^diff --no-color --no-ext-diff -U0 (\S+) (\S+) -- (.*)$/.exec(line)
    if (diff) {
      const [, from, to, path] = diff
      if (from === SHA.base && to === SHA.main) return (addedByFile[path] ?? []).map((l) => '+' + l).join('\n')
      if (from === SHA.main && to === SHA.head) return (deletedByFile[path] ?? []).map((l) => '-' + l).join('\n')
      throw new Error('diff read from the wrong side: ' + line)
    }
    if (args[0] === 'log') return ''
    throw new Error('unexpected git call: ' + line)
  }
  return { run, calls }
}

test('collect asks for the pull request own files (base..HEAD) and both sides of the rule', () => {
  const file = 'core/src/host/room-membership.js'
  const { run, calls } = fakeGit({
    nameStatus: 'M\t' + file,
    addedByFile: { [file]: ['one', 'two'] },
    deletedByFile: { [file]: ['two', 'three'] },
  })
  const report = collect({ dir: 'head', pr: 915, run })
  const lines = calls.map((c) => c.args.join(' '))
  assert.deepEqual(lines.filter((l) => l.startsWith('diff --name-status')), ['diff --name-status ' + SHA.base + ' HEAD'])
  assert.deepEqual(lines.filter((l) => l.includes(' -U0 ')), [
    'diff --no-color --no-ext-diff -U0 ' + SHA.base + ' ' + SHA.main + ' -- ' + file,
    'diff --no-color --no-ext-diff -U0 ' + SHA.main + ' ' + SHA.head + ' -- ' + file,
  ])
  assert.deepEqual(report.findings.map((f) => f.path), [file])
  assert.equal(report.findings[0].count, 1)
  assert.equal(report.scanned, 1)
})

test('a file main touched but the pull request did not is never scanned', () => {
  // #912's shape: the branch is one commit behind, so two files it never edited differ from main.
  // With a main..HEAD file list their D equals main's A and every such branch reports a false revert.
  const touched = 'core/src/host/room-membership.js'
  const untouched = 'core/test/remote-room.test.js'
  const { run } = fakeGit({
    nameStatus: 'M\t' + touched + '\nM\t.github/scripts/silent-revert.mjs\n',
    addedByFile: { [touched]: ['x'], [untouched]: ['y'] },
    deletedByFile: { [touched]: ['x'], [untouched]: ['y'] },
  })
  const report = collect({ dir: 'head', pr: 912, run })
  assert.deepEqual(report.findings.map((f) => f.path), [touched], 'the file the pull request never touched cannot be reported')
  assert.equal(report.scanned, 2)
})

test('workflow: report only, base copy of the script, full history, and it cannot turn the run red', () => {
  const wf = readFileSync(new URL('../workflows/merge-gate.yml', import.meta.url), 'utf8')
  assert.match(wf, /^\s+script=base\/\.github\/scripts\/silent-revert\.mjs$/m, 'the script comes from the base commit, never from the pull request')
  assert.match(wf, /fetch-depth: 0/, 'merge-base and origin/main need the history')
  assert.match(
    wf,
    /git -C head fetch --no-tags --quiet origin \+refs\/heads\/main:refs\/remotes\/origin\/main/,
    'main has to be present, not assumed',
  )
  // The one documented exception, the same one review-gate.yml makes: the pull request that ADDS the
  // script has no base copy, so that single run uses its own under the same read-only token. Once the
  // base has the file, the base always wins.
  assert.match(wf, /^\s+\[ -f "\$script" \] \|\| script=head\/\.github\/scripts\/silent-revert\.mjs$/m)
  assert.match(wf, /^\s+node "\$script" --repo-dir head$/m)
  // A required check that never reports leaves every pull request waiting; this one only reports, on
  // the pull_request event, and its findings never fail the job.
  const marker = wf.indexOf('script=base/.github/scripts/silent-revert.mjs')
  const step = wf.slice(marker - 2000, marker)
  assert.match(step, /if: github\.event_name == 'pull_request'/)
  assert.match(step, /continue-on-error: \$\{\{ github\.event_name == 'pull_request' \}\}/)
  assert.doesNotMatch(step, /: write/, 'read-only')
  assert.doesNotMatch(wf, /silent-revert.*(gh pr merge|--approve|labels)/, 'it never comments, labels or merges')
})
