import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decideMode, closingRefs, isAgentPr, judgeReady, claimExpired, plan, validatePlan, apply, linkedPrs, render } from './controller.mjs'

const config = JSON.parse(readFileSync(new URL('../agent/controller.json', import.meta.url), 'utf8'))
const REPO = 'ThinkFlowLab/FlyBot'
const HOUR = 3600e3
const NOW = Date.parse('2026-10-20T12:00:00Z')
const ago = (h) => new Date(NOW - h * HOUR).toISOString()
const ALL_LABELS = ['agent-ready', 'agent-working', 'agent-pr', 'hold', 'risk:T0', 'risk:T1', 'risk:T2', 'risk:T3']

const labeled = (label, hoursAgo, actor = 'Birfy') => ({ type: 'labeled', at: ago(hoursAgo), actor, label })
const issue = (over) => ({ number: 7, labels: ['agent-ready'], edits: [], events: [labeled('agent-ready', 10)], ...over })
const pr = (over) => ({ number: 20, labels: [], author: 'someone', headRef: 'feature/x', sameRepo: true, body: '', tier: 'T1', lastPushAt: ago(1), ...over })
const run = (state) => plan({ repo: REPO, config, now: NOW, repoLabels: ALL_LABELS, issues: [], prs: [], linked: new Map(), ...state })
const summary = (r) => r.ops.map((o) => `${o.op} ${o.label} #${o.number} ${o.reason}`)

test('mode: dry run is the default; live only on exactly "true"; a pause wins', () => {
  assert.equal(decideMode({}), 'dry-run')
  assert.equal(decideMode({ CONTROLLER_LIVE: '' }), 'dry-run')
  assert.equal(decideMode({ CONTROLLER_LIVE: 'TRUE' }), 'dry-run')
  assert.equal(decideMode({ CONTROLLER_LIVE: '1' }), 'dry-run')
  assert.equal(decideMode({ CONTROLLER_LIVE: 'true' }), 'live')
  assert.equal(decideMode({ CONTROLLER_LIVE: 'true', AGENT_PAUSE: 'true' }), 'paused')
  assert.equal(decideMode({ AGENT_PAUSE: 'true' }), 'paused')
  assert.equal(decideMode({ CONTROLLER_LIVE: 'true', AGENT_PAUSE: 'false' }), 'live')
})

test('config: maintainers, a sane TTL and caps', () => {
  assert.ok(config.maintainers.length >= 1)
  assert.ok(config.claimTtlHours > 0 && config.maxPrsPerRun <= 100 && config.maxIssuesPerRun <= 100)
})

test('closingRefs reads closing keywords for this repository only', () => {
  assert.deepEqual(closingRefs('Fixes #12\nCloses: #5, resolved #9', REPO), [5, 9, 12])
  assert.deepEqual(closingRefs(`Fixes ${REPO}#3 and fixes other/repo#4`, REPO), [3])
  assert.deepEqual(closingRefs('see #12, related to #13', REPO), [])
  assert.deepEqual(closingRefs(null, REPO), [])
})

test('isAgentPr: author, agent branch of this repository, or closes an agent issue; a fork only by author', () => {
  const cfg = { ...config, agentAuthors: ['flybot-agent'], agentBranchPrefixes: ['agent/'] }
  const issues = new Set([7])
  assert.ok(isAgentPr(pr({ author: 'flybot-agent', sameRepo: false }), cfg, REPO, issues))
  assert.ok(isAgentPr(pr({ headRef: 'agent/7-fix' }), cfg, REPO, issues))
  assert.ok(isAgentPr(pr({ body: 'Fixes #7' }), cfg, REPO, issues))
  assert.ok(!isAgentPr(pr({ body: 'Fixes #8' }), cfg, REPO, issues))
  assert.ok(!isAgentPr(pr({ headRef: 'agent/7-fix', sameRepo: false }), cfg, REPO, issues), 'a fork branch is not an agent branch')
  assert.ok(!isAgentPr(pr({ body: 'Fixes #7', sameRepo: false }), cfg, REPO, issues), 'a fork cannot claim an agent issue')
  assert.ok(!isAgentPr(pr(), { ...cfg, agentBranchPrefixes: [''] }, REPO, issues), 'an empty prefix matches nothing')
})

test('judgeReady: a maintainer label stands; a later edit by anyone else voids it', () => {
  assert.equal(judgeReady(issue(), config).demote, null)
  assert.equal(judgeReady(issue({ edits: [{ at: ago(5), editor: 'Birfy' }] }), config).demote, null)
  assert.equal(judgeReady(issue({ edits: [{ at: ago(5), editor: 'stranger' }] }), config).demote, 'edited-by-non-maintainer')
  assert.equal(judgeReady(issue({ edits: [{ at: ago(5), editor: null }] }), config).demote, 'edited-by-non-maintainer', 'an unknown editor is not a maintainer')
  assert.equal(judgeReady(issue({ edits: [{ at: ago(20), editor: 'stranger' }] }), config).demote, null, 'an edit before the label was reviewed by the maintainer')
  assert.equal(judgeReady(issue({ events: [labeled('agent-ready', 10), { type: 'renamed', at: ago(2), actor: 'stranger', label: null }] }), config).demote, 'edited-by-non-maintainer')
  assert.equal(judgeReady(issue({ events: [labeled('agent-ready', 10, 'stranger')] }), config).demote, 'labeled-by-non-maintainer')
  assert.equal(judgeReady(issue({ events: [labeled('agent-ready', 10)], edits: [{ at: ago(5), editor: 'stranger' }, { at: ago(1), editor: 'birfy' }] }), config).demote, 'edited-by-non-maintainer', 'maintainer names compare case-insensitively; one bad edit is enough')
  assert.equal(judgeReady(issue({ events: [labeled('agent-ready', 30, 'Birfy'), labeled('agent-ready', 1, 'Birfy')], edits: [{ at: ago(5), editor: 'stranger' }] }), config).demote, null, 're-labeling after the edit re-approves it')
  assert.match(judgeReady(issue({ events: [] }), config).note, /cannot find/)
})

test('claimExpired: older than the TTL and no recent push on a linked PR', () => {
  const working = (h) => issue({ labels: ['agent-working'], events: [labeled('agent-working', h)] })
  assert.equal(claimExpired(working(1), [], config, NOW), false)
  assert.equal(claimExpired(working(config.claimTtlHours + 1), [], config, NOW), true)
  assert.equal(claimExpired(working(config.claimTtlHours + 1), [{ lastPushAt: ago(1) }], config, NOW), false)
  assert.equal(claimExpired(working(config.claimTtlHours + 1), [{ lastPushAt: ago(config.claimTtlHours + 2) }], config, NOW), true)
  assert.equal(claimExpired(issue({ labels: ['agent-working'], events: [] }), [], config, NOW), false, 'no claim event: leave it')
})

test('plan: issues', () => {
  assert.deepEqual(summary(run({ issues: [issue()] })), [])
  assert.deepEqual(summary(run({ issues: [issue({ edits: [{ at: ago(5), editor: 'stranger' }] })] })), ['remove agent-ready #7 edited-by-non-maintainer'])
  assert.deepEqual(
    summary(run({ issues: [issue({ labels: ['agent-ready', 'agent-working'], edits: [{ at: ago(5), editor: 'stranger' }], events: [labeled('agent-ready', 10), labeled('agent-working', 9)] })] })),
    ['remove agent-ready #7 edited-by-non-maintainer', 'remove agent-working #7 edited-by-non-maintainer'])
  assert.deepEqual(
    summary(run({ issues: [issue({ labels: ['agent-working'], edits: [{ at: ago(5), editor: 'stranger' }], events: [labeled('agent-ready', 10), labeled('agent-working', 9)] })] })),
    ['remove agent-working #7 edited-by-non-maintainer'], 'the claim goes too when the approved text changed under it')
  const stale = issue({ labels: ['agent-working'], events: [labeled('agent-ready', 30), labeled('agent-working', 8)] })
  assert.deepEqual(summary(run({ issues: [stale] })), ['remove agent-working #7 claim-expired'])
  assert.deepEqual(summary(run({ issues: [stale], linked: new Map([[7, [{ lastPushAt: ago(1) }]]]) })), [])
  const held = run({ issues: [issue({ labels: ['agent-ready', 'hold'], edits: [{ at: ago(5), editor: 'stranger' }] })] })
  assert.deepEqual(summary(held), [])
  assert.equal(held.skipped[0].reason, 'hold')
})

test('plan: PRs get one risk label (stale ones removed) and agent-pr by the rule', () => {
  assert.deepEqual(summary(run({ prs: [pr({ tier: 'T3' })] })), ['add risk:T3 #20 risk-tier'])
  assert.deepEqual(summary(run({ prs: [pr({ tier: 'T1', labels: ['risk:T1'] })] })), [])
  assert.deepEqual(summary(run({ prs: [pr({ tier: 'T1', labels: ['risk:T3', 'bug'] })] })), ['remove risk:T3 #20 risk-tier', 'add risk:T1 #20 risk-tier'])
  assert.deepEqual(summary(run({ prs: [pr({ tier: 'T2', headRef: 'agent/7-x' })] })), ['add risk:T2 #20 risk-tier', 'add agent-pr #20 agent-pr'])
  assert.deepEqual(summary(run({ prs: [pr({ tier: 'T2', headRef: 'agent/7-x', labels: ['agent-pr', 'risk:T2'] })] })), [])
  assert.deepEqual(summary(run({ prs: [pr({ tier: null })] })), [], 'files unreadable: change nothing')
  assert.deepEqual(summary(run({ prs: [pr({ tier: 'T3', labels: ['hold'] })] })), [], 'hold: automation leaves it alone')
  assert.deepEqual(summary(run({ issues: [issue()], prs: [pr({ tier: 'T1', body: 'Fixes #7' })] })), ['add risk:T1 #20 risk-tier', 'add agent-pr #20 agent-pr'])
})

test('plan: a label that does not exist is skipped, never created; removals still happen', () => {
  const r = run({ repoLabels: ['agent-ready', 'agent-working', 'hold'], prs: [pr({ tier: 'T3', headRef: 'agent/1' })], issues: [issue({ edits: [{ at: ago(5), editor: 'stranger' }] })] })
  assert.deepEqual(summary(r), ['remove agent-ready #7 edited-by-non-maintainer'])
  assert.deepEqual(r.skipped.map((s) => `${s.label}:${s.reason}`), ['risk:T3:label-missing', 'agent-pr:label-missing'])
  assert.match(render({ ...r, notes: [] }, 'dry-run'), /Labels missing in this repository \(not created\): `risk:T3`, `agent-pr`/)
})

test('plan only ever proposes managed labels in the allowed direction', () => {
  const r = run({
    issues: [issue({ edits: [{ at: ago(5), editor: 'stranger' }] }), issue({ number: 8, labels: ['agent-working'], events: [labeled('agent-working', 9)] })],
    prs: [pr({ tier: 'T3', headRef: 'agent/1', labels: ['risk:T0'] }), pr({ number: 21, tier: 'T0' })],
  })
  assert.ok(r.ops.length > 3)
  assert.doesNotThrow(() => validatePlan({ version: 1, ops: r.ops }))
})

test('validatePlan refuses anything outside the label contract', () => {
  const ok = { kind: 'pr', number: 1, op: 'add', label: 'risk:T1', reason: 'risk-tier' }
  assert.doesNotThrow(() => validatePlan({ version: 1, ops: [ok] }))
  for (const bad of [
    { ...ok, label: 'agent-ready' }, // the controller can never grant approval
    { ...ok, label: 'agent-working' },
    { ...ok, label: 'hold' },
    { ...ok, label: 'bug' },
    { ...ok, op: 'remove', label: 'agent-pr' },
    { ...ok, op: 'remove', label: 'hold' },
    { ...ok, op: 'merge' },
    { ...ok, op: 'comment' },
    { ...ok, number: 0 },
    { ...ok, number: '1; rm -rf' },
    { ...ok, number: 1.5 },
    { ...ok, reason: 'because' },
  ]) assert.throws(() => validatePlan({ version: 1, ops: [bad] }), undefined, JSON.stringify(bad))
  assert.throws(() => validatePlan({ version: 2, ops: [] }))
  assert.throws(() => validatePlan(null))
  assert.throws(() => validatePlan({ version: 1, ops: Array.from({ length: 201 }, () => ok) }))
})

function fakeApi(issues) {
  const calls = []
  return {
    calls,
    get: (path) => { calls.push(['GET', path]); const n = Number(path.split('/').pop()); if (!issues[n]) throw new Error('404 Not Found'); return issues[n] },
    post: (path, body) => { calls.push(['POST', path, body]) },
    del: (path) => { calls.push(['DELETE', path]) },
  }
}

test('apply: only label endpoints are written; closed, held and already-done targets are skipped', () => {
  const api = fakeApi({
    1: { state: 'open', labels: [{ name: 'risk:T3' }] },
    2: { state: 'closed', labels: [] },
    3: { state: 'open', labels: [{ name: 'hold' }] },
    4: { state: 'open', labels: [{ name: 'agent-ready' }] },
    5: { state: 'open', labels: [{ name: 'risk:T1' }] },
  })
  const p = { version: 1, mode: 'live', ops: [
    { kind: 'pr', number: 1, op: 'remove', label: 'risk:T3', reason: 'risk-tier' },
    { kind: 'pr', number: 1, op: 'add', label: 'risk:T1', reason: 'risk-tier' },
    { kind: 'pr', number: 2, op: 'add', label: 'risk:T1', reason: 'risk-tier' },
    { kind: 'pr', number: 3, op: 'add', label: 'risk:T1', reason: 'risk-tier' },
    { kind: 'issue', number: 4, op: 'remove', label: 'agent-ready', reason: 'edited-by-non-maintainer' },
    { kind: 'pr', number: 5, op: 'add', label: 'risk:T1', reason: 'risk-tier' },
  ] }
  const result = apply(p, api, REPO)
  assert.deepEqual(result.done.map((o) => `${o.op} ${o.label} #${o.number}`), ['remove risk:T3 #1', 'add risk:T1 #1', 'remove agent-ready #4'])
  assert.deepEqual(result.skipped.map((o) => `#${o.number} ${o.why}`), ['#2 closed', '#3 hold', '#5 already'])
  const writes = api.calls.filter(([m]) => m !== 'GET')
  assert.deepEqual(writes, [
    ['DELETE', `repos/${REPO}/issues/1/labels/risk%3AT3`],
    ['POST', `repos/${REPO}/issues/1/labels`, { labels: ['risk:T1'] }],
    ['DELETE', `repos/${REPO}/issues/4/labels/agent-ready`],
  ])
})

test('apply: a label that vanished (404) is tolerated; other errors are reported, not thrown', () => {
  const api = { get: () => ({ state: 'open', labels: [{ name: 'risk:T3' }] }), post: () => {}, del: () => { throw new Error('gh: Not Found (HTTP 404)') } }
  const r = apply({ version: 1, mode: 'live', ops: [{ kind: 'pr', number: 1, op: 'remove', label: 'risk:T3', reason: 'risk-tier' }] }, api, REPO)
  assert.equal(r.skipped[0].why, 'label-missing')
  const api2 = { ...api, del: () => { throw new Error('boom') } }
  assert.equal(apply({ version: 1, mode: 'live', ops: [{ kind: 'pr', number: 1, op: 'remove', label: 'risk:T3', reason: 'risk-tier' }] }, api2, REPO).skipped[0].why, 'error')
})

test('linkedPrs maps issues to the PRs that close them', () => {
  const m = linkedPrs([{ body: 'Fixes #7', lastPushAt: 'a' }, { body: 'Closes #7 and fixes #8', lastPushAt: 'b' }], REPO)
  assert.deepEqual(m.get(7).map((p) => p.lastPushAt), ['a', 'b'])
  assert.equal(m.get(8).length, 1)
})

test('render: dry run says so, untrusted characters are neutralized, paused says nothing was read', () => {
  const dry = render({ ops: [{ kind: 'pr', number: 1, op: 'add', label: 'risk:T1', reason: 'risk-tier' }], skipped: [], notes: ['#3: ::error:: <b>x</b>'] }, 'dry-run')
  assert.match(dry, /Dry run\.\*\* Nothing was changed/)
  assert.match(dry, /\| PR #1 \| add \| `risk:T1` \| risk-tier \|/)
  assert.doesNotMatch(dry, /::error::|<b>/)
  assert.match(render({}, 'paused'), /nothing was read, proposed or changed/)
})

// ---- the contract, checked on the source and the workflow ------------------------------------------------

const source = readFileSync(new URL('./controller.mjs', import.meta.url), 'utf8')
const code = source.replace(/^\s*\/\/.*$/gm, '')
const workflow = readFileSync(new URL('../workflows/controller.yml', import.meta.url), 'utf8')

test('source: no merge, review, comment, close, edit or code execution', () => {
  for (const forbidden of [/\/merge\b/, /\/reviews?\b/, /\/comments\b/, /auto_merge|enablePullRequestAutoMerge|mergePullRequest/i, /state['"]?\s*[:=]\s*['"]closed/, /-X['"]?,\s*['"]PATCH|-X['"]?,\s*['"]PUT/, /\beval\s*\(|new Function\s*\(|\bspawn|\bexec\s*\(|execSync|shell:\s*true/, /process\.env\.(?!GH_REPO|GITHUB_|CONTROLLER_LIVE|AGENT_PAUSE|PLAN)/, /fetch\(|https?:\/\//, /mutation\s*[({]/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden))
  }
  // every gh call goes through ghRaw, which is argv-only (no shell)
  assert.equal((code.match(/execFileSync\(/g) || []).length, 1)
  // the only writes: POST and DELETE on issue labels
  assert.deepEqual([...code.matchAll(/'-X', '(\w+)'/g)].map((m) => m[1]).sort(), ['DELETE', 'POST'])
  assert.deepEqual([...code.matchAll(/api\.(post|del)\(`([^`]*)`/g)].map((m) => `${m[1]} ${m[2].replace(/\$\{[^}]+\}/g, '*')}`), ['post */labels', 'del */labels/*'])
})

test('workflow: schedule and dispatch only, no secrets, read-only plan job, label-write only in a live-gated apply job', () => {
  const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\nconcurrency:'))
  assert.match(on, /^ {2}schedule:/m)
  assert.match(on, /^ {2}workflow_dispatch:/m)
  assert.doesNotMatch(on, /pull_request|issues:|issue_comment|push:|workflow_run|repository_dispatch/)
  assert.doesNotMatch(workflow, /secrets\./)
  assert.doesNotMatch(workflow, /\$\{\{[^}]*(github\.event\.(issue|pull_request|comment)|github\.head_ref)[^}]*\}\}/)
  assert.match(workflow, /^permissions: \{\}$/m)
  const plan = workflow.slice(workflow.indexOf('\n  plan:'), workflow.indexOf('\n  apply:'))
  const applyJob = workflow.slice(workflow.indexOf('\n  apply:'))
  assert.match(plan, /contents: read\n\s+issues: read\n\s+pull-requests: read/)
  assert.doesNotMatch(plan, /: write/)
  assert.match(applyJob, /issues: write/)
  assert.doesNotMatch(applyJob, /contents: write|actions: write|statuses: write|checks: write|packages: write/)
  assert.match(applyJob, /if: needs\.plan\.outputs\.live == 'true' && vars\.CONTROLLER_LIVE == 'true'/)
  assert.match(workflow, /AGENT_PAUSE: \$\{\{ vars\.AGENT_PAUSE \}\}/)
  assert.match(workflow, /CONTROLLER_LIVE: \$\{\{ vars\.CONTROLLER_LIVE \}\}/)
  // inputs reach the script through env only; checkout keeps no credentials and takes the default branch
  assert.doesNotMatch(workflow.split('\n').filter((l) => /^\s+run:/.test(l)).join('\n'), /\$\{\{/)
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2)
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
  for (const m of workflow.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `pin ${m[1]}`)
  assert.match(workflow, /group: controller\n\s+cancel-in-progress: false/)
})

test('workflow: the plan reaches apply through a job output, never through a shell expression', () => {
  assert.match(workflow, /PLAN: \$\{\{ needs\.plan\.outputs\.plan \}\}/)
  assert.doesNotMatch(workflow, /run: .*\$\{\{/)
})

test('labels.json has the labels the controller manages', () => {
  const names = JSON.parse(readFileSync(new URL('../labels.json', import.meta.url), 'utf8')).map((l) => l.name)
  for (const l of ['agent-pr', 'agent-ready', 'agent-working', 'hold', 'risk:T0', 'risk:T1', 'risk:T2', 'risk:T3']) assert.ok(names.includes(l), l)
})
