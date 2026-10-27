// The running layer's pure half (#1316, #1272 step 4). A job becomes node cards only where
// `enterNode` allows one, the hand-off is the node's `role` and not an `@`, `(job, node)` has one card
// however often the tick replays, and nothing here writes, wakes or reads a clock.
//
// Every test that guards a pin also has its knife named in a comment: the change that must make it go
// red.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { artifact } from '../src/shared/artifact.js'
import { enterNode, renderRefusal } from '../src/shared/workflow.js'
import { completions, jobDone, planJob } from '../src/shared/workflow-run.js'
import { repoDevWorkflow } from '../src/shared/workflow-repo-dev.js'

// A three-node flow whose nodes carry no `refusal` of their own, so a stale input is answered by the
// engine's default sentence, which names both revisions.
const flow = {
  id: 'run-flow',
  name: 'Run flow',
  version: 1,
  inputs: ['issue'],
  deliverables: ['release'],
  nodes: [
    { id: 'triage', name: 'Triage', role: 'Triage', column: 'not-started', inputs: ['issue'], outputs: ['issue.ready'], guards: [], refusal: '' },
    { id: 'build', name: 'Build', role: 'Dev', column: 'in-progress', inputs: ['issue.ready'], outputs: ['pr'], guards: [], refusal: '' },
    { id: 'release', name: 'Release', role: 'Release', column: 'done', inputs: ['pr'], outputs: ['release'], guards: [], refusal: '' },
  ],
  edges: [],
  loops: [],
}

const job = { id: 'task-job-1', workflow: 'repo-dev' }
const issue = (revision = '1274') => artifact('issue', revision)
const ready = (revision = 'aaaa1111') => artifact('issue.ready', revision)
const release = (revision = 'v0.2.12') => artifact('release', revision)

const facts = (over = {}) => ({
  present: { issue: issue(), ...over.present },
  current: { issue: '1274', ...over.current },
})

// 1. One fixture job on `repo-dev` produces exactly one node card: parented to the job, `node =
// triage`, queued for `Triage`, with no assignee.
// Knife: delete the `enterNode` gate in `planJob` → a job with no `issue` fact opens `triage` too, so
// the length assertion and test 2 both go red.
test('a job instantiates exactly one node card, parented to the job and queued by role', () => {
  const plan = planJob({ definition: repoDevWorkflow, job, facts: facts() })
  assert.equal(plan.workflow, 'repo-dev')
  assert.equal(plan.jobId, 'task-job-1')
  assert.deepEqual(plan.open, [
    { parentId: 'task-job-1', workflow: 'repo-dev', node: 'triage', role: 'Triage', queueRole: 'Triage', assignee: null },
  ])
  // Every other node refuses, because its input has not been produced yet.
  assert.deepEqual(plan.refused.map((entry) => entry.node).sort(), ['build', 'gate', 'merge', 'release', 'review', 'verify'])
  assert.ok(plan.refused.every((entry) => entry.refusal !== null && entry.heldBy === null && entry.unreadable === false))
})

// 2. A missing input creates nothing, and the refusal is the definition's own sentence — the same
// string `enterNode` returns, not a sentence this layer wrote.
test('a missing input creates no card and the refusal is enterNode\'s own sentence', () => {
  const plan = planJob({ definition: repoDevWorkflow, job, facts: {} })
  assert.deepEqual(plan.open, [])
  const triage = plan.refused.find((entry) => entry.node === 'triage')
  assert.equal(triage.refusal, enterNode(repoDevWorkflow, 'triage', {}).refusal)
  assert.match(triage.refusal, /Triage cannot start/)
})

// 3. The hand-off is the queue, not a mention: the card says which role may claim it and names no
// assignee, and the claimer is who the card shows afterwards (#1247). A role mismatch is the queue's
// own `not-in-role` refusal, which is why this layer never writes one.
test('the card is queued for the node\'s role and carries no assignee', () => {
  const plan = planJob({ definition: repoDevWorkflow, job, facts: facts() })
  assert.deepEqual(plan.open.map((entry) => [entry.node, entry.queueRole]), [['triage', 'Triage']])
  assert.ok(plan.open.every((entry) => entry.assignee === null))
  const next = planJob({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, facts: { present: { 'issue.ready': ready() }, current: { 'issue.ready': 'aaaa1111' } } })
  assert.deepEqual(next.open.map((entry) => [entry.node, entry.queueRole]), [['build', 'Dev']])
})

// 4. Idempotent and resumable: two passes over the same facts give one card, and the second pass is
// answered from the cards the job already has — no planner instance, no process-local flag, so a
// restart between the passes changes nothing.
// Knife: remove the `existing` (jobId, nodeId) guard in `planJob` → the second pass opens a second
// triage card and this test goes red.
test('two passes on the same facts open one card, and a replayed tick after a restart opens none', () => {
  const first = planJob({ definition: repoDevWorkflow, job, facts: facts() })
  assert.equal(first.open.length, 1)
  const second = planJob({ definition: repoDevWorkflow, job, cards: first.open, facts: facts() })
  assert.deepEqual(second.open, [])
  // A fresh call — the same thing a restarted host does — must agree with the second pass.
  assert.deepEqual(planJob({ definition: repoDevWorkflow, job, cards: first.open, facts: facts() }).open, [])
})

// 5. The next node waits for a current artifact: with the triage card done but `issue.ready` missing,
// build does not open; once the fact is present and current, exactly build opens.
test('node two opens only when node one\'s output is present and current', () => {
  const waiting = planJob({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, cards: [{ node: 'triage', column: 'done' }], facts: facts() })
  assert.deepEqual(waiting.open, [])
  assert.deepEqual(waiting.refused.map((entry) => entry.node), ['build', 'release'])
  assert.match(waiting.refused[0].refusal, /issue\.ready/)

  const opened = planJob({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, cards: [{ node: 'triage', column: 'done' }], facts: facts({ present: { 'issue.ready': ready() }, current: { 'issue.ready': 'aaaa1111' } }) })
  assert.deepEqual(opened.open.map((entry) => entry.node), ['build'])
})

// 5b. Two nodes ready at once are both opened — the definition said so, and WIP = 1 per Bot is the
// queue's rule (#1247), not a second limit here. A node card parented to another job is not this job's
// record, so it cannot close this job's node (#1316 pin 4: the identity is `(jobId, nodeId)`).
// Knife: drop the `parentId` test in `cardsOfJob` → the foreign card closes `triage` and this goes red.
test('two ready nodes open together, and another job\'s card is not this job\'s record', () => {
  const both = planJob({
    definition: flow,
    job: { id: 'j', workflow: 'run-flow' },
    facts: facts({ present: { 'issue.ready': ready() }, current: { 'issue.ready': 'aaaa1111' } }),
  })
  assert.deepEqual(both.open.map((entry) => entry.node), ['triage', 'build'])

  const foreign = planJob({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, cards: [{ node: 'triage', column: 'done', parentId: 'another-job' }], facts: facts() })
  assert.deepEqual(foreign.open.map((entry) => entry.node), ['triage'])
  const own = planJob({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, cards: [{ node: 'triage', column: 'done', parentId: 'j' }], facts: facts() })
  assert.deepEqual(own.open, [])
  // The same identity in `completions`: another job's done card completes nothing here.
  const current = facts({ present: { 'issue.ready': ready() }, current: { 'issue.ready': 'aaaa1111' } })
  assert.equal(completions({ definition: flow, job: { id: 'j' }, cards: [{ node: 'triage', column: 'done', parentId: 'another-job' }], facts: current }).length, 0)
})

// 6. A stale revision opens nothing and names both revisions; the card already open is untouched.
// Knife: make `planJob` trust `present` alone (skip the freshness answer) → build opens on an old
// `issue.ready` and this test goes red.
test('a stale revision refuses and says both revisions, leaving the open card alone', () => {
  const staleFacts = facts({ present: { 'issue.ready': ready('aaaa1111') }, current: { 'issue.ready': 'bbbb2222' } })
  const plan = planJob({
    definition: flow,
    job: { id: 'j', workflow: 'run-flow' },
    cards: [{ node: 'triage', column: 'in-progress' }],
    facts: staleFacts,
  })
  assert.deepEqual(plan.open, [])
  const build = plan.refused.find((entry) => entry.node === 'build')
  assert.match(build.refusal, /aaaa1111/)
  assert.match(build.refusal, /bbbb2222/)
  // Byte for byte the engine's answer for this node on these facts, not a sentence this layer wrote
  // (#1316 acceptance 2): `enterNode` renders it through `renderRefusal` with both revisions.
  assert.equal(build.refusal, enterNode(flow, 'build', staleFacts).refusal)
  // The card that is already open is in neither list: a refusal moves nothing.
  assert.ok(!plan.refused.some((entry) => entry.node === 'triage'))
})

// 7. Hold refuses every node of every workflow, in the definition's own sentence: the `no-hold` guard
// `repo-dev` already carries — the merge gate's wording, pinned byte for byte in
// `.github/scripts/fixtures/workflow-cases.json` — rendered through `renderRefusal` with `pr: hold`.
// A definition that guards no held pull request gets no sentence from this layer, only the holder.
// Knife: let the hold fall through to `enterNode` → a job whose facts are all current opens triage
// while it is held, and this test goes red.
test("a held job opens nothing on any node, in the definition's own sentence", () => {
  const held = planJob({ definition: repoDevWorkflow, job, facts: facts(), hold: { by: 'Birfy' } })
  assert.deepEqual(held.open, [])
  assert.equal(held.refused.length, repoDevWorkflow.nodes.length)
  const gate = repoDevWorkflow.nodes.find((node) => node.id === 'gate')
  const noHold = gate.guards.find((guard) => guard.id === 'no-hold')
  const sentence = renderRefusal(gate, { spec: noHold.spec, guard: noHold, input: { value: 'hold' } })
  // The sentence is the merge gate's own, not a paraphrase written here.
  assert.equal(sentence, 'the pull request carries the `hold` label')
  assert.ok(held.refused.every((entry) => entry.refusal === sentence && entry.heldBy === 'Birfy'))
  // A definition with no such guard has no sentence to give: the holder's name and nothing invented.
  const plain = planJob({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, facts: facts(), hold: { by: 'Birfy' } })
  assert.deepEqual(plain.open, [])
  assert.ok(plain.refused.every((entry) => entry.refusal === null && entry.heldBy === 'Birfy'))
  // A maintainer Bot's attempt is not a different caller here: the planner has no "who asks" input, so
  // nothing about the request can loosen a hold that names a holder.
  assert.deepEqual(planJob({ definition: repoDevWorkflow, job, facts: facts(), hold: 'Birfy' }).open, [])
})

// 7b. #1337: "the query answered nothing" reaches this layer as `''` from the host writer (slice (b)
// reads the hold out of the pull request's labels/state), and `'   '` is the same absence written by a
// form. Neither names a holder, so a blank string plans exactly like `hold: null` — node by node — and
// nothing carries `heldBy: ''`; a job refused whole with no sentence would be a silent refusal.
// Knife: restore the blank branch in `heldBy` (`hold.trim() === '' ? '' : hold.trim()`) → both blank
// cases refuse every node and the deepEqual against the unheld plan goes red.
test('a blank hold is not a hold: it plans exactly like no hold at all (#1337)', () => {
  const unheld = planJob({ definition: repoDevWorkflow, job, facts: facts() })
  assert.ok(unheld.open.length > 0)
  for (const blank of ['', '   ', '\t\n']) {
    const plan = planJob({ definition: repoDevWorkflow, job, facts: facts(), hold: blank })
    assert.deepEqual(plan, unheld, `hold: ${JSON.stringify(blank)} must plan like no hold`)
    assert.ok(plan.refused.every((entry) => entry.heldBy !== ''))
  }
})

// 7c. #1337: a hold this module cannot name — a non-string with no `by`, or a `by` that is blank or not
// a string — is normalised to "not held" on purpose, and the module header states that contract. The
// alternative, refusing every node with `heldBy: null`, reads exactly like a fact refusal: neither the
// card nor the host writer could tell "held by an unnamed party" from "the query answered nothing".
// Knife: return `''` for those shapes again → every case here refuses the whole job.
test('a hold with no name is read as not held, deliberately (#1337)', () => {
  const unheld = planJob({ definition: repoDevWorkflow, job, facts: facts() })
  for (const shape of [{}, { by: '' }, { by: '   ' }, { by: 7 }, 42, true]) {
    assert.deepEqual(planJob({ definition: repoDevWorkflow, job, facts: facts(), hold: shape }), unheld, `hold: ${JSON.stringify(shape)}`)
  }
  // A name still holds, padded or not, and the holder is the trimmed name.
  const padded = planJob({ definition: repoDevWorkflow, job, facts: facts(), hold: '  Birfy  ' })
  assert.deepEqual(padded.open, [])
  assert.ok(padded.refused.every((entry) => entry.heldBy === 'Birfy'))
})

// 8. A fact nobody could read refuses, and says so: it is not a missing fact and not a current one
// (#1211, #1316 pin 8).
test('an unreadable fact creates no card and is marked unreadable', () => {
  const plan = planJob({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, facts: { present: { issue: issue() }, current: {} } })
  assert.deepEqual(plan.open, [])
  const triage = plan.refused.find((entry) => entry.node === 'triage')
  assert.equal(triage.unreadable, true)
  assert.match(triage.refusal, /could not be checked against the source/)
})

// 9. Append-only: a completion is returned once, a replayed tick adds nothing, and neither the cards
// nor the history handed in are rewritten.
// Knife: make `completions` ignore `history` → the second pass returns the entry again and this test
// goes red.
test('completions are append-only and replay adds nothing', () => {
  const cards = [{ node: 'triage', column: 'done' }]
  const history = []
  const snapshot = JSON.stringify({ cards, history })
  const first = completions({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, cards, history, facts: facts({ present: { 'issue.ready': ready() }, current: { 'issue.ready': 'aaaa1111' } }) })
  assert.equal(first.length, 1)
  assert.deepEqual(first[0].outputs, [{ spec: 'issue.ready', revision: 'aaaa1111' }])
  // A node whose card is not done yet is not a completion, and neither is one already recorded.
  assert.deepEqual(completions({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, cards: [{ node: 'triage', column: 'in-progress' }], facts: facts({ present: { 'issue.ready': ready() }, current: { 'issue.ready': 'aaaa1111' } }) }), [])
  assert.deepEqual(completions({ definition: flow, job: { id: 'j', workflow: 'run-flow' }, cards, history: [...history, ...first], facts: facts({ present: { 'issue.ready': ready() }, current: { 'issue.ready': 'aaaa1111' } }) }), [])
  // Nothing handed in was rewritten: the history grows by appending, never by replacing.
  assert.equal(JSON.stringify({ cards, history }), snapshot)
})

// 9b. A definition edit cannot rewrite what a card already did: a node removed from the definition
// stops being planned, and the card that recorded it is left exactly as it was.
test('an edited definition does not rewrite a card\'s past nodes', () => {
  const edited = { ...flow, nodes: flow.nodes.filter((node) => node.id !== 'triage') }
  const cards = [{ node: 'triage', column: 'done' }]
  const plan = planJob({ definition: edited, job: { id: 'j', workflow: 'run-flow' }, cards, facts: facts() })
  assert.ok(!plan.refused.some((entry) => entry.node === 'triage'))
  assert.deepEqual(cards, [{ node: 'triage', column: 'done' }])
  assert.deepEqual(completions({ definition: edited, job: { id: 'j', workflow: 'run-flow' }, cards, facts: facts() }), [])
})

// 10. A job is done when its terminal node's outputs are current — not when a card says so.
test('a job is done only when its terminal node\'s output is current', () => {
  const missing = jobDone({ definition: flow, facts: facts() })
  assert.equal(missing.done, false)
  assert.deepEqual(missing.waiting.map((entry) => [entry.node, entry.spec, entry.reason]), [['release', 'release', 'missing']])
  assert.equal(jobDone({ definition: flow, facts: facts({ present: { release: release() }, current: { release: 'v0.2.12' } }) }).done, true)
  const stale = jobDone({ definition: flow, facts: facts({ present: { release: release('v0.2.11') }, current: { release: 'v0.2.12' } }) })
  assert.equal(stale.done, false)
  assert.deepEqual(stale.waiting.map((entry) => [entry.have, entry.now]), [['v0.2.11', 'v0.2.12']])
})

// 11. No clock, no timer, no scheduler, no network, no host: the beat belongs to `task-drive.js`
// `driveOnce`, and this module is only a function of what it was handed.
test('the module holds no clock, no timer, no fetch and no host import', () => {
  const source = readFileSync(new URL('../src/shared/workflow-run.js', import.meta.url), 'utf8')
  for (const banned of [/\bnew Date\b/, /\bDate\.now\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bfetch\s*\(/, /from 'node:/, /from '\.\.\/host\//]) {
    assert.equal(banned.test(source), false, `${banned} must not appear in workflow-run.js`)
  }
  const imports = [...source.matchAll(/^import .* from '([^']+)'$/gm)].map((match) => match[1])
  assert.deepEqual(imports.sort(), ['./artifact.js', './workflow.js'])
})
