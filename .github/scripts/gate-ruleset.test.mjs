// gate-ruleset (#812): the ruleset that turns the `enqueue-guard` check into a gate, and the switches
// that would quietly turn it back into a report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BODY_PATH, REQUIRED_CONTEXTS, RULESET_NAME, bodyFor, main, problems, render, summarize } from './gate-ruleset.mjs'

const REPO = 'Birfy/FlyBot'

// The ruleset the API returns for `.github/agent/merge-gate-ruleset.json` once it has been created, with
// the read-only fields GitHub adds on the single-ruleset GET.
const goodRow = () => {
  const body = bodyFor()
  return { id: 7, ...body, current_user_can_bypass: 'never', source_type: 'Repository', source: REPO }
}

const fakeRepo = ({ rulesets = [], ignoreDelete = false } = {}) => {
  const state = {
    list: rulesets.map((r) => ({ id: r.id, name: r.name, target: r.target, enforcement: r.enforcement })),
    details: new Map(rulesets.map((r) => [r.id, r])),
    writes: [],
    nextId: 50,
  }
  const get = (path) => {
    if (/\/rulesets$/.test(path)) return state.list.map(({ id, name }) => ({ id, name }))
    const hit = /\/rulesets\/(\d+)$/.exec(path)
    if (hit) {
      const row = state.details.get(Number(hit[1]))
      if (!row) throw new Error('gh: Not Found (HTTP 404)')
      return row
    }
    throw new Error('fake get: unexpected ' + path)
  }
  const gh = (args, input) => {
    const path = String(args.find((a) => String(a).startsWith('repos/')) ?? args.at(-1))
    const method = args[args.indexOf('-X') + 1]
    state.writes.push({ method, path, sent: input ? JSON.parse(input) : null })
    if (method === 'POST') {
      const row = { id: state.nextId++, ...JSON.parse(input), current_user_can_bypass: 'never' }
      state.list.push({ id: row.id, name: row.name, target: row.target, enforcement: row.enforcement })
      state.details.set(row.id, row)
      return JSON.stringify(row)
    }
    if (method === 'PUT') {
      const id = Number(path.split('/').at(-1))
      const row = { id, ...JSON.parse(input), current_user_can_bypass: 'never' }
      state.details.set(id, row)
      return JSON.stringify(row)
    }
    if (method === 'DELETE') {
      const id = Number(path.split('/').at(-1))
      // `ignoreDelete` keeps the row listed the way a ruleset GitHub did not remove still would be: the
      // point is the read after the DELETE, not the fake's bookkeeping.
      if (!ignoreDelete) {
        state.list = state.list.filter((r) => r.id !== id)
        state.details.delete(id)
      }
      return ''
    }
    throw new Error('fake gh: unexpected write ' + method)
  }
  return { state, gh, get }
}

test('#812: the ruleset requires both checks, on main, with nobody able to bypass it', () => {
  const body = bodyFor(BODY_PATH)
  assert.equal(body.name, RULESET_NAME)
  assert.equal(body.target, 'branch')
  assert.equal(body.enforcement, 'active')
  assert.deepEqual(body.bypass_actors, [])
  assert.deepEqual(body.conditions.ref_name.include, ['refs/heads/main'])
  const status = body.rules.find((r) => r.type === 'required_status_checks').parameters
  assert.deepEqual(status.required_status_checks.map((c) => c.context).sort(), [...REQUIRED_CONTEXTS].sort())
  assert.equal(status.strict_required_status_checks_policy, false)
  // T2/T3 need no approve (owner decision 2026-10-22): the rule requires a pull request, not a signature.
  const pull = body.rules.find((r) => r.type === 'pull_request').parameters
  assert.equal(pull.required_approving_review_count, 0)
  // Nobody force-pushes or deletes main to get around the check.
  const types = body.rules.map((r) => r.type)
  assert.ok(types.includes('non_fast_forward'), types.join(', '))
  assert.ok(types.includes('deletion'), types.join(', '))
})

test('#812: a correctly built ruleset has no problems', () => {
  assert.deepEqual(problems(goodRow()), [])
  const s = summarize(goodRow())
  assert.deepEqual(s.contexts.sort(), [...REQUIRED_CONTEXTS].sort())
  assert.equal(s.canBypass, 'never')
  assert.deepEqual(s.bypass, [])
})

test('#2124: the gate requires the signature job as a context of its own', () => {
  // The signature used to be a step inside `test`, and a required context is a job name: deleting
  // the step left the suite green and nothing was missing. Here it is a job, so it enters the
  // ruleset the way the other two contexts do — and `--check` reads the live ruleset against it.
  const s = summarize(goodRow())
  assert.ok(s.contexts.includes('policy-sign'), `the required checks are ${s.contexts.join(', ')}`)
  assert.ok(REQUIRED_CONTEXTS.includes('policy-sign'), `gate-ruleset calls ${REQUIRED_CONTEXTS.join(', ')} required`)
})

test('#812: every way the gate could be bypassed is a separate problem', () => {
  const cases = [
    ['a bypass actor', (row) => { row.bypass_actors = [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }] }, /bypass actors/],
    ['an admin escape hatch', (row) => { row.current_user_can_bypass = 'always' }, /current_user_can_bypass is "always"/],
    ['a bypass nobody reported', (row) => { delete row.current_user_can_bypass }, /not reported/],
    ['strict checks', (row) => { row.rules.find((r) => r.type === 'required_status_checks').parameters.strict_required_status_checks_policy = true }, /strict_required_status_checks_policy is true/],
    ['a missing context', (row) => { row.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks = [{ context: 'tests-ok' }] }, /do not include "enqueue-guard"/],
    ['an inactive ruleset', (row) => { row.enforcement = 'evaluate' }, /not active/],
    ['another ref', (row) => { row.conditions.ref_name.include = ['refs/heads/release'] }, /does not include refs\/heads\/main/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const row = goodRow()
    mutate(row)
    const found = problems(row)
    assert.ok(found.some((p) => pattern.test(p)), `${name}: ${found.join(' | ')}`)
  }
  // A missing ruleset is the state #812 was filed about: no gate at all.
  assert.match(problems(null)[0], /main is unprotected/)
})

test('#812: --check is read-only and says what is missing', () => {
  const { state, gh, get } = fakeRepo()
  const r = main({ mode: 'check', repo: REPO, gh, get })
  assert.equal(r.ok, false)
  assert.match(r.problems[0], /main is unprotected/)
  assert.equal(state.writes.length, 0)
})

test('#812: --check reads the detail, not the list, because only the detail reports who can bypass', () => {
  const seen = []
  const get = (path) => {
    seen.push(path)
    if (/\/rulesets$/.test(path)) return [{ id: 7, name: RULESET_NAME }]
    return goodRow()
  }
  const r = main({ mode: 'check', repo: REPO, get })
  assert.equal(r.ok, true, r.problems.join('; '))
  assert.ok(seen.includes(`repos/${REPO}/rulesets/7`), seen.join(', '))
  assert.equal(r.summary.canBypass, 'never')
})

test('#812: --apply posts the file itself and reads the result back', () => {
  const { state, gh, get } = fakeRepo()
  const r = main({ mode: 'apply', repo: REPO, gh, get })
  assert.equal(r.ok, true, r.problems.join('; '))
  assert.equal(r.action, 'create')
  const post = state.writes.find((w) => w.method === 'POST')
  assert.ok(post, 'no POST was made')
  assert.deepEqual(post.sent, bodyFor())
  // Read back, not trusted: the summary is what GitHub now holds.
  assert.deepEqual(r.summary.contexts.sort(), [...REQUIRED_CONTEXTS].sort())
})

test('#812: --apply converges an existing ruleset with PUT, not PATCH', () => {
  const { state, gh, get } = fakeRepo({ rulesets: [goodRow()] })
  const r = main({ mode: 'apply', repo: REPO, gh, get })
  assert.equal(r.ok, true, r.problems.join('; '))
  assert.equal(r.action, 'update')
  const put = state.writes.find((w) => w.method === 'PUT')
  assert.ok(put, 'no PUT was made')
  assert.match(put.path, /\/rulesets\/7$/)
  assert.deepEqual(put.sent, bodyFor())
})

test('#812: --rollback deletes the ruleset and proves it is gone', () => {
  const { state, gh, get } = fakeRepo({ rulesets: [goodRow()] })
  const r = main({ mode: 'rollback', repo: REPO, gh, get })
  assert.equal(r.ok, true, r.problems.join('; '))
  assert.equal(r.action, 'delete')
  assert.equal(state.list.length, 0)
  assert.equal(state.writes.filter((w) => w.method === 'DELETE').length, 1)
})

test('#812: --rollback reads the list again — a ruleset still listed after the delete is not gone', () => {
  const { gh, get } = fakeRepo({ rulesets: [goodRow()], ignoreDelete: true })
  const r = main({ mode: 'rollback', repo: REPO, gh, get })
  assert.equal(r.ok, false, 'a ruleset still listed must not be reported as deleted')
  assert.equal(r.action, 'delete')
  assert.match(r.problems.join('; '), /still listed after the delete/)
})

test('#812: --rollback with nothing to roll back is not an error and writes nothing', () => {
  const { state, gh, get } = fakeRepo()
  const r = main({ mode: 'rollback', repo: REPO, gh, get })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'none')
  assert.equal(state.writes.length, 0)
})

test('#812: the printed report names one problem per line, and nothing when it is gated', () => {
  const bad = render({ ok: false, mode: 'check', problems: ['main is unprotected'], summary: null })
  assert.match(bad, /NOT GATED/)
  assert.match(bad, /main is unprotected/)
  const good = render({ ok: true, mode: 'check', problems: [], summary: summarize(goodRow()) })
  assert.match(good, /OK — main requires the checks and nobody can bypass them/)
})
