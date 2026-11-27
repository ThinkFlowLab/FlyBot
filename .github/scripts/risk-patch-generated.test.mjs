// A `.patch` file is lazy text: the gate judges it by its path and does not read the diff it
// carries, so a whole patch body is not 120 changed lines (issue #3393, generatedPaths).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGate, loadRules } from './risk-tier.mjs'

const gate = createGate(loadRules(new URL('../agent/risk-rules.json', import.meta.url)))
const body = (n) => '@@ -1,0 +1,' + n + ' @@\n' + Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n')

test('judge: the body of a .patch is not counted; prose next to it still is', () => {
  const patch = gate.judge([{ filename: 'patches/a.patch', status: 'added', additions: 120, deletions: 0, changes: 120, patch: body(120) }])
  assert.deepEqual([patch.tier, patch.lines, patch.generated], ['T3', 0, 1], 'patches/** is still T3 by path')
  const md = gate.judge([{ filename: 'docs/a.md', status: 'added', additions: 120, deletions: 0, changes: 120, patch: body(120) }])
  assert.deepEqual([md.tier, md.lines, md.generated], ['T0', 120, 0], 'only .patch is exempt')
})

test('judge: a .patch under runtime/flybot keeps its T2 path tier, one code line', () => {
  const r = gate.judge([
    { filename: 'runtime/flybot/patches/a.patch', status: 'modified', additions: 105, deletions: 0, changes: 105 },
    { filename: 'runtime/flybot/x.js', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1 @@\n+x' },
  ])
  assert.deepEqual([r.tier, r.lines, r.generated], ['T2', 1, 1])
})

test('judge: an unreadable diff is tolerated for a .patch, not for other files', () => {
  const bin = gate.judge([{ filename: 'patches/bin.patch', status: 'modified', additions: 0, deletions: 0, changes: 3 }])
  assert.equal(bin.tier, 'T3')
  assert.deepEqual(bin.why, ['path patches/bin.patch'], 'no "diff not inspectable" reason for a .patch')
  const js = gate.judge([{ filename: 'runtime/flybot/x.js', status: 'modified', additions: 3, deletions: 0, changes: 3 }])
  assert.ok(js.why.includes('diff not inspectable: runtime/flybot/x.js'), 'a code file without a patch still says so')
})
