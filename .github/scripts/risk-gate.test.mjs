import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { globToRe, createGate, render, loadRules } from './risk-gate.mjs'

const rules = loadRules(new URL('../agent/risk-rules.json', import.meta.url))
const gate = createGate(rules)
const meaning = Object.fromEntries(Object.entries(rules.tiers).map(([t, d]) => [t, d.meaning]))
// A changed file as GET /pulls/{n}/files returns it.
const file = (filename, patchLines = ['+x'], extra = {}) => ({
  filename, status: 'modified', additions: patchLines.length, deletions: 0, changes: patchLines.length,
  patch: '@@ -1 +1 @@\n' + patchLines.join('\n'), ...extra,
})

test('globToRe: ** crosses directories, * does not, **/ may match zero directories', () => {
  assert.ok(globToRe('docs/**').test('docs/a/b.md'))
  assert.ok(!globToRe('docs/*').test('docs/a/b.md'))
  assert.ok(globToRe('**/package.json').test('package.json'))
  assert.ok(globToRe('**/package.json').test('core/package.json'))
  assert.ok(!globToRe('**/package.json').test('core/not-package.json'))
  assert.ok(globToRe('plugins/*/test/**').test('plugins/social/test/a.test.js'))
  assert.ok(!globToRe('plugins/*/test/**').test('plugins/a/b/test/x.js'))
  assert.ok(globToRe('core/src/host/{authz,reach}.js').test('core/src/host/reach.js'))
  assert.ok(!globToRe('core/src/host/{authz,reach}.js').test('core/src/host/reachX.js'))
  assert.ok(!globToRe('AGENTS.md').test('AGENTSxmd'), 'a dot is a literal dot')
  assert.ok(globToRe('.github/**').test('.github/workflows/x.yml'))
})

test('tierOf: highest matching tier wins; an unnamed path is T2, never T0/T1', () => {
  assert.equal(gate.tierOf('docs/architecture.md'), 'T0')
  assert.equal(gate.tierOf('docs/code-standards.md'), 'T3')
  assert.equal(gate.tierOf('core/src/client/chat.js'), 'T1')
  assert.equal(gate.tierOf('core/src/host/groups.js'), 'T2')
  assert.equal(gate.tierOf('core/src/host/authz.js'), 'T3')
  assert.equal(gate.tierOf('.github/workflows/test.yml'), 'T3')
  assert.equal(gate.tierOf('core/package.json'), 'T3')
  assert.equal(gate.tierOf('core/dev/something.mjs'), 'T2')
  assert.equal(gate.tierOf('brand-new-dir/file.txt'), 'T2')
})

test('judge: tier is the maximum over files', () => {
  assert.equal(gate.judge([file('docs/a.md'), file('README.md')]).tier, 'T0')
  assert.equal(gate.judge([file('docs/a.md'), file('core/test/a.test.js')]).tier, 'T1')
  assert.equal(gate.judge([file('core/test/a.test.js'), file('core/src/host/groups.js')]).tier, 'T2')
  assert.equal(gate.judge([file('docs/a.md'), file('AGENTS.md')]).tier, 'T3')
})

test('judge: moving a file out of a T3 path is still T3 (old path counts)', () => {
  const r = gate.judge([file('core/src/host/moved.js', ['+x'], { status: 'renamed', previous_filename: 'core/src/host/authz.js' })])
  assert.equal(r.tier, 'T3')
  assert.match(r.why.join(), /authz\.js/)
})

test('judge: content hits in added lines of code raise to T3', () => {
  const risky = {
    child_process: "+import { exec } from 'node:child_process'",
    eval: '+eval(input)',
    secret: '+const t = process.env.GITHUB_TOKEN',
    only: "+test.only('x', () => {})",
    lint: '+// oxlint-disable-next-line',
    url: "+fetch('https://evil.example.net/x')",
    fence: '+const fenced = sanitizeName(x)',
    topic: '+tools.create_child_bot()',
  }
  for (const [name, line] of Object.entries(risky)) {
    assert.equal(gate.judge([file('core/src/client/a.js', [line])]).tier, 'T3', name)
  }
})

test('judge: removed lines and prose are not content hits', () => {
  const removed = { ...file('core/src/client/a.js'), patch: '@@ -1 +1 @@\n-eval(x)\n+ok' }
  assert.equal(gate.judge([removed]).tier, 'T1')
  assert.equal(gate.judge([file('docs/a.md', ['+see https://evil.example.net and eval(x)'])]).tier, 'T0')
})

test('judge: allowed URL hosts are not hits; tests may quote URLs and fences', () => {
  assert.equal(gate.judge([file('core/src/client/a.js', ["+fetch('http://localhost:3000/x')"])]).tier, 'T1')
  assert.equal(gate.judge([file('core/src/client/a.js', ['+// https://github.com/ThinkFlowLab/FlyBot/issues/1'])]).tier, 'T1')
  assert.equal(gate.judge([file('core/test/a.test.js', ["+const u = 'https://evil.example.net'", '+const fence = 1'])]).tier, 'T1')
  // ...but test-only red flags still count in tests
  assert.equal(gate.judge([file('core/test/a.test.js', ["+it.skip('x', () => {})"])]).tier, 'T3')
})

test('judge: a diff that cannot be read is T3; generated files are exempt', () => {
  const noPatch = { filename: 'core/src/client/big.js', status: 'modified', additions: 900, deletions: 0, changes: 900 }
  assert.equal(gate.judge([noPatch]).tier, 'T3')
  const generated = { filename: 'core/client.js', status: 'modified', additions: 90000, deletions: 5, changes: 90005 }
  const r = gate.judge([generated, file('core/src/client/a.js')])
  assert.equal(r.tier, 'T1')
  assert.equal(r.lines, 1)
  assert.equal(r.generated, 1)
})

test('judge: size caps use the tier reached so far', () => {
  const many = (n, name = 'docs/a.md') => Array.from({ length: n }, (_, i) => file(`docs/f${i}.md`, ['+x']))
  assert.equal(gate.judge(many(15)).tier, 'T0')
  assert.equal(gate.judge(many(16)).tier, 'T3')
  const big = file('docs/a.md', Array.from({ length: 301 }, () => '+x'))
  assert.equal(gate.judge([big]).tier, 'T3')
  // T3 by path has no size limit of its own
  assert.equal(gate.judge([file('AGENTS.md', Array.from({ length: 900 }, () => '+x'))]).tier, 'T3')
})

test('judge: a file list that may be truncated is T3', () => {
  assert.equal(gate.judge([file('docs/a.md')], { truncated: true }).tier, 'T3')
  assert.equal(gate.judge(Array.from({ length: 3000 }, (_, i) => file(`docs/f${i}.md`))).tier, 'T3')
})

test('judge: no files is T0', () => {
  assert.equal(gate.judge([]).tier, 'T0')
})

test('render: names the tier, the reasons, and says it is report only', () => {
  const text = render(gate.judge([file('AGENTS.md')]), meaning)
  assert.match(text, /Risk tier: T3/)
  assert.match(text, /path AGENTS\.md/)
  assert.match(text, /does not block, label or merge/)
})

test('rules file is consistent', () => {
  for (const t of ['T0', 'T1', 'T2', 'T3']) assert.ok(rules.tiers[t].meaning && rules.tiers[t].paths.length, t)
  assert.ok(['T2', 'T3'].includes(rules.unknownPathTier), 'unknown paths must not default below T2')
  for (const p of [...rules.tiers.T3.diffPatterns, ...rules.tiers.T3.diffPatternsNotInTests]) new RegExp(p)
})

test('the workflow stays report only', () => {
  const wf = readFileSync(new URL('../workflows/risk-tier.yml', import.meta.url), 'utf8').replace(/^\s*#.*$/gm, '')
  assert.match(wf, /^on:\n  pull_request:\n/m, 'pull_request only')
  assert.doesNotMatch(wf, /pull_request_target|workflow_run|secrets\./)
  assert.match(wf, /continue-on-error: true/)
  assert.doesNotMatch(wf, /(contents|pull-requests|issues|statuses|checks): write/)
  const test = readFileSync(new URL('../workflows/test.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(test, /risk-tier|risk-gate/, 'tests-ok must not depend on the report')
})
