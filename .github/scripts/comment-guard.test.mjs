import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classify, FUZZY_THRESHOLD } from './comment-guard.mjs'

// Spawn by absolute path: a relative cwd-dependent path fails to load from anywhere else.
const SCRIPT = fileURLToPath(new URL('./comment-guard.mjs', import.meta.url))

// The replay payload QA built from this round's real comments: 14 PR bodies + 5 UI comments,
// plus #2292 as a fourth case (two different templates 84s apart, which must NOT be merged).
const QA = process.env.FLYBOT_QA_FIXTURES ?? '/data/workspace/.qa-triage'
const fixture = `${QA}/replay/comments-replay.json`
const onThisMachine = existsSync(fixture)

// A: the same PR body, differing only in the marker line.
const A = 'Root-caused this to the tag table: the label writer never reloaded.\nRelated #3067'
const marker = (id) => `\n<!-- flybot:${id} -->`
// B: the same UI event written twice, second one fixing the sha and adding a count.
const B1 = 'Screenshot job is red on d8898ca: the settings page it waits for was deleted.'
const B2 = 'Screenshot job is red on d8898cad: the settings page it waits for was deleted (2156 blobs).'

test('the marker alone cannot decide: the twin may predate it', () => {
  const v = classify([{ id: 1, body: A }], A + marker('pr-2292:closed'))
  assert.equal(v.duplicate, true, 'unmarked first copy, marked second: the second must be blocked')
  assert.equal(v.id, 1)
  assert.equal(v.score, 1)
})

test('a comment whose text was rewritten is still the same event', () => {
  const { score } = classify([{ id: 5, body: B1 }], B2)
  assert.ok(score >= FUZZY_THRESHOLD, `B class must clear ${FUZZY_THRESHOLD}, got ${score.toFixed(3)}`)
  assert.ok(score < 1, 'and stay below an exact match, so it is reported rather than auto-skipped')
})

test('similarity is bounded: a different comment on the same object still posts', () => {
  const other = 'Different event: dropped the unused `fold_long_messages` migration from settings.'
  assert.deepEqual(classify([{ id: 9, body: B1 }], other).duplicate, false)
  assert.equal(classify([], A).duplicate, false, 'an empty history never blocks')
})

test('same text under two different markers is still a duplicate', () => {
  const v = classify([{ id: 2, body: A + marker('pr-2292:closed') }], A + marker('pr-2292:review'))
  assert.equal(v.duplicate, true)
  assert.equal(v.score, 1, 'the marker line is stripped before comparison')
})

test('a minimized comment is not a wall: the text is gone from the thread', () => {
  assert.deepEqual(classify([{ id: 3, body: A, isMinimized: true }], A), { duplicate: false, score: 0, why: 'no comment on this object is close' })
})

// #2292: two genuinely different templates 84 seconds apart. Merging them would lose information.
test('two different templates are not merged (the #2292 case)', () => {
  const a = 'Phase 2 report: label hygiene dry run over 28 open objects, one orphan, exit 2.'
  const b = 'Merged the risk table. Tier for #3112 is T3 by size, 194 files.'
  assert.equal(classify([{ id: 2292, body: a }], b).duplicate, false)
})

test('exit status: a post is 0, a block is 1, a bad input is 3', () => {
  const dir = tmpdir()
  const at = (name, data) => {
    const p = join(dir, `${name}-${process.pid}.json`)
    writeFileSync(p, JSON.stringify(data))
    return p
  }
  const history = at('cg-history', [{ id: 1, body: A }])
  const fresh = at('cg-fresh', [])
  const text = join(dir, `cg-text-${process.pid}.txt`)
  writeFileSync(text, A)
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  assert.equal(run('--text', text, '--comments', fresh).status, 0, 'nothing there yet: post')
  assert.equal(run('--text', text, '--comments', history).status, 1, 'already there: do not post')
  const missing = run('--replay', join(dir, 'cg-no-such-file.json'))
  assert.equal(missing.status, 3, 'a missing payload must not read as "do not post"')
  assert.equal(missing.stderr.trim().split('\n').length, 1, 'one line, no stack')
  assert.match(missing.stderr, /^comment-guard: input error: no such file: /)
  const bad = at('cg-bad', { not: 'a replay' })
  writeFileSync(bad, '{')
  assert.equal(run('--replay', bad).status, 3, 'unparsed payload is an input error')
  assert.equal(run().status, 3, 'no argument at all is an input error, not a clean run')
})

// Real payload. Two numbers matter: it must catch the 19 duplicates and must not block a new one.
test('replay: this round\'s 19 duplicates are caught, and #2292 is not merged',
  { skip: onThisMachine ? false : 'QA payload is not on this machine; CI covers the same cases above' }, () => {
    const raw = readFileSync(fixture)
    assert.equal(createHash('sha256').update(raw).digest('hex'),
      '5eed6b7d90ba65ebc2ea814a05a28deb210a42e67dace55080df4eb6ab347c31', 'a changed fixture voids these numbers')
    const objects = JSON.parse(raw)
    assert.equal(objects.length, 20)
    const out = spawnSync(process.execPath, [SCRIPT, '--replay', fixture], { encoding: 'utf8' })
    assert.equal(out.status, 0, 'no new comment is lost to a near-match')
    assert.match(out.stdout, /19 skipped as exact duplicates/)
    assert.match(out.stdout, /1 missed/, '#2292 is two templates, not a duplicate')
    assert.match(out.stdout, /0 false positive/)
    assert.match(out.stdout, /14 of 20 carried a marker/) // 7 PR twins arrived unmarked first
  })

// --check-only: 0 nothing to post / 3 something would post / 4 somebody must look.
test('--replay-guard: the close ones go to a human, nobody claims a pass',
  { skip: onThisMachine ? false : 'QA payload is not on this machine; CI covers the same cases above' }, () => {
    const out = spawnSync(process.execPath, [SCRIPT, '--replay', fixture, '--check-only'], { encoding: 'utf8' })
    assert.equal(out.status, 3, 'one of them would post')
    assert.match(out.stdout, /1 would post \/ 14 already there \/ 5 for a human/)
    assert.match(out.stdout, /0 are text-detectable and must not|REVIEW /)
  })
