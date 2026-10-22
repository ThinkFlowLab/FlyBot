// The test-layer manifest and its check (#749).
//
//   node .github/scripts/testing-layers.mjs --check   # exit 1 and name what is unclassified
//   node .github/scripts/testing-layers.mjs --write   # regenerate the tables in docs/testing-layers.md
//
// `docs/testing-layers.json` maps every suite to the layer that runs it (L1 commit, L2 merge, L3
// self-test) or says `none` with a reason, and gives every workflow in `.github/workflows/` a row.
// The tables inside `docs/testing-layers.md` are generated from the manifest, so the prose and the
// data cannot drift. The check is the thing that keeps a new `*.test.mjs` or a new workflow from
// running nowhere: it names the file instead of passing quietly.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'

export const MANIFEST = 'docs/testing-layers.json'
export const DOC = 'docs/testing-layers.md'
export const LAYERS = ['L1', 'L2', 'L3', 'none']
export const WORKFLOW_KINDS = ['gate', 'workflow-only', 'not-a-layer']
export const BEGIN = '<!-- generated:testing-layers:begin -->'
export const END = '<!-- generated:testing-layers:end -->'
// A walk never enters these: they are installs, the git store, or a test bench with its own homes.
const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh-test'])

const toPosix = (p) => p.split(sep).join('/')

// `*` matches inside one path segment, `**` crosses segments, `/**/` may match no segment at all,
// and nothing else is special. `core/test/**/*.test.js` matches `core/test/a.test.js` too.
export function globMatch(pattern, path) {
  // Placeholders keep the `*` inside `**` from being rewritten by the single-segment rule below.
  const STAR_STAR = '\u0000starstar'
  const SLASH_STAR_STAR = '\u0000slashstarstar'
  const re = pattern
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\/\*\*\//g, SLASH_STAR_STAR)
    .replace(/\*\*/g, STAR_STAR)
    .replace(/\*/g, '[^/]*')
    .split(SLASH_STAR_STAR).join('/(?:.*/)?')
    .split(STAR_STAR).join('.*')
  return new RegExp('^' + re + '$').test(path)
}

export function collectTestFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.dsh-test-')) continue
        walk(rel)
      } else if (/\.test\.(m?[jt]s|cjs)$/.test(entry.name)) out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

export function collectWorkflows(root) {
  return readdirSync(join(root, '.github/workflows'))
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => `.github/workflows/${f}`)
    .sort()
}

export function loadManifest(root) {
  return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'))
}

// The schema problems that make the manifest itself untrustworthy, independent of the repository.
export function schemaProblems(manifest) {
  const problems = []
  for (const layer of Object.keys(manifest.layers ?? {})) {
    if (!LAYERS.includes(layer)) problems.push(`manifest: unknown layer "${layer}"`)
  }
  for (const layer of ['L1', 'L2', 'L3']) {
    const entry = manifest.layers?.[layer]
    if (!entry) problems.push(`manifest: layer ${layer} is missing`)
    else for (const field of ['name', 'trigger', 'guarantee', 'budget', 'command']) {
      if (!entry[field]) problems.push(`manifest: layer ${layer} has no ${field}`)
    }
  }
  const ids = new Set()
  for (const suite of manifest.suites ?? []) {
    if (!suite.id) problems.push('manifest: a suite row has no id')
    else if (ids.has(suite.id)) problems.push(`manifest: suite id "${suite.id}" appears twice`)
    ids.add(suite.id)
    if (!LAYERS.includes(suite.layer)) problems.push(`manifest: suite "${suite.id}" has unknown layer "${suite.layer}"`)
    if (!Array.isArray(suite.paths) || suite.paths.length === 0) problems.push(`manifest: suite "${suite.id}" names no path`)
    if (suite.layer === 'none' && !suite.reason) problems.push(`manifest: suite "${suite.id}" is "none" without a reason`)
    if (suite.layer !== 'none' && !suite.command) problems.push(`manifest: suite "${suite.id}" has no command`)
  }
  const workflowSeen = new Set()
  for (const row of manifest.workflows ?? []) {
    if (!row.workflow) problems.push('manifest: a workflow row has no workflow path')
    else if (workflowSeen.has(row.workflow)) problems.push(`manifest: workflow "${row.workflow}" appears twice`)
    workflowSeen.add(row.workflow)
    if (!LAYERS.includes(row.layer)) problems.push(`manifest: workflow "${row.workflow}" has unknown layer "${row.layer}"`)
    if (!WORKFLOW_KINDS.includes(row.kind)) problems.push(`manifest: workflow "${row.workflow}" has unknown kind "${row.kind}"`)
    if (row.layer === 'none' && !row.reason) problems.push(`manifest: workflow "${row.workflow}" is "none" without a reason`)
    // A workflow-only layer is one that carries no test file of its own (docker, the compat matrix,
    // live-e2e, label hygiene); a gate runs the suites or judges the entry; the rest are not a layer.
    if (row.kind !== 'not-a-layer' && !row.runs) problems.push(`manifest: workflow "${row.workflow}" has no "runs" trigger`)
    if (row.kind === 'gate' && !row.role) problems.push(`manifest: workflow "${row.workflow}" is a gate without a role`)
    if (row.kind === 'workflow-only' && !(row.role || row.reason)) problems.push(`manifest: workflow "${row.workflow}" says neither what it guarantees nor why it is not a layer`)
  }
  return problems
}

export function renderTables(manifest) {
  const rows = []
  rows.push('| Suite | Layer | Test files | Command |', '| --- | --- | --- | --- |')
  for (const suite of manifest.suites) {
    const layer = suite.layer === 'none' ? 'none (see reason)' : suite.layer
    const paths = suite.paths.map((p) => `\`${p}\``).join('<br>')
    const command = suite.layer === 'none' ? `— ${suite.reason}` : `\`${suite.command}\``
    rows.push(`| \`${suite.id}\` | ${layer} | ${paths} | ${command} |`)
  }
  rows.push('', '| Workflow | Kind | Layer | Gate | Runs on | What it guarantees, or why it is not a layer |', '| --- | --- | --- | --- | --- | --- |')
  for (const row of manifest.workflows) {
    const role = row.layer === 'none' ? row.reason : row.role
    rows.push(`| \`${row.workflow.replace('.github/workflows/', '')}\` | ${row.kind} | ${row.layer} | ${row.gate ? 'yes' : 'no'} | ${row.runs ?? '—'} | ${role} |`)
  }
  return rows.join('\n')
}

export function renderDoc(manifest, existing) {
  const table = renderTables(manifest)
  const begin = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)
  if (begin < 0 || end < begin) throw new Error(`${DOC} has no ${BEGIN} … ${END} block`)
  return existing.slice(0, begin + BEGIN.length) + '\n\n' + table + '\n\n' + existing.slice(end)
}

export function check({ root }) {
  const manifest = loadManifest(root)
  const problems = schemaProblems(manifest)

  // Every test file the repository holds belongs to exactly one suite row, or the row says `none`.
  const testFiles = collectTestFiles(root)
  const covered = new Set()
  for (const suite of manifest.suites ?? []) {
    for (const pattern of suite.paths ?? []) {
      for (const file of testFiles) if (globMatch(pattern, file)) covered.add(file)
    }
  }
  for (const file of testFiles) {
    if (!covered.has(file)) {
      problems.push(`unclassified test file: ${file} — add it to a suite row in ${MANIFEST}, or add a row with layer "none" and a reason`)
    }
  }

  // Every workflow has a row, and every row names a workflow that exists. A row for a workflow-only
  // layer is checked here, not against a test path it does not have.
  const workflows = collectWorkflows(root)
  const named = new Set((manifest.workflows ?? []).map((row) => row.workflow))
  for (const workflow of workflows) {
    if (!named.has(workflow)) {
      problems.push(`unclassified workflow: ${workflow} — add a row in ${MANIFEST} with its layer (or "none" and a reason)`)
    }
  }
  for (const workflow of named) {
    if (!workflows.includes(workflow)) problems.push(`manifest names a workflow that does not exist: ${workflow}`)
  }

  // The doc's tables are generated, so a manifest edit without a regenerate is a drift.
  const docPath = join(root, DOC)
  if (!existsSync(docPath)) problems.push(`${DOC} is missing`)
  else {
    const expected = renderTables(manifest)
    if (!readFileSync(docPath, 'utf8').includes(expected)) {
      problems.push(`${DOC} is out of date with ${MANIFEST} — run: node .github/scripts/testing-layers.mjs --write`)
    }
  }
  return { manifest, problems, testFiles, workflows }
}

export function write({ root }) {
  const manifest = loadManifest(root)
  const docPath = join(root, DOC)
  const next = renderDoc(manifest, readFileSync(docPath, 'utf8'))
  writeFileSync(docPath, next)
  return next
}

export function main({ root, argv = process.argv.slice(2) } = {}) {
  const base = root ?? process.cwd()
  if (argv.includes('--write')) {
    write({ root: base })
    console.log(`testing-layers: regenerated the tables in ${DOC}`)
    return { ok: true }
  }
  const { problems, testFiles, workflows } = check({ root: base })
  console.log(`testing-layers: ${testFiles.length} test file(s) in ${workflows.length} workflow(s)`)
  if (problems.length) {
    for (const problem of problems) console.log(`testing-layers: ${problem}`)
    return { ok: false, problems }
  }
  console.log('testing-layers: every test file and every workflow is classified')
  return { ok: true, problems }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = main()
  process.exit(result.ok ? 0 : 1)
}
