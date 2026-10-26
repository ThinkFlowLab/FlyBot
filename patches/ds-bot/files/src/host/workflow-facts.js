// What reads a fact (#1272 step 2, acceptance 10): one function per fact a guard asks about. A guard
// is a predicate over facts somebody else read, so every function here takes the answer a reader
// already got and turns it into one artifact — the fact's spec, the revision it was read at, and the
// value the node asked for. Nothing here fetches: the reader is the caller's, which is what keeps this
// module pure and what lets a test drive it with a recorded answer.
//
// The rule that matters: **no token, no answer, or an answer missing the field means `unreadable`**,
// never a guess. A fact nobody could read must refuse the node it feeds (`artifact.js` `freshness`,
// `workflow.js` `enterNode`), because "I did not manage to look" and "it is current" are not the same
// answer and only one of them may move work forward.

import { artifact } from '../shared/artifact.js'

// Every fact this module can answer, as `grep`-able names: a provider that is not here is one nobody
// wrote yet, and `workflowFact` says so rather than returning an empty artifact.
export const FACT_NAMES = Object.freeze([
  'github.labels',
  'github.checkAtSha',
  'github.verdictAtTip',
  'github.mergeable',
  'github.prBodyTip',
  'task.progress',
  'manual.tick',
])

// The answer a caller gets when the fact could not be read: `ok: false` and the reason, with no
// `input`, so a guard cannot mistake it for a fact that happened to be empty.
export function unreadable(fact, why) {
  return { fact, ok: false, reason: 'unreadable', why, input: null }
}

// A fact that was read: one artifact and the same `ok` the caller checks.
const read = (fact, input) => (input ? { fact, ok: true, reason: 'read', why: null, input } : unreadable(fact, 'the answer carried no revision'))

// GitHub reads need the token the host holds. Without it nothing was read, and a fact filled in from
// "the pull request probably has no hold label" is the one thing that would let a held card pass.
const hasToken = (token) => typeof token === 'string' && token.trim() !== ''

const labelName = (label) => (typeof label === 'string' ? label : label?.name ?? null)

// `pr` at the head the labels were read at, valued `hold` when the pull request carries that label
// and `none` otherwise. The gate's first guard is `equals: 'none'`.
export function githubLabels({ token, head, labels } = {}) {
  if (!hasToken(token)) return unreadable('github.labels', 'no GITHUB_TOKEN')
  if (!head || !Array.isArray(labels)) return unreadable('github.labels', 'the pull request labels were not read')
  const names = labels.map(labelName).filter(Boolean).map((name) => String(name).toLowerCase())
  return read('github.labels', artifact('pr', head, { value: names.includes('hold') ? 'hold' : 'none' }))
}

// `check:<name>` at the sha the check ran on, valued with its conclusion. A check that never reported
// has no sha to be at, and one that ran but has not concluded has no answer either — `conclusion: null`
// is GitHub's word for "still running", so both are unreadable rather than a check at the tip that
// failed (#1298).
export function githubCheckAtSha({ token, name, sha, conclusion } = {}) {
  if (!hasToken(token)) return unreadable('github.checkAtSha', 'no GITHUB_TOKEN')
  if (!name || !sha) return unreadable('github.checkAtSha', 'the check run was not read')
  if (typeof conclusion !== 'string' || conclusion.trim() === '') {
    return unreadable('github.checkAtSha', 'the check run reported no conclusion')
  }
  return read('github.checkAtSha', artifact(`check:${name}`, sha, { value: conclusion }))
}

// `verdict` at the tip the conclusion names, valued PASS / INC / FAIL / REQUEST_CHANGES and carrying
// the Bot that wrote it, which is what says who holds the gate.
export function githubVerdictAtTip({ token, tip, verdict, by } = {}) {
  if (!hasToken(token)) return unreadable('github.verdictAtTip', 'no GITHUB_TOKEN')
  if (!tip || !verdict) return unreadable('github.verdictAtTip', 'the newest conclusion at this tip was not read')
  return read('github.verdictAtTip', artifact('verdict', tip, { value: verdict, by: by ?? null }))
}

// `mergeable` against the tip it was computed on: `mergeable` / `conflict` / `unknown`. GitHub's own
// answer for a tip it has not computed yet is `unknown`, and `unknown` is not `mergeable`.
export function githubMergeable({ token, head, mergeable } = {}) {
  if (!hasToken(token)) return unreadable('github.mergeable', 'no GITHUB_TOKEN')
  if (!head || !mergeable) return unreadable('github.mergeable', 'the mergeable answer was not read')
  return read('github.mergeable', artifact('mergeable', head, { value: mergeable }))
}

// The `Tip SHA:` line of the pull request body, as the tip it names: this is the fact a checkpoint is
// read through, and a body with no such line is unreadable, not an empty tip.
export function githubPrBodyTip({ token, body } = {}) {
  if (!hasToken(token)) return unreadable('github.prBodyTip', 'no GITHUB_TOKEN')
  if (typeof body !== 'string') return unreadable('github.prBodyTip', 'the pull request body was not read')
  const found = /^\s*Tip SHA:\s*([0-9a-f]{7,40})\s*$/im.exec(body)
  if (!found) return unreadable('github.prBodyTip', 'the body carries no Tip SHA line')
  return read('github.prBodyTip', artifact('text:pr-body-tip', found[1], { value: found[1].toLowerCase() }))
}

// A card's own progress, 0–100, as a text fact: the revision is the number itself, so a card that has
// not moved is the same revision and a card that moved is a different one.
export function taskProgress({ card } = {}) {
  if (!card || typeof card !== 'object') return unreadable('task.progress', 'the card was not read')
  const progress = Number.isInteger(card.progress) ? card.progress : null
  if (progress === null || progress < 0 || progress > 100) return unreadable('task.progress', 'the card carries no progress between 0 and 100')
  return read('task.progress', artifact('text:card-progress', String(progress), { value: progress }))
}

// A tick a node recorded itself — the one fact nothing outside read. It still needs a revision: the
// instant the node recorded, so a tick from before the work is not the tick that says it is done.
export function manualTick({ at, by } = {}) {
  if (!at) return unreadable('manual.tick', 'the node recorded no instant')
  return read('manual.tick', artifact('text:tick', at, { value: by ?? null }))
}

export const FACT_PROVIDERS = Object.freeze({
  'github.labels': githubLabels,
  'github.checkAtSha': githubCheckAtSha,
  'github.verdictAtTip': githubVerdictAtTip,
  'github.mergeable': githubMergeable,
  'github.prBodyTip': githubPrBodyTip,
  'task.progress': taskProgress,
  'manual.tick': manualTick,
})

// One spelling for a caller that has a fact's name as data (a guard's `spec`, a provider list): a name
// nobody wrote a function for is unreadable, with the name in the reason.
export function workflowFact(name, args = {}) {
  const provider = FACT_PROVIDERS[name]
  if (!provider) return unreadable(String(name ?? ''), 'no provider answers this fact')
  return provider(args)
}
