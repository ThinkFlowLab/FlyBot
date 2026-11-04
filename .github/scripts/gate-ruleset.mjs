// The ruleset that makes the check a gate (#812).
//
// A ruleset is identified by what it governs, never by its display name: the live one is called
// `main merge queue` while this file is called `main merge gate`, and a name-based lookup read that as
// "main is unprotected" (#2314). `.github/agent/merge-gate-ruleset.json` is the ruleset this file
// converges to.
//
// The check run is only half of #812: `enqueue-guard.yml` writes it, and a ruleset on `main` has to
// require it, or the refusal is a red badge a merge endpoint never reads. That file is the ruleset
// verbatim — branch ruleset, `enforcement: active`,
// `bypass_actors: []`, `refs/heads/main`, `tests-ok`, `enqueue-guard` and `policy-sign` required,
// `strict_required_status_checks_policy: false` (main moves on every merge, and a strict rule would make
// every open pull request rebase before it could merge).
//
//   node .github/scripts/gate-ruleset.mjs --check     # read-only: is main gated, and by what
//   node .github/scripts/gate-ruleset.mjs --apply     # create (or converge) it — an owner action
//   node .github/scripts/gate-ruleset.mjs --rollback  # delete it and prove it is gone
//
// Changing a repository's ruleset is not a Bot's call (AGENTS.md → Hard rules): `--apply` prints what it
// would do and needs the owner's word, which is why the merge is sequenced in the pull request and in
// #812 rather than performed here. `--check` writes nothing and is safe to run at any time.
//
// Order matters: the check must exist on the open pull requests *before* the ruleset does, or every one of
// them reads "Expected — waiting for status" and cannot merge (#639). `--apply` therefore reads the
// current state back and names any pull request that already carries the check, so the switch is a
// decision made with the evidence in front of it. The rollback is one DELETE by id: no state is kept
// anywhere but GitHub.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const BODY_PATH = fileURLToPath(new URL('../agent/merge-gate-ruleset.json', import.meta.url))
export const RULESET_NAME = 'main merge gate'
export const BASE_REF = 'refs/heads/main'
export const REQUIRED_CONTEXTS = ['tests-ok', 'enqueue-guard', 'policy-sign']

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const realGh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20, input, stdio: ['pipe', 'pipe', 'pipe'] })
const realGet = (path) => JSON.parse(realGh(['api', path]))

export function loadBody(path = BODY_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// The rules the check depends on, read out of a ruleset the API returned. `current_user_can_bypass` only
// appears on the single-ruleset GET, which is why `--check` fetches each one instead of trusting the list.
export function summarize(row) {
  const status = (row?.rules ?? []).find((r) => r?.type === 'required_status_checks')
  const pull = (row?.rules ?? []).find((r) => r?.type === 'pull_request')
  return {
    id: row?.id ?? null,
    name: row?.name ?? '',
    target: row?.target ?? '',
    enforcement: row?.enforcement ?? '',
    refs: row?.conditions?.ref_name?.include ?? [],
    bypass: (row?.bypass_actors ?? []).map((a) => `${a?.actor_type ?? '?'}:${a?.actor_id ?? '?'}`),
    canBypass: row?.current_user_can_bypass ?? null,
    strict: status?.parameters?.strict_required_status_checks_policy ?? null,
    contexts: (status?.parameters?.required_status_checks ?? []).map((c) => c?.context).filter(Boolean),
    approvals: pull?.parameters?.required_approving_review_count ?? null,
  }
}

// Everything that makes the gate real, as problems: an empty list is "main is gated". Each one is a
// separate line because they fail for different reasons and are fixed in different places.
//
// Drift is read in both directions: a context this file wants and the ruleset lacks, and a context the
// ruleset requires and this file does not carry. The second is the downgrade `--apply` must refuse, and
// on the live ruleset it is the only evidence of the drift a person can see without writing anything.
export function problems(row) {
  if (!row) return [`no active ruleset governs ${BASE_REF}: main is unprotected`]
  const s = summarize(row)
  const out = []
  if (s.enforcement !== 'active') out.push(`the ruleset is "${s.enforcement || 'missing'}", not active`)
  if (!s.refs.includes(BASE_REF)) out.push(`the ruleset does not include ${BASE_REF} (includes ${s.refs.join(', ') || 'nothing'})`)
  if (s.bypass.length) out.push(`the ruleset has bypass actors (${s.bypass.join(', ')}): the check can be skipped`)
  if (s.canBypass !== 'never') out.push(`current_user_can_bypass is "${s.canBypass ?? 'not reported'}", not "never"`)
  if (s.strict !== false) out.push(`strict_required_status_checks_policy is ${JSON.stringify(s.strict)}, not false: every open pull request would have to rebase first`)
  for (const context of REQUIRED_CONTEXTS) if (!s.contexts.includes(context)) out.push(`the required checks do not include "${context}" (they are ${s.contexts.join(', ') || 'none'})`)
  for (const context of s.contexts) if (!REQUIRED_CONTEXTS.includes(context)) out.push(`the ruleset also requires "${context}", which the body file does not carry: applying it would drop that context`)
  return out
}

// The body that will be sent: the file, unmodified. A ruleset body carries no comment fields, so the
// file is the request — everything explained lives here, not in JSON the API would reject.
export function bodyFor(path = BODY_PATH) {
  return loadBody(path)
}

// The rulesets that govern `main`: a branch ruleset whose `conditions.ref_name.include` names
// `refs/heads/main`. The list endpoint reports no `conditions`, so each row is read in full — which is
// what `--check` needs anyway for `current_user_can_bypass`.
export function findGoverning(repo, get = realGet) {
  return (listRulesets(repo, get) ?? [])
    .map((row) => (row?.id === undefined ? null : get(`repos/${repo}/rulesets/${row.id}`)))
    .filter((row) => String(row?.target ?? '') === 'branch' && (row?.conditions?.ref_name?.include ?? []).includes(BASE_REF))
}

// What a body would remove from the ruleset it is applied to: every context the live ruleset requires
// and the body does not carry, and the `merge_queue` rule. The body file in this repository lacks
// `merge-gate`, the Node 24 context and the queue rule, so applying it to the live `main merge queue`
// would weaken the gate it is supposed to describe.
export function downgrade(live, body) {
  const s = summarize(live)
  const wanted = summarize({ rules: body?.rules ?? [] })
  const out = []
  for (const context of s.contexts) {
    if (!wanted.contexts.includes(context)) out.push(`the body drops "${context}", which the live ruleset requires: refusing to apply a downgrade`)
  }
  const hasQueue = (rules) => (rules ?? []).some((rule) => rule?.type === 'merge_queue')
  if (hasQueue(live?.rules) && !hasQueue(body?.rules)) out.push('the body drops the merge_queue rule, which the live ruleset requires: refusing to apply a downgrade')
  return out
}

// `gh`/`get` are injectable so a test drives every mode without the network (`gh(args, input)`, the way
// controller.mjs calls `ghRaw`).
export function main({ mode = 'check', repo, gh = realGh, get = realGet, bodyPath = BODY_PATH, current = null } = {}) {
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  if (mode === 'apply') {
    const body = bodyFor(bodyPath)
    const [existing] = findGoverning(repo, get)
    // Decided before the first request: a downgrade that is discovered after the PUT is already written.
    const refused = existing ? downgrade(existing, body) : []
    if (refused.length) {
      return { ok: false, mode, action: 'refused', id: existing.id, name: existing.name ?? '', summary: summarize(existing), problems: refused }
    }
    const saved = existing
      // PUT, not PATCH: the rulesets API answers 404 to a PATCH on a repository ruleset.
      ? JSON.parse(gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${existing.id}`, '--input', '-'], JSON.stringify(body)))
      : JSON.parse(gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(body)))
    const readBack = get(`repos/${repo}/rulesets/${saved.id}`)
    const found = problems(readBack)
    return { ok: found.length === 0, mode, action: existing ? 'update' : 'create', id: saved.id, name: readBack?.name ?? body.name ?? '', summary: summarize(readBack), problems: found }
  }
  if (mode === 'rollback') {
    const [existing] = findGoverning(repo, get)
    if (!existing) return { ok: true, mode, action: 'none', problems: [] }
    gh(['api', '-X', 'DELETE', `repos/${repo}/rulesets/${existing.id}`])
    const left = findGoverning(repo, get)[0]
    return { ok: !left, mode, action: 'delete', id: existing.id, name: existing.name ?? '', problems: left ? [`the ruleset ${left.id} is still listed after the delete`] : [] }
  }
  const [hit] = findGoverning(repo, get)
  if (!hit) return { ok: false, mode: 'check', problems: problems(null), summary: null }
  const found = problems(hit)
  return { ok: found.length === 0, mode: 'check', id: hit.id, summary: summarize(hit), problems: found }
}

export function listRulesets(repo, get = realGet) {
  return get(`repos/${repo}/rulesets`)
}

export function render(result) {
  const lines = []
  const label = result.name || result.summary?.name || RULESET_NAME
  if (result.mode === 'apply') {
    lines.push(result.action === 'refused'
      ? `gate-ruleset: refused to write "${label}" (id ${result.id})`
      : `gate-ruleset: ${result.action}d "${label}" (id ${result.id})`)
  } else if (result.mode === 'rollback') {
    lines.push(result.action === 'delete' ? `gate-ruleset: deleted "${label}" (id ${result.id})` : `gate-ruleset: nothing governs ${BASE_REF} to roll back`)
  }
  if (result.summary) {
    const s = result.summary
    lines.push(`gate-ruleset: ${s.enforcement}, ${s.target} ${s.refs.join(', ')}, bypass [${s.bypass.join(', ')}], can-bypass ${s.canBypass ?? 'not reported'}, strict ${JSON.stringify(s.strict)}, requires [${s.contexts.join(', ')}], approvals ${s.approvals ?? '—'}`)
  }
  if (result.problems?.length) {
    lines.push(result.ok ? 'gate-ruleset: OK' : 'gate-ruleset: NOT GATED')
    for (const problem of result.problems) lines.push(`gate-ruleset: ${problem}`)
  } else {
    lines.push('gate-ruleset: OK — main requires the checks and nobody can bypass them')
  }
  return lines.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--rollback') ? 'rollback' : 'check'
  try {
    const result = main({ mode, repo: arg('--repo') || process.env.GH_REPO })
    console.log(render(result))
    process.exit(result.ok ? 0 : 1)
  } catch (e) {
    console.error(`gate-ruleset: ${e.message}`)
    process.exit(1)
  }
}
