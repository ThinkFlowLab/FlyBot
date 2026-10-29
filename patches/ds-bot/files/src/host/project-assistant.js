// The Project Assistant (#1712): one hidden Bot and Session per Project, memory private to that
// Project, and a 09:00 Asia/Shanghai digest built only from what the Project already knows — the
// Project State reader (2.4) and the board rows (2.3). Nothing here restates Project State, mints
// a second task identity or invents a number: every line the digest prints comes from a row or a
// file it was handed, and a day with nothing to say prints one line saying so.
//
// Identity is the install's own connector account (owner decision 2026-10-29: on a single-person
// install the Project owner is the person signed in, so `GET /user` is that person's own login).
// The shared Project App identity never stands in for a person: with no connector signed in, or on
// a host with more than one member where the Project's `ownerUserId` is not the host's own user,
// the assistant refuses and asks the owner instead. Every write it makes carries the name the
// account is posting for, because one shared GitHub login makes attribution text, not identity.
//
// The digest is not scheduled from inside the plugin: `project-create` puts exactly one 09:00 task
// on the assistant Session through the host's schedule path, and `project-delete` removes it with
// the Project. A missed beat is DSH's, and it posts nothing.
import { defineTool } from './tool-schema.js'
import { listProjectState } from './project-state.js'
import { output } from './tools.js'

export const ASSISTANT_ROLE = 'Project Assistant'
export const DIGEST_ZONE = 'Asia/Shanghai'
export const DIGEST_TIME = '09:00'
export const DIGEST_TITLE = '09:00 Project digest'
export const DIGEST_PROMPT = 'Build today\'s Project digest: call project_digest once. It answers whether today already has one.'
export const MAX_ENTRY = 600
export const MEMORY_KINDS = ['decision', 'question']

export const assistantName = project => `${ASSISTANT_ROLE} (${project.name})`

export const assistantInstructions = project => [
  `You are the Project Assistant of "${project.name}". You speak for that Project and for no other.`,
  'Your memory is private to this Project: record decisions and open questions with project_memory_write, and never carry another Project\'s entries here.',
  'You may speak with the GitHub identity the host has signed in, and only while that identity is the Project owner\'s own. A write you make states the name you write as and the login you post for; the shared Project App identity is never used.',
  'Once a day, when the 09:00 task fires, call project_digest exactly once. It answers the four questions in order from the board rows and the Project State files, and prints one line on a day with no change.',
].join('\n\n')

const refusal = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })
const text = value => (typeof value === 'string' ? value.trim() : '')

// The calendar day in the digest's own zone. A digest is idempotent per *day* rather than per
// 24 hours, so a retry after 09:00 still sees that today already has one.
export function dayIn(at, zone = DIGEST_ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(at))
}

const stamp = at => new Date(at).toISOString().slice(0, 10)

// The four answers, in the order the issue names them, from rows the read model already carries:
// `source`, `column`, `assignee`, `updatedAt`. "Merged" is finished work a workflow run carried
// in (the run's binding is what put the row on this Project's board); "closed" is finished work a
// Bot or group chat owned. A board row has no blocked flag, so the third answer lists the cards
// still in progress and the assignee each one waits on — it never calls one blocked without that
// evidence. The next slice is the oldest card that has not started. Nothing is counted that is
// not a row, and a Project with no rows answers with no line at all.
export function buildDigest({ project, rows = [], since = null, files = [], at = Date.now() }) {
  const changed = row => since === null || (row?.updatedAt ?? 0) > since
  const finished = rows.filter(row => row.column === 'done' && changed(row))
  const merged = finished.filter(row => row.source === 'workflow')
  const closed = finished.filter(row => row.source !== 'workflow')
  const blocked = rows.filter(row => row.column === 'in-progress' && text(row.assignee) !== '')
  const next = rows
    .filter(row => row.column === 'not-started')
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)))[0]
  const line = (head, entries) => [head, ...entries.map(entry => `- ${entry}`)]
  const sections = [
    ...(merged.length === 0 ? [] : line('Merged since the previous digest:', merged.map(row => `${row.id} (${row.source})`))),
    ...(closed.length === 0 ? [] : line('Closed:', closed.map(row => `${row.id} (${row.source})`))),
    ...(blocked.length === 0 ? [] : line('In progress, waiting on:', blocked.map(row => `${row.id} — ${text(row.assignee)}`))),
    ...(next === undefined ? [] : line('Next slice:', [`${next.id} (${next.source})`])),
  ]
  const head = `${assistantName(project)} — ${stamp(at)}`
  if (sections.length === 0) return { changed: false, day: dayIn(at), text: `${head}: no change since the previous digest.` }
  const stateLine = files.length === 0
    ? 'Project State: no Project State files read.'
    : `Project State: ${files.map(file => file.path).join(', ')}`
  return { changed: true, day: dayIn(at), text: [head, stateLine, ...sections].join('\n') }
}

// A write is attributed by text, because one shared GitHub login makes it impossible to tell
// otherwise (#627). The login is the Project owner's own account, resolved at write time.
export const attribution = (project, login) => `Written-by: ${assistantName(project)}\nPosted-for: ${login}`

export function install(rt) {
  const projectOf = id => rt.readProject?.(id) ?? null

  const activeProject = (id) => {
    const project = projectOf(text(id))
    if (project === null) throw refusal(`Unknown Project ${text(id) || '(none)'}`, 'bot/not-found')
    if (project.status === 'archived') throw refusal(`Project ${project.name} is archived`, 'bot/refused')
    return project
  }

  const assistantOf = (project) => {
    const botId = project.assistant?.botId
    return typeof botId === 'string' && rt.botOf(botId) !== undefined ? project.assistant : null
  }

  const memoryOf = (project) => {
    const memory = rt.projectMemoryOf?.(project.id)
    return {
      decisions: Array.isArray(memory?.decisions) ? memory.decisions : [],
      questions: Array.isArray(memory?.questions) ? memory.questions : [],
      digest: memory?.digest ?? null,
    }
  }

  const read = (projectId) => ({ project: activeProject(projectId), memory: memoryOf(activeProject(projectId)) })

  const write = (projectId, body = {}) => {
    const project = activeProject(projectId)
    const kind = text(body.kind) || 'decision'
    if (!MEMORY_KINDS.includes(kind)) throw refusal(`Unknown Project memory kind ${kind}`)
    const entry = text(body.text)
    if (entry === '') throw refusal('A Project memory entry needs text')
    if (entry.length > MAX_ENTRY) throw refusal(`A Project memory entry is at most ${MAX_ENTRY} characters`)
    rt.appendProjectMemory?.(project.id, kind, { text: entry, at: Date.now(), ...(text(body.by) === '' ? {} : { by: text(body.by) }) })
    return { project, memory: memoryOf(project) }
  }

  // The one identity this slice accepts: the connector account, which on a single-person install
  // is the owner's own. Two cases refuse and escalate instead of falling back to the app.
  const identity = (projectId) => {
    const project = activeProject(projectId)
    const github = (rt.connectorsView?.() ?? []).find(row => row.id === 'github')
    const login = text(github?.account)
    if (login === '') {
      return { ok: false, project, escalate: true, reason: 'no GitHub connector is signed in, so the assistant has no owner identity to post for' }
    }
    const members = Object.keys(rt.state?.members ?? {})
    // One member is the person signed in, so the Project owner must be that member. More than one
    // member is exactly the case this slice has no answer for — there is no per-user GitHub linkage
    // yet — so it refuses rather than letting one person's account post for another.
    if (members.length > 1) {
      return { ok: false, project, escalate: true, reason: `this host has more than one member and no per-user GitHub linkage, so Project ${project.name} cannot be posted for by any one owner` }
    }
    const own = members.length === 1 ? members[0] : ''
    const ownerId = text(project.ownerUserId) || own
    if (own !== '' && ownerId !== own) {
      return { ok: false, project, escalate: true, reason: `Project ${project.name} is owned by ${ownerId}, not by this host's own user; there is no per-user GitHub linkage to post for them` }
    }
    return { ok: true, project, login }
  }

  // One task on the assistant's Session, through the host's schedule path — never a cron of the
  // plugin's own. An install with DSH's automation tasks off keeps the Project and records why the
  // digest is not scheduled, because creating a Project must not depend on the schedule service.
  const scheduleDigest = async (project, botId) => {
    const sessionId = rt.chatOf?.(botId) ?? botId
    if (typeof rt.scheduleEndpoint !== 'function') return { error: 'the schedule service is off in DSH' }
    // The Bot exists but the Session index has not been rebuilt yet; a task on it must resolve as
    // that Bot's own Session, or the schedule path refuses it as somebody else's.
    rt.chatOwners?.set(sessionId, botId)
    try {
      const view = await rt.scheduleEndpoint('schedule-create', {
        target: botId,
        title: DIGEST_TITLE,
        prompt: DIGEST_PROMPT,
        when: { kind: 'daily', time: DIGEST_TIME, timeZone: DIGEST_ZONE },
      })
      const row = (view?.tasks ?? []).find(task => task.sessionId === sessionId && task.title === DIGEST_TITLE)
      return { scheduleId: row?.id ?? null }
    } catch (error) {
      return { error: error?.message ?? String(error) }
    }
  }

  const create = async (projectId) => {
    const project = activeProject(projectId)
    const existing = assistantOf(project)
    if (existing !== null) return { project, assistant: existing, created: false }
    const bot = await rt.createBot({
      name: assistantName(project),
      role: ASSISTANT_ROLE,
      instructions: assistantInstructions(project),
      hidden: true,
      ownerId: text(project.ownerUserId) || rt.initialOwnerId?.(),
    })
    // The assistant and its binding are plumbing, not a change of the Project: a Project
    // created with one still answers `createdAt === updatedAt`.
    const stamped = project.updatedAt
    rt.bindProject?.({ kind: 'bot', id: bot.id, projectId: project.id })
    project.updatedAt = stamped
    const schedule = await scheduleDigest(project, bot.id)
    const assistant = { botId: bot.id, sessionId: rt.chatOf?.(bot.id) ?? bot.id, createdAt: Date.now(), ...schedule }
    project.assistant = assistant
    await rt.save?.()
    return { project, assistant, created: true }
  }

  const remove = async (projectId) => {
    const project = projectOf(text(projectId))
    if (project === null) return null
    const assistant = assistantOf(project)
    if (assistant === null) return null
    if (typeof rt.scheduleEndpoint === 'function' && typeof assistant.scheduleId === 'string') {
      await rt.scheduleEndpoint('schedule-delete', { sessionId: assistant.sessionId, id: assistant.scheduleId })
        .catch(error => rt.warn?.('ds-bot: removing the Project Assistant schedule failed: %s', error?.message ?? error))
    }
    await rt.deleteBot?.(assistant.botId)
      .catch(error => rt.warn?.('ds-bot: removing the Project Assistant Bot failed: %s', error?.message ?? error))
    delete project.assistant
    await rt.save?.()
    return assistant
  }

  // One stored Project note and one delivered message, at most once per calendar day. The second
  // build in a day answers `skipped` and writes nothing; it still resolves identity first, because
  // a refused identity must not leave a note behind.
  const digest = async (projectId, { at = Date.now(), force = false } = {}) => {
    const who = identity(projectId)
    if (!who.ok) return { ok: false, escalated: who.escalate === true, reason: who.reason }
    const { project, login } = who
    const memory = memoryOf(project)
    const day = dayIn(at)
    if (!force && memory.digest?.day === day) {
      return { ok: true, skipped: true, day, reason: 'today already has a digest', project }
    }
    const rows = rt.projectBoard?.(project.id) ?? []
    const listed = project.workDir === undefined ? null : await listProjectState(project.workDir).catch(() => null)
    const files = listed?.ok === true ? listed.files : []
    const built = buildDigest({ project, rows, since: memory.digest?.at ?? null, files, at })
    const body = [attribution(project, login), built.text].join('\n\n')
    const note = { day: built.day, at, text: built.text }
    rt.setProjectDigest?.(project.id, note)
    const toId = text(project.ownerUserId) === '' ? rt.state?.mainBotIds?.[0] : (rt.state?.members?.[project.ownerUserId]?.designatedChiefId ?? rt.state?.mainBotIds?.[0])
    if (typeof toId === 'string' && toId !== '') {
      await rt.deliver?.({
        fromId: project.assistant?.botId ?? toId,
        toId,
        sessionId: rt.chatOf?.(toId) ?? toId,
        text: body,
        role: ASSISTANT_ROLE,
      })
    }
    return { ok: true, skipped: false, day: built.day, changed: built.changed, text: body, project }
  }

  rt.projectAssistant = { create, remove, read, write, identity, digest, buildDigest }

  // The assistant's own Session calls this. The Project comes from the Session's bound Bot, never
  // from the arguments, so one Project's assistant cannot reach another Project's memory.
  rt.ctx.tools.register(defineTool({
    name: 'project_digest',
    description: 'Build the Project digest for the Project your Session is bound to: what merged since the previous digest, what closed, which cards are still in progress and on whom, and the next slice. It stores one Project note and delivers one message to the owner, at most once per day; the second call in a day adds nothing and says so.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load?.()
      const botId = rt.selfOf?.(exec?.agent?.id) ?? exec?.agent?.id
      const bot = botId === undefined ? undefined : rt.botOf(botId)
      const projectId = text(bot?.projectId)
      if (projectId === '') return 'This Session is not a Project Assistant, so it has no Project digest to build.'
      const result = await digest(projectId)
      if (result.ok !== true) return `The digest was not posted: ${result.reason}`
      return result.skipped === true ? `Today already has a digest (${result.day}); this call added nothing.` : result.text
    },
  }))
}
