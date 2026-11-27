// The human-readable half of the merge decision (issue #3407): one screen for a person, ending with
// the paste-ready merge record. Pure text: no network, no files, no writes.
//
// The layout is fixed on purpose - verdict first, then the four gates, then the advisory tier, then
// what blocks or qualifies the verdict. The tier line always says it decides nothing, so a reader
// cannot mistake it for the reason.
import { VERDICT } from './merge-decision-input.mjs'

const bullet = (text) => `  - ${text}`

export function render(result) {
  const pr = result.pr ? ` (PR #${result.pr})` : ''
  const head = result.head ? String(result.head) : '(no head)'
  const lines = []

  if (result.verdict === VERDICT.invalid) {
    lines.push(`INVALID INPUT${pr}: no verdict was produced, nothing is being merged (exit ${result.code}).`)
    lines.push('', 'This input does not describe one head with its four gate results:')
    for (const blocker of result.blockers) lines.push(bullet(blocker))
    return lines.join('\n')
  }

  if (result.verdict === VERDICT.merge) {
    lines.push(`RECOMMEND MERGE ${head}${pr} - exit ${result.code}. The FlyBot Lead decides; this is advice.`)
  } else {
    lines.push(`DO NOT MERGE ${head}${pr} - exit ${result.code}.`)
  }

  lines.push('', 'Gates (1-3 are the evidence, 4 is the record):')
  for (const gate of result.gates) lines.push(`  ${gate.pass ? 'pass' : 'FAIL'}  ${gate.n}. ${gate.name}`)

  if (result.tier) {
    lines.push(`Tier risk:${result.tier} - advisory only: printed here, decides nothing.`)
  } else {
    lines.push('Tier - not stated; advisory anyway, it decides nothing.')
  }

  if (result.blockers.length > 0) {
    lines.push('', 'Blockers:')
    for (const blocker of result.blockers) lines.push(bullet(blocker))
  }
  if (result.caveats.length > 0) {
    lines.push('', 'Caveats (they qualify the verdict, they do not reverse it):')
    for (const caveat of result.caveats) lines.push(bullet(caveat))
  }

  if (result.verdict === VERDICT.hold) {
    lines.push('', `Not claimed: that ${head} is mergeable; it stays open until the blockers are answered.`)
    return lines.join('\n')
  }

  lines.push('', 'Merge record (paste into the PR or the merge commit):')
  lines.push(result.record.replace(/^/gm, '  '))
  return lines.join('\n')
}
