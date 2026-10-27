// The definition as a file (#1272 step 3, acceptance 6 and 7): canonical bytes, a preset that a copy
// leaves byte-identical, and a load → save round trip that changes nothing.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { copyOfPreset, differingFields, isPresetId, isWorkflowId, PRESET_IDS, workflowBytes, workflowDocument } from '../src/shared/workflow-doc.js'
import { normaliseWorkflow } from '../src/shared/workflow.js'
import { repoDevWorkflow } from '../src/shared/workflow-repo-dev.js'
import { blankWorkflow } from '../src/shared/workflow-blank.js'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

test('a definition saves to canonical bytes and reads back unchanged', () => {
  const bytes = workflowBytes(repoDevWorkflow)
  assert.ok(bytes.endsWith('}\n'))
  assert.deepEqual(JSON.parse(bytes), workflowDocument(repoDevWorkflow))
  // Saving what was read changes nothing: the same bytes, so a definition diffs cleanly in git.
  assert.equal(workflowBytes(JSON.parse(bytes)), bytes)
})

test('the same definition in a different key order saves to the same bytes', () => {
  const reordered = JSON.parse(workflowBytes(repoDevWorkflow))
  const shuffled = Object.fromEntries(Object.entries(reordered).reverse())
  shuffled.nodes = reordered.nodes.map((node) => Object.fromEntries(Object.entries(node).reverse()))
  assert.equal(workflowBytes(shuffled), workflowBytes(repoDevWorkflow))
})

test('a preset copy differs from its preset only in id and name, and the preset file is untouched', () => {
  const before = sha256(readFileSync(new URL('../src/shared/workflow-repo-dev.js', import.meta.url), 'utf8'))
  const copy = copyOfPreset(repoDevWorkflow, { id: 'repo-dev-mine', name: 'Mine' })
  assert.deepEqual(differingFields(repoDevWorkflow, copy), ['id', 'name'])
  assert.equal(copy.id, 'repo-dev-mine')
  assert.equal(copy.name, 'Mine')
  // The file the preset lives in is not what a save touches; the copy is a value, not a write.
  const after = sha256(readFileSync(new URL('../src/shared/workflow-repo-dev.js', import.meta.url), 'utf8'))
  assert.equal(after, before)
  // Every field but the two is the preset's, node for node.
  assert.deepEqual(normaliseWorkflow({ ...copy, id: repoDevWorkflow.id, name: repoDevWorkflow.name }), normaliseWorkflow(repoDevWorkflow))
})

test('an id is a file name: lowercase, digits and hyphens, and a preset id is never one of ours', () => {
  assert.equal(isWorkflowId('repo-dev-copy'), true)
  assert.equal(isWorkflowId('Repo Dev'), false)
  assert.equal(isWorkflowId('../escape'), false)
  assert.equal(isWorkflowId(''), false)
  assert.equal(isPresetId('repo-dev'), true)
  assert.equal(isPresetId('blank'), true)
  assert.equal(isPresetId('repo-dev-copy'), false)
  // The shipped presets and the ids a workspace may not claim are the same two, and cannot drift.
  assert.deepEqual([...PRESET_IDS].sort(), [repoDevWorkflow.id, blankWorkflow.id].sort())
})

test('a blank copy keeps its nodes and edges and nothing else moves', () => {
  const copy = copyOfPreset(blankWorkflow, { id: 'blank-mine', name: '' })
  assert.deepEqual(differingFields(blankWorkflow, copy), ['id'])
  // An empty name keeps the preset's name rather than writing a definition with no name.
  assert.equal(copy.name, blankWorkflow.name)
})
