// Project application service. Storage and host policy remain local to the FlyBot instance.
import { randomUUID } from 'node:crypto'
import { MAX_ENTRY } from './constants.js'
import { codePoints } from './text.js'
import { ownEntry, setEntry } from './store.js'
import { createProjectDomain } from './project-domain.js'
import { install as installProjectLifecycle, repositorySpec } from './project-lifecycle.js'
import { install as installPersonalAgents } from './personal-agents.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function install(rt) {
  const { state } = rt
  const save = () => rt.save()
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
    if (body.repositories !== undefined && !Array.isArray(body.repositories)) throw projectRefusal('Project repositories must be an array')
    const repositories = body.repositories?.map(repositorySpec)
    if (repositories && new Set(repositories.map(row => row.repository)).size !== repositories.length) throw projectRefusal('Duplicate Project repository association')
    if (repositories && body.repository && !repositories.some(row => row.repository === body.repository)) throw projectRefusal('Default repository must be associated with the Project')
    const name = projectText(body.name, 120)
    if (name === '') throw projectRefusal('A Project needs a name')
    const repository = projectText(body.repository ?? repositories?.[0]?.repository, 200)
    if (repository !== '' && !PROJECT_REPOSITORY.test(repository)) throw projectRefusal('A Project repository is owner/name')
    const defaultBranch = body.defaultBranch ?? repositories?.find(row => row.repository === repository)?.defaultBranch ?? 'main'
    if (repository) repositorySpec({ repository, defaultBranch })
    if (repositories?.some(row => row.repository === repository && row.defaultBranch !== defaultBranch)) throw projectRefusal('Default repository branch conflicts with its association')
    const workDir = projectText(body.workDir, 400)
    if (workDir !== '' && !PROJECT_WORKDIR.test(workDir)) throw projectRefusal('A Project working folder is an absolute path')
    const status = projectText(body.status, 40) || 'active'
    if (!PROJECT_STATUSES.has(status)) throw projectRefusal(`Unknown Project status ${status}`)
    const now = Date.now()
    const id = `project-${randomUUID()}`
    const record = {
      id,
      name,
      description: projectText(body.description, 2000),
      goal: projectText(body.goal, 4000),
      scope: projectText(body.scope, 4000),
      repository: repository === '' ? null : repository,
      defaultBranch,
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
    rt.projectLifecycle.register(record, repositories)
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
    // #1886: the bound counts code points, not UTF-16 units (`MAX_ENTRY` says why), so the emoji
    // note the assistant writer accepts at 600 characters is accepted here too. #1895: both
    // writers count through the one `codePoints` helper.
    if (codePoints(entryText) > MAX_ENTRY) throw projectRefusal(`A Project memory entry is at most ${MAX_ENTRY} characters`)
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
    if (project.status === 'closed') throw projectRefusal('Closed Project history must be retained', 'bot/conflict')
    rt.projects.assertDeletable(id)
    if (rt.sharedProjectMode?.()) {
      project.status = 'archived'
      project.deleting = true
      await save()
      await rt.projectAgents?.removeProject(project.id)
    }
    await rt.projectAssistant?.remove?.(project.id)
    // The Project's own Chief retires with it (#1859), by the same path a deleted Bot takes.
    await projectChief()?.remove?.(project.id)
    delete project.deleting
    rt.projects.repository.archive(project)
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
      else {
        rt.projects.bindRun(id, project.id, body)
        setEntry(state.projectRuns, id, project.id)
      }
      return project
    }
    const member = projectMemberOf(kind, id)
    if (member === null) throw projectRefusal(`Unknown ${kind} ${id}`, 'bot/not-found')
    if ((member.projectAgent || member.ephemeral) && member.projectId !== (project?.id ?? null)) throw projectRefusal('Scoped agent Project identity is immutable')
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
  const requireProjectOwner = (project, actor, action = 'manage') => {
    if (project === null) return
    if (rt.sharedProjectMode?.() ? rt.projectCan(actor, project.id, action) : projectCanManage(project, actor)) return
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
    const agentAccess = await rt.personalAgentAuth?.endpoint(endpoint, body, actor)
    if (agentAccess !== undefined) return agentAccess
    const personal = await rt.personalAgents.endpoint(endpoint, body, actor)
    if (personal !== undefined) return personal
    const lifecycle = await rt.projectLifecycle.endpoint(endpoint, body, actor)
    if (lifecycle !== undefined) return lifecycle
    const scoped = await rt.projectAccessEndpoint?.(endpoint, body, actor)
    if (scoped !== undefined) return scoped

    switch (endpoint) {
      // #1828: the sidebar reads one list, and each entry carries the caller's own role and the
      // roles they may switch to — both from the same policy the endpoint applies, so the menu and
      // the refusal cannot disagree. A host without the helpers (an older plugin instance) answers
      // neither field and the client draws the list without a role.
      case 'project-detail': {
        requireProjectOwner(rt.projects.repository.get(body.id, { includeDeleted: true }), actor)
        return rt.projects.detail(body.id, actor)
      }
      case 'project-archive': {
        const project = requireProject(body.id)
        requireProjectOwner(project, actor)
        if (project.status === 'closed') throw projectRefusal('Closed Project lifecycle and history must be retained', 'bot/conflict')
        project.status = 'archived'
        project.updatedAt = Date.now()
        await save()
        return { project }
      }
      case 'project-workspace-create': {
        requireProjectOwner(requireProject(body.projectId), actor, 'configure')
        const workspace = rt.projects.createWorkspace(body)
        await save()
        return { workspace }
      }
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
      // #1828: the role switch. The policy lives in shared/project-policy.js (`changeRole`), so the endpoint
      // and the menu cannot disagree; a refusal answers the reason and writes nothing.
      case 'project-role': {
        const project = readProject(projectText(body.id, 200))
        if (project === null) throw projectRefusal('Unknown Project', 'bot/not-found')
        const result = rt.projectRole === undefined
          ? { ok: false, reason: 'not-owner' }
          : rt.projectRole(project, { actor, actorId: projectActorId(actor), targetId: body.memberId, role: body.role })
        if (result.ok !== true) return { project, changed: false, reason: result.reason }
        const roles = setProjectRoles(project, result.roles)
        rt.projectScheduler?.revalidate(project.id)
        await save()
        return { project, changed: true, roles }
      }
      case 'project-create': {
        // The caller is stamped as the owner; a member id from the body cannot mint a
        // Project someone else manages.
        if (rt.sharedProjectMode?.() && body.workDir) throw projectRefusal('Project working folders are provisioned by the operator')
        const project = createProject({ ...body, ...(rt.sharedProjectMode?.() ? { workDir: null } : {}), ...(rt.sharedProjectMode?.() ? { ownerUserIds: [] } : {}), ownerUserId: projectActorId(actor) ?? undefined })
        // One assistant per Project (#1712). A Project must not fail because automation is off, so
        // a refusal here is recorded on the record and the Project is still created.
        if (rt.projectAssistant !== undefined && !rt.sharedProjectMode?.()) {
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
        if (rt.sharedProjectMode?.() && rt.projectAgents) {
          try { await rt.projectAgents.ensureProject(project.id, actor) }
          catch (error) { project.agentsError = error?.message ?? String(error); if (!project.chief?.botId) project.chief = { error: project.agentsError } }
        } else if (chief === undefined) project.chief = { error: 'this host has no Project Chief seam, so no Chief was created' }
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
        const project = bindProject({ kind: body.kind, id: body.id, projectId: body.projectId })
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
      // The read-only team dossier (#1864): the Project's Chief, its assistant and its pool, each
      // with persona, memory head/topics and skills. The read lives in project-team.js; a missing
      // Bot is a `null` row there, never an error for the whole answer.
      case 'project-team': return rt.projectTeam?.(projectText(body.id, 200)) ?? { rows: [] }
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

  Object.assign(rt, {
    projectEndpoint, createProject, readProject, listProjects, bindProject, projectOfMember, setProjectRoles,
    projectMemory, projectMemoryOf, projectMemoryFor, appendProjectMemory, setProjectDigest, deleteProject,
  })
  rt.projects = createProjectDomain(rt)
  installProjectLifecycle(rt)
  installPersonalAgents(rt)
}
