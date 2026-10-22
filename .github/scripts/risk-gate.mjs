// Risk tier of a pull request (Phase 0: report only; see docs/autonomous-dev.md).
//
//   PR=12 GH_REPO=owner/repo GH_TOKEN=... node risk-gate.mjs    # what the workflow runs
//   node risk-gate.mjs --pr 12 [--repo owner/repo]               # same, by hand
//   node risk-gate.mjs --replay 30 [--repo owner/repo]           # tiers of the last N merged PRs
//
// The PR is read only through the GitHub API (list of changed files and their patches); no PR
// code is checked out or run. The tier is the highest of: the path of every changed file (and
// the old path of a rename), content hits in added lines of code files, and a size cap.
// The script prints the tier and exits 0. It exits 1 only when it could not compute one.
import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ORDER = ['T0', 'T1', 'T2', 'T3']
const MAX_FILES = 3000 // the pull request files API stops here

// Glob: `**/` any directories (or none), `**` anything, `*` within a segment, `?` one character,
// `{a,b}` alternatives (literals). Everything else is literal.
export function globToRe(g) {
  const lit = (s) => s.replace(/[.+^$()|[\]\\{}*?]/g, '\\$&')
  let re = ''
  let i = 0
  while (i < g.length) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3 } else { re += '.*'; i += 2 }
    } else if (c === '*') { re += '[^/]*'; i++ }
    else if (c === '?') { re += '[^/]'; i++ }
    else if (c === '{' && g.indexOf('}', i) > i) {
      const j = g.indexOf('}', i)
      re += '(?:' + g.slice(i + 1, j).split(',').map(lit).join('|') + ')'
      i = j + 1
    } else { re += lit(c); i++ }
  }
  return new RegExp('^' + re + '$')
}

export function createGate(rules) {
  const t3 = rules.tiers.T3
  const paths = Object.fromEntries(Object.entries(rules.tiers).map(([t, d]) => [t, (d.paths || []).map(globToRe)]))
  const generated = (rules.generatedPaths || []).map(globToRe)
  const codeExt = new RegExp(t3.codeExt)
  const compile = (list) => (list || []).map((p) => [p, new RegExp(p)])
  const patterns = compile(t3.diffPatterns) // every code file
  const prosePatterns = compile(t3.diffPatternsNotInTests) // code files except tests: a test may quote a URL or a fence
  const tests = (t3.testPaths || []).map(globToRe)
  const unknown = rules.unknownPathTier || 'T2'
  const isGenerated = (name) => generated.some((r) => r.test(name))

  function tierOf(file) {
    for (const t of ['T3', 'T2', 'T1', 'T0']) if (paths[t].some((r) => r.test(file))) return t
    return unknown
  }

  // files: the array of GET /pulls/{n}/files. truncated: the list may be incomplete.
  function judge(files, { truncated = false } = {}) {
    let tier = 'T0'
    const why = []
    const bump = (t, reason) => {
      if (ORDER.indexOf(t) > ORDER.indexOf(tier)) tier = t
      if (reason) why.push(reason)
    }
    // Every path the rules were asked about, with the tier it got: the machine-readable line at
    // the end of the report is built from this, not from a second walk over the rules.
    const basis = []
    if (truncated || files.length >= MAX_FILES) bump('T3', `file list may be incomplete (${files.length} files)`)
    for (const f of files) {
      for (const name of [f.filename, f.previous_filename].filter(Boolean)) {
        const t = tierOf(name)
        basis.push([name, t])
        bump(t, t === 'T3' ? `path ${name}` : null)
      }
      if (isGenerated(f.filename)) continue // generated files are verified by `patches check`, not read here
      if (f.changes > 0 && f.patch === undefined) { bump('T3', `diff not inspectable: ${f.filename}`); continue }
      if (!codeExt.test(f.filename)) continue // patterns look at code, not prose
      const added = (f.patch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n')
      const active = tests.some((r) => r.test(f.filename)) ? patterns : [...patterns, ...prosePatterns]
      for (const [src, re] of active) if (re.test(added)) bump('T3', `${f.filename}: /${src.slice(0, 60)}/`)
      for (const w of t3.topics || []) if (added.includes(w)) bump('T3', `${f.filename}: topic ${w}`)
    }
    const real = files.filter((f) => !isGenerated(f.filename))
    const lines = real.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0)
    const lim = (rules.limits || {})[tier]
    if (lim && (lines > lim.lines || real.length > lim.files)) {
      bump('T3', `size ${lines} lines / ${real.length} files > ${lim.lines} / ${lim.files} allowed for ${tier}`)
    }
    const seen = new Map()
    for (const [path, t] of basis) if (!seen.has(path)) seen.set(path, t)
    const ordered = [...seen].map(([path, t]) => ({ path, tier: t }))
      .sort((a, b) => ORDER.indexOf(b.tier) - ORDER.indexOf(a.tier) || a.path.localeCompare(b.path))
    return { tier, why: [...new Set(why)], lines, files: real.length, generated: files.length - real.length, basis: ordered }
  }

  return { tierOf, judge }
}

// The one machine-readable line the job summary ends with (#609): the tier and the paths that
// set it, from the same judge() result the human-readable report is built from, so a reviewer can
// quote a tier instead of guessing one.
export const SUMMARY_LIMIT = 10
export function summaryLine({ tier, basis = [] }) {
  const shown = basis.slice(0, SUMMARY_LIMIT).map((b) => `${b.path}=${b.tier}`)
  const rest = basis.length > SUMMARY_LIMIT ? `, +${basis.length - SUMMARY_LIMIT} more` : ''
  return basis.length === 0 ? `risk-tier: ${tier}; basis: none (no changed files)` : `risk-tier: ${tier}; basis: ${shown.join(', ')}${rest}`
}

export function render(result, meaning) {
  const { tier, why, lines, files, generated } = result
  const out = [
    `### Risk tier: ${tier}`,
    '',
    `${meaning[tier] || ''}`,
    '',
    `Size (generated files excluded): ${lines} changed lines in ${files} files${generated ? `; ${generated} generated file(s) not counted` : ''}.`,
  ]
  if (why.length) {
    out.push('', 'Why:', ...why.slice(0, 20).map((w) => `- ${w}`))
    if (why.length > 20) out.push(`- ... and ${why.length - 20} more`)
  }
  out.push('', '_Report only (Phase 0): this does not block, label or merge anything. Rules: `.github/agent/risk-rules.json`; see `docs/autonomous-dev.md`._', '', summaryLine(result))
  return out.join('\n')
}

export function loadRules(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 << 20 })
// paginated list endpoint -> array (one JSON value per line, so no `gh api --slurp` needed)
const list = (path) => gh('api', '--paginate', '--jq', '.[]', path).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const prFiles = (repo, n) => list(`repos/${repo}/pulls/${n}/files?per_page=100`)

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

function main() {
  const rulesPath = arg('--rules') || process.env.RISK_RULES || fileURLToPath(new URL('../agent/risk-rules.json', import.meta.url))
  const rules = loadRules(rulesPath)
  const gate = createGate(rules)
  const meaning = Object.fromEntries(Object.entries(rules.tiers).map(([t, d]) => [t, d.meaning]))
  const repo = arg('--repo') || process.env.GH_REPO
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')

  if (arg('--replay')) {
    const n = Number(arg('--replay'))
    const prs = JSON.parse(gh('pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(n), '--json', 'number,title'))
    const dist = Object.fromEntries(ORDER.map((t) => [t, 0]))
    for (const pr of prs.sort((a, b) => a.number - b.number)) {
      const r = gate.judge(prFiles(repo, pr.number))
      dist[r.tier]++
      console.log(`#${pr.number}\t${r.tier}\t${r.lines}L/${r.files}F\t${pr.title.slice(0, 60)}\n\t${r.why.slice(0, 4).join(' | ')}`)
    }
    console.log(`\nDistribution over ${prs.length} merged PRs: ` + ORDER.map((t) => `${t} ${dist[t]}`).join(', '))
    return
  }

  const pr = arg('--pr') || process.env.PR
  if (!pr) throw new Error('set PR or pass --pr N (or --replay N)')
  const r = gate.judge(prFiles(repo, pr))
  const text = render(r, meaning)
  console.log(`risk-gate (report only): PR #${pr} tier ${r.tier}${r.why.length ? '; ' + r.why.slice(0, 5).join('; ') : ''}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
  else console.log('\n' + text)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (e) { console.error(`risk-gate: ${e.message}`); process.exit(1) }
}
