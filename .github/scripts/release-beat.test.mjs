// The watchdog's decision and its side effects (#1209, second half). `gh` is injected, so every case
// below runs without the network and a wrong branch cannot pass by accident.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_TITLE, alreadyAlerted, cstDate, decide, latestOf, run, tagDate } from './release-beat.mjs'
import { readFileSync } from 'node:fs'

const REPO = 'o/r'

// Routes are matched in order; the first whose predicate accepts the argv answers. A call nothing
// matches throws, so a new API call in the script cannot slip through untested.
function fakeGh(routes) {
  const calls = []
  const gh = (args, options = {}) => {
    calls.push({ args, options })
    for (const [match, answer] of routes) {
      if (match(args, options)) return typeof answer === 'function' ? answer(args, options) : answer
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  return { gh, calls }
}

const isTagList = (args) => args.some((a) => a.startsWith(`repos/${REPO}/tags?`))
const isTagRef = (args) => args.some((a) => a.startsWith(`repos/${REPO}/git/ref/tags/`))
const isAnnotatedTag = (args) => args.some((a) => a.startsWith(`repos/${REPO}/git/tags/`))
const isCommit = (args) => args.some((a) => a.startsWith(`repos/${REPO}/git/commits/`))
const isPulls = (args) => args.some((a) => a.startsWith(`repos/${REPO}/pulls?`))
const isSearch = (args) => args.some((a) => a.startsWith('search/issues?'))
const isCreate = (args) => args.includes('POST') && args.some((a) => a === `repos/${REPO}/issues`)
const isRuns = (args) => args.some((a) => a.startsWith(`repos/${REPO}/actions/workflows/release.yml/runs`))

function happyRoutes({ tagDateInstant = '2026-10-25T10:00:00Z', tags = 'v0.2.8', openTitles = '', searchTotal = '0', created = '{"number": 77}' } = {}) {
  return [
    [isTagList, `${tags}\n`],
    [isTagRef, 'commit abc123\n'],
    [isCommit, `${tagDateInstant}\n`],
    [isPulls, openTitles],
    [isSearch, searchTotal],
    [isCreate, created],
  ]
}

test('a tag dated today is ok, and nothing else is asked', () => {
  const r = decide({ today: '2026-10-25', latestTag: 'v0.2.8', latestTagDate: '2026-10-25' })
  assert.equal(r.action, 'ok')
})

test('a newest tag older than today is an alert', () => {
  const r = decide({ today: '2026-10-26', latestTag: 'v0.2.8', latestTagDate: '2026-10-25' })
  assert.equal(r.action, 'alert')
  assert.match(r.reason, /since 2026-10-25/)
})

test('an older tag with a release pull request open is in flight, not a miss', () => {
  const r = decide({ today: '2026-10-26', latestTag: 'v0.2.8', latestTagDate: '2026-10-25', openReleasePr: true })
  assert.equal(r.action, 'skip-in-flight')
})

test('no v* tag at all is reported, not alerted', () => {
  assert.equal(decide({ today: '2026-10-26', latestTag: null, latestTagDate: null }).action, 'skip-no-tag')
})

test('a newest tag dated after the judged day is an alert: that day has no tag of its own', () => {
  // `--date 2026-10-25` asks about 10-25. A tag pushed on 10-26 is not 10-25's beat, so answering `ok`
  // would make the manual check in #1209 ("dispatch with date=<yesterday>, it must file one") unable to
  // file anything once today's tag already exists.
  const r = decide({ today: '2026-10-25', latestTag: 'v0.2.8', latestTagDate: '2026-10-26' })
  assert.equal(r.action, 'alert')
  assert.match(r.reason, /no v\* tag on 2026-10-25/)
  assert.match(r.reason, /after the judged day/)
})

test('a malformed date is refused instead of silently read as a miss', () => {
  assert.throws(() => decide({ today: '26/10/2026', latestTag: 'v0.2.8', latestTagDate: '2026-10-25' }), /YYYY-MM-DD/)
})

test('CST is the clock the date is taken in: 18:30Z is already tomorrow in Shanghai', () => {
  assert.equal(cstDate('2026-10-25T18:30:00Z'), '2026-10-26')
  assert.equal(cstDate('2026-10-25T15:59:00Z'), '2026-10-25')
})

test('the newest tag is semver order, not string order', () => {
  assert.equal(latestOf(['v0.2.9', 'v0.2.10', 'v0.2.8']), 'v0.2.10')
  assert.equal(latestOf(['v0.3.0', 'v0.2.99']), 'v0.3.0')
  assert.equal(latestOf(['not-a-tag', 'v1.0.0']), 'v1.0.0')
  assert.equal(latestOf([]), null)
})

test('an annotated tag reads its tagger date; a lightweight tag reads its commit date', () => {
  const annotated = fakeGh([[isTagRef, 'tag 9f9f\n'], [isAnnotatedTag, '2026-10-25T10:00:00Z\n']])
  assert.equal(tagDate(annotated.gh, REPO, 'v0.2.8'), '2026-10-25')
  const lightweight = fakeGh([[isTagRef, 'commit abc\n'], [isCommit, '2026-10-24T20:00:00Z\n']])
  assert.equal(tagDate(lightweight.gh, REPO, 'v0.2.8'), '2026-10-25')
})

test('a miss files exactly one issue, with the fixed title and the two labels', () => {
  const { gh, calls } = fakeGh(happyRoutes())
  const r = run({ gh, repo: REPO, date: '2026-10-26', open: true, summary: null, write: () => {} })
  assert.equal(r.action, 'alert')
  assert.equal(r.filed, true)
  assert.equal(r.number, 77)
  const create = calls.filter((c) => isCreate(c.args))
  assert.equal(create.length, 1)
  const payload = JSON.parse(create[0].options.input)
  assert.equal(payload.title, ALERT_TITLE('2026-10-26'))
  assert.deepEqual(payload.labels, ['bug', 'area:release'])
  assert.match(payload.body, /newest tag: `v0\.2\.8`, dated 2026-10-25/)
  // The run link is a nicety, not the signal: when it cannot be read the alert still says `none found`.
  assert.match(payload.body, /last `release\.yml` run: none found/)
})

test('the alert names the newest release.yml run when one can be read', () => {
  const routes = [...happyRoutes(), [isRuns, 'https://example.test/run/9\n']]
  const { gh, calls } = fakeGh(routes)
  run({ gh, repo: REPO, date: '2026-10-26', open: true, summary: null, write: () => {} })
  const payload = JSON.parse(calls.filter((c) => isCreate(c.args))[0].options.input)
  assert.match(payload.body, /last `release\.yml` run: https:\/\/example\.test\/run\/9/)
})

test('filing for a day older than the newest tag says so instead of printing negative hours', () => {
  const routes = happyRoutes({ tagDateInstant: '2026-10-26T10:00:00Z' })
  const { gh, calls } = fakeGh(routes)
  const r = run({ gh, repo: REPO, date: '2026-10-25', open: true, summary: null, write: () => {} })
  assert.equal(r.action, 'alert')
  assert.equal(r.filed, true)
  const payload = JSON.parse(calls.filter((c) => isCreate(c.args))[0].options.input)
  assert.match(payload.body, /hours since that tag: the tag is newer than the day judged/)
})

test('the same day is never filed twice: a search hit writes the summary and stops', () => {
  const { gh, calls } = fakeGh(happyRoutes({ searchTotal: '1' }))
  const r = run({ gh, repo: REPO, date: '2026-10-26', open: true, summary: null, write: () => {} })
  assert.equal(r.action, 'skip-already-reported')
  assert.equal(r.filed, false)
  assert.equal(calls.filter((c) => isCreate(c.args)).length, 0)
})

test('dry run is the default: a real miss does not file', () => {
  const { gh, calls } = fakeGh(happyRoutes())
  const r = run({ gh, repo: REPO, date: '2026-10-26', open: false, summary: null, write: () => {} })
  assert.equal(r.action, 'alert')
  assert.equal(r.filed, false)
  assert.equal(calls.filter((c) => isCreate(c.args)).length, 0)
})

test('a release pull request in flight writes the summary and files nothing', () => {
  const { gh, calls } = fakeGh(happyRoutes({ openTitles: 'Release v0.2.9\nchore: something\n' }))
  const r = run({ gh, repo: REPO, date: '2026-10-26', open: true, summary: null, write: () => {} })
  assert.equal(r.action, 'skip-in-flight')
  assert.equal(calls.filter((c) => isCreate(c.args)).length, 0)
})

test('an API failure throws and files nothing: a hiccup must not become an alert', () => {
  const { gh, calls } = fakeGh([[isPulls, ''], [isSearch, '0'], [isCreate, '{"number": 1}']]) // tag list is not routed
  assert.throws(() => run({ gh, repo: REPO, date: '2026-10-26', open: true, summary: null, write: () => {} }), /unexpected gh call/)
  assert.equal(calls.filter((c) => isCreate(c.args)).length, 0)
})

test('alreadyAlerted asks the search API and reads its count', () => {
  const { gh, calls } = fakeGh([[isSearch, '3']])
  assert.equal(alreadyAlerted(gh, REPO, '2026-10-26'), true)
  assert.match(calls[0].args.find((a) => a.startsWith('search/issues?')), /Release%20beat%20missing/)
})

// The workflow's own text (INC at 7c8d4142): nothing in this suite read the yml, so a moved cron or a
// widened permission stayed green. Text checks only, the way test-workflow.test.mjs does it.
const workflow = readFileSync(new URL('../workflows/release-beat.yml', import.meta.url), 'utf8')

test('the workflow runs at 02:30 Asia/Shanghai exactly, and its one comment says so', () => {
  assert.match(workflow, /^ {4}- cron: "30 18 \* \* \*" # daily 02:30 Asia\/Shanghai \(the previous day's 18:30 UTC\)$/m)
  assert.deepEqual(workflow.match(/cron: "[^"]*"/g), ['cron: "30 18 * * *"'], 'one cron, and it is this one')
})

test('permissions are exactly the two this job needs: read at the top, issues: write on the job', () => {
  const top = workflow.slice(workflow.indexOf('\npermissions:'), workflow.indexOf('\nconcurrency:'))
  assert.deepEqual(top.trim().split('\n').map(line => line.trim()), ['permissions:', 'contents: read'])
  const job = workflow.slice(workflow.indexOf('\n  beat:'), workflow.indexOf('\n    env:'))
  const block = job.slice(job.indexOf('    permissions:')).trim().split('\n').map(line => line.trim())
  assert.deepEqual(block, ['permissions:', 'contents: read', 'issues: write'])
  assert.equal((workflow.match(/^\s+[\w-]+: write$/gm) ?? []).length, 1, 'issues: write is the only write permission in the file')
})

test('a scheduled run files, and a dispatch files only when dry_run is exactly false', () => {
  assert.match(workflow, /^ {8}default: 'true'$/m, 'dry_run defaults to a dry run')
  assert.match(workflow, /BEAT_DRY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry_run \|\| 'false' \}\}/)
  assert.match(workflow, /if \[\[ "\$\{BEAT_DRY:-false\}" == "false" \]\]; then args\+=\(--open\); fi/, 'a schedule is a real run; only the string false opens the write path')
  assert.equal((workflow.match(/--open/g) ?? []).length, 1, '--open appears once, behind that condition')
})
