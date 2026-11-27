// The paste-ready merge record (issue #3407): the head, the reason, the caveats, and what is not
// claimed. It is the text a Lead can paste into the PR or the merge commit, so it carries the head
// that was decided and the tier as advisory only. Pure: no network, no files, no writes.
import { VERDICT } from './merge-decision-input.mjs'

export function mergeRecord(result, note) {
  const pr = result.pr ? ` (PR #${result.pr})` : ''
  const tier = result.tier ? `risk:${result.tier}` : 'not stated'
  if (result.verdict === VERDICT.merge) {
    const why = 'the four merge-gate gates pass on this head: open and mergeable on main, every required check and the rollup completed success, QA evidence and the Lead review both name this head, and exactly one script-applied risk label'
    const out = [`Merging ${result.head}${pr}.`, `Reason: ${why}. Tier ${tier} is advisory and did not decide this.`]
    if (result.flakes.length === 0 && result.coverage && result.coverage.missing.length === 0) {
      out.push(`Required checks: ${result.coverage.required}/${result.coverage.required} read, one success each on this head (clean green).`)
    }
    for (const caveat of result.caveats) out.push(`Caveat: ${caveat}`)
    if (note) out.push(`Note: ${note}`)
    out.push('Not claimed: parity or product acceptance; local green and CI green are reported separately.')
    return out.join('\n')
  }
  const out = [`Not merging ${result.head}${pr}.`, `Reason: ${result.blockers.join(' | ')}`]
  if (result.tier) out.push(`Tier ${tier} is advisory: it is not why this is on hold.`)
  return out.join('\n')
}
