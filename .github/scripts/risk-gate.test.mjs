import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGate, globToRe } from './risk-gate.mjs'
import { gate, file, rules } from './risk-gate.fixtures.mjs'

test('globToRe: ** crosses directories, * does not, **/ may match zero directories', () => {
  assert.ok(globToRe('docs/**').test('docs/a/b.md'))
  assert.ok(!globToRe('docs/*').test('docs/a/b.md'))
  assert.ok(globToRe('**/package.json').test('package.json'))
  assert.ok(globToRe('**/package.json').test('core/package.json'))
  assert.ok(!globToRe('**/package.json').test('core/not-package.json'))
  assert.ok(!globToRe('services/*/test/**').test('services/a/b/test/x.js'))
  assert.ok(globToRe('flybot_workspace/{oidc,security}.py').test('flybot_workspace/security.py'))
  assert.ok(!globToRe('flybot_workspace/{oidc,security}.py').test('flybot_workspace/securityX.py'))
  assert.ok(!globToRe('NOTICE').test('NOTICEx'), 'no wildcard means a literal path')
  assert.ok(globToRe('.github/**').test('.github/workflows/tests.yml'))
})

test('tierOf: highest matching tier wins; an unnamed path is T2, never T0/T1', () => {
  assert.equal(gate.tierOf('docs/ARCHITECTURE.md'), 'T0')
  assert.equal(gate.tierOf('README.md'), 'T0')
  assert.equal(gate.tierOf('tests/test_shell_page.py'), 'T1')
  assert.equal(gate.tierOf('flybot_workspace/static/agents/app.mjs'), 'T1')
  assert.equal(gate.tierOf('runtime/flybot-workspace-web/index.js'), 'T1')
  assert.equal(gate.tierOf('flybot_workspace/server.py'), 'T2')
  assert.equal(gate.tierOf('runtime/flybot/plugins/social/client.js'), 'T2')
  assert.equal(gate.tierOf('services/bot-social/src/social.ts'), 'T2')
  // services/** is T2 as a whole: a test under it stays T2, not T1 (T2 is checked first)
  assert.equal(gate.tierOf('services/bot-social/test/a.test.ts'), 'T2')
  assert.equal(gate.tierOf('.github/workflows/tests.yml'), 'T3')
  assert.equal(gate.tierOf('scripts/ds-bot-upstream.mjs'), 'T3')
  assert.equal(gate.tierOf('deploy/isolated/bot-social.compose.yml'), 'T3')
  assert.equal(gate.tierOf('runtime/ds-bot-upstream/ds-bot/src/host/schedules.js'), 'T3')
  assert.equal(gate.tierOf('services/bot-social/src/oauth.ts'), 'T3')
  assert.equal(gate.tierOf('flybot_workspace/security.py'), 'T3')
  assert.equal(gate.tierOf('services/bot-social/package.json'), 'T3')
  assert.equal(gate.tierOf('brand-new-dir/file.txt'), 'T2')
})

test('judge: tier is the maximum over files', () => {
  assert.equal(gate.judge([file('docs/a.md'), file('README.md')]).tier, 'T0')
  assert.equal(gate.judge([file('docs/a.md'), file('tests/test_a.py')]).tier, 'T1')
  assert.equal(gate.judge([file('tests/test_a.py'), file('flybot_workspace/server.py')]).tier, 'T2')
  assert.equal(gate.judge([file('docs/a.md'), file('NOTICE')]).tier, 'T3')
})

test('judge: moving a file out of a T3 path is still T3 (old path counts)', () => {
  const r = gate.judge([file('runtime/flybot/host/moved.ts', ['+x'], { status: 'renamed', previous_filename: 'services/bot-social/src/oauth.ts' })])
  assert.equal(r.tier, 'T3')
  assert.match(r.why.join(), /oauth\.ts/)
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
  }
  for (const [name, line] of Object.entries(risky)) {
    assert.equal(gate.judge([file('runtime/flybot/plugins/social/src/a.js', [line])]).tier, 'T3', name)
  }
  // The tree is mostly Python now, so the same red flags are read in .py code too.
  const python = {
    subprocess: '+proc = subprocess.run(cmd, check=True)',
    environ: "+token = os.environ['GITHUB_TOKEN']",
    noqa: '+x = 1  # noqa: E501',
    pytest_skip: '+@pytest.mark.skip(reason="later")',
    url: "+BASE = 'https://evil.example.net/x'",
  }
  for (const [name, line] of Object.entries(python)) {
    assert.equal(gate.judge([file('flybot_workspace/agent_helper.py', [line])]).tier, 'T3', name)
  }
})

test('judge: exec-family hits in a test file stay out of the tier, in product code they still count', () => {
  // These two patterns used to hit fixtures: #3382 was called T3 for `new Function(` inside
  // runtime/flybot/plugins/social/test/. A test that evaluates or spawns is ordinary test
  // machinery, so those patterns are read on product code only. `.only(` and the lint
  // suppressions stay in `diffPatterns`, because in a test file they still mean something.
  const spawned = ["+import { exec } from 'node:child_process'"]
  assert.notEqual(gate.judge([file('tests/harness.mjs', spawned)]).tier, 'T3', 'test helper')
  assert.notEqual(gate.judge([file('runtime/flybot/plugins/social/test/poll-visibility.test.js', ['+new Function(source)'])]).tier, 'T3', 'test fixture')
  assert.equal(gate.judge([file('runtime/flybot/plugins/social/src/a.js', spawned)]).tier, 'T3', 'product code still counts')
  assert.equal(gate.judge([file('tests/test_a.py', ['+test.only("x")'])]).tier, 'T3', '.only still counts in a test')
})

test('#679: a topic counts on the registration line, not on a line that names the tool', () => {
  // The rule survives the port even though no tool in this tree registers a topic yet (`topics` is
  // empty): a plain substring match made any mention of a tool a T3 PR, so the narrow form is kept
  // under test on a rules copy that has one.
  const withTopic = createGate({ ...rules, tiers: { ...rules.tiers, T3: { ...rules.tiers.T3, topics: ['create_child_bot'] } } })
  const named = withTopic.judge([
    file('runtime/flybot/plugins/social/src/prompt.js', ["+    'Use create_child_bot to add a child Bot under yourself.',"]),
    file('runtime/flybot/plugins/social/src/social.js', ['+  adoptUnattached(root)']),
  ])
  assert.equal(named.tier, 'T2', 'naming the tool in prose must not raise the tier')
  assert.doesNotMatch(named.why.join('\n'), /topic create_child_bot/)
  // The positive control, so the rule is narrowed rather than switched off.
  const registered = withTopic.judge([file('runtime/flybot/plugins/social/src/tools.js', ["+  name: 'create_child_bot',"])])
  assert.equal(registered.tier, 'T3')
  assert.match(registered.why.join('\n'), /runtime\/flybot\/plugins\/social\/src\/tools\.js: topic create_child_bot/)
})
