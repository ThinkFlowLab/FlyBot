// The pure half of the merge gate: constants, the lookup helpers, evaluate(), render(). No network,
// no process.argv. The four gates are described at the top of merge-gate.mjs, their fixtures live in
// merge-gate-self-test.mjs. Issue #3401.
export const ROLLUP_CHECK = 'FlyBot required checks'

// One name per check run that the seven suite jobs of .github/workflows/tests.yml publish today
// (matrix legs and reusable-workflow jobs each publish their own name). Recorded from the 16 check
// runs of PR #3400, head 59a1eb15, on 2026-11-26. A new suite job is a deliberate edit here.
export const REQUIRED_CHECKS = [
  'Web and compose planner', // frontend
  'Management API · Python 3.11', // management, matrix
  'Management API · Python 3.13',
  'upstream / Pin and vendor tree', // upstream, reusable workflow
  'upstream / Upstream suite · Node 22 · DSH from pin',
  'upstream / Upstream suite · Node 24 · DSH from pin',
  'upstream / Container startup smoke',
  'runtime-image / Image recipe contract tests', // runtime-image
  'runtime-image / Build and smoke under the manager contract',
  'social-host / Social plugin on the pinned DS-Bot host', // social-host
  'social-host / Façade and ledger unit tests',
  'browser / screenshots', // browser
  'provenance / provenance', // provenance
  'provenance / flybot-social-plugin-tests',
  'provenance / bot-social-source-tests',
]

// The two literals the evidence comments must carry, next to the head sha. They are the wording the
// group agreed on, so the check does not depend on anyone's phrasing of anything else.
//
// English since 2026-11-27: everything the repository writes is English, PR comments included. Until
// then the markers were Chinese, and those comments are still on real pull requests - so the old
// sentences stay as legacy aliases rather than becoming evidence that cannot be read any more. A
// comment counts when it carries the head and any one of the markers for its kind.
//
// The legacy sentences are written as \u escapes on purpose: the file stays ASCII (the repository
// has no Chinese in its own sources any more), while the string it produces is exactly the old
// sentence. The code points are pinned by the unit tests, so a typo cannot quietly stop matching.
export const QA_MARKER = 'This evidence is not an acceptance sign-off'
export const REVIEW_MARKER = 'Lead review record'

export const LEGACY_QA_MARKER = '\u672c\u8bc1\u636e\u4e0d\u6784\u6210\u9a8c\u6536\u901a\u8fc7'
export const LEGACY_REVIEW_MARKER = 'Lead \u8bc4\u5ba1\u8bb0\u5f55'

export const QA_MARKERS = [QA_MARKER, LEGACY_QA_MARKER]
export const REVIEW_MARKERS = [REVIEW_MARKER, LEGACY_REVIEW_MARKER]

export const RISK_LABEL = /^risk:T[0-3]$/

const SHA = /^[0-9a-f]{40}$/
const short = (sha) => String(sha || '').slice(0, 10)

const isSuccess = (run) => run.status === 'completed' && run.conclusion === 'success'

// The newest run per check name. check-runs are asked for with filter=latest, but a gate should not
// depend on the API honouring that, so a re-run cannot hide behind an earlier green attempt.
function latestByName(runs) {
  const out = new Map()
  for (const run of runs) {
    const seen = out.get(run.name)
    const at = Date.parse(run.started_at || run.completed_at || 0) || 0
    const seenAt = seen ? Date.parse(seen.started_at || seen.completed_at || 0) || 0 : -1
    if (!seen || at >= seenAt) out.set(run.name, run)
  }
  return out
}

const bodies = (comments) => comments.map((c) => ({ id: c.id, body: String(c.body || ''), url: c.html_url || '' }))

// One comment that carries the head and any one of the markers for its kind. Markers arrive as an
// array so the legacy sentence counts exactly like the current one; a bare string is still accepted,
// so a caller that wants a single literal keeps working.
function evidence(comments, head, markers) {
  const list = Array.isArray(markers) ? markers : [markers]
  return bodies(comments).filter((c) => c.body.includes(head) && list.some((m) => c.body.includes(m)))
}

// A failure line has to name every accepted literal: the author reads it to learn what to paste, and
// naming only the current one would hide that an older comment of theirs already counts.
const quoted = (markers) => markers.map((m) => `"${m}"`).join(' or ')

// Pure: everything it needs is passed in, so --self-test and the unit tests need no network.
export function evaluate({ number, pr, checkRuns, comments }) {
  const head = pr?.head?.sha || ''
  const labels = (pr?.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean)
  const gates = []

  // 1. head and state
  {
    const detail = []
    let pass = true
    const fail = (msg) => { pass = false; detail.push(msg) }
    if (pr?.state !== 'open') fail(`state is ${pr?.state ?? 'missing'}, not open`)
    if (pr?.draft !== false) fail(`draft is ${pr?.draft ?? 'missing'}, not false`)
    if (pr?.mergeable === null || pr?.mergeable === undefined) fail('mergeable is not computed yet (GitHub returns null); ask again')
    else if (pr.mergeable !== true) fail(`mergeable is ${pr.mergeable}`)
    if (pr?.base?.ref !== 'main') fail(`base is ${pr?.base?.ref ?? 'missing'}, not main`)
    if (!SHA.test(head)) fail(`head is ${JSON.stringify(head)}, not a 40-character sha`)
    if (pass) detail.push(`open, not a draft, mergeable, base main, head ${head}`)
    gates.push({ n: 1, name: 'head and state', pass, detail })
  }

  // 2. required checks, all on this head
  {
    const detail = []
    const byName = latestByName(checkRuns || [])
    const missing = []
    const notGreen = []
    for (const name of [...REQUIRED_CHECKS, ROLLUP_CHECK]) {
      const run = byName.get(name)
      if (!run) missing.push(name)
      else if (!isSuccess(run)) notGreen.push(`${name} ${run.status || '?'}|${run.conclusion || '?'}`)
    }
    const pass = missing.length === 0 && notGreen.length === 0
    if (pass) detail.push(`${REQUIRED_CHECKS.length} required checks and ${ROLLUP_CHECK} completed success on ${short(head)}`)
    for (const name of missing) detail.push(`missing: ${name}`)
    for (const line of notGreen) detail.push(`not green: ${line}`)
    gates.push({ n: 2, name: 'required checks', pass, detail })
  }

  // 3. both pieces of evidence, both on this head
  {
    const detail = []
    const qa = evidence(comments, head, QA_MARKERS)
    const review = evidence(comments, head, REVIEW_MARKERS)
    const pass = qa.length > 0 && review.length > 0
    if (pass) detail.push(`QA ${qa.map((c) => `#${c.id}`).join(' ')}; review ${review.map((c) => `#${c.id}`).join(' ')} - both name ${short(head)}`)
    if (!qa.length) detail.push(`no comment carries ${short(head)} and ${quoted(QA_MARKERS)}`)
    if (!review.length) detail.push(`no comment carries ${short(head)} and ${quoted(REVIEW_MARKERS)}`)
    gates.push({ n: 3, name: 'evidence on this head', pass, detail })
  }

  // 4. risk label: the tier is information, the label itself is the record. No tier blocks a merge
  //    (the merge is the Lead's call); a missing or doubled label does, as a fact about the record.
  //    The tier's reason is in the risk-gate comment; this script reads labels, not the diff.
  {
    const detail = []
    const risk = labels.filter((n) => RISK_LABEL.test(n))
    let pass = true
    if (risk.length === 0) {
      pass = false
      detail.push('no risk:T0..T3 label (the script that judges the diff must put it there; it is never hand-written)')
    } else if (risk.length > 1) {
      pass = false
      detail.push(`more than one risk label: ${risk.join(' ')} - two verdicts on one diff`)
    } else detail.push(`${risk[0]} - advisory only, merge is Lead's call`)
    gates.push({ n: 4, name: 'risk (advisory)', pass, detail })
  }

  const pass = gates.every((g) => g.pass)
  return { number, head, pass, gates }
}

export function render(result) {
  const lines = [`merge-gate (report only): PR #${result.number} head ${result.head} -> ${result.pass ? 'PASS' : 'FAIL'} (${result.gates.filter((g) => g.pass).length}/${result.gates.length} gates)`]
  for (const gate of result.gates) {
    lines.push(`  ${gate.n}. ${gate.name.padEnd(21)} ${gate.pass ? 'PASS' : 'FAIL'}  ${gate.detail[0] || ''}`)
    for (const line of gate.detail.slice(1)) lines.push(`  ${' '.repeat(25)}${line}`)
  }
  return lines.join('\n')
}
