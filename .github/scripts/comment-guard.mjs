// Comment guard: decide, before posting, whether this object already carries this event.
// Report only: there is no code path here that writes to the repository.
import { readFileSync } from 'node:fs'
import { FUZZY_THRESHOLD, markersIn, bodyKey, similarity, auditComments } from './comment-text.mjs'

export * from './comment-text.mjs'

// The answer the poster needs: skip (already said), review (too close to call), or post.
export function guard(comments, event, draft = null, { threshold = FUZZY_THRESHOLD } = {}) {
  const list = comments ?? []
  const marked = list.filter((c) => markersIn(c.body).includes(event))
  if (marked.length) return { status: 'skip', reason: `marker ${event} already on comment ${marked[0].id}` }
  if (draft !== null) {
    const key = bodyKey(draft)
    const same = list.find((c) => bodyKey(c.body) === key)
    if (same) return { status: 'skip', reason: `the same text is already on comment ${same.id}, written without a marker` }
    const near = list.map((c) => ({ id: c.id, score: similarity(c.body, draft) })).sort((a, b) => b.score - a.score)[0]
    if (near && near.score >= threshold) return { status: 'review', reason: `comment ${near.id} is ${near.score.toFixed(3)} similar; a human decides, the guard does not post` }
  }
  return { status: 'post', reason: `no marker ${event} and no matching text yet` }
}

// A1 on the replay fixture: for every object the second write must not come back as `post`.
export function replayGuard(fixture, { threshold = FUZZY_THRESHOLD } = {}) {
  return (fixture.objects ?? []).map((o) => {
    const [first, ...rest] = o.comments ?? []
    const second = rest[0] ?? null
    const verdict = second
      ? guard([first], o.event_key, second.body, { threshold })
      : { status: 'n/a', reason: 'a single comment, so there is no second write to stop' }
    return { number: o.number, duplicate_class: o.duplicate_class ?? null, event_key: o.event_key, second_comment_id: second?.id ?? null, status: verdict.status, reason: verdict.reason }
  })
}

// One line per object, the shape the replay fixture is compared against.
export function verdicts(fixture, { threshold = FUZZY_THRESHOLD } = {}) {
  const rows = [...(fixture.objects ?? []), ...(fixture.negatives ?? [])]
  return rows.map((o) => {
    const a = auditComments(o.comments, { threshold })
    return { number: o.number, event_key: o.event_key ?? null, duplicate: a.duplicate, first_comment_id: a.first_comment_id, duplicate_comment_ids: a.duplicate_comment_ids }
  })
}

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

function main() {
  const replay = arg('--replay')
  const replayGuardFile = arg('--replay-guard')
  const commentsFile = arg('--comments')
  const object = arg('--object')
  const event = arg('--event', 'close-stale')
  const json = process.argv.includes('--json')
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

  if (replay) {
    const fixture = read(replay)
    const rows = verdicts(fixture)
    const expected = [...(fixture.objects ?? []), ...(fixture.negatives ?? [])]
    let missed = 0
    let falsePositive = 0
    rows.forEach((r, i) => {
      const want = expected[i].expected === 'duplicate'
      if (want && !r.duplicate) missed++
      if (!want && r.duplicate) falsePositive++
      if (!json) console.log(`${String(r.number).padEnd(6)} ${r.duplicate ? 'duplicate' : 'unique   '} ${r.duplicate ? `first ${r.first_comment_id}, dup ${r.duplicate_comment_ids.join(',')}` : ''}`)
    })
    if (!json) console.log(`\nReplayed ${rows.length} objects; ${rows.filter((r) => r.duplicate).length} flagged as duplicates; ${missed} missed (a duplicate stays, a comment is only written twice); ${falsePositive} false positive (blocks a real comment).`)
    if (json) console.log(JSON.stringify(rows, null, 2))
    process.exit(falsePositive ? 1 : 0)
  }

  if (replayGuardFile) {
    const rows = replayGuard(read(replayGuardFile))
    // A and B are text-detectable by construction; C is the documented limit and may still post.
    const posted = rows.filter((r) => r.status === 'post' && /^[AB]/.test(r.duplicate_class ?? ''))
    if (json) console.log(JSON.stringify(rows, null, 2))
    else {
      for (const r of rows) console.log(`${String(r.number).padEnd(6)} ${r.status.padEnd(7)} ${r.reason}`)
      console.log(`\nReplayed ${rows.length} objects; ${rows.filter((r) => r.status === 'skip').length} skipped as already said, ${rows.filter((r) => r.status === 'review').length} sent to review, ${rows.filter((r) => r.status === 'post').length} would post (of which ${posted.length} are text-detectable and must not).`)
    }
    process.exit(posted.length ? 1 : 0)
  }

  if (commentsFile) {
    const comments = read(commentsFile)
    const draftFile = arg('--draft')
    const draft = draftFile ? readFileSync(draftFile, 'utf8') : null
    const result = guard(comments, event, draft)
    const audit = auditComments(comments)
    if (json) console.log(JSON.stringify({ ...result, audit }, null, 2))
    else console.log(`object ${object ?? '?'} event ${event}: ${result.status} (${result.reason}); ${audit.duplicate_comment_ids.length} pre-existing duplicate(s)`)
    // --check-only: exit status only, 0 = post, 3 = already said it, 4 = needs a human.
    if (process.argv.includes('--check-only')) process.exit(result.status === 'skip' ? 3 : result.status === 'review' ? 4 : 0)
    process.exit(0)
  }

  console.error('report only, nothing is written. Usage:')
  console.error('  node .github/scripts/comment-guard.mjs --replay <fixture.json> [--json]')
  console.error('  node .github/scripts/comment-guard.mjs --replay-guard <fixture.json> [--json]')
  console.error('  node .github/scripts/comment-guard.mjs --comments <comments.json> --event <key> [--draft <body.txt>] [--object <n>] [--check-only]')
  process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('comment-guard.mjs')) main()
