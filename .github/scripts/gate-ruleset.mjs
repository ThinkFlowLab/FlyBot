// The ruleset that makes the check a gate (#812).
//
// The check run is only half of #812: `enqueue-guard.yml` writes it, and a ruleset on `main` has to
// require it, or the refusal is a red badge a merge endpoint never reads. `.github/agent/
// merge-gate-ruleset.json` is that ruleset verbatim — branch ruleset, `enforcement: active`,
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
export function problems(row) {
  if (!row) return [`no ruleset named "${RULESET_NAME}" on ${BASE_REF}: main is unprotected`]
  const s = summarize(row)
  const out = []
  if (s.enforcement !== 'active') out.push(`the ruleset is "${s.enforcement || 'missing'}", not active`)
  if (!s.refs.includes(BASE_REF)) out.push(`the ruleset does not include ${BASE_REF} (includes ${s.refs.join(', ') || 'nothing'})`)
  if (s.bypass.length) out.push(`the ruleset has bypass actors (${s.bypass.join(', ')}): the check can be skipped`)
  if (s.canBypass !== 'never') out.push(`current_user_can_bypass is "${s.canBypass ?? 'not reported'}", not "never"`)
  if (s.strict !== false) out.push(`strict_required_status_checks_policy is ${JSON.stringify(s.strict)}, not false: every open pull request would have to rebase first`)
  for (const context of REQUIRED_CONTEXTS) if (!s.contexts.includes(context)) out.push(`the required checks do not include "${context}" (they are ${s.contexts.join(', ') || 'none'})`)
  return out
}

// The body that will be sent: the file, unmodified. A ruleset body carries no comment fields, so the
// file is the request — everything explained lives here, not in JSON the API would reject.
export function bodyFor(path = BODY_PATH) {
  return loadBody(path)
}

export function findByRow(rows, name = RULESET_NAME) {
  return (rows ?? []).find((row) => String(row?.name ?? '') === name) ?? null
}

// `gh`/`get` are injectable so a test drives every mode without the network (`gh(args, input)`, the way
// controller.mjs calls `ghRaw`).
export function main({ mode = 'check', repo, gh = realGh, get = realGet, bodyPath = BODY_PATH, current = null } = {}) {
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  if (mode === 'apply') {
    const body = bodyFor(bodyPath)
    const existing = findByRow(listRulesets(repo, get))
    const saved = existing
      // PUT, not PATCH: the rulesets API answers 404 to a PATCH on a repository ruleset.
      ? JSON.parse(gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${existing.id}`, '--input', '-'], JSON.stringify(body)))
      : JSON.parse(gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(body)))
    const readBack = get(`repos/${repo}/rulesets/${saved.id}`)
    const found = problems(readBack)
    return { ok: found.length === 0, mode, action: existing ? 'update' : 'create', id: saved.id, summary: summarize(readBack), problems: found }
  }
  if (mode === 'rollback') {
    const existing = findByRow(listRulesets(repo, get))
    if (!existing) return { ok: true, mode, action: 'none', problems: [] }
    gh(['api', '-X', 'DELETE', `repos/${repo}/rulesets/${existing.id}`])
    const left = findByRow(listRulesets(repo, get))
    return { ok: !left, mode, action: 'delete', id: existing.id, problems: left ? [`the ruleset ${existing.id} is still listed after the delete`] : [] }
  }
  const rows = listRulesets(repo, get)
  const hit = findByRow(rows)
  if (!hit) return { ok: false, mode: 'check', problems: problems(null), summary: null }
  const row = get(`repos/${repo}/rulesets/${hit.id}`)
  const found = problems(row)
  return { ok: found.length === 0, mode: 'check', id: hit.id, summary: summarize(row), problems: found }
}

export function listRulesets(repo, get = realGet) {
  return get(`repos/${repo}/rulesets`)
}

export function render(result) {
  const lines = []
  if (result.mode === 'apply') lines.push(`gate-ruleset: ${result.action}d "${RULESET_NAME}" (id ${result.id})`)
  else if (result.mode === 'rollback') lines.push(result.action === 'delete' ? `gate-ruleset: deleted "${RULESET_NAME}" (id ${result.id})` : `gate-ruleset: no ruleset named "${RULESET_NAME}" to roll back`)
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
