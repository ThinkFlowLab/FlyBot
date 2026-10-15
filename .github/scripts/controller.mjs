// Label-only controller (Phase 1, PR C; see docs/controller.md and docs/autonomous-dev.md).
//
//   node .github/scripts/controller.mjs plan    read the repo (GET only), print a plan, write it to $GITHUB_OUTPUT
//   PLAN='{...}' node .github/scripts/controller.mjs apply    validate the plan and add/remove labels
//
// It manages labels and nothing else. It never merges, approves, comments on or closes anything, never
// edits an issue or PR, and never runs or checks out PR/issue content: titles and bodies are read as data
// (a regex for `Fixes #N`), changed files only through the API and the risk gate's pattern rules.
//
//   - sets `agent-pr` on pull requests an agent opened, and `risk:T0..T3` (the risk gate's tier) on open PRs
//   - removes `agent-ready` (and `agent-working`) when someone who is not a maintainer labeled the issue
//     or edited its text after it was labeled
//   - removes `agent-working` from a claim older than the TTL with no recent push on a linked PR
//
// Mode: DRY RUN unless the repository variable CONTROLLER_LIVE is exactly `true`. AGENT_PAUSE=true stops
// all of it (nothing is even proposed). A label that does not exist yet is skipped, never created.
import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createGate, loadRules } from './risk-gate.mjs'

const MANAGED = {
  // label -> what the controller may do with it
  add: new Set(['agent-pr', 'risk:T0', 'risk:T1', 'risk:T2', 'risk:T3']),
  remove: new Set(['agent-ready', 'agent-working', 'risk:T0', 'risk:T1', 'risk:T2', 'risk:T3']),
}
const RISK = ['risk:T0', 'risk:T1', 'risk:T2', 'risk:T3']
const MAX_OPS = 200
const REASONS = new Set(['labeled-by-non-maintainer', 'edited-by-non-maintainer', 'claim-expired', 'risk-tier', 'agent-pr'])

// ---- mode ------------------------------------------------------------------------------------------

// Live only on an exact `true`; dry run is the default. A pause wins over everything.
export function decideMode(env) {
  if (env.AGENT_PAUSE === 'true') return 'paused'
  return env.CONTROLLER_LIVE === 'true' ? 'live' : 'dry-run'
}

// ---- pure planning ---------------------------------------------------------------------------------

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
export const isMaintainer = (config, login) => Boolean(login) && config.maintainers.some((m) => same(m, login))

// `Fixes #12`, `closes: #12`, `Resolved owner/repo#12` -> [12]. Data only: a bounded regex over the body.
export function closingRefs(body, repo) {
  const out = new Set()
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+((?:[\w.-]+\/[\w.-]+)?)#(\d{1,7})\b/gi
  for (const m of String(body ?? '').slice(0, 20000).matchAll(re)) if (!m[1] || same(m[1], repo)) out.add(Number(m[2]))
  return [...out].sort((a, b) => a - b)
}

// An agent's PR: by author or by a branch of this repository with an agent prefix, or a branch of this
// repository that closes an issue that is agent-ready or agent-working. A fork PR counts only by author.
export function isAgentPr(pr, config, repo, agentIssues) {
  if (config.agentAuthors.some((a) => same(a, pr.author))) return true
  if (!pr.sameRepo) return false
  if (config.agentBranchPrefixes.some((p) => p && pr.headRef.startsWith(p))) return true
  return closingRefs(pr.body, repo).some((n) => agentIssues.has(n))
}

const last = (events, pred) => events.filter(pred).sort((a, b) => a.at.localeCompare(b.at)).at(-1)

// issue: { number, labels: [names], edits: [{at, editor}], events: [{type: 'labeled'|'unlabeled'|'renamed', at, actor, label}], complete }
// -> { demote: 'labeled-by-non-maintainer' | 'edited-by-non-maintainer' | null, note }
export function judgeReady(issue, config) {
  const labeled = last(issue.events, (e) => e.type === 'labeled' && same(e.label, 'agent-ready'))
  if (!labeled) return { demote: null, note: 'cannot find when agent-ready was set' }
  if (!isMaintainer(config, labeled.actor)) return { demote: 'labeled-by-non-maintainer' }
  const edited = [...issue.edits.map((e) => ({ at: e.at, who: e.editor })), ...issue.events.filter((e) => e.type === 'renamed').map((e) => ({ at: e.at, who: e.actor }))]
  if (edited.some((e) => e.at > labeled.at && !isMaintainer(config, e.who))) return { demote: 'edited-by-non-maintainer' }
  return { demote: null }
}

// A claim is stale when agent-working has been on the issue longer than the TTL and no linked open PR has
// had a commit (or been opened) within the TTL.
export function claimExpired(issue, linkedPrs, config, now) {
  const claimed = last(issue.events, (e) => e.type === 'labeled' && same(e.label, 'agent-working'))
  if (!claimed) return false
  const ttl = config.claimTtlHours * 3600e3
  if (now - Date.parse(claimed.at) <= ttl) return false
  return !linkedPrs.some((p) => now - Date.parse(p.lastPushAt) <= ttl)
}

// Compare the labels a thing has with what it should have; only managed labels, only allowed directions.
function diffLabels(have, { add = [], remove = [] }) {
  const has = new Set(have.map((l) => l.toLowerCase()))
  return [
    ...remove.filter((l) => MANAGED.remove.has(l) && has.has(l.toLowerCase())).map((label) => ({ op: 'remove', label })),
    ...add.filter((l) => MANAGED.add.has(l) && !has.has(l.toLowerCase())).map((label) => ({ op: 'add', label })),
  ]
}

// state: { repoLabels: [names], config, prs: [{number, labels, author, headRef, sameRepo, body, tier, lastPushAt}],
//          issues: [{number, labels, edits, events}], linked: Map(issue -> [{lastPushAt}]), now }
export function plan(state) {
  const { config, now } = state
  const exists = new Set(state.repoLabels.map((l) => l.toLowerCase()))
  const ops = []
  const skipped = []
  const notes = []
  const push = (kind, number, found, reason) => {
    for (const { op, label } of found) {
      if (op === 'add' && !exists.has(label.toLowerCase())) skipped.push({ number, label, reason: 'label-missing' })
      else ops.push({ kind, number, op, label, reason })
    }
  }

  const agentIssues = new Set(state.issues.map((i) => i.number))
  for (const issue of state.issues) {
    if (issue.labels.some((l) => same(l, 'hold'))) { skipped.push({ number: issue.number, label: '*', reason: 'hold' }); continue }
    const ready = issue.labels.some((l) => same(l, 'agent-ready'))
    const working = issue.labels.some((l) => same(l, 'agent-working'))
    // The approval is the last time a maintainer set agent-ready, even if the label was later swapped for
    // agent-working: text changed by anyone else after that voids both.
    const verdict = judgeReady(issue, config)
    if (verdict.note && ready) notes.push(`#${issue.number}: ${verdict.note}`)
    if (verdict.demote) {
      push('issue', issue.number, diffLabels(issue.labels, { remove: ['agent-ready', 'agent-working'] }), verdict.demote)
      continue
    }
    if (working && claimExpired(issue, state.linked.get(issue.number) ?? [], config, now)) {
      push('issue', issue.number, diffLabels(issue.labels, { remove: ['agent-working'] }), 'claim-expired')
    }
  }

  for (const pr of state.prs) {
    if (pr.labels.some((l) => same(l, 'hold'))) { skipped.push({ number: pr.number, label: '*', reason: 'hold' }); continue }
    if (!pr.tier) continue // the files could not be read; leave the labels as they are
    const want = `risk:${pr.tier}`
    push('pr', pr.number, diffLabels(pr.labels, { remove: RISK.filter((l) => l !== want), add: [want] }), 'risk-tier')
    if (isAgentPr(pr, config, state.repo, agentIssues)) push('pr', pr.number, diffLabels(pr.labels, { add: ['agent-pr'] }), 'agent-pr')
  }
  if (ops.length > MAX_OPS) { notes.push(`${ops.length} operations; keeping the first ${MAX_OPS}`); ops.length = MAX_OPS }
  return { ops, skipped, notes }
}

// ---- plan <-> apply contract -----------------------------------------------------------------------

// What `apply` accepts. Anything else is refused, whoever wrote the plan.
export function validatePlan(p) {
  if (!p || p.version !== 1 || !Array.isArray(p.ops)) throw new Error('not a controller plan')
  if (p.ops.length > MAX_OPS) throw new Error(`too many operations (${p.ops.length})`)
  for (const o of p.ops) {
    if (!Number.isInteger(o.number) || o.number < 1) throw new Error('bad issue number')
    if (o.op !== 'add' && o.op !== 'remove') throw new Error(`bad operation ${JSON.stringify(o.op)}`)
    if (!MANAGED[o.op].has(o.label)) throw new Error(`label ${JSON.stringify(o.label)} may not be ${o.op === 'add' ? 'added' : 'removed'} by the controller`)
    if (!REASONS.has(o.reason)) throw new Error('bad reason')
  }
  return p
}

// api: { get(path) -> object, post(path, body), del(path) }. Only the label endpoints are ever written to.
export function apply(p, api, repo) {
  validatePlan(p)
  const done = []
  const skipped = []
  for (const o of p.ops) {
    const base = `repos/${repo}/issues/${o.number}`
    const now = api.get(base) // state may have changed since the plan was made
    const labels = (now.labels || []).map((l) => (typeof l === 'string' ? l : l.name))
    if (now.state !== 'open') { skipped.push({ ...o, why: 'closed' }); continue }
    if (labels.some((l) => same(l, 'hold'))) { skipped.push({ ...o, why: 'hold' }); continue }
    const has = labels.some((l) => same(l, o.label))
    if (o.op === 'add' && has) { skipped.push({ ...o, why: 'already' }); continue }
    if (o.op === 'remove' && !has) { skipped.push({ ...o, why: 'already' }); continue }
    try {
      if (o.op === 'add') api.post(`${base}/labels`, { labels: [o.label] })
      else api.del(`${base}/labels/${encodeURIComponent(o.label)}`)
      done.push(o)
    } catch (error) {
      skipped.push({ ...o, why: /404|Not Found/.test(String(error.message)) ? 'label-missing' : 'error' })
    }
  }
  return { done, skipped }
}

// ---- GitHub access (gh CLI; GITHUB_TOKEN from the environment) ---------------------------------------

const ghRaw = (args, input) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20, input, stdio: ['pipe', 'pipe', 'pipe'] })

export function ghApi() {
  const list = (path) => ghRaw(['api', '--paginate', '--jq', '.[]', path]).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return {
    get: (path) => JSON.parse(ghRaw(['api', path])),
    list,
    graphql: (query, vars) => JSON.parse(ghRaw(['api', 'graphql', '-f', `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ['-F', `${k}=${v}`])])),
    post: (path, body) => ghRaw(['api', '-X', 'POST', path, '--input', '-'], JSON.stringify(body)),
    del: (path) => ghRaw(['api', '-X', 'DELETE', path]),
  }
}

const ISSUES_QUERY = `query($owner: String!, $name: String!, $label: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $n, states: OPEN, labels: [$label], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        labels(first: 50) { nodes { name } }
        userContentEdits(first: 50) { nodes { createdAt editor { login } } }
        timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT]) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt actor { login } label { name } }
            ... on UnlabeledEvent { createdAt actor { login } label { name } }
            ... on RenamedTitleEvent { createdAt actor { login } }
          }
        }
      }
    }
  }
}`

const EVENT_TYPES = { LabeledEvent: 'labeled', UnlabeledEvent: 'unlabeled', RenamedTitleEvent: 'renamed' }

export function readIssues(api, repo, config) {
  const [owner, name] = repo.split('/')
  const byNumber = new Map()
  for (const label of ['agent-ready', 'agent-working']) {
    const data = api.graphql(ISSUES_QUERY, { owner, name, label, n: config.maxIssuesPerRun })
    for (const node of data.data.repository.issues.nodes) {
      byNumber.set(node.number, {
        number: node.number,
        labels: node.labels.nodes.map((l) => l.name),
        edits: node.userContentEdits.nodes.map((e) => ({ at: e.createdAt, editor: e.editor?.login ?? null })),
        events: node.timelineItems.nodes.map((e) => ({ type: EVENT_TYPES[e.__typename], at: e.createdAt, actor: e.actor?.login ?? null, label: e.label?.name ?? null })),
      })
    }
  }
  return [...byNumber.values()]
}

export function readPrs(api, repo, config, gate) {
  const prs = api.get(`repos/${repo}/pulls?state=open&per_page=${config.maxPrsPerRun}&sort=updated&direction=desc`)
  const out = []
  for (const pr of prs.slice(0, config.maxPrsPerRun)) {
    let tier = null
    try { tier = gate.judge(api.list(`repos/${repo}/pulls/${pr.number}/files?per_page=100`)).tier } catch { /* leave unlabeled */ }
    let lastPushAt = pr.created_at
    try {
      const date = api.get(`repos/${repo}/commits/${pr.head.sha}`).commit.committer.date
      if (date > lastPushAt) lastPushAt = date
    } catch { /* keep created_at */ }
    out.push({
      number: pr.number,
      labels: pr.labels.map((l) => l.name),
      author: pr.user?.login ?? '',
      headRef: pr.head.ref,
      sameRepo: pr.head.repo?.full_name?.toLowerCase() === repo.toLowerCase(),
      body: pr.body ?? '',
      tier,
      lastPushAt,
    })
  }
  return out
}

export function linkedPrs(prs, repo) {
  const linked = new Map()
  for (const pr of prs) for (const n of closingRefs(pr.body, repo)) linked.set(n, [...(linked.get(n) ?? []), { lastPushAt: pr.lastPushAt }])
  return linked
}

// ---- reporting ---------------------------------------------------------------------------------------

const safe = (s) => String(s).replace(/[^\w.:\- ]/g, '?').replace(/::+/g, '?')

export function render(result, mode) {
  const lines = [`### Controller (labels only): ${mode}`, '']
  if (mode === 'paused') return [...lines, 'AGENT_PAUSE is `true`: nothing was read, proposed or changed.'].join('\n')
  if (mode === 'dry-run') lines.push('**Dry run.** Nothing was changed. Set the repository variable `CONTROLLER_LIVE` to `true` to apply labels.', '')
  const rows = result.ops.map((o) => `| ${o.kind === 'pr' ? 'PR' : 'issue'} #${o.number} | ${o.op} | \`${safe(o.label)}\` | ${safe(o.reason)} |`)
  lines.push(rows.length ? ['| Target | Operation | Label | Why |', '| --- | --- | --- | --- |', ...rows].join('\n') : 'No label changes to make.')
  if (result.skipped.length) lines.push('', 'Skipped:', ...result.skipped.slice(0, 30).map((s) => `- #${s.number} \`${safe(s.label)}\`: ${safe(s.reason ?? s.why)}`))
  if (result.notes?.length) lines.push('', 'Notes:', ...result.notes.slice(0, 30).map((n) => `- ${safe(n)}`))
  const missing = [...new Set(result.skipped.filter((s) => s.reason === 'label-missing').map((s) => s.label))]
  if (missing.length) lines.push('', `Labels missing in this repository (not created): ${missing.map((l) => `\`${safe(l)}\``).join(', ')}. A maintainer creates them with \`node .github/scripts/sync-labels.mjs --repo OWNER/REPO --apply\`.`)
  return lines.join('\n')
}

const out = (text) => (process.env.GITHUB_STEP_SUMMARY ? appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`) : console.log(text))
const setOutput = (name, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`) }
const readJson = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))

function main(command, env = process.env) {
  const repo = env.GH_REPO
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('set GH_REPO to owner/name')

  if (command === 'plan') {
    const mode = decideMode(env)
    const empty = { version: 1, mode, ops: [], skipped: [], notes: [] }
    if (mode === 'paused') {
      out(render(empty, mode))
      setOutput('live', 'false')
      setOutput('plan', JSON.stringify(empty))
      return
    }
    const config = readJson('../agent/controller.json')
    const gate = createGate(loadRules(fileURLToPath(new URL('../agent/risk-rules.json', import.meta.url))))
    const api = ghApi()
    const repoLabels = api.list(`repos/${repo}/labels?per_page=100`).map((l) => l.name)
    const issues = readIssues(api, repo, config)
    const prs = readPrs(api, repo, config, gate)
    const result = plan({ repo, config, now: Date.now(), repoLabels, issues, prs, linked: linkedPrs(prs, repo) })
    const full = { version: 1, mode, ...result }
    out(render(full, mode))
    console.log(`controller: ${mode}, ${result.ops.length} operation(s), ${result.skipped.length} skipped`)
    setOutput('live', mode === 'live' && result.ops.length > 0 ? 'true' : 'false')
    setOutput('plan', JSON.stringify({ version: 1, mode, ops: result.ops }))
  } else if (command === 'apply') {
    if (env.CONTROLLER_LIVE !== 'true' || env.AGENT_PAUSE === 'true') throw new Error('refusing to apply: not live (CONTROLLER_LIVE must be true and AGENT_PAUSE must not)')
    const p = JSON.parse(env.PLAN || 'null')
    if (p?.mode !== 'live') throw new Error('refusing to apply a plan that was not made in live mode')
    const result = apply(p, ghApi(), repo)
    out(`### Controller applied\n\n${result.done.length} label change(s) made, ${result.skipped.length} skipped.\n\n${result.done.map((o) => `- ${o.op} \`${safe(o.label)}\` on #${o.number} (${safe(o.reason)})`).join('\n')}`)
    console.log(`controller: applied ${result.done.length}, skipped ${result.skipped.length}`)
  } else throw new Error('usage: controller.mjs plan | apply')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]) } catch (e) { console.error(`controller: ${safe(e.message)}`); process.exit(1) }
}
