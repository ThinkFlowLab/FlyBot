// Where a definition lives (#1272 step 3): the workspace's `workflows/<id>.json`, the presets that
// are read-only, and the two endpoints — `workflows` reads, `workflow-save` writes with a signed-in
// actor (acceptance 6 and 7).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installAuthz } from '../src/host/authz.js'
import { createWorkflowStore, install, PRESETS } from '../src/host/workflow-store.js'
import { copyOfPreset, differingFields, workflowBytes } from '../src/shared/workflow-doc.js'
import { repoDevWorkflow } from '../src/shared/workflow-repo-dev.js'
import { blankWorkflow } from '../src/shared/workflow-blank.js'

const withDir = (run) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  try {
    return run(join(root, 'workflows'), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

test('a save writes canonical bytes, and saving an unedited definition rewrites the same bytes', () => {
  withDir((dir) => {
    const store = createWorkflowStore({ dir })
    const copy = copyOfPreset(blankWorkflow, { id: 'blank-mine', name: 'Mine' })
    const first = store.save({ definition: copy })
    assert.equal(first.ok, true)
    assert.equal(first.changed, true)
    const written = readFileSync(join(dir, 'blank-mine.json'), 'utf8')
    assert.equal(written, workflowBytes(copy))
    // Acceptance 7: normalising and re-saving an unedited definition produces identical bytes.
    const opened = store.open('blank-mine')
    const again = store.save({ definition: opened.workflow.definition })
    assert.equal(again.ok, true)
    assert.equal(again.changed, false)
    assert.equal(readFileSync(join(dir, 'blank-mine.json'), 'utf8'), written)
    assert.equal(sha256(readFileSync(join(dir, 'blank-mine.json'), 'utf8')), sha256(written))
  })
})

test('a preset id cannot be saved over, and an invalid definition is refused with its own sentence', () => {
  withDir((dir) => {
    const store = createWorkflowStore({ dir })
    const preset = store.save({ definition: repoDevWorkflow })
    assert.equal(preset.ok, false)
    assert.equal(preset.code, 'workflow/preset-read-only')
    assert.equal(existsSync(join(dir, 'repo-dev.json')), false)

    const copy = copyOfPreset(blankWorkflow, { id: 'blank-mine', name: 'Mine' })
    copy.nodes[0] = { ...copy.nodes[0], role: '' }
    const invalid = store.save({ definition: copy })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'workflow/invalid')
    assert.match(invalid.problems[0].message, /names no role/)
    assert.equal(existsSync(join(dir, 'blank-mine.json')), false)
  })
})

test('customize writes a new file and leaves the shipped preset byte-identical', () => {
  withDir((dir) => {
    const presetFile = new URL('../src/shared/workflow-repo-dev.js', import.meta.url)
    const before = sha256(readFileSync(presetFile, 'utf8'))
    const store = createWorkflowStore({ dir })
    const copied = store.customize({ from: 'repo-dev', id: 'repo-dev-mine', name: 'Mine' })
    assert.equal(copied.ok, true)
    assert.equal(copied.copiedFrom, 'repo-dev')
    assert.equal(sha256(readFileSync(presetFile, 'utf8')), before)
    const copy = JSON.parse(readFileSync(join(dir, 'repo-dev-mine.json'), 'utf8'))
    assert.deepEqual(differingFields(repoDevWorkflow, copy), ['id', 'name'])
    // The preset itself is still served from its module, not from the workspace file.
    assert.equal(store.open('repo-dev').workflow.source, 'preset')
    assert.equal(store.open('repo-dev-mine').workflow.source, 'workspace')
  })
})

test('the list names the presets, the owner files and the project default', () => {
  withDir((dir) => {
    const store = createWorkflowStore({ dir })
    const empty = store.list()
    assert.deepEqual(empty.presets.map((entry) => entry.id), PRESETS.map((entry) => entry.id))
    assert.deepEqual(empty.own, [])
    assert.equal(empty.default, null)

    store.customize({ from: 'blank', id: 'blank-mine', name: 'Mine' })
    const withDefault = store.setDefault({ id: 'blank-mine' })
    assert.equal(withDefault.ok, true)
    assert.equal(withDefault.default, 'blank-mine')
    assert.deepEqual(withDefault.own.map((entry) => entry.id), ['blank-mine'])
    // A default naming a file somebody deleted answers "none" instead of a workflow that cannot open.
    rmSync(join(dir, 'blank-mine.json'))
    assert.equal(store.list().default, null)
  })
})

test('open answers the definition, its layout and a guard preview', () => {
  withDir((dir) => {
    const store = createWorkflowStore({ dir, factsFor: () => ({ ok: true, facts: { present: { pr: { spec: 'pr', revision: 'abc1234', value: 'none' } }, current: { pr: 'abc1234' } } }) })
    const opened = store.open('repo-dev')
    assert.equal(opened.ok, true)
    assert.equal(opened.workflow.editable, false)
    assert.equal(opened.workflow.bytes, workflowBytes(repoDevWorkflow))
    assert.equal(opened.layout.boxes.length, repoDevWorkflow.nodes.length)
    assert.equal(opened.layout.edges.length, repoDevWorkflow.edges.length)
    assert.equal(opened.preview.node, 'triage')
    // No fact reader answers on this host: the preview says it could not read rather than guessing.
    const blind = createWorkflowStore({ dir }).open('repo-dev', 'gate')
    assert.equal(blind.preview.facts, 'unavailable')
    assert.ok(blind.preview.rows.every((row) => row.state === 'unreadable'))
  })
})

test('the host endpoints read and write, and workflow-save is in the authz allow list', async () => {
  await withDir(async (dir, root) => {
    const rt = { state: { bots: {} }, ctx: { workspaceRegistry: { get: () => ({ path: root }) } }, warn: () => {} }
    install(rt)
    installAuthz(rt)
    // Enforced means someone has signed in on this host; before that every endpoint answers.
    rt.state.authSessions = { 'session-1': {} }
    const actor = { memberId: 'm1' }
    assert.equal(rt.authorize(actor, 'workflow-save', {}).ok, true)
    assert.equal(rt.authorize(actor, 'workflows', {}).ok, true)
    assert.equal(rt.authorize(actor, 'not-an-endpoint', {}).ok, false)

    const listed = await rt.workflowEndpoint('workflows', { op: 'list' })
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.presets.map((entry) => entry.id), ['repo-dev', 'blank'])
    const saved = await rt.workflowEndpoint('workflow-save', { op: 'customize', from: 'blank', id: 'blank-mine', name: 'Mine' })
    assert.equal(saved.ok, true)
    assert.equal(existsSync(join(dir, 'blank-mine.json')), true)
    const opened = await rt.workflowEndpoint('workflows', { op: 'open', id: 'blank-mine' })
    assert.equal(opened.workflow.source, 'workspace')
    // The board reads its columns from these definitions (acceptance 1 and 2).
    assert.deepEqual(rt.workflowDefinitions().map((definition) => definition.id).sort(), ['blank', 'blank-mine', 'repo-dev'])
    const unknown = await rt.workflowEndpoint('workflow-save', { op: 'rewrite-everything' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'workflow/unknown-op')
  })
})

test('a workspace file that does not parse is skipped instead of breaking the list', () => {
  withDir((dir) => {
    const store = createWorkflowStore({ dir, warn: () => {} })
    store.customize({ from: 'blank', id: 'blank-mine', name: 'Mine' })
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    const listed = store.list()
    assert.deepEqual(listed.own.map((entry) => entry.id), ['blank-mine'])
  })
})

// ---------------------------------------------------------------------------
// #2057: a linked folder is not this workspace's workflows.

const elsewhere = (t, files) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-outside-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('#2057: a workflow folder that is a symlink lists nothing and never reads the outside file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'workflows')
  const outside = elsewhere(t, { 'other.json': JSON.stringify({ ...blankWorkflow, id: 'other', name: 'Other' }) })
  symlinkSync(outside, dir, 'dir')
  const store = createWorkflowStore({ dir })
  const listed = store.list()
  assert.deepEqual(listed.own, [])
  assert.equal(listed.default, null)
  const opened = store.open('other')
  assert.equal(opened.ok, false)
  assert.equal(opened.code, 'workflow/not-found')
  assert.equal(JSON.stringify(opened).includes('Other'), false, 'the outside definition never comes back')
  assert.deepEqual(store.definitions().map((definition) => definition.id).sort(), PRESETS.map((preset) => preset.id).sort())
})

test('#2057: a workflow folder that is a plain file lists nothing and does not throw', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'workflows')
  writeFileSync(dir, 'not a folder')
  const store = createWorkflowStore({ dir })
  assert.deepEqual(store.list().own, [])
  assert.deepEqual(store.definitions().map((definition) => definition.id).sort(), PRESETS.map((preset) => preset.id).sort())
})

test('#2057: a linked workflow folder warns once, a missing or real one never warns', async (t) => {
  const warned = []
  const host = (root) => {
    const rt = {
      state: { bots: {} },
      ctx: { workspaceRegistry: { get: () => ({ path: root }) } },
      warn: (template, ...args) => warned.push(String(template).replace(/%s/g, () => String(args.shift() ?? ''))),
    }
    install(rt)
    return rt
  }
  const folderWarnings = () => warned.filter((line) => line.includes('workflow folder is not a plain directory'))

  // A link to a folder outside the workspace: every read says "nothing", and the folder is named once.
  const linkedRoot = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(linkedRoot, { recursive: true, force: true }))
  const outside = elsewhere(t, { 'other.json': JSON.stringify({ ...blankWorkflow, id: 'other', name: 'Other' }) })
  symlinkSync(outside, join(linkedRoot, 'workflows'), 'dir')
  const linked = host(linkedRoot)
  for (let round = 0; round < 3; round++) {
    const listed = await linked.workflowEndpoint('workflows', { op: 'list' })
    assert.deepEqual(listed.own, [])
    linked.workflowDefinitions()
  }
  const said = folderWarnings()
  assert.equal(said.length, 1, 'one warning per folder per process, not one per read')
  assert.ok(said[0].includes(join(linkedRoot, 'workflows')), `the warning names the folder: ${said[0]}`)
  assert.match(said[0], /keeping it empty$/)

  // A workspace nobody has saved a workflow in: empty, silent.
  const freshRoot = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(freshRoot, { recursive: true, force: true }))
  const fresh = host(freshRoot)
  assert.deepEqual((await fresh.workflowEndpoint('workflows', { op: 'list' })).own, [])
  assert.deepEqual(folderWarnings(), said)

  // A real folder: listed, silent.
  const realRoot = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(realRoot, { recursive: true, force: true }))
  mkdirSync(join(realRoot, 'workflows'), { recursive: true })
  writeFileSync(join(realRoot, 'workflows', 'mine.json'), JSON.stringify({ ...blankWorkflow, id: 'mine', name: 'Mine' }))
  const real = host(realRoot)
  assert.deepEqual((await real.workflowEndpoint('workflows', { op: 'list' })).own.map((entry) => entry.id), ['mine'])
  assert.deepEqual(folderWarnings(), said)
})
