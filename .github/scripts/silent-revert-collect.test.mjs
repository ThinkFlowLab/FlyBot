// The git side of the silent-revert check: `collect()` is driven by a fake `run`, because every case
// fed pre-recorded A/D and a flipped A side left all of them green (#915 INC record). The recorded-tree
// cases and the report shape stay in `silent-revert.test.mjs`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collect } from './silent-revert.mjs'

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
  const wf = readFileSync(new URL('../workflows/silent-revert.yml', import.meta.url), 'utf8')
  assert.match(
    wf,
    /^ {10}script=base\.mjs$/m,
    'the script comes from the base commit, never from the pull request',
  )
  assert.match(wf, /git -C head show origin\/main:\.github\/scripts\/silent-revert\.mjs > base\.mjs/, 'the base copy is read out of main')
  assert.match(wf, /fetch-depth: 0/, 'merge-base and origin/main need the history')
  assert.match(
    wf,
    /git -C head fetch --no-tags --quiet origin \+refs\/heads\/main:refs\/remotes\/origin\/main/,
    'main has to be present, not assumed',
  )
  // The one documented exception, the same one review-gate.yml makes: the pull request that ADDS the
  // script has no base copy, so that single run uses its own under the same read-only token. Once the
  // base has the file, the base always wins.
  assert.match(wf, /^ {10}\[ -s "\$script" \] \|\| script=head\/\.github\/scripts\/silent-revert\.mjs$/m)
  assert.match(wf, /^\s+node "\$script" --repo-dir head$/m)
  // A required check that never reports leaves every pull request waiting; this one only reports, on
  // the pull_request event, and its findings never fail the job.
  const marker = wf.indexOf('script=base.mjs')
  const step = wf.slice(marker - 2000, marker)
  assert.match(step, /if: github\.event_name == 'pull_request'/)
  assert.match(step, /continue-on-error: \$\{\{ github\.event_name == 'pull_request' \}\}/)
  assert.doesNotMatch(step, /: write/, 'read-only')
  assert.doesNotMatch(wf, /silent-revert.*(gh pr merge|--approve|labels)/, 'it never comments, labels or merges')
})
