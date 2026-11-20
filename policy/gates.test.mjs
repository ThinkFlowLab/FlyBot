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
import { gateFiles as signatureGateFiles, judge } from '../.github/scripts/policy-sign.mjs'

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

// A workflow can need a signature without being a merge gate. `risk-tier.yml` reports the tier on
// every pull request and gates nothing, yet a review quotes the `risk-tier: …` line it writes, so a
// pull request could rewrite the evidence its own review cites (#3095). The manifest keeps it
// `gate: false` — it is not a required check — and this list names it explicitly instead.
const SIGNATURE_ONLY_WORKFLOWS = ['.github/workflows/risk-tier.yml']

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
  // a stale entry, and it would ask for a signature the repository no longer requires. A workflow on
  // the signature-only list is the stated exception, not a stale entry.
  const stale = [...gateFiles].filter(
    (file) =>
      file.startsWith('.github/workflows/') &&
      !gateWorkflows.includes(file) &&
      !SIGNATURE_ONLY_WORKFLOWS.includes(file),
  )
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

// #3095: the rule data the gates read, and the workflow that produces the tier evidence a review
// quotes, were outside `gateFiles`. Two of the four files in `.github/agent/` carry the sentence
// "Editing this file is itself T3", and that sentence locks nothing: the tier decides which gate
// judges a change, never whether a person has to sign it. The directory is the entry, so rule data
// added later is covered by construction rather than by remembering another line.
const AGENT_DIR = '.github/agent/'
const agentRuleFiles = readdirSync(join(ROOT, AGENT_DIR))
  .filter((file) => file.endsWith('.json'))
  .sort()
const TIER_RUNNER = '.github/workflows/risk-tier.yml'

test('#3095: rule data under .github/agent/ is a gate file, as a directory', () => {
  assert.ok(agentRuleFiles.length > 0, `${AGENT_DIR} holds no rule data, so this test would pass vacuously`)
  const uncovered = agentRuleFiles
    .map((file) => AGENT_DIR + file)
    .filter((file) => signatureGateFiles([file]).length === 0)
  assert.deepEqual(
    uncovered,
    [],
    `the rules that decide what counts as ready, as a PASS and as T3 need a person's signature; add \`${AGENT_DIR}\` to \`gateFiles\` in policy/gates.json: ${uncovered.join(', ')}`,
  )

  // The typo guard, as a test rather than an eyeball: a misspelt directory entry is the one failure
  // mode that never reports itself, because it keeps returning [] and nobody notices until it is used.
  assert.ok(
    policy.gateFiles.includes(AGENT_DIR),
    `\`gateFiles\` carries no \`${AGENT_DIR}\` entry; a path entry that does not match the directory is a hole, not a gate`,
  )

  // And the entry is a directory, not four remembered lines: a rule file added after this change is
  // covered without a second edit.
  assert.deepEqual(signatureGateFiles([`${AGENT_DIR}added-later.json`]), [`${AGENT_DIR}added-later.json`])
})

test('#3095: the tier runner is a gate file while the manifest still calls it report-only', () => {
  const row = manifest.workflows.find((entry) => entry.workflow === TIER_RUNNER)
  assert.ok(row !== undefined, `${TIER_RUNNER} has no row in docs/testing-layers.json`)
  assert.equal(
    row.gate,
    false,
    `the manifest no longer calls ${TIER_RUNNER} report-only; move the gateFiles entry and this test in the same change`,
  )
  assert.deepEqual(
    signatureGateFiles([TIER_RUNNER]),
    [TIER_RUNNER],
    `${TIER_RUNNER} writes the \`risk-tier: …\` line a review quotes and gates nothing itself, so a pull request could rewrite that evidence unsigned; add it to \`gateFiles\``,
  )
  // The workflow really is the producer of the line, so the entry names a fact rather than a guess.
  assert.match(read(TIER_RUNNER), /risk-tier: /, `${TIER_RUNNER} no longer writes the \`risk-tier: …\` line; then this entry is stale`)
})

test('#3095: a roster edit without `Policy-sign:` is refused, and a signing comment at the tip accepts it', () => {
  const head = 'deadbeef'.repeat(5)
  const author = 'HugoXK'
  const comments = [{ id: 4312, body: `signing the gate change at ${head}`, user: { login: 'Birfy', type: 'User' } }]

  const refused = judge({ files: [`${AGENT_DIR}review-policy.json`], body: 'Fixes #3095', author, comments, head })
  assert.equal(refused.ok, false, 'a pull request that moves the reviewers roster and carries no signature is accepted today')
  assert.match(refused.reason, /gate file changed/)
  assert.deepEqual(refused.signable, [{ id: 4312, login: 'Birfy' }])

  // The same change with a line naming a comment that names this tip is accepted — for both give ways
  // a seat is recorded: the reviewers roster and the maintainers roster the controller trusts.
  for (const roster of ['review-policy.json', 'controller.json']) {
    const accepted = judge({
      files: [`${AGENT_DIR}${roster}`],
      body: `Fixes #3095\n\nPolicy-sign: 4312`,
      author,
      comments,
      head,
    })
    assert.equal(accepted.ok, true, accepted.reason)
  }
})

test('#3095: negative controls — an ordinary client file is not a gate change and policy/ still covers a new file', () => {
  assert.deepEqual(signatureGateFiles(['plugins/social/client.js']), [])
  assert.deepEqual(signatureGateFiles(['policy/new-gate-note.json']), ['policy/new-gate-note.json'])
  assert.equal(new Set(policy.gateFiles).size, policy.gateFiles.length, '`gateFiles` lists an entry twice')
})
