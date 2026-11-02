// The live E2E preflight (#794): with no repository secret the suite cannot run, and the choice
// this pins is that the run warns and skips instead of failing every night. What must never change
// without a decision: a missing key does not fail the step, it does not claim a pass, and the run
// summary says out loud that nothing was measured.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUMMARY, WARNING, plan } from './live-e2e-preflight.mjs'

test('#794: a configured key runs the suite and says nothing', () => {
  const step = plan('sk-live-e2e-0123456789abcdef')
  assert.equal(step.output, 'key=true')
  assert.equal(step.warning, null)
  assert.equal(step.summary, null)
})

test('#794: a missing key published as an empty string skips the suite and warns', () => {
  const step = plan('')
  assert.equal(step.output, 'key=false')
  assert.match(step.warning, /^::warning /, 'a warning, never an ::error')
  assert.equal(step.warning, WARNING)
  assert.match(step.summary, /nothing to run, not because the suite passed/)
  assert.match(step.summary, /#794/)
  assert.equal(plan(undefined).output, 'key=false', 'an unset secret is the same thing')
})

test('#794: the step exits 0 without a key, writes key=false and appends the summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-e2e-preflight-'))
  const output = join(dir, 'output')
  const summary = join(dir, 'summary')
  writeFileSync(output, '')
  writeFileSync(summary, '')
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'live-e2e-preflight.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  })
  assert.equal(result.status, 0, 'a missing key must not fail the step')
  assert.doesNotMatch(result.stdout, /::error/)
  assert.match(result.stdout, /::warning title=Live E2E skipped::/)
  assert.equal(readFileSync(output, 'utf8').trim(), 'key=false')
  assert.match(readFileSync(summary, 'utf8'), new RegExp(SUMMARY[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('#794: with a key the step writes key=true and adds no warning or summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-e2e-preflight-'))
  const output = join(dir, 'output')
  const summary = join(dir, 'summary')
  writeFileSync(output, '')
  writeFileSync(summary, '')
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'live-e2e-preflight.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'sk-live-e2e-0123456789abcdef', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(readFileSync(output, 'utf8').trim(), 'key=true')
  assert.equal(readFileSync(summary, 'utf8'), '')
})

test('a key that is present but unusable skips like a missing one, and says why', () => {
  assert.equal(plan('   ').warning, WARNING, 'a blank secret is the same thing as no secret')
  for (const key of ['mock-key', 'short', 'a'.repeat(15)]) {
    const step = plan(key)
    assert.equal(step.output, 'key=false', `the preflight lets ${JSON.stringify(key)} through`)
    assert.match(step.warning, /^::warning /)
    assert.match(step.warning, /not a usable key/)
    assert.notEqual(step.warning, WARNING, 'a key someone set is a different warning from no key at all')
    assert.match(step.summary, /not a usable key/)
    assert.match(step.summary, /nothing to run, not because the suite passed/)
  }
})
