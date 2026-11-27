import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, summaryLine } from './risk-gate.mjs'
import { gate, file, meaning, rules } from './risk-gate.fixtures.mjs'

test('judge: removed lines and prose are not content hits', () => {
  const removed = { ...file('runtime/flybot/plugins/social/src/a.js'), patch: '@@ -1 +1 @@\n-eval(x)\n+ok' }
  assert.equal(gate.judge([removed]).tier, 'T2')
  assert.equal(gate.judge([file('docs/a.md', ['+see https://evil.example.net and eval(x)'])]).tier, 'T0')
})

test('judge: allowed URL hosts are not hits; tests may quote URLs and fences', () => {
  assert.equal(gate.judge([file('runtime/flybot/plugins/social/src/a.js', ["+fetch('http://localhost:3000/x')"])]).tier, 'T2')
  assert.equal(gate.judge([file('runtime/flybot/plugins/social/src/a.js', ['+// https://github.com/ThinkFlowLab/FlyBot/issues/1'])]).tier, 'T2')
  assert.equal(gate.judge([file('runtime/flybot/plugins/social/test/a.test.js', ["+const u = 'https://evil.example.net'", '+const fence = 1'])]).tier, 'T2')
  // ...but test-only red flags still count in tests
  assert.equal(gate.judge([file('runtime/flybot/plugins/social/test/a.test.js', ["+it.skip('x', () => {})"])]).tier, 'T3')
})

test('judge: a diff that cannot be read is T3; generated files are exempt', () => {
  const noPatch = { filename: 'runtime/flybot/plugins/social/src/big.js', status: 'modified', additions: 900, deletions: 0, changes: 900 }
  assert.equal(gate.judge([noPatch]).tier, 'T3')
  const generated = { filename: 'runtime/ds-bot-upstream/ds-bot/client.js', status: 'modified', additions: 90000, deletions: 5, changes: 90005 }
  const r = gate.judge([generated, file('runtime/flybot/plugins/social/src/a.js')])
  // The bundle sits in the vendor tree, so the path rule alone makes this T3; the exemption is
  // about counting (90000 lines of generated output must not trip a size cap) and about not
  // scanning a 3.2 MB build product for red flags.
  assert.equal(r.tier, 'T3')
  assert.equal(r.lines, 1)
  assert.equal(r.generated, 1)
  assert.doesNotMatch(r.why.join('\n'), /size /)
})

test('judge: size caps use the tier reached so far', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => file(`docs/f${i}.md`, ['+x']))
  assert.equal(gate.judge(many(20)).tier, 'T0')
  assert.equal(gate.judge(many(21)).tier, 'T3')
  assert.equal(gate.judge([file('docs/a.md', Array.from({ length: 600 }, () => '+x'))]).tier, 'T0')
  assert.equal(gate.judge([file('docs/a.md', Array.from({ length: 601 }, () => '+x'))]).tier, 'T3')
  // T3 by path has no size limit of its own
  const t3 = gate.judge([file('scripts/big.mjs', Array.from({ length: 5000 }, () => '+x'))])
  assert.equal(t3.tier, 'T3')
  assert.doesNotMatch(t3.why.join('\n'), /size /)
})

test('judge: a file list that may be truncated is T3', () => {
  assert.equal(gate.judge([file('docs/a.md')], { truncated: true }).tier, 'T3')
  assert.equal(gate.judge(Array.from({ length: 3000 }, (_, i) => file(`docs/f${i}.md`))).tier, 'T3')
})

test('judge: no files is T0', () => {
  assert.equal(gate.judge([]).tier, 'T0')
})

test('render: names the tier, the reasons, and says it is report only', () => {
  const text = render(gate.judge([file('NOTICE')]), meaning)
  assert.match(text, /Risk tier: T3/)
  assert.match(text, /path NOTICE/)
  assert.match(text, /does not block, label or merge/)
  assert.match(text, /risk-rules\.json/)
})

test('render: a T2 verdict is quotable too, not only a T3 hit', () => {
  const text = render(gate.judge([file('services/bot-social/src/social.ts')]), meaning)
  assert.match(text, /Risk tier: T2/)
  assert.match(text, /services\/bot-social\/src\/social\.ts \(T2\)/)
})

test('summaryLine: one machine-readable line with the tier and the paths that set it', () => {
  const r = gate.judge([file('NOTICE'), file('services/bot-social/src/oauth.ts')])
  assert.equal(summaryLine(r), 'risk-tier: T3; basis: NOTICE=T3, services/bot-social/src/oauth.ts=T3')
})

test('summaryLine: highest tier first, and a long basis is capped', () => {
  const files = Array.from({ length: 12 }, (_, i) => file(`services/bot-social/src/p${i}.ts`))
  const line = summaryLine(gate.judge([...files, file('docs/x.md')]))
  assert.match(line, /^risk-tier: T2; basis: /)
  assert.match(line, /\+3 more$/)
})

test('summaryLine: no changed files says so instead of listing nothing', () => {
  assert.equal(summaryLine(gate.judge([])), 'risk-tier: T0; basis: none (no changed files)')
})

test('render: the machine-readable line is the last line of the report', () => {
  const r = gate.judge([file('NOTICE'), file('flybot_workspace/server.py')])
  assert.equal(render(r, meaning).trimEnd().split('\n').at(-1), summaryLine(r))
})

test('rules file is consistent', () => {
  for (const t of ['T0', 'T1', 'T2', 'T3']) assert.ok(rules.tiers[t].meaning && rules.tiers[t].paths.length, t)
  assert.ok(['T2', 'T3'].includes(rules.unknownPathTier), 'unknown paths must not default below T2')
  for (const p of [...rules.tiers.T3.diffPatterns, ...rules.tiers.T3.diffPatternsNotInTests]) new RegExp(p)
  for (const [t, lim] of Object.entries(rules.limits)) {
    assert.ok(rules.tiers[t], `limits name an existing tier: ${t}`)
    assert.ok(lim.lines > 0 && lim.files > 0, t)
  }
  assert.equal(rules.limits.T3, undefined, 'T3 is the top tier: no cap of its own')
  assert.ok(rules.limitsNote && rules.limitsNote.length > 100, 'a recomputed cap carries its reason')
})
