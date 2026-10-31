// Store: the saved team (state.json), its migrations, the lock that keeps a second dsh
// host on the same data from writing it, and the indexes that map a Session to the Bot
// or group chat it belongs to.
import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_THEMES, MAX_ENTRY, MAX_EXCHANGES, ROOM_MODES } from './constants.js'
import { homeLock } from './home-lock.js'
import { openJournal } from './journal.js'
import { currentColor, normalize, unquote } from './text.js'

// The saved team's format version. Version 2 (#47) adds the identity schema: member
// records, a per-Bot owner binding, and the owner's designated Chief. A version-1 file
// is migrated on load (after a one-time `state.json.v1` backup); a file written by a
// newer DS Bot is refused read-only, so an older binary never overwrites this schema.
const STATE_VERSION = 2
// The immutable id of the one owner a fresh or legacy team starts with.
const OWNER_ID = 'owner-1'
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Ids and names arrive from the wire, and the saved tables are plain objects, so `table[id]`
// answers `Object.prototype` for `__proto__` (and `isRecord` accepts it): every id lookup in
// the host reads its table through this one own-key check, and a write defines an own entry so
// the prototype setter never swallows it (#1704, #1711).
export const ownEntry = (table, id) => (Object.hasOwn(table, id) ? table[id] : undefined)
export const setEntry = (table, id, value) => Object.defineProperty(table, id, { value, writable: true, enumerable: true, configurable: true })
// Retired (#638): the record keeps its chat, parts and memory, but no host path may resolve it
// into a turn, a capability, a memory write or a timer (#1700, #1709). One predicate, here,
// because every such path imports it rather than growing its own copy.
export const retiredBot = bot => bot?.fields?.['flybot-tree']?.retired === true


export function install(rt) {
  const { ctx, home, statePath, config = {} } = rt

  /** @type {{version:2, workspaceId?:string, mainBotIds:string[], members:Record<string,any>, bots:Record<string,any>, rooms:Record<string,any>, agents:Record<string,any>, capabilities:{items:Record<string,any>}, exchanges:any[], exchangeTurns:Record<string,number[]>, revision:number, invitations:Record<string,any>, authSessions:Record<string,any>, tasks:Record<string,any>, retiredSessions:Record<string,string>, projects:Record<string,any>, projectRuns:Record<string,string>}} */
  // `projects` is the durable Project record (#1691); `projectRuns` is the binding a workflow run
  // reports, because a run lives in the workflow plugin's own state and cannot carry the field.
  const state = { version: STATE_VERSION, mainBotIds: [], members: {}, bots: {}, rooms: {}, agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, invitations: {}, authSessions: {}, tasks: {}, retiredSessions: {}, projects: {}, projectRuns: {}, projectMemory: {}, revision: 0 }
  let loaded = null
  let writing = Promise.resolve()
  // Every save this host has accepted since it started — a monotonic watermark, never decremented
  // — and the chain's tail: what `savesQueued` and `savesSettled` answer (#1368).
  let queued = 0
  const { warn } = rt
  // Opt-in (#511): every saved change is also recorded for replay; off by default.
  const journal = config.stateJournal === true ? openJournal({ path: join(home, 'journal', 'state.jsonl'), warn }) : undefined

  const EMPTY = JSON.stringify(state)
  // The other dsh host that holds state.lock while this one only reads (see home-lock.js);
  // undefined while this host may write.
  let holder
  let lockBroken = false
  let stuck
  let warnedReadOnly = false
  let stopped = false
  // mtime and size of the state.json this host last read or wrote.
  let seen = ''
  const stamp = () => {
    try {
      const { mtimeMs, size } = statSync(statePath)
      return `${mtimeMs}:${size}`
    } catch {
      return ''
    }
  }
  const lock = homeLock(join(home, 'state.lock'))
  const claimLock = () => {
    if (lockBroken) return
    try {
      mkdirSync(home, { recursive: true })
      holder = lock.claim()
    } catch (error) {
      // An unusable lock (a read-only or odd file system) must not stop the team; a
      // save that then cannot write still rejects.
      lockBroken = true
      holder = undefined
      warn('ds-bot: cannot lock %s, so another dsh on the same data could undo changes: %s', home, error)
    }
  }
  const readOnly = () => {
    if (stuck !== undefined) return `The Bot team file ${statePath} could not be read (${stuck}). FlyBot does not change it; fix or move the file and reload.`
    if (holder === undefined) return undefined
    const where = holder.pid ? `pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}` : 'unknown process'
    return `The Bot team in ${home} is open in another dsh (Web or Desktop, ${where}). This window shows the team but cannot change it; close the other one and reload.`
  }

  // A version-1 team predates member records: it carries no `members` and no per-Bot
  // `ownerId`. Ownership fields on it are not something the migration can trust, so the
  // file is refused (fail closed) instead of being guessed at.
  const legacyOwnershipProblem = (parsed) => {
    if (parsed.members !== undefined) return 'the version-1 state carries member records'
    if (!isRecord(parsed.bots)) return undefined
    for (const [id, bot] of Object.entries(parsed.bots)) {
      if (isRecord(bot) && bot.ownerId !== undefined) return `the version-1 Bot ${id} carries an owner binding`
    }
    return undefined
  }

  // One backup of the version-1 file, taken before the first version-2 write can
  // replace it. A backup already on disk counts only when it is a readable file holding
  // a version-1 state; a directory, an unreadable, empty or truncated file, or anything
  // else there stops the migration rather than risk losing the legacy state. The bytes
  // may differ: another host on the same home rewrites state.json between reads, and a
  // valid backup from an earlier read is still the home's pre-migration copy.
  const backUpLegacy = async () => {
    const backup = `${statePath}.v1`
    try {
      await copyFile(statePath, backup, constants.COPYFILE_EXCL)
    } catch (error) {
      if (error?.code !== 'EEXIST') return `cannot back up the version-1 state (${error?.code ?? error?.message ?? error})`
      let kept
      try {
        kept = await readFile(backup, 'utf8')
      } catch (readError) {
        return `the existing backup ${backup} cannot be read (${readError?.code ?? readError?.message ?? readError})`
      }
      let parsed
      try {
        parsed = JSON.parse(kept)
      } catch {
        return `the existing backup ${backup} is not a usable version-1 backup`
      }
      if (parsed?.version !== 1) return `the existing backup ${backup} is not a usable version-1 backup`
      return undefined
    }
    warn('ds-bot: backed up the version-1 Bot team as %s before the identity update', backup)
    return undefined
  }

  // The identity schema's invariants (#47): member ids are unique and match their
  // records; every Bot binds to a member that exists; a designated Chief is a Bot of the
  // member that designates it. A file that breaks any of this is refused read-only —
  // malformed ownership never repairs itself, and a Bot's name grants nothing.
  const ownershipProblem = (team) => {
    if (!isRecord(team.members)) return 'member records are missing'
    if (Object.hasOwn(team, 'bots') && !isRecord(team.bots)) return 'the Bot roster is missing or malformed'
    const memberIds = new Set()
    for (const [key, member] of Object.entries(team.members)) {
      if (!isRecord(member)) return `member ${key} is not a record`
      if (typeof member.id !== 'string' || member.id === '') return `member ${key} has no id`
      if (memberIds.has(member.id)) return `duplicate member id ${member.id}`
      memberIds.add(member.id)
    }
    for (const [key, member] of Object.entries(team.members)) {
      if (member.id !== key) return `member id ${member.id} does not match its record key ${key}`
    }
    const bots = team.bots ?? {}
    for (const [id, bot] of Object.entries(bots)) {
      if (!isRecord(bot)) return `Bot ${id} is not a record`
      if (typeof bot.ownerId !== 'string' || !memberIds.has(bot.ownerId)) return `Bot ${id} is not owned by a known member`
    }
    for (const [key, member] of Object.entries(team.members)) {
      const chief = member.designatedChiefId
      if (chief === undefined || chief === null) continue
      if (typeof chief !== 'string' || chief === '') return `member ${key} has an invalid designated Chief`
      const bot = bots[chief]
      if (!isRecord(bot)) return `member ${key} designates unknown Bot ${chief} as Chief`
      if (bot.ownerId !== member.id) return `member ${key} designates a Chief owned by ${bot.ownerId}`
    }
    return undefined
  }

  const readFileState = async () => {
    let contents
    try {
      contents = await readFile(statePath, 'utf8')
    } catch (error) {
      seen = stamp()
      if (error?.code === 'ENOENT') {
        stuck = undefined
        return undefined
      }
      stuck = error?.code ?? error?.message ?? String(error)
      warn('ds-bot: unreadable state %s: %s', statePath, error)
      return undefined
    }
    seen = stamp()
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch (error) {
      const backup = `${statePath}.broken-${Date.now()}`
      try {
        await copyFile(statePath, backup)
        stuck = undefined
        warn('ds-bot: unreadable state %s: %s; backed up as %s', statePath, error, backup)
      } catch (copyError) {
        stuck = copyError?.code ?? copyError?.message ?? error?.message ?? String(error)
        warn('ds-bot: unreadable state %s: %s; backup failed: %s', statePath, error, copyError)
      }
      return undefined
    }
    if (parsed?.version === 1) {
      const problem = legacyOwnershipProblem(parsed)
      if (problem !== undefined) {
        stuck = `malformed ownership: ${problem}`
        warn('ds-bot: state %s was refused: %s', statePath, problem)
        return undefined
      }
      const backupProblem = await backUpLegacy()
      if (backupProblem !== undefined) {
        stuck = backupProblem
        warn('ds-bot: unreadable state %s: %s', statePath, backupProblem)
        return undefined
      }
      stuck = undefined
      return parsed
    }
    if (parsed?.version === STATE_VERSION) {
      const problem = ownershipProblem(parsed)
      if (problem !== undefined) {
        stuck = `malformed ownership: ${problem}`
        warn('ds-bot: state %s was refused: %s', statePath, problem)
        return undefined
      }
      stuck = undefined
      return parsed
    }
    stuck = 'saved by a newer FlyBot; update FlyBot'
    return undefined
  }

  // Fill `state` from the saved file and bring an older team up to date. Returns the
  // groups whose Session titles still need the new name.
  const adopt = (parsed) => {
    const hadCapabilities = parsed !== null && parsed !== undefined && Object.hasOwn(parsed, 'capabilities')
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, JSON.parse(EMPTY), parsed ?? {})
    state.prefs ??= {}
    // Teams saved before the DSH Agent existed carry no `agents`; corrupt values reset.
    if (state.agents === null || typeof state.agents !== 'object' || Array.isArray(state.agents)) state.agents = {}
    let migrated = !hadCapabilities
    if (!isRecord(state.projects)) {
      state.projects = {}
      migrated = true
    }
    if (!isRecord(state.projectRuns)) {
      state.projectRuns = {}
      migrated = true
    }
    // A Project Assistant's memory (#1712) is keyed by Project id and read by that id alone, so one
    // Project's entries never appear in another's answer.
    if (!isRecord(state.projectMemory)) {
      state.projectMemory = {}
      migrated = true
    }
    if (state.capabilities === null || typeof state.capabilities !== 'object' || Array.isArray(state.capabilities)) {
      state.capabilities = { items: {} }
      migrated = true
    } else if (state.capabilities.items === null || typeof state.capabilities.items !== 'object' || Array.isArray(state.capabilities.items)) {
      state.capabilities.items = {}
      migrated = true
    }
    for (const bot of Object.values(state.bots)) {
      // FlyBot fields (hooks.js): a corrupt value resets; absent stays absent.
      if ('fields' in bot && (bot.fields === null || typeof bot.fields !== 'object' || Array.isArray(bot.fields))) {
        delete bot.fields
        migrated = true
      }
      if (!Array.isArray(bot.capabilities)) {
        bot.capabilities = []
        migrated = true
      }
      if (bot.color !== currentColor(bot.color)) {
        bot.color = currentColor(bot.color)
        migrated = true
      }
      // A friend's Bot whose model was changed by mistake goes back to its relay route.
      if (bot.remote?.handle && bot.model !== `flybot-remote/${bot.remote.handle}`) {
        bot.model = `flybot-remote/${bot.remote.handle}`
        migrated = true
      }
      // LEGACY: Bots saved with a lab ran on that lab's default model; the model they
      // last ran on becomes their own, so dropping the lab changes nothing for them.
      if ('lab' in bot) {
        if (!bot.model && bot.appliedModel) bot.model = bot.appliedModel
        delete bot.lab
        migrated = true
      }
    }
    // A team from before several Main Bots were allowed names a single one.
    if (!Array.isArray(state.mainBotIds)) state.mainBotIds = []
    if ('mainBotId' in state) {
      if (state.mainBotId && !state.mainBotIds.includes(state.mainBotId)) state.mainBotIds.unshift(state.mainBotId)
      delete state.mainBotId
      migrated = true
    }
    state.mainBotIds = state.mainBotIds.filter(id => state.bots[id])
    // Teams from before the whale was stored at setup: their first Bot, while still a
    // Main Bot, gets it once wherever it has no look of its own. After that the whale is
    // an ordinary look the user can change, and it never passes to another Bot.
    if (state.whaleStored !== true) {
      const first = Object.values(state.bots).reduce((best, bot) => (best === undefined || (bot.createdAt ?? 0) < (best.createdAt ?? 0) ? bot : best), undefined)
      if (first !== undefined && state.mainBotIds.includes(first.id)) {
        if (!first.avatar?.shape && !first.avatar?.image) first.avatar = { ...first.avatar, shape: 'whale' }
        if (!first.color) first.color = 'deepseek'
      }
      state.whaleStored = true
      if (first !== undefined) migrated = true
    }
    if (Object.hasOwn(LEGACY_THEMES, state.prefs.theme ?? '')) {
      state.prefs.theme = LEGACY_THEMES[state.prefs.theme]
      migrated = true
    }
    // Groups from before group settings existed reply in turn, led by a Main Bot member.
    for (const room of Object.values(state.rooms)) {
      if (room.admin !== undefined && ROOM_MODES.includes(room.mode)) continue
      if (room.admin === undefined) room.admin = room.members.find(id => state.mainBotIds.includes(id)) ?? null
      if (!ROOM_MODES.includes(room.mode)) room.mode = 'everyone'
      room.notice ??= ''
      migrated = true
    }
    // Unnamed groups from before names followed their members may still list old names.
    const stale = Object.values(state.rooms).filter(room => !room.named && room.name !== rt.autoRoomName(room.members, room))
    for (const room of stale) room.name = rt.autoRoomName(room.members)
    // Identity schema (#47). A version-1 team had no member records — ownership was
    // implicit in the single human — so it gets one initial owner and every Bot binds
    // to it. readFileState already refused a legacy file that carries ownership fields
    // and a version-2 file whose ownership does not check out, so what is here is
    // either legacy or coherent. Bot ids, Session parts and histories are untouched.
    const legacy = state.version !== STATE_VERSION
    if (legacy) {
      state.version = STATE_VERSION
      // Ownership fields a version-1 file should not carry were refused on read.
      state.members = {}
      migrated = true
    }
    if (!isRecord(state.members)) {
      state.members = {}
      migrated = true
    }
    // Member auth (#48): invitations and session records; a missing map resets.
    if (!isRecord(state.invitations)) {
      state.invitations = {}
      migrated = true
    }
    if (!isRecord(state.authSessions)) {
      state.authSessions = {}
      migrated = true
    }
    if (!isRecord(state.tasks)) {
      state.tasks = {}
      migrated = true
    }
    // #1453: who owned the Sessions a deleted Bot left behind; a corrupt value resets.
    if (!isRecord(state.retiredSessions)) {
      state.retiredSessions = {}
      migrated = true
    }
    if (ensureOwner()) migrated = true
    if (legacy) {
      const ownerId = Object.keys(state.members)[0]
      for (const bot of Object.values(state.bots)) {
        if (bot.ownerId !== ownerId) {
          bot.ownerId = ownerId
          migrated = true
        }
      }
    }
    if (syncDesignatedChief()) migrated = true
    indexSessions()
    return { migrated: migrated || stale.length > 0, stale }
  }

  // The setup step (#47): a team with no member record gets the single owner a fresh or
  // legacy install starts with. No shipped path makes a second member — team mode stays
  // disabled until the gates in docs/subsystems/team.md pass.
  // Projects (#1691): the smallest durable identity a group, a Bot or a workflow run can name.
  // A record is flat and created through `createProject`; a binding hangs off the member record
  // (`bot.projectId`, `room.projectId`) or off `state.projectRuns` for a workflow run. An unbound
  // member resolves `null`, so an install with zero Projects behaves exactly as before.
  const PROJECT_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
  const PROJECT_STATUSES = new Set(['active', 'archived'])
  // A Project's working folder is the absolute path the folder picker hands back (#1766), never a
  // relative one: a record that says 'src' would mean a different folder on every machine.
  const PROJECT_WORKDIR = /^(?:\/|[A-Za-z]:[\\/]|~[\\/]|\\\\)[^\u0000-\u001f]*$/
  const projectText = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '')
  const projectRefusal = (message, code = 'bot/invalid') => {
    const error = new Error(message)
    error.code = code
    return error
  }
  const projectOfId = (id) => {
    if (typeof id !== 'string') return null
    const project = ownEntry(state.projects, id)
    return isRecord(project) ? project : null
  }
  const requireProject = (id) => {
    const project = projectOfId(id)
    if (project === null) throw projectRefusal(`Unknown Project ${String(id ?? '')}`, 'bot/not-found')
    return project
  }
  // The Project Chief seam (#1859), read at call time so a host that ships no Chief module — an
  // older core, or a narrowed test host — is told once instead of on every Project. It answers
  // `undefined` and never throws: automation being off must not refuse a Project.
  let chiefSeamMissing = false
  const projectChief = () => {
    if (rt.projectChief !== undefined) return rt.projectChief
    if (!chiefSeamMissing) {
      chiefSeamMissing = true
      rt.warn?.('ds-bot: this host has no Project Chief seam, so no Project gets its own Chief (#1859)')
    }
    return undefined
  }
  const projectMemberOf = (kind, id) => {
    if (kind === 'bot' || kind === 'group') {
      const member = ownEntry(kind === 'bot' ? state.bots : state.rooms, id)
      return isRecord(member) ? member : null
    }
    if (kind === 'run') return null
    throw projectRefusal(`Unknown Project member kind ${String(kind ?? '')}`)
  }
  const projectOfMember = (kind, id) => {
    if (kind === 'run') return projectOfId(ownEntry(state.projectRuns, String(id ?? '')))
    const member = projectMemberOf(kind, id)
    return member === null ? null : projectOfId(member.projectId)
  }
  const createProject = (body = {}) => {
    const name = projectText(body.name, 120)
    if (name === '') throw projectRefusal('A Project needs a name')
    const repository = projectText(body.repository, 200)
    if (repository !== '' && !PROJECT_REPOSITORY.test(repository)) throw projectRefusal('A Project repository is owner/name')
    const workDir = projectText(body.workDir, 400)
    if (workDir !== '' && !PROJECT_WORKDIR.test(workDir)) throw projectRefusal('A Project working folder is an absolute path')
    const status = projectText(body.status, 40) || 'active'
    if (!PROJECT_STATUSES.has(status)) throw projectRefusal(`Unknown Project status ${status}`)
    const now = Date.now()
    const id = `project-${randomUUID()}`
    const record = {
      id,
      name,
      repository: repository === '' ? null : repository,
      defaultBranch: projectText(body.defaultBranch, 120) || 'main',
      workDir: workDir === '' ? null : workDir,
      ownerUserId: projectText(body.ownerUserId, 120) || null,
      // Further owners of the same Project (#1733): each has their own memory and their own digest,
      // built from the same board read. An empty list is a single-owner Project.
      ownerUserIds: Array.isArray(body.ownerUserIds) ? [...new Set(body.ownerUserIds.map(id => projectText(id, 120)).filter(id => id !== ''))] : [],
      createdAt: now,
      updatedAt: now,
      status,
    }
    state.projects[id] = record
    return record
  }
  const readProject = id => projectOfId(id)
  const listProjects = () => Object.values(state.projects).filter(isRecord)
  // A Project Assistant's memory (#1712, per owner since #1733): decisions, open questions and
  // the last digest, stored per (Project, owner). The row keyed by the Project id keeps one record
  // per owner under `owners`; its own three fields mirror the Project's primary owner, so a
  // single-owner Project reads exactly as it did before the owner dimension existed.
  const projectMemoryOf = (id) => {
    const kept = ownEntry(state.projectMemory, String(id ?? ''))
    return isRecord(kept) ? kept : null
  }
  const primaryOwner = project => projectText(project?.ownerUserId, 120)
  const ownerRow = (table, ownerId, project) => {
    if (!isRecord(table.owners)) {
      // A record written before the owner dimension existed keeps its three fields on the row
      // itself (#1712). The first write after the upgrade moves them onto the primary owner
      // instead of replacing them with a fresh empty row.
      table.owners = {}
      const primary = primaryOwner(project)
      const legacy = ownerView(table)
      if (primary !== '' && (legacy.decisions.length > 0 || legacy.questions.length > 0 || legacy.digest !== null)) setEntry(table.owners, primary, legacy)
    }
    const kept = ownEntry(table.owners, String(ownerId ?? ''))
    if (isRecord(kept)) return kept
    const fresh = { decisions: [], questions: [], digest: null }
    setEntry(table.owners, String(ownerId ?? ''), fresh)
    return fresh
  }
  const ownerView = record => ({
    decisions: Array.isArray(record?.decisions) ? record.decisions : [],
    questions: Array.isArray(record?.questions) ? record.questions : [],
    digest: isRecord(record?.digest) ? record.digest : null,
  })
  // Mirrors an owner's record onto the Project row when that owner is the primary one, which is
  // the whole row on a single-owner Project.
  const mirrorOwner = (table, project, ownerId, record) => {
    if (String(ownerId ?? '') !== primaryOwner(project)) return
    table.decisions = record.decisions
    table.questions = record.questions
    table.digest = record.digest
  }
  const projectMemory = (id) => {
    const project = projectOfId(id)
    if (project === null) throw projectRefusal(`Unknown Project ${String(id ?? '')}`, 'bot/not-found')
    return ownerView(projectMemoryOf(project.id))
  }
  // One owner's view. A Project with no entries for that owner answers empty lists, never another
  // owner's or another Project's.
  const projectMemoryFor = (id, ownerId) => {
    const project = projectOfId(id)
    if (project === null) throw projectRefusal(`Unknown Project ${String(id ?? '')}`, 'bot/not-found')
    const kept = projectMemoryOf(project.id)
    if (kept === null) return ownerView(null)
    const row = isRecord(kept.owners) ? ownEntry(kept.owners, String(ownerId ?? '')) : null
    if (isRecord(row)) return ownerView(row)
    // A pre-#1733 record has no `owners`, and its three fields belong to the primary owner.
    if (!isRecord(kept.owners) && String(ownerId ?? '') === primaryOwner(project)) return ownerView(kept)
    return ownerView(null)
  }
  const memoryTable = (project) => {
    const kept = projectMemoryOf(project.id)
    if (kept !== null) return kept
    const fresh = { decisions: [], questions: [], digest: null, owners: {} }
    setEntry(state.projectMemory, project.id, fresh)
    return fresh
  }
  const appendProjectMemory = (id, kind, entry = {}) => {
    const project = requireProject(id)
    if (kind !== 'decision' && kind !== 'question') throw projectRefusal(`Unknown Project memory kind ${String(kind ?? '')}`)
    // #1847: this is the one door into a Project's memory, so the bound the assistant writer states
    // is enforced here too. Before this, an endpoint caller could store an empty entry or have a
    // long one cut to `MAX_ENTRY` without being told; a refusal leaves the table and `updatedAt` as
    // they were.
    const entryText = projectText(entry.text)
    if (entryText === '') throw projectRefusal('A Project memory entry needs text')
    if (entryText.length > MAX_ENTRY) throw projectRefusal(`A Project memory entry is at most ${MAX_ENTRY} characters`)
    const table = memoryTable(project)
    const ownerId = projectText(entry.ownerId, 120) || primaryOwner(project)
    const record = ownerRow(table, ownerId, project)
    const list = kind === 'decision' ? record.decisions : record.questions
    list.push({ text: entryText, at: Number(entry.at) || Date.now(), ...(projectText(entry.by, 120) === '' ? {} : { by: projectText(entry.by, 120) }) })
    mirrorOwner(table, project, ownerId, record)
    project.updatedAt = Math.max(project.updatedAt, Date.now())
    return ownerView(record)
  }
  // The last digest is one note per (Project, owner), replaced only by a later day's build; the
  // assistant refuses a second build in the same day before it gets here.
  const setProjectDigest = (id, note = {}, ownerId) => {
    const project = requireProject(id)
    const table = memoryTable(project)
    const owner = projectText(ownerId, 120) || primaryOwner(project)
    const record = ownerRow(table, owner, project)
    record.digest = { day: projectText(note.day, 20), at: Number(note.at) || Date.now(), text: projectText(note.text, 4000), ...(projectText(note.error, 300) === '' ? {} : { error: projectText(note.error, 300) }) }
    mirrorOwner(table, project, owner, record)
    project.updatedAt = Math.max(project.updatedAt, Date.now())
    return ownerView(record)
  }
  // Deleting a Project takes its bindings and its memory with it (#1712): an unbound member
  // resolves `null` again, and no orphan memory keyed by a dead id can be read.
  const deleteProject = async (id) => {
    const project = requireProject(id)
    await rt.projectAssistant?.remove?.(project.id)
    // The Project's own Chief retires with it (#1859), by the same path a deleted Bot takes.
    await projectChief()?.remove?.(project.id)
    delete state.projects[project.id]
    delete state.projectMemory[project.id]
    for (const member of [...Object.values(state.bots), ...Object.values(state.rooms)]) {
      if (member.projectId === project.id) delete member.projectId
    }
    for (const [runId, bound] of Object.entries(state.projectRuns)) if (bound === project.id) delete state.projectRuns[runId]
    return project
  }
  // One Project to many members, a member to at most one Project; `projectId: null` unbinds.
  const bindProject = (body = {}) => {
    const kind = projectText(body.kind, 20)
    const id = projectText(body.id, 200)
    if (id === '') throw projectRefusal('A binding needs the member id')
    const project = body.projectId === undefined || body.projectId === null ? null : requireProject(projectText(body.projectId, 200))
    if (kind === 'run') {
      if (project === null) delete state.projectRuns[id]
      else setEntry(state.projectRuns, id, project.id)
      return project
    }
    const member = projectMemberOf(kind, id)
    if (member === null) throw projectRefusal(`Unknown ${kind} ${id}`, 'bot/not-found')
    if (project === null) delete member.projectId
    else member.projectId = project.id
    if (project !== null) project.updatedAt = Math.max(project.updatedAt, Date.now())
    return project
  }
  // Who may act on a Project (#1710). The record names its owner member; an install with no
  // session falls back to the first member, exactly like `requesterOf` in tasks.js. The host
  // decides this, never the page: a caller that is not the owner may read the board and nothing
  // else; the Project record, its memory and its assistant settings are the owner's (#1740).
  const projectActorId = actor => projectText(actor?.memberId, 120) || Object.keys(state.members ?? {})[0] || null
  const projectCanManage = (project, actor) => {
    if (project === null || typeof project !== 'object') return false
    const owner = projectText(project.ownerUserId, 120)
    if (owner === '') return true
    const actorId = projectActorId(actor)
    return actorId !== null && actorId === owner
  }
  const requireProjectOwner = (project, actor) => {
    if (project === null) return
    if (projectCanManage(project, actor)) return
    throw projectRefusal('Only the owner of this Project may change it', 'bot/forbidden')
  }

// #1828: only the two assignable ranks are stored; the Owner stays derived from `ownerUserIds`.
  const setProjectRoles = (project, roles) => {
    const list = value => (Array.isArray(value) ? [...new Set(value.map(id => projectText(id, 120)).filter(id => id !== ''))] : [])
    project.roles = { maintainers: list(roles?.maintainers), members: list(roles?.members) }
    project.updatedAt = Math.max(project.updatedAt, Date.now())
    return project.roles
  }
  const projectEndpoint = async (endpoint, body = {}, actor = null) => {
    switch (endpoint) {
      // #1828: the sidebar reads one list, and each entry carries the caller's own role and the
      // roles they may switch to — both from the same policy the endpoint applies, so the menu and
      // the refusal cannot disagree. A host without the helpers (an older plugin instance) answers
      // neither field and the client draws the list without a role.
      case 'projects': {
        const actorId = projectActorId(actor)
        return {
          projects: listProjects().map(project => ({
            ...project,
            role: rt.projectRoleOf === undefined ? null : rt.projectRoleOf(project, actorId),
            choices: rt.projectRoleChoices === undefined ? [] : rt.projectRoleChoices(project, actorId),
          })),
        }
      }
      // #1828: the role switch. The policy lives in project-board.js (`changeRole`), so the endpoint
      // and the menu cannot disagree; a refusal answers the reason and writes nothing.
      case 'project-role': {
        const project = readProject(projectText(body.id, 200))
        if (project === null) throw projectRefusal('Unknown Project', 'bot/not-found')
        const result = rt.projectRole === undefined
          ? { ok: false, reason: 'not-owner' }
          : rt.projectRole(project, { actor, actorId: projectActorId(actor), targetId: body.memberId, role: body.role })
        if (result.ok !== true) return { project, changed: false, reason: result.reason }
        const roles = setProjectRoles(project, result.roles)
        await save()
        return { project, changed: true, roles }
      }
      case 'project-create': {
        // The caller is stamped as the owner; a member id from the body cannot mint a
        // Project someone else manages.
        const project = createProject({ ...body, ownerUserId: projectActorId(actor) ?? undefined })
        // One assistant per Project (#1712). A Project must not fail because automation is off, so
        // a refusal here is recorded on the record and the Project is still created.
        if (rt.projectAssistant !== undefined) {
          try {
            await rt.projectAssistant.create(project.id)
          } catch (error) {
            project.assistant = { error: error?.message ?? String(error) }
          }
        }
        // Every Project gets its own Chief (#1859) — not the user's main Chief acting part-time.
        // Same contract as the assistant: a spawn failure is recorded on the record, and a host
        // without the seam still creates the Project with the reason written down.
        const chief = projectChief()
        if (chief === undefined) project.chief = { error: 'this host has no Project Chief seam, so no Chief was created' }
        else {
          try {
            await chief.create(project.id)
          } catch (error) {
            project.chief = { error: error?.message ?? String(error) }
          }
        }
        await save()
        return { project }
      }
      // Deleting a Project and reading or writing its assistant memory are the owner's (#1740).
      // #1722 shipped them without the check `project-bind` already made, so any signed-in member
      // could take another member's Project and its private memory with it. The record is read
      // first, so a missing id still answers not-found from the call that needs it: the gate
      // returns early on `null`, it never turns an unknown id into a refusal.
      case 'project-delete': {
        const id = projectText(body.id, 200)
        requireProjectOwner(readProject(id), actor)
        const project = await deleteProject(id)
        await save()
        return { project }
      }
      // The assistant's private memory (#1712): read and write are per Project id, so a caller
      // holding one id can never reach another Project's entries.
      case 'project-memory': {
        const id = projectText(body.id, 200)
        const project = readProject(id)
        requireProjectOwner(project, actor)
        return { project, memory: projectMemory(id) }
      }
      case 'project-memory-write': {
        const id = projectText(body.id, 200)
        requireProjectOwner(readProject(id), actor)
        const memory = appendProjectMemory(id, projectText(body.kind, 20), body)
        await save()
        return { memory }
      }
      case 'project-read': {
        const project = readProject(projectText(body.id, 200))
        // #1845: the panel's own switches live per owner on the assistant record, never on the
        // Project, so the read carries the caller's own record beside it.
        // An absent Project has no assistant record to report, so the answer keeps the shape a
        // missing id always had (`{ project: null, canManage: false }`).
        if (project === null) return { project, canManage: false }
        const actorId = projectActorId(actor)
        const assistantMine = actorId === null
          ? { off: false, quiet: null }
          : (rt.projectAssistant?.mine?.(project.id, actorId) ?? { off: false, quiet: null })
        return { project, canManage: projectCanManage(project, actor), assistantMine }
      }
      case 'project-bind': {
        const target = body.projectId === undefined || body.projectId === null
          ? projectOfMember(projectText(body.kind, 20), projectText(body.id, 200))
          : requireProject(projectText(body.projectId, 200))
        requireProjectOwner(target, actor)
        const project = bindProject(body)
        await save()
        return { project }
      }
      // The assistant's per-owner controls (#1733): a quiet window and the digest opt-out live on
      // the Project's own assistant record, not in the host-wide prefs. The body names the owner,
      // so it carries the second half of the gate (#1740): a Project's owner may change their own
      // record and no other, and an omitted ownerId means the caller's own.
      case 'project-assistant-owner': {
        const project = requireProject(projectText(body.id, 200))
        requireProjectOwner(project, actor)
        const actorId = projectActorId(actor)
        const ownerId = projectText(body.ownerId, 120) || actorId
        if (ownerId !== actorId) throw projectRefusal('Only your own assistant settings may be changed here', 'bot/forbidden')
        const result = await rt.projectAssistant?.setOwner?.(project.id, ownerId, body.settings ?? {})
        await save()
        return { project: readProject(project.id), ...(result ?? {}) }
      }
      case 'project-of': return { project: projectOfMember(projectText(body.kind, 20), projectText(body.id, 200)) }
      // The read-only board (#1696): Project id in, its tasks out. The aggregate lives in
      // project-board.js; it reads and returns, and writes nothing. The actor goes with the id
      // so the board applies the same visibility rule `tasks` does (#1723).
      case 'project-board': {
        const board = (await rt.projectBoard?.(projectText(body.id, 200), actor,
          { timeZone: typeof body.timeZone === 'string' ? body.timeZone.slice(0, 64) : undefined })) ?? []
        const rows = Array.isArray(board) ? board : (board.rows ?? [])
        const sections = Array.isArray(board) ? {} : board
        return {
          tasks: rows,
          // #1855: the finished cards ride beside the rows, in the same row shape, so the page keeps
          // them in one collapsed group instead of painting a wall of 已完成.
          done: sections.done ?? [],
          decisions: sections.decisions ?? { dir: null, files: [], reason: 'the board reads no decisions' },
          meetings: sections.meetings ?? { decided: [], pending: [], reason: 'the board reads no meetings' },
          // The queue/lease/blocked groups (#1768) ride along with the sections: one read of the
          // same Project, so the header counts and the cards cannot disagree.
          waiting: sections.waiting ?? [],
          inflight: sections.inflight ?? [],
          blocked: sections.blocked ?? [],
          counts: sections.counts ?? { waiting: null, inflight: null, blocked: null, done: null },
          // #1829: the seven numbers and the running rows ride on this read, so the header and the
          // cards come from one pass over the same Project.
          metrics: sections.metrics ?? null,
        }
      }
      default: throw projectRefusal(`Unknown endpoint ${endpoint}`, 'bot/not-found')
    }
  }

  const ensureOwner = () => {
    if (Object.keys(state.members).length > 0) return false
    state.members[OWNER_ID] = { id: OWNER_ID, createdAt: Date.now(), designatedChiefId: null }
    return true
  }

  // The one human owner a new Bot binds to. The shipped product has a single owner; a
  // file with any other count of member records is not something this runtime may
  // choose between, so it fails closed.
  const initialOwnerId = () => {
    ensureOwner()
    const ids = Object.keys(state.members)
    if (ids.length !== 1) throw new Error(`The Bot team file lists ${ids.length} members; FlyBot runs one owner per team`)
    return ids[0]
  }

  // The designated Chief of the single owner is its first Main Bot — the shipped Main
  // role (#46), recorded on the member record, never a name. A team with any other
  // number of member records is left as it is rather than guessed at.
  const syncDesignatedChief = () => {
    const ids = Object.keys(state.members)
    if (ids.length !== 1) return false
    const chief = state.mainBotIds[0] ?? null
    const member = state.members[ids[0]]
    if (member.designatedChiefId === chief) return false
    member.designatedChiefId = chief
    return true
  }

  const load = () => loaded ??= (async () => {
    claimLock()
    if (holder !== undefined) warn('ds-bot: %s', readOnly())
    const { migrated, stale } = adopt(await readFileState())
    if (holder !== undefined) return
    if (migrated && stuck === undefined) {
      // A failed write must not poison `loaded`: the migrated state stays in
      // memory and the next save() writes it.
      try {
        await save()
      } catch (error) {
        warn('ds-bot: saving the migrated Bot team failed: %s', error)
      }
    }
    // Not awaited: renaming a session must not hold up the first roster read.
    for (const room of stale) void rt.retitleRoom(room)
  })()

  // The one takeover line, printed from either entry point: refresh() when a reading host
  // follows the file, save() when a stale read-only window writes (#1041). It names the host
  // that let go, so "this window wrote over someone else's state.json" can be traced from the
  // log afterwards.
  const announceTakeover = (previous) => {
    const where = previous.pid ? `pid ${previous.pid}${previous.host ? ` on ${previous.host}` : ''}` : 'unknown process'
    warn('ds-bot: the other dsh has closed; this one now saves the Bot team (was %s)', where)
  }

  // A reading host follows the file and takes over once the other host has gone.
  const refresh = async () => {
    await load()
    const hadHolder = holder !== undefined
    if (hadHolder) {
      const previous = holder
      claimLock()
      if (holder === undefined) {
        announceTakeover(previous)
        warnedReadOnly = false
        adopt(await readFileState())
        return
      }
    } else if (!lockBroken && !lock.owns()) {
      // A cached "writer" is stale once the lock file no longer names this host:
      // another dsh may have taken it over, or the file may just be gone. Re-claim
      // and re-check instead of trusting the flag.
      claimLock()
      if (lockBroken) return
      if (holder === undefined) {
        // The lock was free: still the writer, but the file may carry changes
        // written while no host held it.
        warnedReadOnly = false
        adopt(await readFileState())
        return
      }
      warn('ds-bot: %s', readOnly())
    }
    if ((stuck !== undefined || holder !== undefined) && stamp() !== seen) adopt(await readFileState())
  }

  const warnReadOnly = () => {
    if (!warnedReadOnly) {
      warnedReadOnly = true
      warn('ds-bot: not saving the Bot team: %s', readOnly())
    }
    return false
  }
  const writable = () => {
    if (stuck !== undefined) return warnReadOnly()
    if (lockBroken) return true
    if (holder === undefined && lock.owns()) return true
    // Lost the lock: retake it when nobody else holds it (its file was deleted), else
    // another host took it over and this one stops writing.
    if (holder === undefined) {
      claimLock()
      if (holder === undefined) return true
    }
    return warnReadOnly()
  }

  // A window that was read-only because the other dsh held state.lock takes the lock on
  // its next write once that file is gone, instead of waiting for a later state call
  // (#1027). Taking over adopts nothing by itself: whoever called save() may already have
  // changed `state`, and adopt() replaces it whole (#1032).
  const takeover = () => {
    const previous = holder
    claimLock()
    if (holder !== undefined) return false
    // The same line refresh() prints (#1041). A stale window that writes over the file the
    // other host left has no other trace, so the takeover is announced here too.
    if (previous !== undefined) announceTakeover(previous)
    warnedReadOnly = false
    return true
  }

  const save = () => {
    if (stopped) return writing
    indexSessions()
    // A reading host keeps the file's revision, so its window does not skip the next change.
    if (holder !== undefined && !lockBroken && stuck === undefined) {
      // The other dsh may have closed since this window last looked: take the free lock
      // instead of dropping the write (#1027). Nothing is adopted here — a caller may have
      // already changed `state`, and adopt() replaces it whole (#1032). The write-path
      // entry that adopts *before* a change is `mutate()`, just below.
      if (!takeover()) {
        warnReadOnly()
        return writing
      }
    }
    if (!writable()) return writing
    queued += 1
    state.revision += 1
    state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
    const snapshot = JSON.stringify(state, null, 2)
    const run = writing.then(async () => {
      const temp = `${statePath}.${process.pid}.tmp`
      try {
        await mkdir(home, { recursive: true })
        const ensureLock = () => {
          if (lockBroken) return
          if (!lock.owns()) {
            const error = new Error('ds-bot lost the state lock to another dsh')
            error.code = 'ELOCKLOST'
            throw error
          }
        }
        ensureLock()
        await writeFile(temp, snapshot, 'utf8')
        ensureLock()
        await rename(temp, statePath)
        seen = stamp()
        await journal?.record(snapshot)
        rt.capabilitiesStateSaved?.()
      } catch (error) {
        await unlink(temp).catch(() => { /* the temp file may already be gone */ })
        throw error
      }
    })
    writing = run.catch(() => {})
    return run.catch(error => {
      warn('ds-bot: state write failed: %s', error)
      throw error
    })
  }

  // What the write chain holds, for a caller that must read state.json: `savesQueued` is a
  // monotonic watermark — every save this host has accepted since it started, never decremented —
  // and `savesSettled` resolves once the chain is empty. A test (or a caller finishing a rollback)
  // otherwise has to guess a delay, and a delay long enough on an idle machine reads a half-written team on a busy one (#1368).
  const savesQueued = () => queued
  const savesSettled = async () => {
    for (;;) {
      const tail = writing
      await tail
      if (tail === writing) return
    }
  }

  // The write-path entry for a change made outside a request (a plugin, a scheduled task,
  // a delivery): take over the lock and adopt what the other host left *before* the change
  // is made, then write it. Adopting first is what keeps both sides: a change already in
  // `state` cannot be adopted around without losing it (#1032).
  const mutate = async (change) => {
    await refresh()
    const result = await change()
    await save()
    return result
  }

  ctx.effect(() => () => {
    stopped = true
    return writing.finally(() => lock.release())
  }, 'ds-bot: state lock')

  const botOf = id => (id === undefined ? undefined : ownEntry(state.bots, id))
  const roomOf = id => (id === undefined ? undefined : ownEntry(state.rooms, id))
  const isMain = id => id !== undefined && state.mainBotIds.includes(id)

  // Group Sessions. A member speaks in each group from a hidden Session of its own,
  // `room.sessions[botId]`, that renders the same system prompt and tools as its own
  // chat: the provider's prefix cache is shared, and a group turn never re-reads the
  // member's private context. Created on the member's first turn in the group.
  //
  // Segments. A long conversation moves to a fresh Session at a context line (see
  // parts.js). A Bot's id is the Session id of its first own-chat segment and
  // never changes; `bot.sessionId` is the current one. Earlier segments, of the own
  // chat (`bot.segments`) and of each group Session (`room.segments[botId]`), are
  // archived and stay readable.
  /** @type {Map<string, string>} */
  const chatOwners = new Map()
  /** @type {Map<string, {botId:string, roomId:string}>} */
  const groupOwners = new Map()
  /** @type {Map<string, {botId:string, roomId?:string}>} */
  const pastOwners = new Map()
  const chatOf = botId => botOf(botId)?.sessionId ?? botId
  const indexSessions = () => {
    chatOwners.clear()
    groupOwners.clear()
    pastOwners.clear()
    for (const bot of Object.values(state.bots)) {
      for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id })
      chatOwners.set(chatOf(bot.id), bot.id)
    }
    for (const room of Object.values(state.rooms)) {
      for (const [botId, segments] of Object.entries(room.segments ?? {})) {
        for (const segment of segments) pastOwners.set(segment.sessionId, { botId, roomId: room.id })
      }
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) groupOwners.set(sessionId, { botId, roomId: room.id })
    }
    // #1453: a deleted Bot's Sessions keep the Bot that owned them, so a call still in flight is
    // refused instead of being read as a plain Session. The record only fills what the live
    // indexes do not claim: a live Bot or room holding the same id wins.
    for (const [sessionId, botId] of Object.entries(state.retiredSessions ?? {})) {
      if (typeof botId !== 'string' || chatOwners.has(sessionId) || groupOwners.has(sessionId) || pastOwners.has(sessionId)) continue
      pastOwners.set(sessionId, { botId })
    }
    // The agents module owns the DSH Agent session index; it installs after this.
    rt.indexAgents?.()
  }
  // The Bot a Session speaks for: its own chat, one of its group Sessions, or an
  // earlier segment of either.
  const selfOf = id => chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId
  // A Session where the Bot speaks now, as opposed to an archived segment.
  const isBotSession = id => chatOwners.has(id) || groupOwners.has(id)
  const groupSessionsOf = botId => Object.values(state.rooms).map(room => room.sessions?.[botId]).filter(Boolean)
  const dropGroupSession = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    if (room.segments !== undefined) delete room.segments[botId]
    groupOwners.delete(sessionId)
    // An external participant's process goes with the seat (#198); a DSH Session is archived below.
    rt.closeExternalParticipant?.(room.id, botId)
    rt.cancelApprovals?.(sessionId)
    // A plain archive refuses a running Session, which would go on working for a group
    // that no longer has it.
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
  }
  const findBot = (ref) => {
    if (ref === undefined) return undefined
    const direct = ownEntry(state.bots, ref)
    if (direct) return direct.remote === undefined ? direct : undefined
    const wanted = normalize(ref).replace(/^@/, '')
    // A friend's Bot (remote chat) is no team member, so a name never finds it.
    return Object.values(state.bots).find(bot => bot.remote === undefined && normalize(bot.name) === wanted)
  }
  // Every group chat whose id or name matches; callers refuse an ambiguous name.
  const findRooms = (ref) => {
    if (ref === undefined || ref === null) return []
    const direct = ownEntry(state.rooms, ref)
    if (direct) return [direct]
    const wanted = normalize(unquote(ref))
    return Object.values(state.rooms).filter(room => normalize(room.name) === wanted)
  }
  const isAdminOf = (room, id) => id !== undefined && room.admin === id

  Object.assign(rt, {
    state, load, save, refresh, readOnly, mutate, savesQueued, savesSettled,
    botOf, roomOf, isMain, chatOf, selfOf, isBotSession,
    chatOwners, groupOwners, pastOwners,
    groupSessionsOf, dropGroupSession, findBot, findRooms, isAdminOf,
    initialOwnerId, syncDesignatedChief,
    projectEndpoint, createProject, readProject, listProjects, bindProject, projectOfMember, setProjectRoles,
    projectMemory, projectMemoryOf, projectMemoryFor, appendProjectMemory, setProjectDigest, deleteProject,
  })
}
