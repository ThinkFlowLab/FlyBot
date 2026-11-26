// Would this comment be posted twice? GitHub cannot tell us: the same text arrives with and without
// our marker. So compare the text itself, within one object. Writes nothing.
import { readFileSync } from 'node:fs'
import { norm, similar } from './comment-text.mjs'

export const FUZZY_THRESHOLD = 0.8
const MARKER = /<!--\s*flybot:([\w:.-]+)\s*-->/i
const marked = (text) => String(text ?? '').match(MARKER)?.[1] ?? null

// Foreign markers are not evidence of our own template, so they do not buy a discount: still a dup.
export function classify(comments, text) {
  const mine = norm(text)
  const id = marked(text)
  const kept = (comments ?? []).filter((c) => !c.isMinimized)
  const exact = kept.filter((c) => norm(c.body) === mine)
  const same = id ? exact.find((c) => marked(c.body) === id) : null
  if (same) return { duplicate: true, id: same.id, score: 1, why: `this exact comment (${id}) is already there` }
  if (exact.length) return { duplicate: true, id: exact[0].id, score: 1, why: 'the same text is already there, without our marker' }
  const near = kept.map((c) => ({ ...c, score: similar(mine, norm(c.body)) }))
    .filter((c) => c.score >= FUZZY_THRESHOLD).sort((a, b) => b.score - a.score)[0]
  if (near) return { duplicate: true, id: near.id, score: near.score, why: `${near.score.toFixed(3)} like comment ${near.id} (marker differs or missing)` }
  return { duplicate: false, score: exact[0]?.score ?? 0, why: 'no comment on this object is close' }
}

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

export function main() {
  const replay = arg('--replay')
  const checkOnly = arg('--check-only')
  const text = arg('--text')
  if (!replay && !text) {
    console.error('dry run by default, nothing is written. Usage: comment-guard.mjs --replay <saved comments, with.expected> | --text <file> [--comments <saved comments>] [--check-only]')
    return 3
  }
  const load = (p) => JSON.parse(readFileSync(p, 'utf8'))
  if (replay && replay !== true) return report(load(replay), { checkOnly })
  const comments = load(arg('--comments'))
  const body = readFileSync(text === true ? process.argv[process.argv.indexOf('--text') + 1] : text, 'utf8')
  const verdict = classify(comments, body)
  console.log(verdict.duplicate
    ? `BLOCK  ${verdict.why}; a real post would be skipped`
    : `POST   ${verdict.why}`)
  return verdict.duplicate && !checkOnly ? 1 : 0
}

// The replay says what SHOULD happen to each sample, so it can fail rather than describe.
// --check-only exits 0/3/4: somebody reviews the close ones instead of a gate guessing.
function report(objects, { checkOnly }) {
  let post = 0, skip = 0, review = 0, missed = 0, falsePositive = 0
  for (const o of objects ?? []) {
    const v = classify(o.comments, o.text)
    const want = o.expected
    const got = !v.duplicate ? 'post' : v.score >= 0.999 ? 'skip' : 'review'
    if (got === 'post') post += 1
    else if (got === 'skip') skip += 1
    else review += 1
    if (want === 'post' && v.duplicate) { falsePositive += 1; console.log(`FALSE POSITIVE #${o.object} ${v.why}: would block a new comment`) }
    if (want !== 'post' && !v.duplicate) { missed += 1; console.log(`MISSED  #${o.object} ${o.text.slice(0, 40)}...: would post a duplicate`) }
    else if (v.duplicate) console.log(`${want === 'post' ? 'REVIEW ' : 'DUP    '} #${String(o.object).padEnd(6)} ${v.why}`)
  }
  const tagged = (objects ?? []).filter((o) => o.text.includes('<!-- flybot:')).length
  console.log(`\nReplayed ${objects.length} objects; ${skip} skipped as exact duplicates; ${review} near-duplicates to review; ${missed} missed; ${falsePositive} false positive`)
  console.log(`${tagged} of ${objects.length} carried a marker: marking alone would have caught ${objects.length - tagged}`)
  if (checkOnly) { console.log(`${post} would post / ${skip} already there / ${review} for a human`); return post ? 3 : review ? 4 : 0 }
  // 0 means no new comment was lost to a near-match; the close ones are printed for a human.
  return falsePositive ? 1 : 0
}

// `exit 1` means "do not post", so it must never be an unreadable file: input errors are 3.
if (process.argv[1] && process.argv[1].endsWith('comment-guard.mjs')) {
  try {
    const code = main()
    if (code != null) process.exit(code)
  } catch (e) {
    console.error(`comment-guard: input error: ${e.code === 'ENOENT' ? `no such file: ${e.path}` : e.message}`)
    process.exit(3)
  }
}
