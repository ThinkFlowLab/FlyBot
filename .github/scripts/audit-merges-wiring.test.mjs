// The wiring between the two report-only gates and their workflows, kept in one small file so the
// decision survives without anyone re-uploading the long suites beside it.
//
// Both gates are report-only in one direction only: a finding must not block a pull request, and it
// must not be hidden either. A step that swallows the script's exit code turns a run that DID report
// a finding green — and `audit-merges` takes its watermark from the last *green* run of itself, so
// the next run then signs that finding off as `earlier` and nobody sees it again. The same swallow on
// `silent-revert` hides a run that could not do its job at all (no `origin/main`, shallow history).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (name) => readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8')

test('neither gate swallows the exit code of the script it runs', () => {
  for (const name of ['audit-merges.yml', 'silent-revert.yml']) {
    const text = read(name)
    assert.doesNotMatch(text, /continue-on-error/, `${name} must let a finding or a failure show`)
  }
})

test('audit-merges still has both a watermark run and a first run without one', () => {
  const text = read('audit-merges.yml')
  assert.match(text, /--since "\$SINCE"/, 'a run after one green run keeps to what came after it')
  assert.match(text, /--baseline/, 'the first run has no watermark, so it reports everything as earlier')
  assert.match(text, /status=success&per_page=1/, 'the watermark comes from a green run, never a red one')
  assert.match(text, /ref: main/, 'it audits main, never a pull request head')
})

test('silent-revert asks for the pull request number when run by hand', () => {
  const text = read('silent-revert.yml')
  assert.match(text, /^ {8}required: true$/m, 'an empty input would check out refs/pull//head and fail in checkout')
  assert.match(text, /ref: refs\/pull\/\$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr \}\}\/head/)
})

test('a silent-revert run that cannot read the repository exits 1, so the step goes red', () => {
  const script = new URL('./silent-revert.mjs', import.meta.url).pathname
  const run = spawnSync(process.execPath, [script, '--repo-dir', 'no-such-directory'], { encoding: 'utf8' })
  assert.equal(run.status, 1, 'a broken run must not exit 0')
  assert.match(run.stdout, /silent-revert: could not run/, 'it says what went wrong instead of printing a clean line')
})
