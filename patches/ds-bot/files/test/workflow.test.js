// The workflow engine, pure half (#1272). A definition is data, so these tests run it with no
// repository, no clock and no Bot: the blank preset the content workflow below go through the same
// calls, and the flowchart is asserted against the definition rather than against a picture.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  artifactsBySpec,
  artifact,
  formatArtifact,
  formatArtifactSpec,
  freshness,
  normaliseRevision,
  parseArtifactSpec,
  sameRevision,
} from '../src/shared/artifact.js'
import {
  enterNode,
  holderOf,
  inputStates,
  layoutWorkflow,
  nodeById,
  resolvedEdges,
  topologicalOrder,
  validateWorkflow,
  workflowColumns,
} from '../src/shared/workflow.js'
import { BLANK_TEAM, blankWorkflow } from '../src/shared/workflow-blank.js'

const content = {
  id: 'editorial',
  name: 'Editorial',
  version: 1,
  inputs: ['text:topic'],
  deliverables: ['text:archived'],
  nodes: [
    { id: 'idea', name: 'Idea', role: 'Planner', inputs: ['text:topic'], outputs: ['text:brief'] },
    { id: 'draft', name: 'Draft', role: 'Writer', inputs: ['text:brief'], outputs: ['text:draft'] },
    { id: 'edit', name: 'Edit', role: 'Editor', inputs: ['text:draft'], outputs: ['text:edited'] },
    { id: 'publish', name: 'Publish', role: 'Publisher', inputs: ['text:edited'], outputs: ['link:published'] },
    { id: 'archive', name: 'Archive', role: 'Archivist', inputs: ['link:published'], outputs: ['text:archived'] },
  ],
  edges: [
    { from: 'idea.text:brief', to: 'draft.text:brief' },
    { from: 'draft.text:draft', to: 'edit.text:draft' },
    { from: 'edit.text:edited', to: 'publish.text:edited' },
    { from: 'publish.link:published', to: 'archive.link:published' },
  ],
  loops: [],
}
const contentTeam = ['Planner', 'Writer', 'Editor', 'Publisher', 'Archivist']

const spec = (value) => {
  const parsed = parseArtifactSpec(value)
  return parsed ? formatArtifactSpec(parsed) : null
}

test('an artifact spec is a kind, and the kinds that name a fact need the name', () => {
  assert.deepEqual(parseArtifactSpec('check:tests-ok'), { kind: 'check', name: 'tests-ok' })
  assert.deepEqual(parseArtifactSpec('issue.ready'), { kind: 'issue.ready', name: '' })
  assert.deepEqual(parseArtifactSpec('  verdict  '), { kind: 'verdict', name: '' })
  assert.equal(parseArtifactSpec('check'), null)
  assert.equal(parseArtifactSpec('checks:lint'), null)
  assert.equal(parseArtifactSpec('file'), null)
  assert.equal(parseArtifactSpec(''), null)
  assert.equal(spec('text:topic'), 'text:topic')
  assert.equal(spec('nonsense'), null)
})

test('a revision is part of the artifact, and a SHA compares case-insensitively', () => {
  assert.equal(normaliseRevision('  ABC1234 '), 'abc1234')
  assert.equal(normaliseRevision('1274@1519968b'), '1274@1519968b')
  assert.equal(normaliseRevision('  '), null)
  assert.equal(sameRevision('ABC1234', 'abc1234'), true)
  assert.equal(sameRevision('abc1234', 'def5678'), false)
  assert.equal(sameRevision(null, null), false)

  const verdict = artifact('verdict', 'ABC1234', { value: 'PASS', by: 'Reviewer' })
  assert.equal(verdict.spec, 'verdict')
  assert.equal(verdict.revision, 'abc1234')
  assert.equal(verdict.value, 'PASS')
  assert.equal(formatArtifact(verdict), 'verdict@abc1234')
  assert.equal(formatArtifact(artifact('check:tests-ok', 'def5678')), 'check:tests-ok@def5678')
  assert.equal(artifact('check:tests-ok', ''), null)
  assert.equal(artifact('nonsense', 'abc1234'), null)
})

test('present and current are two questions, and an unreadable fact is not a pass', () => {
  const have = artifact('check:tests-ok', 'abc1234')
  assert.deepEqual(freshness(have, 'abc1234'), { fresh: true, reason: 'current', have: 'abc1234', now: 'abc1234' })
  assert.deepEqual(freshness(have, 'DEF5678'), { fresh: false, reason: 'stale', have: 'abc1234', now: 'def5678' })
  assert.equal(freshness(null, 'abc1234').reason, 'missing')
  assert.equal(freshness(have, null).reason, 'unreadable')
  assert.equal(freshness(have, null).fresh, false)
  assert.deepEqual(Object.keys(artifactsBySpec([have])), ['check:tests-ok'])
})

test('the blank preset validates with its own team, and names a Bot on every node', () => {
  const result = validateWorkflow(blankWorkflow, { team: BLANK_TEAM })
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.deepEqual(workflowColumns(blankWorkflow).map((column) => column.id), ['draft', 'review', 'publish'])
  assert.deepEqual(workflowColumns(blankWorkflow).map((column) => column.role), ['Writer', 'Editor', 'Publisher'])
  assert.equal(holderOf(blankWorkflow, 'review'), 'Editor')
  assert.equal(holderOf(blankWorkflow, 'nowhere'), null)

  const other = validateWorkflow(blankWorkflow, { team: ['Someone'] })
  assert.equal(other.ok, false)
  assert.deepEqual(other.problems.map((problem) => problem.code), [
    'node/unknown-role',
    'node/unknown-role',
    'node/unknown-role',
  ])
})

test('the columns are the definition s, not a built-in list', () => {
  const blank = workflowColumns(blankWorkflow)
  const editorial = workflowColumns(content)
  assert.deepEqual(editorial.map((column) => column.id), ['idea', 'draft', 'edit', 'publish', 'archive'])
  assert.deepEqual(editorial.map((column) => column.role), contentTeam)
  assert.notDeepEqual(blank.map((column) => column.id), editorial.map((column) => column.id))
  // Same calls, two vocabularies: nothing above this line knows either set of ids.
  assert.equal(validateWorkflow(content, { team: contentTeam }).ok, true, JSON.stringify(validateWorkflow(content, { team: contentTeam }).problems))
  assert.deepEqual(topologicalOrder(content), ['idea', 'draft', 'edit', 'publish', 'archive'])
})

test('the flowchart is generated: one box per node, one edge per edges[] row', () => {
  const graph = layoutWorkflow(content)
  assert.equal(graph.boxes.length, content.nodes.length)
  assert.equal(graph.edges.length, content.edges.length)
  for (const node of content.nodes) {
    const box = graph.boxes.find((candidate) => candidate.id === node.id)
    assert.ok(box, `no box for ${node.id}`)
    assert.equal(box.role, node.role)
    assert.deepEqual(box.inputs, node.inputs)
    assert.deepEqual(box.outputs, node.outputs)
  }
  for (const [index, edge] of content.edges.entries()) {
    const drawn = graph.edges[index]
    assert.equal(drawn.artifact, edge.from.slice(edge.from.indexOf('.') + 1))
    assert.equal(drawn.from, edge.from)
    assert.equal(drawn.to, edge.to)
    assert.ok(drawn.points.length === 2)
  }
  // Left to right in dependency order, and a layout of the same file twice is the same layout.
  const rankOf = (id) => graph.boxes.find((box) => box.id === id).rank
  assert.ok(rankOf('idea') < rankOf('draft'))
  assert.ok(rankOf('draft') < rankOf('edit'))
  assert.ok(rankOf('edit') < rankOf('publish'))
  assert.ok(rankOf('publish') < rankOf('archive'))
  assert.deepEqual(layoutWorkflow(content), graph)
  assert.ok(graph.width > 0 && graph.height > 0)
  // A row written with an end that is not in the file keeps its place, so the picture shows the defect.
  const broken = layoutWorkflow({ nodes: content.nodes, edges: [{ from: 'idea.text:brief', to: 'gone.text:brief' }] })
  assert.equal(broken.edges.length, 1)
  assert.equal(broken.edges[0].toBox, null)
  // One field for one value: the edge carries `artifact`, and says it once (#1291 debt).
  assert.deepEqual(resolvedEdges(content)[0], {
    from: 'idea.text:brief',
    to: 'draft.text:brief',
    fromNode: 'idea',
    toNode: 'draft',
    artifact: 'text:brief',
  })
})

test('an input nothing produces is refused, unless the workflow declares it as a starting point', () => {
  const def = {
    nodes: [
      { id: 'draft', name: 'Draft', role: 'Writer', inputs: ['text:topic'], outputs: ['text:draft'] },
      { id: 'publish', name: 'Publish', role: 'Publisher', inputs: ['text:draft'], outputs: ['link:published'] },
    ],
    edges: [],
    deliverables: ['link:published'],
  }
  const result = validateWorkflow(def)
  assert.equal(result.ok, false)
  assert.deepEqual(result.problems.map((problem) => problem.code), ['input/without-producer'])
  assert.match(result.problems[0].message, /node "draft" takes in "text:topic", but no node hands it out/)
  assert.equal(validateWorkflow({ ...def, inputs: ['text:topic'] }).ok, true)
})

test('an output nothing consumes is refused, unless it is a declared deliverable', () => {
  const def = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'draft', name: 'Draft', role: 'Writer', inputs: ['text:topic'], outputs: ['text:draft', 'text:extra'] },
      { id: 'publish', name: 'Publish', role: 'Publisher', inputs: ['text:draft'], outputs: ['link:published'] },
    ],
    deliverables: ['link:published'],
  }
  const result = validateWorkflow(def)
  assert.deepEqual(result.problems.map((problem) => problem.code), ['output/without-consumer'])
  assert.match(result.problems[0].message, /node "draft" hands out "text:extra", and nothing takes it in/)
  assert.equal(validateWorkflow({ ...def, deliverables: ['link:published', 'text:extra'] }).ok, true)
})

test('one fact has one producer, and two producers are refused by name', () => {
  const def = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'draft', name: 'Draft', role: 'Writer', inputs: ['text:topic'], outputs: ['text:draft'] },
      { id: 'redraft', name: 'Redraft', role: 'Writer', inputs: ['text:topic'], outputs: ['text:draft'] },
      { id: 'publish', name: 'Publish', role: 'Publisher', inputs: ['text:draft'], outputs: ['link:published'] },
    ],
    deliverables: ['link:published'],
  }
  const result = validateWorkflow(def)
  assert.deepEqual(result.problems.map((problem) => problem.code), ['artifact/two-producers'])
  assert.match(result.problems[0].message, /"text:draft" is handed out by "draft" and "redraft"/)
})

test('a node without a role is refused, and so is a role that names nobody on the team', () => {
  const def = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'draft', name: 'Draft', role: '', inputs: ['text:topic'], outputs: ['text:draft'] },
      { id: 'publish', name: 'Publish', role: 'Ghost', inputs: ['text:draft'], outputs: ['link:published'] },
    ],
    deliverables: ['link:published'],
  }
  const loose = validateWorkflow(def)
  assert.deepEqual(loose.problems.map((problem) => problem.code), ['node/without-role'])
  const strict = validateWorkflow(def, { team: ['Writer'] })
  assert.deepEqual(strict.problems.map((problem) => problem.code), ['node/without-role', 'node/unknown-role'])
  assert.match(strict.problems[1].message, /node "publish" names "Ghost", who is not on this team/)
  // `system` and a human role are part of the model, not a missing role.
  assert.equal(validateWorkflow({ inputs: ['text:topic'], nodes: [{ id: 'merge', name: 'Merge', role: 'system', inputs: ['text:topic'], outputs: ['merge-commit'] }], deliverables: ['merge-commit'] }, { team: [] }).ok, true)
})

test('a cycle that is not declared is refused; a declared loop is how work goes back', () => {
  const twoStep = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic'], outputs: ['pr'] },
      { id: 'review', name: 'Review', role: 'Reviewer', inputs: ['pr'], outputs: ['verdict'] },
      { id: 'gate', name: 'Gate', role: 'Reviewer', inputs: ['verdict'], outputs: [] },
    ],
    edges: [],
    deliverables: ['verdict'],
  }
  const cyc = { ...twoStep, edges: [{ from: 'review.verdict', to: 'build.text:topic' }] }
  const refused = validateWorkflow(cyc)
  assert.ok(refused.problems.some((problem) => problem.code === 'edge/crossed-artifacts'))
  const loop = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic', 'verdict'], outputs: ['pr'] },
      { id: 'review', name: 'Review', role: 'Reviewer', inputs: ['pr'], outputs: ['verdict'] },
    ],
    edges: [{ from: 'review.verdict', to: 'build.verdict' }],
    deliverables: ['pr'],
  }
  const undeclared = validateWorkflow(loop, { team: ['Dev', 'Reviewer'] })
  assert.deepEqual(undeclared.problems.map((problem) => problem.code), ['graph/cycle'])
  assert.match(undeclared.problems[0].message, /the nodes loop \("build" -> "review" -> "build"\)/)
  const declared = validateWorkflow({ ...loop, loops: [{ from: 'review', to: 'build' }] }, { team: ['Dev', 'Reviewer'] })
  assert.equal(declared.ok, true, JSON.stringify(declared.problems))
  assert.deepEqual(topologicalOrder({ ...loop, loops: [{ from: 'review', to: 'build' }] }), ['build', 'review'])
})

test('a spelling the engine does not know, or an edge that does not line up, is refused on its own', () => {
  const def = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'draft', name: 'Draft', role: 'Writer', inputs: ['text:topic'], outputs: ['text:draft'] },
      { id: 'publish', name: 'Publish', role: 'Publisher', inputs: ['text:draft'], outputs: ['link:published'] },
    ],
    edges: [{ from: 'draft.text:draft', to: 'publish.link:published' }],
    deliverables: ['link:published'],
  }
  const wrongKind = validateWorkflow({ ...def, nodes: [{ ...def.nodes[0], outputs: ['text:draft', 'checks:lint'] }, def.nodes[1]] })
  assert.ok(wrongKind.problems.some((problem) => problem.code === 'artifact/unknown-kind'))
  const misaligned = validateWorkflow({ ...def, edges: [{ from: 'draft.text:draft', to: 'publish.text:nothing' }] })
  assert.ok(misaligned.problems.some((problem) => problem.code === 'edge/unknown-end' || problem.code === 'edge/misaligned'))
})

test('a missing input refuses in the node s own words, and moves nothing', () => {
  const gate = {
    inputs: ['pr'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic'], outputs: ['pr'] },
      { id: 'gate', name: 'Gate', role: 'Reviewer', inputs: ['pr', 'check:tests-ok'], outputs: ['queue-entry'], refusal: '{node} refuses: its input {spec} has not been produced yet.' },
    ],
    edges: [],
    deliverables: ['queue-entry'],
  }
  const refused = enterNode(gate, 'gate', { present: { pr: artifact('pr', '1274@abc1234') } })
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.missing, ['check:tests-ok'])
  assert.equal(refused.refusal, 'Gate refuses: its input check:tests-ok has not been produced yet.')
})

test('a stale input refuses with both revisions, so a card reads without asking anyone', () => {
  const gate = {
    inputs: ['pr'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic'], outputs: ['pr', 'verdict'] },
      {
        id: 'gate',
        name: 'Gate',
        role: 'Reviewer',
        inputs: ['verdict', 'check:tests-ok'],
        outputs: ['queue-entry'],
        refusal: '{node} refuses: its input {input} is stale, the tip is now {now}.',
      },
    ],
    edges: [],
    deliverables: ['queue-entry'],
  }
  const present = {
    verdict: artifact('verdict', 'abc1234', { value: 'PASS' }),
    'check:tests-ok': artifact('check:tests-ok', 'abc1234'),
  }
  const refused = enterNode(gate, 'gate', { present, current: { verdict: 'def5678', 'check:tests-ok': 'def5678' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.stale.length, 2)
  assert.equal(refused.refusal, 'Gate refuses: its input verdict@abc1234 is stale, the tip is now def5678.')

  const fresh = { verdict: artifact('verdict', 'def5678', { value: 'PASS' }), 'check:tests-ok': artifact('check:tests-ok', 'def5678') }
  assert.equal(enterNode(gate, 'gate', { present: fresh, current: { verdict: 'def5678', 'check:tests-ok': 'def5678' } }).ok, true)
  // No reading of the current revision is not a pass on a guess.
  assert.equal(enterNode(gate, 'gate', { present, current: { verdict: null } }).ok, false)

  const states = inputStates(gate, 'gate', { present, current: { verdict: 'def5678', 'check:tests-ok': 'def5678' } })
  assert.deepEqual(states.map((state) => [state.spec, state.present, state.revision, state.stale]), [
    ['verdict', true, 'abc1234', true],
    ['check:tests-ok', true, 'abc1234', true],
  ])
  assert.deepEqual(inputStates(gate, 'gate', { present: { verdict: present.verdict } })[1], {
    spec: 'check:tests-ok',
    present: false,
    revision: null,
    stale: false,
    now: null,
    reason: 'missing',
    unreadable: false,
  })
  // A revision the log does not carry is not a pass, and the card says so instead of `stale: false` (#1291 INC).
  const unread = inputStates(gate, 'gate', { present, current: {} })
  assert.deepEqual(unread.map((state) => [state.spec, state.present, state.stale, state.unreadable, state.reason]), [
    ['verdict', true, true, true, 'unreadable'],
    ['check:tests-ok', true, true, true, 'unreadable'],
  ])
})

test('a guard is a predicate over a fact, and its refusal says what the fact said', () => {
  const def = {
    inputs: ['pr'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic'], outputs: ['pr', 'verdict'] },
      {
        id: 'gate',
        name: 'Gate',
        role: 'Reviewer',
        inputs: ['verdict'],
        outputs: ['queue-entry'],
        guards: [{ id: 'pass', spec: 'verdict', is: 'equals', value: 'PASS' }],
      },
    ],
    deliverables: ['queue-entry'],
  }
  const current = { verdict: 'abc1234' }
  const inc = enterNode(def, 'gate', { present: { verdict: artifact('verdict', 'abc1234', { value: 'INC' }) }, current })
  assert.equal(inc.ok, false)
  assert.match(inc.refusal, /Gate refuses: its input verdict@abc1234 does not say PASS/)
  const pass = enterNode(def, 'gate', { present: { verdict: artifact('verdict', 'abc1234', { value: 'PASS' }) }, current })
  assert.equal(pass.ok, true)
  assert.equal(pass.refusal, null)
})

test('the ids are data: renaming them changes nothing but the strings', () => {
  const renamed = {
    ...blankWorkflow,
    nodes: blankWorkflow.nodes.map((node, index) => ({ ...node, id: `step-${index}` })),
    edges: [
      { from: 'step-0.text:draft', to: 'step-1.text:draft' },
      { from: 'step-1.text:edited', to: 'step-2.text:edited' },
    ],
  }
  assert.equal(validateWorkflow(renamed, { team: BLANK_TEAM }).ok, true)
  assert.deepEqual(workflowColumns(renamed).map((column) => column.id), ['step-0', 'step-1', 'step-2'])
  const graph = layoutWorkflow(renamed)
  assert.equal(graph.boxes.length, 3)
  assert.equal(graph.edges.length, 2)
  const blankGraph = layoutWorkflow(blankWorkflow)
  assert.deepEqual(graph.boxes.map((box) => box.rank), blankGraph.boxes.map((box) => box.rank))
  assert.equal(nodeById(renamed, 'step-1').role, 'Editor')
})

test('a fact whose source revision is unreadable refuses, whether the key is missing or null (#1291 INC)', () => {
  const gate = {
    inputs: ['pr'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic'], outputs: ['pr', 'verdict'] },
      { id: 'gate', name: 'Gate', role: 'Reviewer', inputs: ['verdict'], outputs: ['queue-entry'] },
    ],
    edges: [],
    deliverables: ['queue-entry'],
  }
  const present = { verdict: artifact('verdict', 'abc1234', { value: 'PASS' }) }
  for (const current of [{}, { verdict: null }]) {
    const refused = enterNode(gate, 'gate', { present, current })
    assert.equal(refused.ok, false, `${JSON.stringify(current)} must refuse`)
    assert.equal(refused.stale.length, 1)
    assert.equal(refused.stale[0].reason, 'unreadable')
    assert.equal(refused.stale[0].now, null)
    assert.match(refused.refusal, /could not be checked against the source/)
  }
  // The same node on a revision it can read starts.
  assert.equal(enterNode(gate, 'gate', { present, current: { verdict: 'abc1234' } }).ok, true)
})

test('the unreadable sentence names the fact it read and never fills the source revision with an empty slot (#1291 INC)', () => {
  const gate = {
    inputs: ['pr'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic'], outputs: ['pr', 'verdict'] },
      // The node's own wording speaks of "stale"; the engine must not use it for an unread source.
      { id: 'gate', name: 'Gate', role: 'Reviewer', inputs: ['verdict'], outputs: ['queue-entry'], refusal: '{node} refuses: its input {input} is stale, the tip is now {now}.' },
    ],
    edges: [],
    deliverables: ['queue-entry'],
  }
  const refused = enterNode(gate, 'gate', { present: { verdict: artifact('verdict', 'abc1234', { value: 'PASS' }) }, current: { verdict: null } })
  assert.equal(refused.ok, false)
  assert.match(refused.refusal, /verdict@abc1234/)
  assert.match(refused.refusal, /could not be checked against the source/)
  assert.doesNotMatch(refused.refusal, /the tip is now \./)
  assert.doesNotMatch(refused.refusal, /null/)
})

test('the card and the gate say the same thing about an unreadable input (#1291 INC)', () => {
  const gate = {
    inputs: ['pr'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic'], outputs: ['pr', 'verdict'] },
      { id: 'gate', name: 'Gate', role: 'Reviewer', inputs: ['verdict', 'check:tests-ok'], outputs: ['queue-entry'] },
    ],
    edges: [],
    deliverables: ['queue-entry'],
  }
  const present = { verdict: artifact('verdict', 'abc1234'), 'check:tests-ok': artifact('check:tests-ok', 'abc1234') }
  for (const current of [{}, { verdict: null, 'check:tests-ok': null }]) {
    const refused = enterNode(gate, 'gate', { present, current })
    const states = inputStates(gate, 'gate', { present, current })
    assert.equal(refused.ok, false)
    assert.deepEqual(states.map((state) => state.spec), ['verdict', 'check:tests-ok'])
    for (const state of states) {
      assert.equal(state.present, true)
      assert.equal(state.unreadable, true)
      assert.equal(state.reason, 'unreadable')
      // The card must not draw a refused input as a normal one.
      assert.equal(state.stale, true)
      assert.equal(state.now, null)
    }
  }
})
