// The one reader of a `merge_group` queue ref (#2671): `merge-gate.mjs` and `policy-sign.mjs` both
// decide what to do from the same `merge_group.head_ref`, so they must agree on which pull request it
// names. Two parsers drifted apart — one accepted a base branch with slashes, the other did not, and
// the one that did not put its refusal where it read "nothing to sign" — and the gate that saw no
// pull request passed the entry while the other judged it. The function lives here so there is one
// answer to import.
//
// A `merge_group` event carries no pull request, no labels and no reviews. The only pointer to them
// is `merge_group.head_ref`, the queue branch the entry was built on:
// `gh-readonly-queue/<base>/pr-<N>-<sha>`, where <sha> is the BASE the entry was built on — the tip of
// <base> (or of the entry ahead of it) — not the pull request head. Run 39701316520 (#654) carried
// `pr-654-d105f222…`: d105f22 was main's tip (#640's merge), the pull request head was ad0c4716… and
// the entry's own commit (GITHUB_SHA, `merge_group.head_sha`) was ee1739ef…. Reading that sha as the
// head refused every entry: "the head moved" to its real head, and "no Verifier report names" the base.
// So the sha is returned as `base`, and the head is judged the way the `pull_request` run judges it:
// the pull request's own head sha, read live from the API.
//
// It arrives fully qualified: every real queue entry so far passed `refs/heads/gh-readonly-queue/...`
// (runs 39602546475, 39602806953, 39653640861, 39694988559, 39696278650 — all five failed with
// "cannot read a pull request from head_ref" before this prefix was accepted, so the gate never once
// judged a queue entry). Accept both spellings rather than depend on which one the event carries.
//
// The base branch is not a single segment: by the queue naming rule
// `gh-readonly-queue/<base>/pr-<N>-<sha>`, a queue built on `release/1.0` yields
// `gh-readonly-queue/release/1.0/pr-<N>-<sha>` (no such run in this repo yet), so the base
// is matched greedily up to the final `/pr-…` and may contain slashes. Everything that made the old
// single-segment pattern refuse still refuses: a non-`gh-readonly-queue/` ref, a missing or
// non-numeric PR number, and a tail that is not 7–40 hex characters.
export function prFromHeadRef(ref) {
  const branch = String(ref ?? '').trim().replace(/^refs\/heads\//i, '')
  const m = /^gh-readonly-queue\/(.+)\/pr-(\d+)-([0-9a-f]{7,40})$/i.exec(branch)
  return m ? { pr: Number(m[2]), base: m[3].toLowerCase() } : null
}
