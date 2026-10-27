// The board's columns come from the definition (#1272 step 3, acceptance 1, 2 and 8): a five-node
// content workflow draws its own columns beside a repository card with no code change between them,
// two workflows never share a column, every column header names its workflow, and a card that names
// no workflow keeps the five columns it has today.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardSections, columnPlan, placeCard } from '../src/shared/workflow-board.js'
import { repoDevWorkflow } from '../src/shared/workflow-repo-dev.js'
import { blankWorkflow } from '../src/shared/workflow-blank.js'

// The content workflow from the parent issue's acceptance 1: five nodes, no repository, no `column`
// stated anywhere — so each node id is the lane, which is what "no code change between them" means.
const content = {
  id: 'content',
  name: 'Content',
  version: 1,
  inputs: ['text:topic'],
  deliverables: ['link:published'],
  nodes: [
    { id: '选题', name: '选题', role: 'Writer', inputs: ['text:topic'], outputs: ['text:draft'], guards: [], refusal: '' },
    { id: '草稿', name: '草稿', role: 'Writer', inputs: ['text:draft'], outputs: ['text:edited'], guards: [], refusal: '' },
    { id: '审稿', name: '审稿', role: 'Editor', inputs: ['text:edited'], outputs: ['verdict'], guards: [], refusal: '' },
    { id: '发布', name: '发布', role: 'Publisher', inputs: ['verdict'], outputs: ['link:published'], guards: [], refusal: '' },
    { id: '归档', name: '归档', role: 'Publisher', inputs: ['link:published'], outputs: [], guards: [], refusal: '' },
  ],
  edges: [
    { from: '选题.text:draft', to: '草稿.text:draft' },
    { from: '草稿.text:edited', to: '审稿.text:edited' },
    { from: '审稿.verdict', to: '发布.verdict' },
    { from: '发布.link:published', to: '归档.link:published' },
  ],
  loops: [],
}

const card = (over) => ({ kind: 'issue', number: 1, title: 'a card', workflow: null, node: null, ...over })

test('a five-node content workflow draws its own five columns, in the definition order', () => {
  assert.deepEqual(columnPlan(content).map((column) => column.id), ['选题', '草稿', '审稿', '发布', '归档'])
})

test('repo-dev draws the three lanes its nodes name, and the review node draws none', () => {
  const plan = columnPlan(repoDevWorkflow)
  assert.deepEqual(plan.map((column) => column.id), ['not-started', 'in-progress', 'done'])
  // Two nodes share the middle lane, so it is named by its id rather than after one of them.
  assert.equal(plan[1].label, 'in-progress')
  assert.deepEqual(plan[1].nodes, ['build', 'verify', 'gate'])
  // `review` carries `column: false` and is in no lane at all (#1265).
  assert.equal(placeCard(repoDevWorkflow, card({ workflow: 'repo-dev', node: 'review' })), null)
})

test('a card sits in the lane its node names, and nowhere when it names no workflow', () => {
  assert.equal(placeCard(repoDevWorkflow, card({ workflow: 'repo-dev', node: 'build' })), 'in-progress')
  assert.equal(placeCard(repoDevWorkflow, card({ workflow: 'repo-dev', node: 'release' })), 'done')
  assert.equal(placeCard(content, card({ workflow: 'content', node: '审稿' })), '审稿')
  assert.equal(placeCard(content, card({ workflow: 'repo-dev', node: 'build' })), null)
  assert.equal(placeCard(content, card()), null)
  // A node the definition does not have is not placed by a guess.
  assert.equal(placeCard(content, card({ workflow: 'content', node: 'nope' })), null)
})

test('a content card and a repo-dev card get their own columns and no column holds both', () => {
  const cards = [
    card({ number: 7, workflow: 'repo-dev', node: 'build' }),
    card({ number: 8, workflow: 'content', node: '草稿' }),
    card({ number: 9 }),
  ]
  const { sections, legacy } = boardSections([repoDevWorkflow, content], cards)
  assert.deepEqual(sections.map((section) => section.id), ['repo-dev', 'content'])
  const repoColumn = sections[0].columns.find((column) => column.id === 'in-progress')
  const contentColumn = sections[1].columns.find((column) => column.id === '草稿')
  assert.deepEqual(repoColumn.cards.map((entry) => entry.number), [7])
  assert.deepEqual(contentColumn.cards.map((entry) => entry.number), [8])
  // Every column names its workflow: `data-workflow` comes from the section id, and the header text
  // is the definition's own name.
  assert.equal(sections[0].name, 'Repository change')
  assert.equal(sections[1].name, 'Content')
  // No column holds two workflows' cards: the sections are disjoint by construction.
  const numbers = sections.flatMap((section) => section.columns.flatMap((column) => column.cards.map((entry) => entry.number)))
  assert.deepEqual(numbers.sort(), [7, 8])
  // The card that names no workflow is still where it was, in the legacy columns.
  assert.deepEqual(legacy.map((entry) => entry.number), [9])
})

test('a workflow with no cards draws no section, and a blank card names its own workflow', () => {
  assert.deepEqual(boardSections([repoDevWorkflow, blankWorkflow], [card({ workflow: 'blank', node: 'draft' })]).sections.map((section) => section.id), ['blank'])
  const { sections } = boardSections([blankWorkflow], [card({ workflow: 'blank', node: 'draft' }), card({ number: 2, workflow: 'blank', node: 'publish' })])
  assert.deepEqual(sections[0].columns.filter((column) => column.cards.length > 0).map((column) => column.id), ['draft', 'publish'])
})

test('a card naming a node with no column is kept, not dropped', () => {
  const { sections, legacy } = boardSections([repoDevWorkflow], [card({ number: 3, workflow: 'repo-dev', node: 'review' })])
  assert.deepEqual(sections[0].unplaced.map((entry) => entry.number), [3])
  assert.deepEqual(legacy, [])
})

test('an unknown workflow in a card keeps it in the five columns it had', () => {
  const { sections, legacy } = boardSections([repoDevWorkflow], [card({ number: 4, workflow: 'gone', node: 'build' })])
  assert.deepEqual(sections, [])
  assert.deepEqual(legacy.map((entry) => entry.number), [4])
})
