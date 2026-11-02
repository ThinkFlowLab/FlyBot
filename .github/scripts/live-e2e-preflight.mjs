#!/usr/bin/env node
// The live E2E preflight (#794). The suite cannot run without DEEPSEEK_API_KEY, and a run that is
// red every night for a reason nobody can act on teaches the team to ignore red. So a key the suite
// cannot use is a warning, not a failure: this step publishes `key=false`, the workflow skips every
// step that needs the key, and the summary says the run measured nothing. A failure inside the
// suite still fails the run, so the skip is never a pass.
//
// "Cannot use" is the suite's own reading (`dev/live-e2e/key.mjs`), not this step's: the bench and
// the run guard refuse a key under 16 characters or the mock's, and a preflight that accepted them
// let those keys through to a red bench instead of the skip.
//
// `.github/workflows/live-e2e.yml` runs it as `node .github/scripts/live-e2e-preflight.mjs`, with
// the secret mapped into DEEPSEEK_API_KEY step-scoped and nothing else in the environment.
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { keyReading } from '../../dev/live-e2e/key.mjs'

export const WARNING = '::warning title=Live E2E skipped::DEEPSEEK_API_KEY is not configured as a repository secret; the four real-model checks and the evidence bundle are skipped, so this run measured nothing'

export const SUMMARY = [
  '### Live E2E skipped: no repository secret',
  '',
  '`DEEPSEEK_API_KEY` is not configured, so no step of the suite ran and no evidence bundle was produced.',
  '',
  '**This run is green because there was nothing to run, not because the suite passed.** Add the secret in Settings → Secrets and variables → Actions to measure the suite again (#794).',
]

export const UNUSABLE_WARNING = '::warning title=Live E2E skipped::DEEPSEEK_API_KEY is set but is not a usable key (the mock\'s key, or shorter than 16 characters); the four real-model checks and the evidence bundle are skipped, so this run measured nothing'

export const UNUSABLE_SUMMARY = [
  '### Live E2E skipped: the repository secret is not a usable key',
  '',
  '`DEEPSEEK_API_KEY` is set, but the suite refuses it: the mock\'s key or fewer than 16 characters never reaches the real endpoint, so no step of the suite ran and no evidence bundle was produced.',
  '',
  '**This run is green because there was nothing to run, not because the suite passed.** Replace the secret in Settings → Secrets and variables → Actions with a real key to measure the suite again.',
]

// A secret that is not configured reaches the step as an empty string, not as a missing variable,
// so both have to mean the same thing here.
export function plan(key) {
  const { usable, reason } = keyReading(key)
  const missing = reason === 'missing'
  return {
    present: usable,
    output: `key=${usable}`,
    warning: usable ? null : (missing ? WARNING : UNUSABLE_WARNING),
    summary: usable ? null : (missing ? SUMMARY : UNUSABLE_SUMMARY).join('\n'),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const step = plan(process.env.DEEPSEEK_API_KEY)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${step.output}\n`)
  if (step.warning) console.log(step.warning)
  if (step.summary && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${step.summary}\n`)
}
