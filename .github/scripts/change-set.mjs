// #1317: the identity a conclusion was written against, so a tip that moved without changing it keeps
// the PASS.
//
// A PASS names one tip, and the gate refused every other tip (#1112) — which is right when the code
// changed and wrong when only `main` moved: #1304 was PASSed three times for one change set, once per
// `PUT /pulls/1304/update-branch`, and every PR that has to be brought up to date pays the same review.
//
// The identity is a fingerprint over `(path → blob sha)` at the pull request's changed paths, not a
// shell `git patch-id`: the scripts have `gh` and nothing else (`enqueue-guard.mjs` is `execFileSync`),
// a rebased-away tip is not reachable by ref anyway, and a patch-id of one file answers a different
// question than "is the content a reviewer judged still the content here". Comparing path by path also
// catches the case the rule must still refuse: at #1304's `d7bd1c1d` an update-branch left
// `core/package.json` at 0.2.9 while main had 0.2.10, and that blob differed.
//
// Fail closed, always. Any read that does not answer — an API error, a 404, a tree the API cut short
// (`truncated: true`), a path missing on either side, a changed-file list the caller could not read —
// is "could not be read", and a caller that could not read it refuses the tip exactly as it did before.
// This helper never decides whether a PASS counts; `review-gate.mjs`'s `decide` does, and it calls this
// only when a conclusion names a different tip (#1317 keeps one cut: `decidePull`, the `enqueue-guard`
// check and `merge-gate`'s `judge` all read its answer).
const SHORT = 12
const short = (s) => String(s ?? '').slice(0, SHORT)

// What a failed `gh` call says, in one word when the answer is "no such object" and one short line
// otherwise: the refusal has to name the read that failed, not just "an error".
function describe(error) {
  const text = String(error?.stderr ?? '') || String(error?.message ?? '')
  if (/\b404\b|not found/i.test(text)) return '404'
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? 'unknown error'
  return line.length > 120 ? line.slice(0, 119) + '…' : line
}

// The blobs of one tree, or the reason it could not be read. `recursive=1` is one call for the whole
// tree; `truncated` is the API saying it stopped early, which is not a tree to compare against.
function blobsAt({ gh, repo, sha }) {
  let answer
  try {
    answer = JSON.parse(gh('api', `repos/${repo}/git/trees/${sha}?recursive=1`))
  } catch (error) {
    return { error: `git tree of ${short(sha)}: ${describe(error)}` }
  }
  if (!answer || !Array.isArray(answer.tree)) return { error: `git tree of ${short(sha)}: the answer carries no tree` }
  if (answer.truncated) return { error: `git tree of ${short(sha)}: truncated` }
  const blobs = new Map()
  for (const entry of answer.tree) {
    if (entry && entry.type === 'blob' && typeof entry.path === 'string') blobs.set(entry.path, entry.sha)
  }
  return { blobs }
}

// `paths` is the pull request's changed-file list, read by the caller (`GET /pulls/{n}/files`, one page —
// the callers in `review-gate.mjs`, `enqueue-guard.mjs` and `merge-gate.mjs` all use `per_page=100` and
// read one page); `reviewed` and `head` are the two tips. Identical means every changed path carries the
// same blob at both — a path missing on either side is a difference, not a pass.
const FILE_PAGE = 100

export function sameChangeSet({ gh, repo, reviewed, head, paths } = {}) {
  const wanted = (paths ?? []).map((path) => String(path ?? '').trim()).filter(Boolean)
  if (!wanted.length) return { ok: false, read: 'the pull request names no changed path to compare' }
  // A list that fills the page may be cut short, and a comparison over a part of the change set is the
  // one thing this must never report as identical: file 101 could be the file that moved. Refusing here
  // costs a second review on a pull request that large, which is the answer the gate already gave.
  if (wanted.length >= FILE_PAGE) return { ok: false, read: `the changed-file list stops at ${FILE_PAGE} entries, so it may be cut short` }
  if (!gh || !repo) return { ok: false, read: 'no repository reader was given' }
  const atReviewed = blobsAt({ gh, repo, sha: reviewed })
  if (atReviewed.error) return { ok: false, read: atReviewed.error }
  const atHead = blobsAt({ gh, repo, sha: head })
  if (atHead.error) return { ok: false, read: atHead.error }
  for (const path of wanted) {
    const before = atReviewed.blobs.get(path)
    const now = atHead.blobs.get(path)
    // A path the tree does not carry on one side is not "unchanged": a file that only exists at one of
    // the two tips changes the change set. The refusal names it like any other difference.
    if (before === undefined || now === undefined) return { ok: false, path }
    if (before !== now) return { ok: false, path }
  }
  return { ok: true, paths: wanted.length }
}
