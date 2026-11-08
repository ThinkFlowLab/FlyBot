// Where a definition lives (#1272 step 3): the workspace's `workflows/<id>.json`, the presets that
// are read-only, and the two endpoints — `workflows` reads, `workflow-save` writes with a signed-in
// actor (acceptance 6 and 7).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installAuthz } from '../src/host/authz.js'
import { createWorkflowStore, install, PRESETS } from '../src/host/workflow-store.js'
import { WORKFLOW_VERSION } from '../src/shared/workflow.js'
import { copyOfPreset, differingFields, workflowBytes, workflowDocument } from '../src/shared/workflow-doc.js'
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
    const store = createWorkflowStore({ dir })
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

// The set that keeps the folder warning once per process lives in `install`, not in the store,
// because the store is rebuilt whenever the workspace moves: a set inside it would say the same
// thing again after a move away and back.
test('#2068: a linked workflow folder stays one warning after the workspace moves away and back', async (t) => {
  const warned = []
  const a = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  const b = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }) })
  const outside = elsewhere(t, {})
  symlinkSync(outside, join(a, 'workflows'), 'dir')
  mkdirSync(join(b, 'workflows'), { recursive: true })
  const rt = {
    state: { bots: {}, workspaceId: 'a' },
    ctx: { workspaceRegistry: { get: (id) => ({ path: id === 'b' ? b : a }) } },
    warn: (template, ...args) => warned.push(String(template).replace(/%s/g, () => String(args.shift() ?? ''))),
  }
  install(rt)
  const read = async () => {
    await rt.workflowEndpoint('workflows', { op: 'list' })
    rt.workflowDefinitions()
  }
  await read()
  rt.state.workspaceId = 'b'
  await read()
  rt.state.workspaceId = 'a'
  await read()
  const said = warned.filter((line) => line.includes('workflow folder is not a plain directory'))
  assert.equal(said.length, 1, 'one warning per folder per process, even across a rebuilt store')
  assert.ok(said[0].includes(join(a, 'workflows')), `the warning names the folder: ${said[0]}`)
})

// A file that does not parse is skipped on every read; the line that says so is said once per
// file and process, from the same closure that keeps the folder warning.
test('#2068: a workflow file that does not parse is reported once per file and process', async (t) => {
  const warned = []
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'workflows')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'broken.json'), '{ not json')
  const rt = { state: { bots: {} }, ctx: { workspaceRegistry: { get: () => ({ path: root }) } }, warn: (template, ...args) => warned.push(String(template).replace(/%s/g, () => String(args.shift() ?? ''))) }
  install(rt)
  const skips = () => warned.filter((line) => line.includes('does not parse as a definition'))
  for (let round = 0; round < 3; round++) await rt.workflowEndpoint('workflows', { op: 'list' })
  assert.equal(skips().length, 1, 'one line per file per process, not one per read')
  writeFileSync(join(dir, 'also-broken.json'), '{ nope')
  await rt.workflowEndpoint('workflows', { op: 'list' })
  assert.equal(skips().length, 2, 'a second broken file earns its own line')
})

// #2068: the write side of the same rule — a missing folder is created, a link is refused.
test('#2068: a linked workflow folder refuses a save instead of writing into it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outside = elsewhere(t, {})
  const warnings = []
  symlinkSync(outside, join(root, 'workflows'), 'dir')
  const store = createWorkflowStore({ dir: join(root, 'workflows'), warnFolder: (dir, kind) => { if (kind === 'other') warnings.push(dir) } })
  for (let round = 0; round < 2; round++) {
    const saved = store.save({ definition: { ...blankWorkflow, id: 'mine', name: 'Mine' } })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'workflow/not-a-folder')
  }
  assert.deepEqual(readdirSync(outside), [], 'nothing was written through the link')
  assert.deepEqual([...new Set(warnings)], [join(root, 'workflows')], 'the warning names the folder')
})

test('#2068: a save still creates a missing workflow folder, and lands in a real one', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const missing = join(root, 'workflows')
  assert.equal(existsSync(missing), false)
  assert.equal(createWorkflowStore({ dir: missing }).save({ definition: { ...blankWorkflow, id: 'mine', name: 'Mine' } }).ok, true)
  assert.equal(existsSync(join(missing, 'mine.json')), true, 'the missing folder was created, as before')
  const real = join(root, 'real')
  mkdirSync(real, { recursive: true })
  assert.equal(createWorkflowStore({ dir: real }).save({ definition: { ...blankWorkflow, id: 'theirs', name: 'Theirs' } }).ok, true)
  assert.equal(existsSync(join(real, 'theirs.json')), true)
})

// The one-resolver rule, checked at the source, with a probe for every sink: a list alone would
// still be green after a new bypass was added to it (#2068).
const WORKFLOW_PROBES = {
  fileFor: 'a linked workflow folder refuses a save instead of writing into it',
  ownFiles: 'a workflow folder that is a symlink lists nothing and never reads the outside file',
  readOwnFile: 'a workflow folder that is a symlink lists nothing and never reads the outside file',
  projectDefault: 'a workflow folder that is a symlink lists nothing and never reads the outside file',
  list: 'a workflow folder that is a symlink lists nothing and never reads the outside file',
  save: 'a linked workflow folder refuses a save instead of writing into it',
  setDefault: 'a linked workflow folder refuses to be the default instead of writing into it',
}

test('#2068: every path built from the workflow folder is one of the reviewed sinks', () => {
  const source = readFileSync(new URL('../src/host/workflow-store.js', import.meta.url), 'utf8')
  const lines = source.split('\n')
  const ownerOf = (at) => {
    for (let back = at; back >= 0; back--) {
      const found = /^ {2}(?:const|let|async function|function) ([\w$]+)/.exec(lines[back])
      if (found !== null) return found[1]
    }
    return '(top level)'
  }
  const ownersOf = (pattern) => lines.flatMap((line, at) => (pattern.test(line) ? [ownerOf(at)] : []))
    .filter((owner, at, all) => all.indexOf(owner) === at)
  const paths = ownersOf(/join\(dir|fileFor\(/)
  const gates = ownersOf(/folderReal\(\)|folderWritable\(\)/)
  assert.deepEqual(paths, ['fileFor', 'readOwnFile', 'projectDefault', 'list', 'save', 'setDefault'],
    'a new path under workflows/ is a new sink: route it through folderReal/folderWritable and add it here and to WORKFLOW_PROBES')
  assert.deepEqual(gates, ['ownFiles', 'readOwnFile', 'projectDefault', 'save', 'setDefault'])
  assert.deepEqual([...new Set([...paths, ...gates])].sort(), Object.keys(WORKFLOW_PROBES).sort(),
    'every sink needs a probe in WORKFLOW_PROBES, and every probe a sink')
  const tests = new Set([...readFileSync(new URL('./workflow-store.test.js', import.meta.url), 'utf8').matchAll(/test\('#(?:2057|2068): ([^']+)'/g)].map((found) => found[1]))
  for (const [sink, probe] of Object.entries(WORKFLOW_PROBES)) {
    assert.equal(tests.has(probe), true, `the probe for ${sink} is missing: ${probe}`)
  }
})

test('#2068: a linked workflow folder refuses to be the default instead of writing into it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outside = elsewhere(t, {})
  symlinkSync(outside, join(root, 'workflows'), 'dir')
  const store = createWorkflowStore({ dir: join(root, 'workflows') })
  const set = store.setDefault({ id: 'blank' })
  assert.equal(set.ok, false)
  assert.equal(set.code, 'workflow/not-a-folder')
  assert.deepEqual(readdirSync(outside), [], 'nothing was written through the link')
})

// #2079: `folderWritable` asks the folder, and a definition file that is itself a link was written
// straight through it. The leaf is asked too: an absent file is created, a plain file is written,
// a link or a directory is refused with its own code, and neither the link nor the file it names
// is touched.
test('#2079: a linked workflow file refuses a save instead of writing through it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'workflows')
  mkdirSync(dir, { recursive: true })
  const outside = elsewhere(t, { 'mine.json': 'OUTSIDE BYTES\n' })
  const link = join(dir, 'mine.json')
  symlinkSync(join(outside, 'mine.json'), link, 'file')
  const warnings = []
  const store = createWorkflowStore({ dir, warnFile: (file) => warnings.push(file) })
  for (let round = 0; round < 2; round++) {
    const saved = store.save({ definition: { ...blankWorkflow, id: 'mine', name: 'Mine' } })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'workflow/not-a-file')
  }
  assert.equal(readFileSync(join(outside, 'mine.json'), 'utf8'), 'OUTSIDE BYTES\n', 'the file the link names is byte-identical')
  assert.equal(lstatSync(link).isSymbolicLink(), true, 'the link is still a link')
  assert.deepEqual([...new Set(warnings)], [link], 'the warning names the file, once')
  // The control: an absent file is still created, with no group or world bits, as before.
  unlinkSync(link)
  assert.equal(store.save({ definition: { ...blankWorkflow, id: 'mine', name: 'Mine' } }).ok, true)
  assert.equal(existsSync(link), true)
  assert.equal(statSync(link).mode & 0o077, 0, 'a newly created definition is not group- or world-readable')
})

test('#2079: a linked project file refuses to become the default', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'workflows')
  mkdirSync(dir, { recursive: true })
  const outside = elsewhere(t, { 'project.json': 'OUTSIDE BYTES\n' })
  const link = join(dir, 'project.json')
  symlinkSync(join(outside, 'project.json'), link, 'file')
  const warnings = []
  const store = createWorkflowStore({ dir, warnFile: (file) => warnings.push(file) })
  for (let round = 0; round < 2; round++) {
    const set = store.setDefault({ id: 'blank' })
    assert.equal(set.ok, false)
    assert.equal(set.code, 'workflow/not-a-file')
  }
  assert.equal(readFileSync(join(outside, 'project.json'), 'utf8'), 'OUTSIDE BYTES\n', 'the file the link names is byte-identical')
  assert.equal(lstatSync(link).isSymbolicLink(), true, 'the link is still a link')
  assert.deepEqual([...new Set(warnings)], [link], 'the warning names the file, once')
})

// #2159: a hard link at a definition file is a plain file to `lstat` while its bytes are also a name
// outside the workspace, so the save would land in the shared inode. The leaf is asked with the same
// predicate as the temp name (#2114): the file is refused as `workflow/not-a-file`, once, and the
// other name keeps its bytes.
test('#2159: a hard-linked workflow file refuses a save instead of writing through it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'workflows')
  mkdirSync(dir, { recursive: true })
  const outside = elsewhere(t, { 'mine.json': 'OUTSIDE BYTES\n' })
  const leaf = join(dir, 'mine.json')
  linkSync(join(outside, 'mine.json'), leaf)
  const warnings = []
  const store = createWorkflowStore({ dir, warnFile: (file) => warnings.push(file) })
  for (let round = 0; round < 2; round++) {
    const saved = store.save({ definition: { ...blankWorkflow, id: 'mine', name: 'Mine' } })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'workflow/not-a-file')
    assert.match(saved.message, /not a plain file of its own/)
  }
  assert.equal(readFileSync(join(outside, 'mine.json'), 'utf8'), 'OUTSIDE BYTES\n', 'the shared inode keeps its bytes')
  assert.equal(lstatSync(leaf).nlink, 2, 'the file is still another name of the same inode')
  assert.deepEqual([...new Set(warnings)], [leaf], 'the warning names the file, once')
  // The control: the same file carrying one name is written.
  unlinkSync(leaf)
  assert.equal(store.save({ definition: { ...blankWorkflow, id: 'mine', name: 'Mine' } }).ok, true)
  assert.equal(existsSync(leaf), true)
})

test('#2159: a hard-linked project file refuses to become the default', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'workflows')
  mkdirSync(dir, { recursive: true })
  const outside = elsewhere(t, { 'project.json': 'OUTSIDE BYTES\n' })
  const leaf = join(dir, 'project.json')
  linkSync(join(outside, 'project.json'), leaf)
  const warnings = []
  const store = createWorkflowStore({ dir, warnFile: (file) => warnings.push(file) })
  for (let round = 0; round < 2; round++) {
    const set = store.setDefault({ id: 'blank' })
    assert.equal(set.ok, false)
    assert.equal(set.code, 'workflow/not-a-file')
  }
  assert.equal(readFileSync(join(outside, 'project.json'), 'utf8'), 'OUTSIDE BYTES\n', 'the shared inode keeps its bytes')
  assert.equal(lstatSync(leaf).nlink, 2, 'the file is still another name of the same inode')
  assert.deepEqual([...new Set(warnings)], [leaf], 'the warning names the file, once')
})

// ---------------------------------------------------------------------------
// #2609: the read path asks the same question the write path does. An id was joined onto the
// workflow folder unchecked, so `../outside/stolen` read a JSON file written outside the workspace's
// `workflows/` folder and served it as this workspace's own definition. Every read entry point goes
// through `readDefinition`, which is where the guard lives.

const folderWithOutsideDefinition = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'workflows')
  mkdirSync(dir, { recursive: true })
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'stolen.json'), JSON.stringify({ ...blankWorkflow, id: 'stolen', name: 'SECRET-OUTSIDE-WORKFLOWS' }, null, 2))
  return { root, dir }
}

test('#2609: a read of an id that leaves the workflow folder answers not-found', (t) => {
  const { dir } = folderWithOutsideDefinition(t)
  const store = createWorkflowStore({ dir })
  const id = '../outside/stolen'
  const opened = store.open(id)
  assert.equal(opened.ok, false)
  assert.equal(opened.code, 'workflow/not-found')
  assert.equal(JSON.stringify(opened).includes('SECRET-OUTSIDE-WORKFLOWS'), false, 'the outside definition never comes back')
  assert.equal(store.bytesOf(id), null, 'no bytes of a file outside the folder')
  const copied = store.customize({ from: id, id: 'stolen-copy', name: 'Copy' })
  assert.equal(copied.ok, false)
  assert.equal(copied.code, 'workflow/not-found')
  assert.deepEqual(readdirSync(dir), [], 'nothing outside the folder was read or copied in')
  // The control: a legal id still opens, so the guard did not switch the feature off.
  assert.equal(store.customize({ from: 'blank', id: 'blank-mine', name: 'Mine' }).ok, true)
  const mine = store.open('blank-mine')
  assert.equal(mine.ok, true)
  assert.equal(mine.workflow.source, 'workspace')
  assert.equal(store.bytesOf('blank-mine').source, 'workspace')
  assert.equal(store.open('blank').workflow.source, 'preset', 'a preset id still opens')
})

test('#2609: the workflows endpoint previews nothing for an id that leaves the folder', async (t) => {
  const { root } = folderWithOutsideDefinition(t)
  const rt = { state: { bots: {} }, ctx: { workspaceRegistry: { get: () => ({ path: root }) } }, warn: () => {} }
  install(rt)
  const previewed = await rt.workflowEndpoint('workflows', { op: 'preview', id: '../outside/stolen' })
  assert.equal(previewed.ok, false)
  assert.equal(previewed.code, 'workflow/not-found')
  assert.equal(JSON.stringify(previewed).includes('SECRET-OUTSIDE-WORKFLOWS'), false)
  assert.equal((await rt.workflowEndpoint('workflows', { op: 'open', id: '../outside/stolen' })).code, 'workflow/not-found')
  // The control, at the endpoint the page actually calls.
  assert.equal((await rt.workflowEndpoint('workflows', { op: 'open', id: 'blank' })).ok, true)
})

test('#2609: a stored default that leaves the folder is answered as none', (t) => {
  const { dir } = folderWithOutsideDefinition(t)
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ default: '../outside/stolen' }, null, 2)}\n`)
  const listed = createWorkflowStore({ dir }).list()
  assert.equal(listed.default, null, 'a stored key is a file name only when it is one')
  assert.deepEqual(listed.own, [])
})

// ---------------------------------------------------------------------------
// #2614: a workflow folder that is there but cannot be listed (a restore with the owner bits
// wrong, or a `chmod -R` accident) answered `ok: true` with an empty `own`, while `open` still
// read a definition by name: listing a folder needs `+r`, reading a name in it only `+x`, so the
// two halves disagreed. The listing half refuses with `workflow/unreadable`, a write that landed
// still says `wrote: true`, and getting the permission back lists the files again.
// Root ignores the permission bits, so both cases are skipped there.

const unlistableFolder = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-workflows-'))
  const dir = join(root, 'workflows')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mine.json'), JSON.stringify({ ...blankWorkflow, id: 'mine', name: 'Mine' }))
  t.after(() => {
    chmodSync(dir, 0o755)
    rmSync(root, { recursive: true, force: true })
  })
  chmodSync(dir, 0o311)
  return dir
}

test('#2614: a workflow folder that cannot be listed refuses the list instead of answering empty', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root ignores the folder permission bits')
    return
  }
  const dir = unlistableFolder(t)
  const store = createWorkflowStore({ dir })
  const listed = store.list()
  assert.equal(listed.ok, false)
  assert.equal(listed.code, 'workflow/unreadable')
  assert.ok(listed.message.includes(`the workflow folder ${dir} is there but cannot be listed`), listed.message)
  assert.equal('own' in listed, false, 'a refusal never carries an empty own list')
  // Reading a name out of the folder needs only `+x`, so it still answers: that is how the two
  // halves disagreed before the refusal existed.
  const opened = store.open('mine')
  assert.equal(opened.ok, true)
  assert.equal(opened.workflow.source, 'workspace')
  assert.equal(opened.workflow.definition.name, 'Mine')
  // Put the permission back: the same store lists the file again.
  chmodSync(dir, 0o755)
  const back = store.list()
  assert.equal(back.ok, true)
  assert.deepEqual(back.own.map((entry) => entry.id), ['mine'])
})

test('#2614: a save that landed in an unlistable folder says wrote: true and refuses the list', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root ignores the folder permission bits')
    return
  }
  const dir = unlistableFolder(t)
  const store = createWorkflowStore({ dir })
  const saved = store.save({ definition: { ...blankWorkflow, id: 'mine', name: 'Mine 2' } })
  assert.equal(saved.ok, false)
  assert.equal(saved.code, 'workflow/unreadable')
  assert.equal(saved.wrote, true)
  assert.equal(saved.changed, true)
  assert.equal('own' in saved, false, 'a refusal never carries an empty own list')
  assert.equal(JSON.parse(readFileSync(join(dir, 'mine.json'), 'utf8')).name, 'Mine 2', 'the write landed')
  // An unedited save writes nothing, and still refuses the list it could not read.
  const again = store.save({ definition: store.open('mine').workflow.definition })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'workflow/unreadable')
  assert.equal(again.wrote, false)
  assert.equal(again.changed, false)
  // A default lands too, and says the same thing about the listing half.
  const set = store.setDefault({ id: 'mine' })
  assert.equal(set.ok, false)
  assert.equal(set.code, 'workflow/unreadable')
  assert.equal(set.wrote, true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).default, 'mine', 'the default landed')
  // Reading the default back by name needs only `+x`; the listing half is what refused.
  assert.equal(store.open('mine').ok, true)
  chmodSync(dir, 0o755)
  const back = store.list()
  assert.equal(back.ok, true)
  assert.equal(back.default, 'mine')
  assert.deepEqual(back.own.map((entry) => entry.id), ['mine'])
})

// #2681: a file written by a newer build is not this build's to rewrite. `workflowDocument` emits
// a fixed key set and `normaliseWorkflow` reads only what it knows, so a save over such a file would
// drop every field this build has no reader for while `version` kept saying the newer number — the
// newer build reading it back could not even tell the file had been damaged. The refusal names the
// file, and the bytes stay exactly as the newer build wrote them.
const newerDocument = (id = 'newer-mine') => ({
  id,
  name: 'Newer mine',
  version: WORKFLOW_VERSION + 1,
  inputs: [],
  deliverables: [],
  stages: ['plan', 'build'],
  nodes: [
    { id: 'plan', name: 'Planner', role: 'Dev', inputs: [], outputs: [], guards: [], refusal: '', timeoutMinutes: 30 },
    { id: 'build', name: 'Builder', role: 'Dev', inputs: [], outputs: [], guards: [], refusal: '' },
  ],
  edges: [{ from: 'plan', to: 'build' }],
  loops: [],
})

test('#2681: a store file from a newer build is named on read and never rewritten', () => {
  withDir((dir) => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'newer-mine.json')
    const original = Buffer.from(`${JSON.stringify(newerDocument(), null, 2)}\n`, 'utf8')
    writeFileSync(path, original)
    const store = createWorkflowStore({ dir })

    const listed = store.list()
    assert.equal(listed.ok, true, 'one file this build cannot read does not take the list down')
    assert.deepEqual(listed.own, [], 'a definition whose fields this build cannot read is not listed as its own')
    assert.deepEqual(listed.newer, [{ id: 'newer-mine', version: WORKFLOW_VERSION + 1 }], 'the read names the file and the version that wrote it')

    const opened = store.open('newer-mine')
    assert.equal(opened.ok, false, 'a read does not present a stripped definition as the store')
    assert.equal(opened.code, 'workflow/newer-version')
    assert.match(opened.message, /newer/)

    // What an older page would send after reading the file through a build that strips it: this
    // build's own version, and none of the fields it does not know. Today that overwrote the file.
    const stale = store.save({ definition: copyOfPreset(blankWorkflow, { id: 'newer-mine', name: 'Mine' }) })
    assert.equal(stale.ok, false, 'the write path refuses a file a newer build wrote')
    assert.equal(stale.code, 'workflow/newer-version')
    // And a definition that says it is newer itself is refused too, before anything is written.
    const incoming = store.save({ definition: newerDocument() })
    assert.equal(incoming.ok, false)
    assert.equal(incoming.code, 'workflow/newer-version')

    const after = readFileSync(path)
    assert.equal(after.equals(original), true, 'the file is byte-identical after both refusals')
    const kept = JSON.parse(after.toString('utf8'))
    assert.equal(kept.version, WORKFLOW_VERSION + 1)
    assert.deepEqual(kept.stages, ['plan', 'build'], 'the top-level field this build cannot read is still there')
    assert.equal(kept.nodes[0].timeoutMinutes, 30, 'the node field this build cannot read is still there')
  })
})

test('#2681: a definition at this build own version with unknown fields still saves as it does today', () => {
  withDir((dir) => {
    mkdirSync(dir, { recursive: true })
    const base = copyOfPreset(blankWorkflow, { id: 'mine', name: 'Mine' })
    const doc = workflowDocument(base)
    const handEdited = { ...doc, stages: ['plan'], nodes: doc.nodes.map((node) => ({ ...node, timeoutMinutes: 30 })) }
    writeFileSync(join(dir, 'mine.json'), `${JSON.stringify(handEdited, null, 2)}\n`)
    const store = createWorkflowStore({ dir })

    const listed = store.list()
    assert.deepEqual(listed.newer, [], 'a file at this build version is not reported as newer')
    assert.deepEqual(listed.own.map((entry) => entry.id), ['mine'], 'and it is still listed as this store own')

    const opened = store.open('mine')
    assert.equal(opened.ok, true, 'a definition at this build version still opens')
    const saved = store.save({ definition: opened.workflow.definition })
    assert.equal(saved.ok, true, 'and still saves')
    assert.equal(saved.changed, true)
    const written = JSON.parse(readFileSync(join(dir, 'mine.json'), 'utf8'))
    assert.equal('stages' in written, false, 'a key this build has no reader for is dropped, as before')
    assert.equal('timeoutMinutes' in written.nodes[0], false)
    assert.deepEqual(written, workflowDocument(base), 'the canonical bytes are unchanged by this fix')
  })
})
