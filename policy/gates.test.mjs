// The gate list is derived from the test-layer manifest (#2303).
//
// `policy/gates.json` decides which files need another person's signature, and it was handwritten.
// The repository already carries the machine-readable answer: `docs/testing-layers.json` marks a
// workflow `gate: true` when a merge cannot land without it, and `policy/gates.json`'s own `$comment`
// says "a rule that does not cover its own switch is advice, not a gate". The two drifted —
// `merge-gate.yml` and `enqueue-guard.yml` are gates by the manifest and were not gate files, and
// `gate-check.mjs`, which writes the check run the fork's ruleset requires, was outside too.
//
// These tests are the derivation: a `gate: true` workflow is a gate file by construction, and each
// gate workflow is pinned to the scripts it runs, in both directions — the workflow runs the script
// itself or imports it, and no other workflow runs it. A new gate workflow, or a rule moving under
// another workflow, fails here instead of shipping advice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(join(ROOT, path), 'utf8')

const manifest = JSON.parse(read('docs/testing-layers.json'))
const policy = JSON.parse(read('policy/gates.json'))
const gateFiles = new Set(policy.gateFiles)
const gateWorkflows = manifest.workflows.filter((row) => row.gate === true).map((row) => row.workflow)

const workflowFiles = readdirSync(join(ROOT, '.github/workflows'))
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => `.github/workflows/${file}`)

// The scripts a workflow starts, read from its `node <path>` steps. `base/` is stripped because the
// judging workflows check the base commit out under that prefix and run the script from there.
function runsOf(workflow) {
  const out = new Set()
  for (const match of read(workflow).matchAll(/\bnode\s+([\w./-]+\.mjs)\b/g)) {
    out.add(match[1].replace(/^base\//, ''))
  }
  return out
}

// The repository-relative scripts a script imports, following only relative specifiers. A step that
// runs `node scripts/x.mjs` from another package (`core/`, a plugin) is not this repository's script
// at that path, so a missing file is simply not one of them.
function importsOf(script) {
  const out = new Set()
  let text
  try {
    text = read(script)
  } catch {
    return out
  }
  for (const match of text.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
    out.add(relative(ROOT, resolve(ROOT, dirname(script), match[1])))
  }
  return out
}

// A script and everything it imports: `gate-check.mjs` is the run step, and the rules it judges by
// are one and two imports down (`enqueue-guard.mjs`, `enqueue-rules.mjs`).
function reachableFrom(seeds) {
  const seen = new Set()
  const queue = [...seeds]
  while (queue.length > 0) {
    const script = queue.shift()
    if (seen.has(script) || !script.endsWith('.mjs')) continue
    seen.add(script)
    queue.push(...importsOf(script))
  }
  return seen
}

test('#2303: every workflow the manifest marks as a gate is a gate file', () => {
  const missing = gateWorkflows.filter((workflow) => !gateFiles.has(workflow))
  assert.deepEqual(
    missing,
    [],
    `a workflow a merge cannot land without is a gate by construction; add it to \`gateFiles\` in policy/gates.json: ${missing.join(', ')}`,
  )

  // The other direction: a workflow quoted in `gateFiles` that the manifest does not call a gate is
  // a stale entry, and it would ask for a signature the repository no longer requires.
  const stale = [...gateFiles].filter((file) => file.startsWith('.github/workflows/') && !gateWorkflows.includes(file))
  assert.deepEqual(stale, [], `\`gateFiles\` names a workflow the manifest does not mark \`gate: true\`: ${stale.join(', ')}`)
})

test('#2303: each gate workflow is pinned to the scripts it runs, in both directions', () => {
  // The explicit table, rather than an inference: the manifest says which workflows are gates, and
  // this says which scripts each one judges by. A rule that moves to another workflow fails here.
  const PINS = [
    {
      workflow: '.github/workflows/merge-gate.yml',
      scripts: ['.github/scripts/merge-gate.mjs'],
    },
    {
      workflow: '.github/workflows/enqueue-guard.yml',
      scripts: [
        '.github/scripts/gate-check.mjs',
        '.github/scripts/enqueue-guard.mjs',
        '.github/scripts/enqueue-rules.mjs',
      ],
    },
    {
      workflow: '.github/workflows/test.yml',
      scripts: ['.github/scripts/policy-sign.mjs'],
    },
  ]

  const runs = new Map(workflowFiles.map((workflow) => [workflow, runsOf(workflow)]))
  const reached = new Map(workflowFiles.map((workflow) => [workflow, reachableFrom(runs.get(workflow))]))

  for (const pin of PINS) {
    for (const script of pin.scripts) {
      assert.ok(gateFiles.has(script), `${script} decides a gate workflow, so it is a gate file too; add it to policy/gates.json`)
      assert.ok(reached.get(pin.workflow).has(script), `${pin.workflow} does not run ${script} (directly or through its imports)`)
      for (const other of workflowFiles) {
        if (other === pin.workflow) continue
        assert.equal(runs.get(other).has(script), false, `${other} runs ${script} too; a gate script belongs to one workflow, and the pin above is stale`)
      }
    }
  }
})

// The image build is `gate: true` in the manifest — a packaging change cannot land without the image
// proving it starts — so it is a gate file as well. Product asked the implementer to include it in
// this change unless the image build is not a gate; the row answers that it is. The decision is
// written down here instead of inferred, so a manifest that stops calling it a gate has to move this
// line in the same pull request.
const DOCKER_WORKFLOW = '.github/workflows/docker.yml'

test('#2303: the image build is a gate file while the manifest calls it a gate', () => {
  const row = manifest.workflows.find((entry) => entry.workflow === DOCKER_WORKFLOW)
  assert.ok(row !== undefined, `${DOCKER_WORKFLOW} has no row in docs/testing-layers.json`)
  assert.equal(
    row.gate,
    true,
    'the manifest no longer marks the image build a gate; then take it out of `gateFiles` in the same change',
  )
  assert.ok(
    gateFiles.has(DOCKER_WORKFLOW),
    'docker.yml builds the image a packaging change must start before it merges, so it is a gate file',
  )
})
