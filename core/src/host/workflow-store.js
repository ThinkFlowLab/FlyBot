// Where a workflow definition lives (#1272 step 3): the two FlyBot ships as presets, plus the
// owner's own `workflows/<id>.json` in the workspace. This module is the only writer — a page asks
// it, it validates with the engine's own `validateWorkflow`, and it writes the canonical bytes
// `workflow-doc.js` produces. Four rules are enforced here rather than trusted to the page:
//
//   - **a preset is copied, never mutated.** `repo-dev` and `blank` are read from the shipped
//     modules and no file with their id is ever written, so the factory preset's bytes cannot
//     change by any path this host serves (`customize` is the only way to start from one).
//   - **a save that changes nothing writes the same bytes** (acceptance 7): `workflowBytes` is
//     canonical, so a round trip is byte-identical and a definition diffs cleanly in git.
//   - **a guard preview never invents a pass** (acceptance 5): the facts come from a reader the
//     caller supplies; a reader that answered nothing makes every row say it could not read.
//   - **a file from a newer build is refused, not rewritten** (#2681). `workflowDocument` emits a
//     fixed key set and `normaliseWorkflow` reads only what it knows, so writing over a definition
//     whose `version` is higher would drop every field this build has no reader for while the file
//     kept claiming that version — the newer build could not tell its file had been damaged. The
//     read names such a file instead of presenting it, and the write refuses with its bytes intact,
//     the shape `plugins/timeline/src/store.js` takes for a newer trace segment.
//
// The endpoint is `workflow-save`, which is in `authz.js`'s `TASK_ENDPOINTS` allow list; `workflows`
// is the read side and is listed with the other reads.
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { replacePrivateFileSync } from './private-files.js'
import { layoutWorkflow, normaliseWorkflow, validateWorkflow, WORKFLOW_VERSION } from '../shared/workflow.js'
import { copyOfPreset, isPresetId, isWorkflowId, workflowBytes, WORKFLOW_DIR } from '../shared/workflow-doc.js'
import { previewNode } from '../shared/workflow-preview.js'
import { repoDevWorkflow } from '../shared/workflow-repo-dev.js'
import { blankWorkflow } from '../shared/workflow-blank.js'
import { dirKindSync, fileKindSync, tempWritable } from './real-dir.js'

// The shipped presets, as definitions. `PRESET_IDS` in `workflow-doc.js` names the same two; a test
// asserts they cannot drift apart.
export const PRESETS = Object.freeze([repoDevWorkflow, blankWorkflow])
// The project's own answer for "which workflow does this board use": a tiny file beside the
// definitions, so it is exportable and diffable like they are.
const PROJECT_FILE = 'project.json'

const summary = (definition, source) => ({
  id: normaliseWorkflow(definition).id,
  name: normaliseWorkflow(definition).name,
  source,
  nodes: normaliseWorkflow(definition).nodes.length,
  columns: normaliseWorkflow(definition).nodes.filter((node) => node.column !== false).length,
})

export function createWorkflowStore({ dir, presets = PRESETS, team = () => null, factsFor = () => ({ ok: false, why: 'this host has no fact reader' }), warnFolder = () => {}, warnFile = () => {}, skipped = () => {} } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('a workflow store needs a directory')
  const fileFor = (id) => join(dir, `${id}.json`)

  // `readdir` and `readFile` follow a directory link (#2057), so a `workflows` that is a link would
  // list and read another folder's definitions as this workspace's own. Only a real folder is read;
  // a missing or linked one answers what a missing folder answers today. The warning is what tells
  // the two apart in the page, and the caller says it once per folder rather than once per read.
  const folderReal = () => {
    const kind = dirKindSync(dir)
    if (kind !== 'real') warnFolder(dir, kind)
    return kind === 'real'
  }
  // The write side of the same rule: a folder that is not there yet is created, as it always
  // was, and a link or a plain file is refused instead of written through.
  const folderWritable = () => {
    const kind = dirKindSync(dir)
    if (kind === 'real' || kind === 'absent') return true
    warnFolder(dir, kind)
    return false
  }
  const refuseWritable = () => ({ ok: false, code: 'workflow/not-a-folder', message: `the workflow folder ${dir} is not a plain directory, so nothing is written there`, problems: [] })
  // The file is asked too (#2079): `writeFileSync` follows a link at the last component, so a
  // `mine.json` or `project.json` that is a link would write into the file it names. An absent file
  // is still created; a link or a directory is refused, and the warning names the file once.
  const warnedFiles = new Set()
  const fileWritable = (file) => {
    const kind = fileKindSync(file)
    if (kind === 'real' || kind === 'absent') return true
    if (!warnedFiles.has(file)) {
      warnedFiles.add(file)
      warnFile(file)
    }
    return false
  }
  const refuseNotFile = (file) => ({ ok: false, code: 'workflow/not-a-file', message: `the workflow file ${file} is not a plain file of its own, so nothing is written there`, problems: [] })
  // A write replaces the file instead of truncating it (#2762): `writeFileSync(path, …)` opens the
  // target 'w', so a second process reading inside that window parses half a definition (or nothing)
  // and `open()` answers `workflow/not-found` for a file that is being rewritten. A private temp
  // name beside the target, renamed over it, makes every read see the previous complete bytes or the
  // new complete bytes, and a crash inside the write leaves the previous definition whole.
  let sweptTemps = false
  // A crashed host's temp name holds no state — the target it was going to replace is still the
  // last complete definition — so this host's first write sweeps it, and only a writing host does.
  const sweepTemps = (file) => {
    sweptTemps = true
    const folder = dirname(file)
    const prefix = `${basename(file)}.`
    let names = []
    try {
      names = readdirSync(folder)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      try { unlinkSync(`${folder}/${name}`) } catch { /* another host may be writing it */ }
    }
  }
  const replaceBytes = (path, bytes) => {
    const temp = `${path}.${process.pid}.tmp`
    if (!sweptTemps) sweepTemps(path)
    // `writeFileSync` follows a link at the temp name (#2097, #2159), which would take the bytes
    // outside and the rename after it would put the link where the definition belongs.
    if (!tempWritable(temp)) return refuseNotFile(temp)
    try {
      replacePrivateFileSync(temp, path, bytes)
    } catch (error) {
      // The target still holds the bytes it had; its temp name is ours to remove.
      try { unlinkSync(temp) } catch { /* nothing was staged, or the rename already took it */ }
      throw error
    }
    return null
  }
  // A directory may not exist yet (a workspace nobody has customized anything in), and a file in it
  // may be someone's hand-edit that does not parse: one broken file must not take the list down.
  // A real folder that cannot be listed is not that case (#2614): `list` turns the failure into a
  // refusal, because an empty list here would sit beside the files `open` still reads by name.
  const ownFiles = () => {
    if (!folderReal()) return []
    return readdirSync(dir).filter((name) => name.endsWith('.json') && name !== PROJECT_FILE).sort()
  }
  const refuseUnreadable = () => ({ ok: false, code: 'workflow/unreadable', message: `the workflow folder ${dir} is there but cannot be listed, so its workflows cannot be read`, problems: [] })
  // The version a file says it carries, read the way `normaliseWorkflow` reads it: a value that is
  // not an integer is no claim at all, so this build's own version stands in for it.
  const versionOf = (raw) => (Number.isInteger(raw?.version) ? raw.version : WORKFLOW_VERSION)
  const refuseNewer = (file, version) => ({
    ok: false,
    code: 'workflow/newer-version',
    message: `the workflow file ${file} was written by a newer FlyBot (version ${version}); this build writes version ${WORKFLOW_VERSION} and would drop the fields it has no reader for, so nothing is written there`,
    problems: [],
  })

  // What `workflows/<id>.json` holds, or why this build may not present it: `{ definition }`, or
  // `{ newer: version, refusal }` for a file a newer build wrote (the refusal names the file, so the
  // path is built here, inside the sink that already asks `folderReal`), or `null` when the file is
  // absent or does not parse.
  const readOwnFile = (id) => {
    if (!folderReal()) return null
    let raw
    try {
      raw = JSON.parse(readFileSync(fileFor(id), 'utf8'))
    } catch {
      return null
    }
    const version = versionOf(raw)
    if (version > WORKFLOW_VERSION) return { newer: version, refusal: refuseNewer(fileFor(id), version) }
    try {
      return { definition: normaliseWorkflow(raw) }
    } catch {
      return null
    }
  }
  const readOwn = (id) => readOwnFile(id)?.definition ?? null

  // A file name is a file name on both sides of the store (#2609): `save` has always refused an id
  // that is not one, and the read joins the same id onto the folder, so `../outside/stolen` would
  // read a JSON file outside `workflows/` — including the stored `default` key `list()` feeds
  // back in here. Every read entry point comes through this function, so the check lives here once.
  // A newer file is answered as itself (`refusal`), never as a stripped definition of this build's.
  const readDefinition = (id) => {
    if (!isWorkflowId(id)) return null
    const preset = presets.map(normaliseWorkflow).find((definition) => definition.id === id)
    if (preset !== undefined) return { definition: preset, source: 'preset' }
    const own = readOwnFile(id)
    if (own === null) return null
    if (own.refusal !== undefined) return { newer: own.newer, refusal: own.refusal }
    return { definition: own.definition, source: 'workspace' }
  }

  const projectDefault = () => {
    if (!folderReal()) return null
    try {
      const value = JSON.parse(readFileSync(join(dir, PROJECT_FILE), 'utf8'))
      return typeof value?.default === 'string' && value.default !== '' ? value.default : null
    } catch {
      return null
    }
  }

  const list = () => {
    let names
    try {
      names = ownFiles()
    } catch {
      return refuseUnreadable()
    }
    const own = []
    const newer = []
    for (const name of names) {
      const id = name.slice(0, -'.json'.length)
      const found = readOwnFile(id)
      if (found === null || (found.definition !== undefined && found.definition.id === '')) {
        skipped(join(dir, name), name, dir)
        continue
      }
      // #2681: a file a newer build wrote is named, not listed as one of this store's own — its
      // definition would come back stripped of the fields this build cannot read.
      if (found.newer !== undefined) {
        newer.push({ id, version: found.newer })
        continue
      }
      own.push(summary(found.definition, 'workspace'))
    }
    const current = projectDefault()
    const chosen = current === null ? null : readDefinition(current)
    return {
      ok: true,
      presets: presets.map((definition) => summary(definition, 'preset')),
      own,
      newer,
      // A default naming a workflow nobody has (a deleted file) is answered as "none", never echoed
      // back as a workflow the page would then fail to open. A newer file cannot be opened either.
      default: chosen !== null && chosen.definition !== undefined ? current : null,
    }
  }

  const open = (id, node = null) => {
    const found = readDefinition(String(id ?? ''))
    if (found === null) return { ok: false, code: 'workflow/not-found', message: `there is no workflow "${id}"`, problems: [] }
    if (found.refusal !== undefined) return found.refusal
    const { definition, source } = found
    const target = typeof node === 'string' && node !== '' ? node : definition.nodes.find((entry) => entry.column !== false)?.id ?? definition.nodes[0]?.id ?? null
    const answer = factsFor({ id: definition.id, node: target })
    const listed = list()
    return {
      ok: true,
      // A folder that cannot be listed still opens a definition by name (reading one name needs
      // only `+x`), so the refusal belongs to the listing half: the listing fields are left out
      // rather than spreading an empty `own` over this answer (#2614).
      ...(listed.ok ? listed : {}),
      workflow: {
        id: definition.id,
        name: definition.name,
        source,
        editable: source === 'workspace',
        definition,
        // The bytes a save would write, so the page can say "unchanged" before it asks.
        bytes: workflowBytes(definition),
        sha: null,
      },
      layout: layoutWorkflow(definition),
      preview: target === null ? null : previewNode(definition, target, answer),
    }
  }

  const validate = (definition) => {
    const problems = validateWorkflow(definition, { team: team() ?? undefined }).problems
    return problems
  }

  const save = ({ definition } = {}) => {
    const def = normaliseWorkflow(definition)
    if (!isWorkflowId(def.id)) {
      return { ok: false, code: 'workflow/bad-id', message: `"${def.id}" is not a file name a workflow can have (lowercase letters, digits and hyphens)`, problems: [] }
    }
    if (isPresetId(def.id)) {
      return { ok: false, code: 'workflow/preset-read-only', message: `"${def.id}" is a preset FlyBot ships; customize it into a new workflow instead of saving over it`, problems: [] }
    }
    const path = fileFor(def.id)
    // #2681: before anything else about the content, the version question. A definition that says
    // it is newer, or a file on disk a newer build wrote, is refused and left byte-for-byte alone;
    // `validate` would otherwise answer a stripped copy with its own, unrelated refusal.
    if (def.version > WORKFLOW_VERSION) return refuseNewer(path, def.version)
    const onDisk = readOwnFile(def.id)
    if (onDisk?.newer !== undefined) return refuseNewer(path, onDisk.newer)
    const problems = validate(def)
    if (problems.length > 0) return { ok: false, code: 'workflow/invalid', message: problems[0].message, problems }
    const bytes = workflowBytes(def)
    if (!folderWritable()) return refuseWritable()
    if (!fileWritable(path)) return refuseNotFile(path)
    const previous = (() => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    })()
    const wrote = previous !== bytes
    if (wrote) {
      mkdirSync(dir, { recursive: true })
      const refused = replaceBytes(path, bytes)
      if (refused !== null) return refused
    }
    const listed = list()
    // A landed write and a folder that refuses to be listed are both true: saying only `ok: false`
    // would hide the write, and `ok: true` beside an empty `own` would hide the folder (#2614).
    if (!listed.ok) return { ...listed, id: def.id, wrote, changed: wrote }
    return { ok: true, id: def.id, bytes, changed: wrote, ...listed }
  }

  const customize = ({ from, id, name } = {}) => {
    const found = readDefinition(String(from ?? ''))
    if (found === null) return { ok: false, code: 'workflow/not-found', message: `there is no workflow "${from}" to customize`, problems: [] }
    // A copy is a write of this build's canonical bytes, so it may not be made from a definition
    // whose fields this build cannot read (#2681).
    if (found.refusal !== undefined) return found.refusal
    const copy = copyOfPreset(found.definition, { id, name })
    const saved = save({ definition: copy })
    if (!saved.ok) return saved
    return { ...saved, copiedFrom: found.definition.id, source: 'workspace' }
  }

  const setDefault = ({ id } = {}) => {
    const found = readDefinition(String(id ?? ''))
    if (found === null) return { ok: false, code: 'workflow/not-found', message: `there is no workflow "${id}"`, problems: [] }
    if (found.refusal !== undefined) return found.refusal
    if (!folderWritable()) return refuseWritable()
    const path = join(dir, PROJECT_FILE)
    if (!fileWritable(path)) return refuseNotFile(path)
    mkdirSync(dir, { recursive: true })
    const refused = replaceBytes(path, `${JSON.stringify({ default: found.definition.id }, null, 2)}\n`)
    if (refused !== null) return refused
    const listed = list()
    if (!listed.ok) return { ...listed, wrote: true, changed: true }
    return { ok: true, ...listed }
  }

  return {
    dir,
    list,
    open,
    save,
    customize,
    setDefault,
    // The definitions in play, for the board's columns. Presets always; a workspace file is read on
    // every call so a save is visible to the next board read without a restart. A file a newer build
    // wrote is left out: this build cannot run a definition whose fields it cannot read (#2681).
    definitions: () => {
      const own = ownFiles().map((name) => readOwn(name.slice(0, -'.json'.length))).filter((definition) => definition !== null && definition.id !== '')
      return [...presets.map(normaliseWorkflow), ...own]
    },
    bytesOf: (id) => {
      const found = readDefinition(String(id ?? ''))
      // No bytes this build would write for a file it may not rewrite.
      return found?.definition === undefined ? null : { source: found.source, bytes: workflowBytes(found.definition) }
    },
  }
}

// `workflows` reads; `workflow-save` writes. Both answer the store's own objects, so a refusal is a
// code and a sentence the page can show rather than an exception in the channel.
export function install(rt) {
  const dirFor = () => {
    let base = null
    try { base = rt.ctx?.workspaceRegistry?.get?.(rt.state?.workspaceId)?.path ?? null } catch { base = null }
    return base === null ? null : join(base, WORKFLOW_DIR)
  }
  // The roster's role names are the team a definition may name; a node role that is not one of them
  // is refused by `validateWorkflow` (`system` and `human:` stay allowed by the engine).
  const team = () => {
    try {
      const roles = new Set()
      for (const bot of Object.values(rt.state?.bots ?? {})) if (typeof bot?.role === 'string' && bot.role !== '') roles.add(bot.role)
      // An empty roster is "no team to check against", not a team of nobody: refusing every role
      // would make the first definition unsavable on a fresh host.
      return roles.size === 0 ? null : [...roles]
    } catch {
      return null
    }
  }
  const warnedFolders = new Set()
  const warnFolder = (dir, kind) => {
    if (kind !== 'other' || warnedFolders.has(dir)) return
    warnedFolders.add(dir)
    rt.warn?.('ds-bot: workflow folder is not a plain directory %s; keeping it empty', dir)
  }
  // The once-per-file warning for a refused write is deduped inside the store (#2079); this
  // callback only prints, so one file is named once however many saves hit it.
  const warnNotFile = (file) => {
    rt.warn?.('ds-bot: workflow file is not a plain file of its own %s; nothing is written there', file)
  }
  // A file that does not parse is skipped on every read, so it would repeat this line on every
  // read too: the store is rebuilt when the workspace moves, so the set lives here, with the one
  // above, and a file is named once per process.
  const warnedSkips = new Set()
  const warnSkipped = (file, name, dir) => {
    if (warnedSkips.has(file)) return
    warnedSkips.add(file)
    rt.warn?.('ds-bot: workflow store: %s in %s does not parse as a definition; skipped', name, dir)
  }
  const store = () => {
    const dir = dirFor()
    if (dir === null) return null
    if (rt.workflowStore?.dir !== dir) rt.workflowStore = createWorkflowStore({ dir, team, warnFolder, warnFile: warnNotFile, skipped: warnSkipped, factsFor: rt.workflowFactsFor ?? (() => ({ ok: false, why: 'this host has no fact reader' })) })
    return rt.workflowStore
  }
  rt.workflowEndpoint = async (endpoint, body = {}) => {
    const found = store()
    if (found === null) return { ok: false, code: 'workflow/no-workspace', message: 'this host has no workspace, so there is nowhere to read or save a workflow', problems: [] }
    if (endpoint === 'workflow-save') {
      const op = String(body?.op ?? 'save')
      if (op === 'save') return found.save({ definition: body?.definition })
      if (op === 'customize') return found.customize({ from: body?.from, id: body?.id, name: body?.name })
      if (op === 'default') return found.setDefault({ id: body?.id })
      return { ok: false, code: 'workflow/unknown-op', message: `workflow-save has no "${op}"; it saves, customizes or sets the default`, problems: [] }
    }
    const op = String(body?.op ?? 'list')
    if (op === 'list') return found.list()
    if (op === 'open') return found.open(body?.id, body?.node)
    if (op === 'preview') {
      const opened = found.open(body?.id, body?.node)
      if (!opened.ok) return opened
      return { ok: true, id: opened.workflow.id, preview: opened.preview }
    }
    return { ok: false, code: 'workflow/unknown-op', message: `workflows has no "${op}"; it lists, opens or previews`, problems: [] }
  }
  // Presets plus the workspace files. The settings page lists and opens them; nothing here draws a board.
  rt.workflowDefinitions = () => {
    try { return store()?.definitions() ?? PRESETS.map(normaliseWorkflow) } catch { return PRESETS.map(normaliseWorkflow) }
  }
  return rt
}
