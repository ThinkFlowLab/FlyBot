// The layer manifest (#749): every test file and every workflow is classified, and the check that
// enforces it names what it cannot place. The real repository is one case; the rest run against a
// small fixture so the two required reds — a dropped suite row and a dropped workflow-only row — are
// tested without editing the branch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { check, renderDoc, renderTables, globMatch, loadManifest, BEGIN, END, MANIFEST, DOC } from './testing-layers.mjs'

const repo = join(import.meta.dirname, '..', '..')

// A miniature repository: the manifest rows it is given, the files on disk, and a generated doc.
function fixture({ suites, workflows, files, workflowsOnDisk, staleDoc = false }) {
  const root = mkdtempSync(join(tmpdir(), 'testing-layers-'))
  const manifest = { ...loadManifest(repo), suites, workflows }
  const write = (rel, text) => { mkdirSync(join(root, dirname(rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
  write(MANIFEST, JSON.stringify(manifest, null, 2))
  for (const rel of files) write(rel, '// fixture test file\n')
  for (const rel of workflowsOnDisk) write(rel, 'name: fixture\non: push\n')
  const empty = `${BEGIN}\n${END}\n`
  write(DOC, staleDoc ? empty : renderDoc(manifest, empty))
  return root
}

const realSuite = (id) => loadManifest(repo).suites.find((s) => s.id === id)
const realWorkflow = (id) => loadManifest(repo).workflows.find((w) => w.id === id)

// The repository as it is: every test file and every workflow is classified, and the doc matches.
test('#749: the repository classifies every test file and every workflow', () => {
  const { problems, testFiles, workflows } = check({ root: repo })
  assert.deepEqual(problems, [])
  assert.ok(testFiles.length > 100, `expected the repository to hold many test files, saw ${testFiles.length}`)
  assert.ok(workflows.includes('.github/workflows/test.yml'))
})

// A suite row that disappears takes its whole suite out of every layer: that must fail, and name the
// files nobody runs any more.
test('#749: removing the plugins/timeline row fails the check and names its test file', () => {
  const suites = loadManifest(repo).suites.filter((s) => s.id !== 'plugins/timeline')
  const root = fixture({
    suites,
    workflows: [realWorkflow('test'), realWorkflow('docker')],
    files: ['core/test/a.test.js', 'plugins/timeline/test/window.test.js'],
    workflowsOnDisk: ['.github/workflows/test.yml', '.github/workflows/docker.yml'],
  })
  try {
    const { problems } = check({ root })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /plugins\/timeline\/test\/window\.test\.js/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// A workflow-only layer carries no test path, so its row is checked against the workflow file: this is
// the row a test-path check could never verify.
test('#749: removing the docker row fails the check and names docker.yml', () => {
  const suites = [realSuite('core'), realSuite('plugins/timeline')]
  const root = fixture({
    suites,
    workflows: [realWorkflow('test')],
    files: ['core/test/a.test.js'],
    workflowsOnDisk: ['.github/workflows/test.yml', '.github/workflows/docker.yml'],
  })
  try {
    const { problems } = check({ root })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /unclassified workflow: \.github\/workflows\/docker\.yml/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('#749: a new test file nobody classified fails the check, and so does a new workflow', () => {
  const suites = [realSuite('core')]
  const root = fixture({
    suites,
    workflows: [realWorkflow('test')],
    files: ['core/test/a.test.js', 'misc/unregistered.test.js'],
    workflowsOnDisk: ['.github/workflows/test.yml', '.github/workflows/fresh-gate.yml'],
  })
  try {
    const { problems } = check({ root })
    assert.equal(problems.length, 2)
    assert.ok(problems.some((p) => p.includes('misc/unregistered.test.js')), problems.join('\n'))
    assert.ok(problems.some((p) => p.includes('.github/workflows/fresh-gate.yml')), problems.join('\n'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('#749: a "none" row without a reason, and a stale doc, are both reported', () => {
  const suites = [
    realSuite('core'),
    { id: 'generated', layer: 'none', paths: ['patches/ds-bot/**'] },
    { id: 'bad-layer', layer: 'L9', paths: ['nowhere/**'], command: 'true' },
  ]
  const workflows = [
    realWorkflow('test'),
    // A workflow row with an unknown kind, and a workflow-only layer that does not say when it runs.
    { id: 'mystery', workflow: '.github/workflows/mystery.yml', kind: 'whatever', layer: 'none', reason: 'a fixture' },
    { id: 'docker', workflow: '.github/workflows/docker.yml', kind: 'workflow-only', layer: 'L2', gate: true },
  ]
  const root = fixture({
    suites,
    workflows,
    files: ['core/test/a.test.js'],
    workflowsOnDisk: ['.github/workflows/test.yml', '.github/workflows/mystery.yml', '.github/workflows/docker.yml'],
    staleDoc: true,
  })
  try {
    const { problems } = check({ root })
    assert.ok(problems.some((p) => /suite "generated" is "none" without a reason/.test(p)), problems.join('\n'))
    assert.ok(problems.some((p) => /suite "bad-layer" has unknown layer/.test(p)), problems.join('\n'))
    assert.ok(problems.some((p) => /out of date/.test(p) && p.includes('--write')), problems.join('\n'))
    assert.ok(problems.some((p) => /mystery\.yml" has unknown kind/.test(p)), problems.join('\n'))
    assert.ok(problems.some((p) => /docker\.yml" has no "runs" trigger/.test(p)), problems.join('\n'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// The manifest is the data the doc is generated from, so the two directions must agree.
test('#749: the doc tables are exactly what the manifest renders', () => {
  const manifest = loadManifest(repo)
  const doc = readFileSync(join(repo, DOC), 'utf8')
  assert.ok(doc.includes(renderTables(manifest)))
  // Every suite and every workflow appears in the generated block, and nothing else does.
  const block = doc.slice(doc.indexOf(BEGIN), doc.indexOf(END))
  for (const suite of manifest.suites) assert.ok(block.includes(`\`${suite.id}\``), `suite ${suite.id} is not in the doc`)
  for (const row of manifest.workflows) assert.ok(block.includes(row.workflow.replace('.github/workflows/', '')), `workflow ${row.workflow} is not in the doc`)
})

test('#749: the glob matcher handles one segment, many segments, and a trailing wildcard', () => {
  assert.equal(globMatch('core/test/**/*.test.js', 'core/test/about.test.js'), true)
  assert.equal(globMatch('core/test/**/*.test.js', 'core/test/deep/a.test.js'), true)
  assert.equal(globMatch('core/test/**/*.test.js', 'core/test/about.js'), false)
  assert.equal(globMatch('.github/scripts/*.test.mjs', '.github/scripts/merge-gate.test.mjs'), true)
  assert.equal(globMatch('.github/scripts/*.test.mjs', '.github/scripts/sub/x.test.mjs'), false)
  assert.equal(globMatch('patches/ds-bot/files/**', 'patches/ds-bot/files/test/about.test.js'), true)
})
