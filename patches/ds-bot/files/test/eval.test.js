import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hashes, unchanged } from '../dev/eval/guard.mjs'
import { grade, judgePrompt, parseVerdict } from '../dev/eval/judge.mjs'
import { check } from '../dev/eval/rubric.mjs'
import { SPECS, specById } from '../dev/eval/specs.mjs'
import { run } from '../dev/eval/run.mjs'

test('check: must, mustNot and order, with a string as a case-insensitive substring', () => {
  assert.deepEqual(check('Chief asked Travel and Food, then wrote the plan', {
    must: ['chief', /travel/i], mustNot: [/error/i], order: [['Chief', 'plan']],
  }), { pass: true, failures: [] })
  const bad = check('An error happened', { must: ['travel'], mustNot: [/error/i], order: [['zzz', 'qqq']] })
  assert.equal(bad.pass, false)
  assert.deepEqual(bad.failures, ['missing: travel', 'forbidden: /error/i', 'missing: zzz'])
  assert.deepEqual(check('', {}), { pass: true, failures: [] })
})

test('specs are well formed and lookable up', () => {
  assert.ok(SPECS.length >= 4)
  for (const spec of SPECS) assert.ok(spec.id && spec.title && spec.journey && spec.rubric)
  assert.equal(specById('P3-tree-split').journey, 'P3')
  assert.equal(specById('nope'), null)
})

test('run scores a text against a spec and records the grader hash', () => {
  const result = run({ spec: specById('P3-tree-split'), text: 'Chief: Travel booked, Food planned. Final plan below.' })
  assert.equal(result.pass, true)
  assert.equal(result.spec.id, 'P3-tree-split')
  assert.match(result.specHash[Object.keys(result.specHash)[0]], /^[0-9a-f]{64}$/)
})

test('parseVerdict reads a judge answer and rejects a malformed one', () => {
  assert.deepEqual(parseVerdict('{"pass": true, "reasons": ["ok", 3]}'), { pass: true, reasons: ['ok'] })
  assert.deepEqual(parseVerdict('nonsense {"pass": false, "reasons": []} tail'), { pass: false, reasons: [] })
  assert.equal(parseVerdict('no json here'), undefined)
  assert.equal(parseVerdict('{"reasons": []}'), undefined)
})

test('grade: the deterministic check gates; the judge can only tighten', async () => {
  const spec = specById('P3-tree-split')
  const good = 'Chief delegated to Travel, Food and Budget. Final plan: day 1 travel.'
  assert.equal((await grade(spec, good)).pass, true)
  // A judge that fails turns a deterministic pass into a fail.
  const judged = await grade(spec, good, { ask: async () => ({ text: '{"pass": false, "reasons": ["no combine"]}' }) })
  assert.equal(judged.pass, false)
  assert.deepEqual(judged.judged, { pass: false, reasons: ['no combine'] })
  // A failing deterministic check is never rescued by a passing judge.
  const rescued = await grade(spec, 'error', { ask: async () => ({ text: '{"pass": true}' }) })
  assert.equal(rescued.pass, false)
})

test('judgePrompt names the journey and the checklist', () => {
  const prompt = judgePrompt(specById('P3-tree-split'), 'a run')
  assert.match(prompt.system, /JSON/)
  assert.match(prompt.prompt, /P3-tree-split|Tree/)
  assert.match(prompt.prompt, /must show/)
})

test('guard: a touched grader file is not unchanged', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-eval-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'rubric.txt')
  writeFileSync(file, 'v1')
  const before = hashes([file])
  assert.deepEqual(unchanged(before, hashes([file])), { ok: true, changed: [] })
  writeFileSync(file, 'v2')
  assert.deepEqual(unchanged(before, hashes([file])).ok, false)
})
