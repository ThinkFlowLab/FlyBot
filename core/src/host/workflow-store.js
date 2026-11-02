// Where a workflow definition lives (#1272 step 3): the two FlyBot ships as presets, plus the
// owner's own `workflows/<id>.json` in the workspace. This module is the only writer — a page asks
// it, it validates with the engine's own `validateWorkflow`, and it writes the canonical bytes
// `workflow-doc.js` produces. Three rules are enforced here rather than trusted to the page:
//
//   - **a preset is copied, never mutated.** `repo-dev` and `blank` are read from the shipped
//     modules and no file with their id is ever written, so the factory preset's bytes cannot
//     change by any path this host serves (`customize` is the only way to start from one).
//   - **a save that changes nothing writes the same bytes** (acceptance 7): `workflowBytes` is
//     canonical, so a round trip is byte-identical and a definition diffs cleanly in git.
//   - **a guard preview never invents a pass** (acceptance 5): the facts come from a reader the
//     caller supplies; a reader that answered nothing makes every row say it could not read.
//
// The endpoint is `workflow-save`, which is in `authz.js`'s `TASK_ENDPOINTS` allow list; `workflows`
// is the read side and is listed with the other reads.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { layoutWorkflow, normaliseWorkflow, validateWorkflow } from '../shared/workflow.js'
import { copyOfPreset, isPresetId, isWorkflowId, workflowBytes, WORKFLOW_DIR } from '../shared/workflow-doc.js'
import { previewNode } from '../shared/workflow-preview.js'
import { repoDevWorkflow } from '../shared/workflow-repo-dev.js'
import { blankWorkflow } from '../shared/workflow-blank.js'
import { dirKindSync, fileKindSync } from './real-dir.js'

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
  const refuseNotFile = (file) => ({ ok: false, code: 'workflow/not-a-file', message: `the workflow file ${file} is not a plain file, so nothing is written there`, problems: [] })
  // A directory may not exist yet (a workspace nobody has customized anything in), and a file in it
  // may be someone's hand-edit that does not parse: one broken file must not take the list down.
  const ownFiles = () => {
    if (!folderReal()) return []
    try {
      return readdirSync(dir).filter((name) => name.endsWith('.json') && name !== PROJECT_FILE).sort()
    } catch {
      return []
    }
  }

  const readOwn = (id) => {
    if (!folderReal()) return null
    try {
      return normaliseWorkflow(JSON.parse(readFileSync(fileFor(id), 'utf8')))
    } catch {
      return null
    }
  }

  const readDefinition = (id) => {
    const preset = presets.map(normaliseWorkflow).find((definition) => definition.id === id)
    if (preset !== undefined) return { definition: preset, source: 'preset' }
    const own = readOwn(id)
    return own === null ? null : { definition: own, source: 'workspace' }
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
    const own = ownFiles().flatMap((name) => {
      const definition = readOwn(name.slice(0, -'.json'.length))
      if (definition === null || definition.id === '') {
        skipped(join(dir, name), name, dir)
        return []
      }
      return [summary(definition, 'workspace')]
    })
    const current = projectDefault()
    return {
      ok: true,
      presets: presets.map((definition) => summary(definition, 'preset')),
      own,
      // A default naming a workflow nobody has (a deleted file) is answered as "none", never echoed
      // back as a workflow the page would then fail to open.
      default: current !== null && readDefinition(current) !== null ? current : null,
    }
  }

  const open = (id, node = null) => {
    const found = readDefinition(String(id ?? ''))
    if (found === null) return { ok: false, code: 'workflow/not-found', message: `there is no workflow "${id}"`, problems: [] }
    const { definition, source } = found
    const target = typeof node === 'string' && node !== '' ? node : definition.nodes.find((entry) => entry.column !== false)?.id ?? definition.nodes[0]?.id ?? null
    const answer = factsFor({ id: definition.id, node: target })
    return {
      ok: true,
      ...list(),
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
    const problems = validate(def)
    if (problems.length > 0) return { ok: false, code: 'workflow/invalid', message: problems[0].message, problems }
    const bytes = workflowBytes(def)
    if (!folderWritable()) return refuseWritable()
    const path = fileFor(def.id)
    if (!fileWritable(path)) return refuseNotFile(path)
    const previous = (() => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    })()
    if (previous !== bytes) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, bytes, { mode: 0o600 })
    }
    return { ok: true, id: def.id, bytes, changed: previous !== bytes, ...list() }
  }

  const customize = ({ from, id, name } = {}) => {
    const found = readDefinition(String(from ?? ''))
    if (found === null) return { ok: false, code: 'workflow/not-found', message: `there is no workflow "${from}" to customize`, problems: [] }
    const copy = copyOfPreset(found.definition, { id, name })
    const saved = save({ definition: copy })
    if (!saved.ok) return saved
    return { ...saved, copiedFrom: found.definition.id, source: 'workspace' }
  }

  const setDefault = ({ id } = {}) => {
    const found = readDefinition(String(id ?? ''))
    if (found === null) return { ok: false, code: 'workflow/not-found', message: `there is no workflow "${id}"`, problems: [] }
    if (!folderWritable()) return refuseWritable()
    const path = join(dir, PROJECT_FILE)
    if (!fileWritable(path)) return refuseNotFile(path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify({ default: found.definition.id }, null, 2)}\n`, { mode: 0o600 })
    return { ok: true, ...list() }
  }

  return {
    dir,
    list,
    open,
    save,
    customize,
    setDefault,
    // The definitions in play, for the board's columns. Presets always; a workspace file is read on
    // every call so a save is visible to the next board read without a restart.
    definitions: () => {
      const own = ownFiles().map((name) => readOwn(name.slice(0, -'.json'.length))).filter((definition) => definition !== null && definition.id !== '')
      return [...presets.map(normaliseWorkflow), ...own]
    },
    bytesOf: (id) => {
      const found = readDefinition(String(id ?? ''))
      return found === null ? null : { source: found.source, bytes: workflowBytes(found.definition) }
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
    rt.warn?.('ds-bot: workflow file is not a plain file %s; nothing is written there', file)
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
