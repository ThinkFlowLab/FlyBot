// #3248: a T0/T1 pull request needs no verdict, so `pass-label.yml` never labels it and nothing starts
// its queue entry — every one of them waits for a person to press "Add to merge queue". This is the
// trigger. It reads the open pull requests, decides one pull request at a time from the gates that
// already exist, and — only when it is switched on — enqueues with the runbook command.
//
// Report mode is the default and the shipped state: the decision reaches the job summary and nothing is
// pressed. The switch is a `workflow_dispatch` input or the repository variable
// `AUTO_QUEUE_T1_MODE=execute`, never a code edit.
//
// Which heads it may start: a branch of this repository, or the team's fork when `head repo ==
// HugoXK/FlyBot` AND `author == HugoXK`. Every other fork is refused (owner decision 2026-11-20).
//
// It never comments on a pull request, never touches a label and never edits a body: a reason lives in
// the job summary, where a reader looks and where nothing can be mistaken for a review. There is no
// `--admin` and no force flag anywhere: the queue is the only way in, so the worst a bug here can do is
// put a T0/T1 pull request where a person would have put it a few minutes later.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createGate, loadRules } from './risk-gate.mjs'

// A change to either of these is never queued by this trigger: the code that decides must not be the
// code that decides whether it may decide (#3248, owner constraint 3). The test file is deliberately
// absent: it is not this workflow's own code path, and `.github/**` scores T3 today, so a change to it
// still needs a PASS. That protection is the tier rule, not this list (#3253) — if the tier loosens,
// nothing else here stops a pull request from editing the test that this list's behaviour rests on.
export const SELF_PATHS = Object.freeze([
  '.github/scripts/auto-queue-t1.mjs',
  '.github/workflows/auto-queue-t1.yml',
])

const MODES = ['report', 'execute']
const LOW_TIERS = ['T0', 'T1']
const MAX_FILES = 3000 // the pull-request files API stops here, and risk-gate treats it as truncated

const short = (sha) => String(sha ?? '').slice(0, 8)
const labelsOf = (pr) => (pr?.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
const covered = (file, entries = []) => entries.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))

// The switch: a dispatch input wins over the repository variable, an unreadable value fails closed.
// Report mode is what ships, so forgetting to set anything presses nothing.
export function resolveMode({ input = '', variable = '' } = {}) {
  const read = (value) => {
    const text = String(value ?? '').trim().toLowerCase()
    return MODES.includes(text) ? text : ''
  }
  return read(input) || read(variable) || 'report'
}

// The one fork this trigger starts, and only when both halves hold (owner decision 2026-11-20):
// `head repo == HugoXK/FlyBot` AND `author == HugoXK`. The conjunction is the point — the repository
// name alone would start a stranger's pull request opened from a same-named fork, and the author alone
// would start any branch that login happens to push. A head in this repository needs no fork rule: only
// a member can push there, and it keeps the plain "is it this repository" answer it always had.
export const TRUSTED_FORK = Object.freeze({ repo: 'HugoXK/FlyBot', author: 'HugoXK' })

// The refusals that need no API call beyond the pull request itself: a head this trigger does not
// start, a human's hold, a draft, and a base that is not this repository's `main`. They are read first
// both for the reason they carry and because they are what keeps a five-minute round inside a
// GITHUB_TOKEN's hourly budget: only a survivor of this function is worth a files or a checks request.
export function headRefusal({ repo, pr } = {}) {
  const headRepo = String(pr?.head?.repo?.full_name ?? '')
  const author = String(pr?.user?.login ?? '')
  if (headRepo === repo) return ''
  if (headRepo === TRUSTED_FORK.repo && author === TRUSTED_FORK.author) return ''
  if (headRepo === '') return `the head repository is gone, so the head is not ${TRUSTED_FORK.repo} by ${TRUSTED_FORK.author}; a forked head is started only when both match`
  if (headRepo === TRUSTED_FORK.repo) return `the head is ${headRepo} but its author is ${author || 'unknown'}, not ${TRUSTED_FORK.author}; a forked head is started only when both match`
  return `the head is a fork this trigger does not start (${headRepo} by ${author || 'unknown author'})`
}

function cheapRefusal({ repo, pr }) {
  const head = headRefusal({ repo, pr })
  if (head) return head
  if (labelsOf(pr).includes('hold')) return 'the hold label is set'
  if (pr?.draft) return 'the pull request is a draft'
  const base = String(pr?.base?.ref ?? '')
  if (base !== 'main') return `the base is not main (${base || 'unknown'})`
  return ''
}

// A head can carry several runs of one check: a re-run is a second entry, and GitHub reads the newest
// one as the context's state. Reading the first entry instead would let a stale failure outvote the
// re-run that fixed it (and a stale success outvote a later failure), so the newest wins.
const rankOf = (check) => [String(check?.started_at ?? check?.completed_at ?? ''), Number(check?.id ?? 0)]
function checkAt(checks = [], name, sha) {
  const at = checks.filter((check) => check.name === name && check.head_sha === sha)
  if (at.length === 0) return undefined
  return at.reduce((best, check) => {
    const [aTime, aId] = rankOf(check)
    const [bTime, bId] = rankOf(best)
    return aTime > bTime || (aTime === bTime && aId > bId) ? check : best
  })
}

// A check that has not finished has no conclusion. `in progress` rather than `null` so the summary
// sentence reads as a reason a person can act on.
function conclusionOf(check) {
  if (check.conclusion) return check.conclusion
  return String(check.status ?? 'pending').replaceAll('_', ' ')
}

// The decision, pure: fixtures in, one answer out. `tier` comes from `risk-gate.mjs`'s own judge(), so
// these rules are never a second copy of the tier rules; the caller only passes the result.
export function decidePull({ repo = '', pr = {}, files = [], tier = '', checks = [], queued = false, gateFiles = [] }) {
  const head = String(pr?.head?.sha ?? '')
  const where = short(head)
  const answer = (action, reason, command) => ({ number: pr?.number, tier, sha: head, action, reason, command })

  const cheap = cheapRefusal({ repo, pr })
  if (cheap) return answer('refuse', cheap)
  if (!LOW_TIERS.includes(tier)) return answer('refuse', `tier ${tier || 'unknown'} is judged by a reviewer, not by this trigger`)

  for (const file of files.map((entry) => entry?.filename).filter(Boolean)) {
    if (covered(file, gateFiles)) return answer('refuse', `changed file is a gate file: ${file}`)
    if (covered(file, SELF_PATHS)) return answer('refuse', `changed file is this trigger: ${file}`)
  }

  for (const name of ['tests-ok', 'merge-gate']) {
    const check = checkAt(checks, name, head)
    if (check === undefined) return answer('refuse', `${name} has not reported at ${where}`)
    if (check.conclusion !== 'success') return answer('refuse', `${name} is ${conclusionOf(check)} at ${where}`)
  }
  const guard = checkAt(checks, 'enqueue-guard', head)
  if (guard !== undefined && guard.conclusion !== 'success') return answer('refuse', `enqueue-guard is ${conclusionOf(guard)} at ${where}`)

  if (queued) return answer('refuse', 'already in the merge queue')
  return answer(
    'enqueue',
    `every condition holds: tier ${tier}, tests-ok and merge-gate green at ${where}`,
    `gh pr merge ${pr?.number} --auto --squash --match-head-commit ${head}`,
  )
}

// The job summary: the only place a reason is written. One line per pull request so a reader can grep
// a number, and one machine-readable line at the end so a later round can be compared with this one.
export function renderSummary({ mode = 'report', rows = [], note = '' } = {}) {
  const counts = { 'would-enqueue': 0, enqueued: 0, refused: 0, moved: 0, failed: 0 }
  const verbOf = (row) => {
    if (row.action === 'refuse') return 'refused'
    if (row.action === 'moved') return 'moved'
    if (row.action === 'failed') return 'failed'
    if (row.action === 'enqueued') return 'enqueued'
    return mode === 'execute' ? 'enqueued' : 'would enqueue'
  }
  const lines = [
    `### auto-queue-t1 — ${mode} mode`,
    '',
    mode === 'execute'
      ? 'Execute mode: every "enqueued" line below was sent to the merge queue with its tip pinned.'
      : 'Report mode: nothing was pressed. Switch: repository variable `AUTO_QUEUE_T1_MODE=execute`, or dispatch this workflow with `mode: execute`.',
    '',
  ]
  for (const row of rows) {
    const verb = verbOf(row)
    const bucket = verb === 'would enqueue' ? 'would-enqueue' : verb
    counts[bucket] += 1
    // A failed press answers with the reason, never with the command it sent: the reader already knows
    // what was tried — the row says it failed — and the reason is the only text that explains why the
    // round is one enqueue short (#3257).
    const detail = row.action === 'failed' || !row.command ? String(row.reason ?? '') : `\`${row.command}\``
    lines.push(`- #${row.number} (${row.tier || 'tier unknown'}, ${short(row.sha)}): ${verb} — ${detail}`)
  }
  if (rows.length === 0) lines.push('- no open pull request this round')
  const parts = [`mode=${mode}`]
  parts.push(mode === 'execute' ? `enqueued=${counts.enqueued}` : `would-enqueue=${counts['would-enqueue']}`)
  parts.push(`refused=${counts.refused}`)
  for (const extra of ['moved', 'failed']) if (counts[extra] > 0) parts.push(`${extra}=${counts[extra]}`)
  lines.push('', `auto-queue-t1: ${parts.join(' ')}`)
  if (note) lines.push('', note)
  return lines.join('\n') + '\n'
}

// A snapshot is a read-only artefact: it carries the head shas of a past read, so acting on it would
// enqueue or chase a tip that has since moved. Report only, whatever mode was asked for.
export function guardMode({ mode = 'report', snapshot = false } = {}) {
  if (snapshot && mode === 'execute') throw new Error('--snapshot is report-only; refusing to enqueue from a snapshot')
  return mode
}

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 })
const ghJson = (args) => JSON.parse(gh(args))
// One JSON value per line, the way `risk-gate.mjs` reads a paginated list: `gh api --paginate` repeats
// the page array, so the array itself is not one JSON document.
const ghList = (path) => gh(['api', '--paginate', '--jq', '.[]', path]).split('\n').filter(Boolean).map((line) => JSON.parse(line))
const firstLine = (error) => String(error?.stderr || error?.stdout || error?.message || error).split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? 'unknown error'

const prFiles = (repo, number) => ghList(`repos/${repo}/pulls/${number}/files?per_page=100`)
const prChecks = (repo, sha) => ghList(`repos/${repo}/commits/${sha}/check-runs?per_page=100`)
  .map((check) => ({ id: check.id, name: check.name, conclusion: check.conclusion, status: check.status, started_at: check.started_at, completed_at: check.completed_at, head_sha: check.head_sha }))
const prHead = (repo, number) => gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.head.sha']).trim()

const QUEUE_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{state}}}}'
function inQueue(repo, number) {
  const [owner, name] = String(repo).split('/')
  const out = ghJson(['api', 'graphql', '-f', `query=${QUEUE_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`])
  return out?.data?.repository?.pullRequest?.mergeQueueEntry != null
}

function policyGateFiles() {
  const path = arg('--policy') || fileURLToPath(new URL('../../policy/gates.json', import.meta.url))
  const policy = JSON.parse(readFileSync(path, 'utf8'))
  return policy.gateFiles ?? []
}

// One round over the live open pull requests. The cheap refusals are decided from the list response
// alone; files, checks and the queue state are read only for a pull request that survived them.
function liveRound({ repo, gate, gateFiles }) {
  const pulls = ghList(`repos/${repo}/pulls?state=open&per_page=100`).sort((a, b) => a.number - b.number)
  const rows = []
  for (const pr of pulls) {
    const cheap = cheapRefusal({ repo, pr })
    if (cheap !== '') {
      rows.push({ number: pr.number, tier: '', sha: pr?.head?.sha, action: 'refuse', reason: cheap })
      continue
    }
    const files = prFiles(repo, pr.number)
    const tier = gate.judge(files, { truncated: files.length >= MAX_FILES }).tier
    const checks = prChecks(repo, pr.head.sha)
    let decision = decidePull({ repo, pr, files, tier, checks, queued: false, gateFiles })
    if (decision.action === 'enqueue') {
      let queued = false
      try {
        queued = inQueue(repo, pr.number)
      } catch (error) {
        decision = { ...decision, action: 'refuse', reason: `could not read the merge-queue state (${firstLine(error)})`, command: undefined }
      }
      if (decision.action === 'enqueue' && queued) {
        decision = decidePull({ repo, pr, files, tier, checks, queued: true, gateFiles })
      }
    }
    rows.push(decision)
  }
  return rows
}

// A snapshot of the same inputs, for a report a reader can reproduce without the API: the shape the
// workflow reads, written to one JSON file. Nothing here presses anything.
function snapshotRound({ path, repo, gate, gateFiles }) {
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  const rows = []
  for (const entry of snapshot.pulls ?? []) {
    const files = entry.files ?? []
    const tier = gate.judge(files, { truncated: files.length >= MAX_FILES }).tier
    rows.push(decidePull({
      repo: snapshot.repo ?? repo,
      pr: entry.pr,
      files,
      tier,
      checks: entry.checks ?? [],
      queued: entry.queued === true,
      gateFiles,
    }))
  }
  return rows
}

// Execute mode only. The head is re-read *after* the decision and pinned with `--match-head-commit`:
// a tip that moved while this round was reading other pull requests is dropped, not chased, and the
// next round decides again (constraint 2). `already queued to merge` is success — the round wanted it
// queued and it is.
function act(rows, { repo, mode }) {
  let enqueued = 0
  for (const row of rows) {
    if (row.action !== 'enqueue') continue
    if (mode !== 'execute') continue
    const fresh = prHead(repo, row.number)
    if (fresh !== row.sha) {
      Object.assign(row, { action: 'moved', reason: `the head moved to ${short(fresh)} after the decision; the next round decides again`, command: undefined })
      continue
    }
    try {
      gh(['pr', 'merge', String(row.number), '--auto', '--squash', '--match-head-commit', row.sha])
      Object.assign(row, { action: 'enqueued' })
      enqueued += 1
    } catch (error) {
      const text = `${error?.stderr ?? ''}${error?.stdout ?? ''}`
      if (/already queued/i.test(text)) {
        Object.assign(row, { action: 'enqueued' })
        enqueued += 1
      } else {
        Object.assign(row, { action: 'failed', reason: firstLine(error) })
      }
    }
  }
  return enqueued
}

// A merge made with a GITHUB_TOKEN starts no push pipeline by itself, so the `Test` run on main that
// the merge would have started is dispatched once, here, after an enqueue landed (#3248).
function dispatchAfterEnqueue(enqueued) {
  if (enqueued === 0) return ''
  try {
    gh(['workflow', 'run', 'test.yml', '--ref', 'main'])
    return `Dispatched \`Test\` on main once after ${enqueued} enqueue(s).`
  } catch (error) {
    return `Could not dispatch \`Test\` on main (${firstLine(error)}); the merge itself landed.`
  }
}

function main() {
  const repo = arg('--repo') || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || ''
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const mode = guardMode({
    mode: resolveMode({ input: arg('--mode') ?? process.env.INPUT_MODE, variable: process.env.AUTO_QUEUE_T1_MODE }),
    snapshot: Boolean(arg('--snapshot')),
  })
  const gateFiles = policyGateFiles()
  const rulesPath = arg('--rules') || process.env.RISK_RULES || fileURLToPath(new URL('../agent/risk-rules.json', import.meta.url))
  const gate = createGate(loadRules(rulesPath))

  const snapshot = arg('--snapshot')
  const rows = snapshot
    ? snapshotRound({ path: snapshot, repo, gate, gateFiles })
    : liveRound({ repo, gate, gateFiles })
  const enqueued = act(rows, { repo, mode })
  const summary = renderSummary({ mode, rows, note: mode === 'execute' ? dispatchAfterEnqueue(enqueued) : '' })

  const out = arg('--summary')
  if (out) appendFileSync(out, summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  // The decision also goes to the log, always: the REST API hands back a run's log text but not its step
  // summary, so without this line a round that a person did not open the run page for leaves nothing
  // quotable behind (#3253). Same bytes as the file, so a reader can compare the two.
  process.stdout.write(summary)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`auto-queue-t1: ${error?.message ?? error}`)
    process.exit(1)
  }
}
