// The `pass` label (#739): a verdict that let a pull request in leaves a visible mark, mechanically.
// The parser is the one the gates already use, so these cases pin the three rules that decide it —
// who may write a conclusion, what a correction is, and that the label is only ever added.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PASS_LABEL, STRANGER_MARK, historyFrom, namesHead, planBackfill, planComment, planCommentRun, planStrangerComment, verdictOf } from './pass-label.mjs'
import { loadPolicy } from './review-gate.mjs'

const repo = join(import.meta.dirname, '..', '..')
const writers = loadPolicy(join(repo, '.github/agent/review-policy.json')).writers
const head = 'df5d6f7e2b1c4f7a9e0d3c5b8a1f2e4d6c8b0a13'

const conclusion = (verdict = 'PASS', sha = head, writer = 'Reviewer') => `Verdict: ${verdict} at ${sha}
Written-by: ${writer}

## What I ran
- \`cd core && npm test\` → 1239/1239

## Risk
T1.`

test('#739: a PASS at the tip labels the pull request', () => {
  const plan = planComment({ pr: 7, body: conclusion(), association: 'MEMBER', writers })
  assert.equal(plan.add, true)
  assert.equal(plan.tip, head)
})

test('#739: an INC, a correction, a non-member and an unknown writer never label', () => {
  assert.equal(verdictOf(conclusion('INC'), { writers, association: 'MEMBER' }), null)
  const correction = `Correction from Reviewer: the PASS at ${head} listed no command it ran.

Verdict: PASS at ${head}
Written-by: Reviewer`
  assert.equal(verdictOf(correction, { writers, association: 'MEMBER' }), null, 'a correction is text about a conclusion')
  assert.equal(verdictOf(conclusion(), { writers, association: 'NONE' }), null, 'a passer-by is not a conclusion')
  assert.equal(verdictOf(conclusion('PASS', head, 'Stranger'), { writers, association: 'MEMBER' }), null, 'the name must be in writers')
})

test('#739: a replacement PASS labels like a normal PASS, and a second run adds nothing', () => {
  const replacement = `Verdict: PASS at ${head}
Written-by: Reviewer
Replaces: the PASS at ${head} merge-gate rejected for having no Ran: line

## What I ran
- \`node --test test/follow-through.test.js\` → 14/14`
  assert.ok(verdictOf(replacement, { writers, association: 'OWNER' }))
  const already = planComment({ pr: 7, body: conclusion(), association: 'MEMBER', writers, labels: [{ name: PASS_LABEL }, { name: 'agent-pr' }] })
  assert.equal(already.add, false)
  assert.match(already.reason, /already labelled/)
})

test('#739: backfill labels a merged pull request whose head carried a PASS, and nothing else', () => {
  const pulls = [
    { number: 11, title: 'merged on a PASS', merged_at: '2026-10-22T10:00:00Z', head: { sha: head }, labels: [{ name: 'agent-pr' }] },
    { number: 12, title: 'merged on an INC', merged_at: '2026-10-22T10:05:00Z', head: { sha: head }, labels: [] },
    { number: 13, title: 'already labelled', merged_at: '2026-10-22T10:10:00Z', head: { sha: head }, labels: [{ name: PASS_LABEL }] },
    { number: 14, title: 'still open', merged_at: null, head: { sha: head }, labels: [] },
    // A PASS about some other tip is not a PASS about the head that merged.
    { number: 15, title: 'PASS at another tip', merged_at: '2026-10-22T10:20:00Z', head: { sha: head }, labels: [] },
  ]
  const history = {
    11: historyFrom({ comments: [{ body: conclusion(), author_association: 'MEMBER', created_at: '2026-10-22T09:00:00Z' }] }),
    12: historyFrom({ comments: [{ body: conclusion('INC'), author_association: 'MEMBER', created_at: '2026-10-22T09:00:00Z' }] }),
    13: historyFrom({ comments: [{ body: conclusion(), author_association: 'MEMBER', created_at: '2026-10-22T09:00:00Z' }] }),
    14: historyFrom({ comments: [{ body: conclusion(), author_association: 'MEMBER', created_at: '2026-10-22T09:00:00Z' }] }),
    15: historyFrom({ comments: [{ body: conclusion('PASS', 'aaaaaaaaaaaa'), author_association: 'MEMBER', created_at: '2026-10-22T09:00:00Z' }] }),
  }
  const items = planBackfill({ pulls, historyOf: (n) => history[n], writers })
  assert.deepEqual(items.map((item) => item.number), [11])
  // Second run: the label added by the first run is what the API now reports, so nothing is planned.
  const after = planBackfill({ pulls: pulls.map((p) => (p.number === 11 ? { ...p, labels: [{ name: PASS_LABEL }] } : p)), historyOf: (n) => history[n], writers })
  assert.deepEqual(after, [])
})

test('#739: a review body counts like a comment, and the label is a closed record', () => {
  const history = historyFrom({ reviews: [{ body: conclusion(), author_association: 'COLLABORATOR', submitted_at: '2026-10-22T09:30:00Z' }] })
  assert.equal(history.length, 1)
  assert.ok(verdictOf(history[0].body, { writers, association: history[0].association }))
  // No path removes the label: only `add` lines exist in the script.
  const source = readFileSync(join(repo, '.github/scripts/pass-label.mjs'), 'utf8')
  assert.doesNotMatch(source, /-X\s+'?\s*DELETE|method:\s*'DELETE'/)
})

test('#739: a 12-character tip names the head, a different one does not', () => {
  assert.equal(namesHead(head.slice(0, 12), head), true)
  assert.equal(namesHead(head, head.slice(0, 12)), true)
  assert.equal(namesHead('aaaaaaaaaaaa', head), false)
  assert.equal(namesHead(null, head), false)
})

// #767: the gates refuse a PASS whose `Written-by:` names someone the policy does not list, and the one
// place that already knew the answer said it in a log line. Now the author is told, once per tip.
const stranger = (writer = 'Reviewer3') => conclusion('PASS', head, writer)

test('#767: a PASS from someone outside writers leaves one note naming the author, the tip and the file', () => {
  const plan = planStrangerComment({ pr: 7, body: stranger(), association: 'MEMBER', writers })
  assert.equal(plan.add, true)
  assert.equal(plan.writer, 'Reviewer3')
  assert.equal(plan.tip, head)
  assert.ok(plan.body.startsWith(`${STRANGER_MARK} tip:${head}`), 'the marker carries the tip')
  assert.match(plan.body, /Written-by: Reviewer3/)
  assert.match(plan.body, /\.github\/agent\/review-policy\.json/, 'names the file to edit')
  assert.match(plan.body, /`writers`/, 'names the key to edit')
  // The label path is unchanged: no label for this comment, ever.
  assert.equal(planComment({ pr: 7, body: stranger(), association: 'MEMBER', writers }).add, false)
})

test('#767: the note is idempotent per tip, and a moved tip may speak once', () => {
  const first = planStrangerComment({ pr: 7, body: stranger(), association: 'MEMBER', writers })
  const again = planStrangerComment({ pr: 7, body: stranger(), association: 'MEMBER', writers, comments: [{ body: first.body }] })
  assert.equal(again.add, false)
  assert.match(again.reason, /already noted/)
  const moved = 'f'.repeat(40)
  const next = planStrangerComment({ pr: 7, body: conclusion('PASS', moved, 'Reviewer3'), association: 'MEMBER', writers, comments: [{ body: first.body }] })
  assert.equal(next.add, true, 'a note about another tip is not this tip')
  assert.equal(next.tip, moved)
})

test('#767: everything that is not a stranger PASS stays silent', () => {
  const plan = (body, extra = {}) => planStrangerComment({ pr: 7, body, association: 'MEMBER', writers, ...extra })
  assert.equal(plan(conclusion()).add, false, 'a listed writer labels, and is not told anything')
  assert.equal(plan(conclusion('INC', head, 'Reviewer3')).add, false, 'an INC is not the case, whoever writes it')
  assert.equal(plan(conclusion('PASS', head, 'Reviewer3'), { association: 'NONE' }).add, false, 'a passer-by is not a conclusion')
  assert.equal(plan(`Written-by: Reviewer3\n\nWhat I ran: nothing.`).add, false, 'no verdict line, nothing to say')
  assert.equal(plan(`Verdict: PASS at ${head}`).add, false, 'a PASS with no Written-by names no one to tell')
  assert.equal(plan(`Correction from Reviewer: the PASS at ${head} was written by Reviewer3.`).add, false, 'a correction is not a conclusion')
})

test('#767: one run picks the label, the note, or silence — and never both', () => {
  const run = (body, extra = {}) => planCommentRun({ pr: 7, body, association: 'MEMBER', writers, ...extra })
  const labelled = run(conclusion())
  assert.equal(labelled.write, 'label', 'a listed writer still just labels')
  const noted = run(stranger())
  assert.equal(noted.write, 'comment')
  assert.equal(noted.writer, 'Reviewer3')
  assert.ok(noted.body.startsWith(`${STRANGER_MARK} tip:${head}`))
  assert.equal(noted.labelled, undefined, 'the note path never labels')
  const again = run(stranger(), { comments: () => [{ body: noted.body }] })
  assert.equal(again.write, 'none', 'a second run on the same tip writes nothing')
  const silent = run(conclusion('INC', head, 'Reviewer3'))
  assert.equal(silent.write, 'none')
  // The thread is read only when a stranger's PASS is really on the table.
  let reads = 0
  run(conclusion(), { comments: () => { reads += 1; return [] } })
  assert.equal(reads, 0, 'a plain PASS does not read the thread')
  run(stranger(), { comments: () => { reads += 1; return [] } })
  assert.equal(reads, 1)
})

test('#767: one note per commit, whether the tip is written 12 characters or 40', () => {
  const long = 'a'.repeat(40)
  assert.equal(long.length, 40)
  const short = long.slice(0, 12)
  const first = planStrangerComment({ pr: 7, body: conclusion('PASS', short, 'Reviewer3'), association: 'MEMBER', writers })
  assert.equal(first.add, true)
  const again = planStrangerComment({ pr: 7, body: conclusion('PASS', long, 'Reviewer3'), association: 'MEMBER', writers, comments: [{ body: first.body }] })
  assert.equal(again.add, false, 'the same commit named two ways is one note')
  const other = 'b'.repeat(40)
  const next = planStrangerComment({ pr: 7, body: conclusion('PASS', other, 'Reviewer3'), association: 'MEMBER', writers, comments: [{ body: first.body }] })
  assert.equal(next.add, true, 'a different commit may speak once')
})
