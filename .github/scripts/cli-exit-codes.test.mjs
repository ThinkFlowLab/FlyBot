// Exit codes are the contract with whoever wires these scripts into a workflow: 0 clean, 1 a
// finding, 2 unjudged, 3 input error. The cases below are the ones that got them wrong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const HYGIENE = join(here, 'label-hygiene.mjs')
const GUARD = join(here, 'comment-guard.mjs')
const dir = mkdtempSync(join(tmpdir(), 'cli-'))
let n = 0
const save = (v) => {
  const path = join(dir, `${++n}.txt`)
  writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v))
  return path
}
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

// A branch that really exists on the remote today; the point is that nothing in the payload says so.
const LIVE = 'Claim-Id: dfddd1297c094b41a8dfc70778143d10\nBranch: dev/3393-write-guards\n'
const live = { items: [{ number: 1, kind: 'issue', state: 'open', labels: ['agent-working'], body: LIVE }] }

test('an empty listing is no fact: a live branch is unjudged, never an orphan', () => {
  const issues = save(live)
  assert.equal(run(HYGIENE, ['--issues', issues]).status, 2, 'no --refs at all')
  assert.equal(run(HYGIENE, ['--issues', issues, '--refs', save([])]).status, 2, '--refs [] is what a flaked ls-remote gives')
  assert.equal(run(HYGIENE, ['--issues', issues, '--refs', save(['dev/3393-write-guards'])]).status, 0, 'the branch exists')
  assert.equal(run(HYGIENE, ['--issues', issues, '--refs', save(['main'])]).status, 1, 'a non-empty list without it is a finding')
  assert.equal(run(HYGIENE, ['--issues', issues, '--prs', save({})]).status, 2, 'an empty PR map is no fact either')
})

test('raw git ls-remote output is the normal --refs input and equals the JSON array', () => {
  const issues = save(live)
  const sha = (c) => c.repeat(40)
  const text = `${sha('a')}\trefs/heads/dev/3393-write-guards\n${sha('b')}\trefs/heads/main\n`
  const fromText = run(HYGIENE, ['--issues', issues, '--refs', save(text)])
  const fromJson = run(HYGIENE, ['--issues', issues, '--refs', save(['dev/3393-write-guards', 'main'])])
  assert.equal(fromText.status, 0)
  assert.equal(fromText.stdout, fromJson.stdout, 'same verdicts, same exit code')
  assert.equal(run(HYGIENE, ['--issues', issues, '--refs', save(`${sha('c')}\trefs/tags/v1\n`)]).status, 2,
    'a tags-only listing says nothing about branches')
})

// The prompt fix: a caller who already passed --refs is not sent back for it, and a live branch is
// still not a PR (agent-pr means a PR carries this, so the row stays unknown).
test('a run that was given a fact never asks for that fact again', () => {
  const AP = { items: [{ number: 3066, kind: 'issue', state: 'open', labels: ['agent-pr'], body: LIVE }] }
  const prsFile = save([{ number: 9, state: 'open', head: { ref: 'dev/other' } }])
  const onlyRefs = run(HYGIENE, ['--issues', save(AP), '--refs', save(['dev/3393-write-guards'])])
  assert.equal(onlyRefs.status, 2, 'a live branch is not an open PR')
  assert.doesNotMatch(onlyRefs.stdout + onlyRefs.stderr, /--refs/, 'it already was given')
  assert.match(onlyRefs.stderr, /pass --prs/, 'name the one fact that is missing')
  const onlyPrs = run(HYGIENE, ['--issues', save(AP), '--prs', prsFile])
  assert.equal(onlyPrs.status, 2)
  assert.match(onlyPrs.stderr, /pass --refs/, 'the branch list is what is missing here')
  assert.doesNotMatch(onlyPrs.stdout, /--prs/, 'the row must not ask for what it was given')
  const both = run(HYGIENE, ['--issues', save(AP), '--refs', save(['dev/3393-write-guards']), '--prs', prsFile])
  assert.equal(both.status, 2)
  assert.doesNotMatch(both.stdout + both.stderr, /--(prs|refs)/, 'nothing is missing, so no flag is named')
})

test('input errors exit 3, never 1, and print one line instead of a stack', () => {
  const cases = [run(HYGIENE, ['--issues', join(dir, 'missing.json')]),
    run(HYGIENE, ['--issues', save('{not json')]),
    run(GUARD, ['--replay', join(dir, 'missing.json')])]
  for (const r of cases) {
    assert.equal(r.status, 3, `exit 3, got ${r.status}: ${r.stderr.trim()}`)
    assert.equal(r.stderr.trim().split('\n').length, 1, 'one line, no stack')
  }
  assert.equal(run(HYGIENE, []).status, 3, 'no arguments is a usage error, not a finding')
  assert.equal(run(GUARD, []).status, 3)
})
