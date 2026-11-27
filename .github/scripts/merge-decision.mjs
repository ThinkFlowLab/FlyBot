// Should this head be merged? (issue #3407)
//
//   node .github/scripts/merge-decision.mjs --in decision.json      # read one input file, print the decision
//   cat decision.json | node .github/scripts/merge-decision.mjs     # the same, from stdin
//   node .github/scripts/merge-decision.mjs --in decision.json --json   # the same result, as data
//   node .github/scripts/merge-decision.mjs --self-test             # no network: the ten cases below
//
// Input: one head plus the four merge-gate results, and the run history of the checks on that head
// (see merge-decision-core.mjs for the shape; `gate` is merge-gate.mjs --json). Output:
//
//   exit 0  RECOMMEND MERGE - the four gates pass; caveats (a flake, partial coverage) are listed
//   exit 1  DO NOT MERGE    - a gate failed, or the run history contradicts a gate-2 success
//   exit 2  INVALID INPUT   - the input does not describe one head and its four gate results
//
// The tier is printed as an advisory line and never decides anything: since 2026-11-26 the merge is
// the FlyBot Lead's call. The script never writes: it does not merge, label, comment or push. It also
// does not call the API - the caller supplies the gate result and the run history, so the decision is
// reproducible from the record alone.
//
// This file is the CLI only; the decision itself is pure and lives in merge-decision-core.mjs, the
// fixtures in merge-decision-self-test.mjs.
import { readFileSync } from 'node:fs'
import { decide, render, VERDICT } from './merge-decision-core.mjs'
import { selfTest } from './merge-decision-self-test.mjs'

export * from './merge-decision-core.mjs'
export { SELF_TEST_CASES, SNAPSHOT_3406 } from './merge-decision-self-test.mjs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

function readInput() {
  const path = arg('--in')
  if (path) return readFileSync(path, 'utf8')
  if (process.argv.includes('--in')) throw new Error('--in needs a file path')
  if (process.stdin.isTTY) throw new Error('pass --in <file.json>, or pipe the input on stdin')
  return readFileSync(0, 'utf8')
}

function main() {
  if (process.argv.includes('--self-test')) {
    process.exitCode = selfTest() ? 0 : 1
    return
  }
  let input
  try {
    input = JSON.parse(readInput())
  } catch (error) {
    console.error(`merge-decision: cannot read the input: ${error.message}`)
    console.error('Expected a JSON object: { head, gate, checks, tier? } - see merge-decision-core.mjs.')
    process.exitCode = 2
    return
  }
  const result = decide(input)
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : render(result))
  if (result.verdict === VERDICT.invalid) {
    console.error('merge-decision: invalid input, no verdict was produced')
  }
  process.exitCode = result.code
}

main()
