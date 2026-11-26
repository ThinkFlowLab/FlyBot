import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  FUZZY_THRESHOLD, markerFor, markersIn, stripMarkers, bodyKey, similarity,
  auditComments, guard, replayGuard, verdicts,
} from './comment-guard.mjs'

const closeComment = (anchor, extra = '') => `基于已退役布局关闭（关闭原因，非验收结论）

- main 锚点：\`${anchor}\`（2026-11-25T12:20:16Z，2156 blobs）
- 该 PR 改动文件在 main \`${anchor}\` 上存在 0 个${extra}`

// markers
test('a marker is bookkeeping: it does not change the text fingerprint', () => {
  const body = closeComment('d8898cad')
  assert.equal(bodyKey(body), bodyKey(`${body}\n\n${markerFor('close-stale')}`))
  assert.deepEqual(markersIn(`${body}\n\n${markerFor('close-stale')}`), ['close-stale'])
  assert.deepEqual(markersIn(body), [])
  assert.equal(stripMarkers(`x <!-- flybot:a --> y`), 'x  y')
})

// A: same text, one side without a marker
test('A: two comments that differ only by the marker are one duplicate, not two opinions', () => {
  const first = { id: 1, body: closeComment('d8898cad') }
  const second = { id: 2, body: `${closeComment('d8898cad')}\n\n${markerFor('close-stale')}` }
  const audit = auditComments([first, second])
  assert.equal(audit.duplicate, true)
  assert.deepEqual(audit.duplicate_comment_ids, [2])
  assert.equal(audit.first_comment_id, 1)
})

// B: same event, rewritten by hand
test('B: the same event written twice with a reworded anchor is caught, but sent to a human', () => {
  // The two real pairs differ exactly here: `d8898ca` -> `d8898cad` and `12:20:16Z` -> `T12:20:16Z，2156 blobs`.
  const first = {
    id: 10,
    body: `基于已退役布局关闭（关闭原因，非验收结论）

- main 锚点：\`d8898ca\`（2026-11-25 12:20:16Z）
- head：\`91e93f2cce49aab0430f196f5908b01955ea2228\`，base 未固定
- 该 PR 改动文件在 main \`d8898ca\` 上存在 0 个（git cat-file 逐条核）
- 相关：FlyBot 0.3.0（2026-11-25T01:29Z）之后这一批路径已经全部不存在
- 备注：这一条是关闭原因，不是验收结论，也没有写 parity`,
  }
  const second = {
    id: 11,
    body: `基于已退役布局关闭（关闭原因，非验收结论）

- main 锚点：\`d8898cad\`（2026-11-25T12:20:16Z，2156 blobs）
- head：\`91e93f2cce49aab0430f196f5908b01955ea2228\`，base 未固定
- 该 PR 改动文件在 main \`d8898cad\` 上存在 0 个（git cat-file 逐条核）
- 相关：FlyBot 0.3.0（2026-11-25T01:29Z）之后这一批路径已经全部不存在
- 备注：这一条是关闭原因，不是验收结论，也没有写 parity`,
  }
  assert.ok(similarity(first.body, second.body) >= FUZZY_THRESHOLD, 'the sample has to be close, or this test proves nothing')
  assert.notEqual(bodyKey(first.body), bodyKey(second.body), 'and it has to differ once markers are stripped')
  assert.equal(guard([first], 'close-stale', second.body).status, 'review')
  assert.equal(auditComments([first, second]).duplicate, true)
})

// C and the negatives: never a false positive
test('C: two different templates for one event are not detectable by text, and that is reported as a miss', () => {
  const short = { id: 20, body: '这一批自动化提案随 0.3.0 退役。' }
  const long = { id: 21, body: '旧线 Chief / Attempt / SDK 评审门已经不在 main 上，这一条描述的是那套已被删除的机器，因此按历史项关闭。' }
  assert.ok(similarity(short.body, long.body) < FUZZY_THRESHOLD)
  assert.equal(auditComments([short, long]).duplicate, false)
  const fixture = { objects: [{ number: 1, event_key: 'k', duplicate_class: 'C-cross-template', comments: [short, long] }] }
  assert.equal(replayGuard(fixture)[0].status, 'post', 'a documented limit, not something the text side can fix')
})

test('negative: two comments on one object for different purposes are not a duplicate', () => {
  const review = { id: 30, body: '评审通过，两条建议写在下面。' }
  const close = { id: 31, body: closeComment('d8898cad') }
  assert.ok(similarity(review.body, close.body) < FUZZY_THRESHOLD)
  assert.equal(auditComments([review, close]).duplicate, false)
})

test('negative: a single comment is never marked, and an empty body never matches', () => {
  assert.equal(auditComments([{ id: 40, body: closeComment('d8898cad') }]).duplicate, false)
  assert.equal(auditComments([]).duplicate, false)
  assert.equal(similarity('', ''), 0)
})

// what the poster asks
test('guard: already marked, already said without a marker, or free to post', () => {
  const marked = [{ id: 1, body: `done\n\n${markerFor('close-stale')}` }]
  assert.equal(guard(marked, 'close-stale').status, 'skip')
  assert.equal(guard(marked, 'other-event', 'done').status, 'skip', 'the same words are already there, marker or not')
  assert.equal(guard([{ id: 2, body: closeComment('d8898cad') }], 'other-event').status, 'post')
  assert.equal(guard([], 'close-stale').status, 'post')
})

// The replay fixture. It sits outside the repo, so CI prints this test as skipped: the cases
// above carry the same rules there, this one holds them to QA's real payload.
const fixture = '/data/workspace/.qa-triage/replay/comments-replay.json'
test('replay (QA fixture only, skipped on CI): 19 duplicates, 6 negatives clean, 1 documented miss',
  { skip: existsSync(fixture) ? false : 'QA fixture is not on this machine; CI covers the rules above' }, () => {
    const raw = readFileSync(fixture)
    assert.equal(createHash('sha256').update(raw).digest('hex'),
      '5eed6b7d90ba65ebc2ea814a05a28deb210a42e67dace55080df4eb6ab347c31', 'a changed fixture voids these numbers')
    const data = JSON.parse(raw)
    const rows = verdicts(data)
    assert.equal(rows.length, 26)
    assert.equal(rows.filter((r) => r.duplicate).length, 19)
    assert.equal(data.negatives.filter((n, i) => rows[data.objects.length + i].duplicate).length, 0)
    const missing = data.objects.filter((o, i) => o.expected === 'duplicate' && !rows[i].duplicate)
    assert.deepEqual(missing.map((o) => [o.number, o.duplicate_class]), [[2292, 'C-cross-template']])
    const stopped = replayGuard(data).filter((r) => r.status !== 'post')
    assert.equal(stopped.length, 19, 'every one of the 19 is stopped: 14 as already said, 5 sent to review')
  })

// report only
test('the guard cannot write: no network client input, no POST, no child process', () => {
  const src = readFileSync(new URL('./comment-guard.mjs', import.meta.url), 'utf8')
    + readFileSync(new URL('./comment-text.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /child_process/)
  assert.doesNotMatch(src, /method:\s*['"]POST['"]/)
  assert.doesNotMatch(src, /octokit/)
})
