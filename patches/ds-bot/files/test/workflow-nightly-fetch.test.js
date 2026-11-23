import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// nightly.yml duplicates the steps of .github/actions/flybot-tests/action.yml instead of using the
// composite action, and a copy drifts: both jobs lost the `Fetch origin/main for arch-docs check`
// step, so a workflow_dispatch on any ref but main dies in `Lint` with
// `arch-docs: FAIL — cannot diff against origin/main` before a single test runs (#3295).
const workflow = readFileSync(new URL('../../.github/workflows/nightly.yml', import.meta.url), 'utf8')

// A job body runs from its 2-space key up to the next 2-space key (the next job) or the end of the file.
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:`)
  assert.notEqual(start, -1, `nightly.yml has a ${name} job`)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(name.length + 2).search(/\n  [a-z][a-z0-9-]*:\s*(\n|$)/)
  return next === -1 ? rest : rest.slice(0, name.length + 2 + next)
}

const FETCH = 'Fetch origin/main for arch-docs check'

// A dispatched Compatibility run on a branch is the only place a Windows-only regression can be
// measured without merging it first, so the fetch step has to be in both jobs, before `Lint`.
for (const name of ['daily', 'weekly']) {
  test(`${name} job fetches origin/main before lint (#3295)`, () => {
    const body = job(name)
    assert.ok(body.includes(FETCH), `${name}: the step copied from flybot-tests/action.yml is missing`)
    assert.ok(body.indexOf(FETCH) < body.indexOf('- name: Lint'), `${name}: the fetch step must run before Lint`)
  })
}
