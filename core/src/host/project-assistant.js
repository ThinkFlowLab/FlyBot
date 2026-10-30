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
import { inQuietHours, clockIn, quietHoursOf, readQuietHours } from '../shared/quiet-hours.js'

export const ASSISTANT_ROLE = 'Project Assistant'
export const DIGEST_ZONE = 'Asia/Shanghai'
export const DIGEST_TIME = '09:00'
export const DIGEST_TITLE = '09:00 Project digest'
export const DIGEST_PROMPT = 'Build today\'s Project digest: call project_digest once. It answers whether today already has one.'
export const MAX_ENTRY = 600
export const MEMORY_KINDS = ['decision', 'question']
// At most this many cards that need one owner's decision in one digest (#1733): a digest is a
// short list of things to decide, not the board. One constant, not a setting.
export const MAX_ACTIONABLE = 5

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
export function buildDigest({ project, rows = [], since = null, files = [], at = Date.now(), owner = null, actionable = [] }) {
  const changed = row => since === null || (row?.updatedAt ?? 0) > since
  const finished = rows.filter(row => row.column === 'done' && changed(row))
  const merged = finished.filter(row => row.source === 'workflow')
  const closed = finished.filter(row => row.source !== 'workflow')
  const blocked = rows.filter(row => row.column === 'in-progress' && text(row.assignee) !== '')
  const next = rows
    .filter(row => row.column === 'not-started')
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)))[0]
  const line = (head, entries) => [head, ...entries.map(entry => `- ${entry}`)]
  // The personal block comes last: the same rows answer the same four sections for every owner,
  // and only this one names the cards that wait on the person reading it.
  const shown = owner === null ? [] : actionable.slice(0, MAX_ACTIONABLE).map(item => `${item.id} — ${item.ask}`)
  // The block stays five cards: a person with seven waiting is told how many are left over instead
  // of being handed the whole board (#P-197). Five or fewer print exactly as they did before.
  const rest = owner === null ? 0 : actionable.length - MAX_ACTIONABLE
  if (rest > 0) shown.push(`… and ${rest} more waiting on you`)
  const personal = shown.length === 0 ? [] : line(`Needs ${owner}'s decision:`, shown)
  const sections = [
    ...(merged.length === 0 ? [] : line('Merged since the previous digest:', merged.map(row => `${row.id} (${row.source})`))),
    ...(closed.length === 0 ? [] : line('Closed:', closed.map(row => `${row.id} (${row.source})`))),
    ...(blocked.length === 0 ? [] : line('In progress, waiting on:', blocked.map(row => `${row.id} — ${text(row.assignee)}`))),
    ...(next === undefined ? [] : line('Next slice:', [`${next.id} (${next.source})`])),
    ...personal,
  ]
  const head = `${assistantName(project)} — ${stamp(at)}`
  if (sections.length === 0) return { changed: false, day: dayIn(at), text: `${head}: no change since the previous digest.` }
  const stateLine = files.length === 0
    ? 'Project State: no Project State files read.'
    : `Project State: ${files.map(file => file.path).join(', ')}`
  return { changed: true, day: dayIn(at), text: [head, stateLine, ...sections].join('\n') }
}

// The cards that need *this* owner's decision: owned by that owner, and stopped where only the
// reader can move them. A card somebody else owns is their decision, and never appears in this
// owner's digest. The board's `assignee` is a Bot name or null, never a member id (#1733), so the
// owner comes from `ownerOf`: the host resolves it from the card's own Bot, and a hand-built row
// may carry `ownerId` itself.
const WAITING_STATUS = new Set(['blocked', 'result-ready'])
export function actionableFor(rows, ownerId, ownerOf = row => text(row?.ownerId)) {
  const owner = text(ownerId)
  if (owner === '') return []
  return (rows ?? [])
    .filter(row => row?.column !== 'done' && ownerOf(row) === owner)
    // A row that carries no status keeps the older answer: absence is not evidence that the card
    // is moving, and reading it as "not waiting" would silently delete a card from the digest.
    .filter((row) => {
      const status = text(row?.status)
      return status === '' || WAITING_STATUS.has(status)
    })
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)))
    .map(row => ({ id: String(row.id), ask: askOf(row) }))
}

// One line, because the block is a list of decisions and a card description may be long. What the
// card is waiting for is its own status, not its column: a blocked card wants a call, a finished
// result wants acceptance, and anything else the caller chose to list is still a decision to make.
const waitOf = (row) => {
  const status = text(row?.status)
  if (status === 'blocked') return 'needs your call'
  if (status === 'result-ready') return 'ready for your acceptance'
  return 'decide what happens next'
}
const askOf = (row) => {
  const title = text(row.title).replace(/\s+/g, ' ')
  const where = text(row.column) === '' ? 'open' : `still ${text(row.column)}`
  if (title === '') return `${waitOf(row)} — ${where}`
  const short = title.length > 80 ? `${title.slice(0, 77)}…` : title
  return `${waitOf(row)} — ${short} (${where})`
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

  // The owners of one Project (#1733): its primary owner plus every owner listed on the record.
  // This list is the boundary a memory read is checked against.
  const ownersOf = (project) => {
    const primary = text(project.ownerUserId)
    const listed = Array.isArray(project.ownerUserIds) ? project.ownerUserIds.map(id => text(id)).filter(id => id !== '') : []
    return [...new Set([...(primary === '' ? [] : [primary]), ...listed])]
  }

  const memoryOf = (project, ownerId) => {
    const owner = text(ownerId) || ownersOf(project)[0] || ''
    const memory = rt.projectMemoryFor?.(project.id, owner) ?? null
    return {
      decisions: Array.isArray(memory?.decisions) ? memory.decisions : [],
      questions: Array.isArray(memory?.questions) ? memory.questions : [],
      digest: memory?.digest ?? null,
    }
  }

  // The refusal names the boundary instead of pretending the Project has no memory (#1733): one
  // owner asking for another owner's entries learns whose they are, and nothing else.
  const outsideBoundary = (project, ownerId) => {
    const owners = ownersOf(project)
    return refusal(`Project ${project.name} memory belongs only to ${owners.join(', ') || '(no owner)'}; ${text(ownerId) || '(none)'} is outside that boundary and cannot read it`, 'bot/refused')
  }

  const read = (projectId, ownerId = '') => {
    const project = activeProject(projectId)
    if (text(ownerId) !== '' && !ownersOf(project).includes(text(ownerId))) throw outsideBoundary(project, ownerId)
    return { project, memory: memoryOf(project, ownerId) }
  }

  const write = (projectId, body = {}) => {
    const project = activeProject(projectId)
    const kind = text(body.kind) || 'decision'
    if (!MEMORY_KINDS.includes(kind)) throw refusal(`Unknown Project memory kind ${kind}`)
    const entry = text(body.text)
    if (entry === '') throw refusal('A Project memory entry needs text')
    if (entry.length > MAX_ENTRY) throw refusal(`A Project memory entry is at most ${MAX_ENTRY} characters`)
    const ownerId = text(body.ownerId) || ownersOf(project)[0] || ''
    if (text(body.ownerId) !== '' && !ownersOf(project).includes(text(body.ownerId))) throw outsideBoundary(project, body.ownerId)
    rt.appendProjectMemory?.(project.id, kind, { text: entry, at: Date.now(), ownerId, ...(text(body.by) === '' ? {} : { by: text(body.by) }) })
    return { project, memory: memoryOf(project, ownerId) }
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

  // A Project whose assistant exists without a `scheduleId` — created while DSH's automation tasks
  // were off, or whose task was never written — gets its 09:00 digest on the first moment the
  // service exists (#1751). A success clears the recorded error, so a later `project-create`
  // answers `created:false` with nothing left to retry. One run at a time: a caller that arrives
  // while one is in flight joins it instead of putting a second task on the Session.
  let reconciling = null
  const reconcile = () => {
    if (reconciling !== null) return reconciling
    reconciling = (async () => {
      if (typeof rt.scheduleEndpoint !== 'function') return { scheduled: [] }
      const scheduled = []
      for (const project of rt.listProjects?.() ?? []) {
        const assistant = assistantOf(project)
        // No assistant, or one whose digest is already scheduled: nothing to retry.
        if (assistant === null || typeof assistant.scheduleId === 'string') continue
        const schedule = await scheduleDigest(project, assistant.botId)
        if (typeof schedule.scheduleId !== 'string') {
          if (typeof schedule.error === 'string') assistant.error = schedule.error
          continue
        }
        assistant.scheduleId = schedule.scheduleId
        delete assistant.error
        scheduled.push(project.id)
      }
      if (scheduled.length > 0) await rt.save?.()
      return { scheduled }
    })().finally(() => { reconciling = null })
    return reconciling
  }

  const create = async (projectId) => {
    const project = activeProject(projectId)
    const existing = assistantOf(project)
    if (existing !== null) {
      // An assistant that exists but never got its digest is offered the retry here, and the
      // answer still says `created:false`: this call did not create anything.
      if (typeof existing.scheduleId !== 'string') await reconcile()
      return { project, assistant: assistantOf(project) ?? existing, created: false }
    }
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

  // Per-owner controls (#1733) live on the Project's assistant record, never in the host-wide
  // prefs: a quiet window read in the owner's own zone, and the digest opt-out.
  const assistantOwners = (assistant) => {
    if (typeof assistant.owners !== 'object' || assistant.owners === null || Array.isArray(assistant.owners)) assistant.owners = {}
    return assistant.owners
  }
  const ownerRecord = (assistant, ownerId) => {
    const rows = assistantOwners(assistant)
    const key = text(ownerId)
    const kept = rows[key]
    if (typeof kept !== 'object' || kept === null || Array.isArray(kept)) rows[key] = {}
    return rows[key]
  }
  const quietOf = (assistant, ownerId) => {
    const record = text(ownerId) === '' ? null : (assistant?.owners?.[text(ownerId)] ?? null)
    return { ...quietHoursOf({ quietHours: record?.quiet ?? null }), zone: text(record?.zone) || DIGEST_ZONE }
  }

  // The opt-out and the quiet window of one owner. The 09:00 task is paused only when every owner
  // is off, because it is the one task every owner's digest is built by; turning one owner back on
  // resumes it. Nothing here touches GitHub: these are the user's own controls.
  const setOwner = async (projectId, ownerId, settings = {}) => {
    const project = activeProject(projectId)
    const owner = text(ownerId)
    if (!ownersOf(project).includes(owner)) throw outsideBoundary(project, ownerId)
    const assistant = assistantOf(project)
    if (assistant === null) throw refusal(`Project ${project.name} has no assistant yet`, 'bot/refused')
    const record = ownerRecord(assistant, owner)
    const wasOff = record.off === true
    if (settings.quiet !== undefined) {
      const next = readQuietHours(settings.quiet ?? null, record.quiet ?? null)
      if (next === undefined) delete record.quiet
      else record.quiet = next
    }
    if (settings.zone !== undefined) {
      if (text(settings.zone) === '') delete record.zone
      else record.zone = text(settings.zone)
    }
    if (settings.off !== undefined) record.off = settings.off === true
    let schedule = null
    if (settings.off !== undefined && typeof rt.scheduleEndpoint === 'function' && typeof assistant.scheduleId === 'string') {
      const allOff = ownersOf(project).every(id => assistant.owners?.[id]?.off === true)
      try {
        const view = await rt.scheduleEndpoint(allOff ? 'schedule-pause' : 'schedule-resume', { sessionId: assistant.sessionId, id: assistant.scheduleId })
        schedule = (view?.tasks ?? []).find(task => task.id === assistant.scheduleId)?.status ?? (allOff ? 'paused' : 'active')
      } catch (error) {
        record.scheduleError = error?.message ?? String(error)
      }
    }
    await rt.save?.()
    return { owner, off: record.off === true, quiet: quietOf(assistant, owner), schedule, changed: wasOff !== (record.off === true) }
  }

  // A board row carries the card's identity and its column, not its title; the ask line needs a
  // subject, so the card's own record supplies it.
  const withTitles = rows => rows.map((row) => {
    const task = rt.state?.tasks?.[String(row?.id ?? '')]
    const title = text(task?.title)
    // The card's status comes from its own record here, not from a second read further down: a
    // card that is still moving waits on nobody, and the digest decides that from this row (#P-195).
    const status = text(task?.status)
    const shaped = title === '' ? row : { ...row, title }
    return status === '' ? shaped : { ...shaped, status }
  })

  // A card's owner is the owner of the Bot that owns the card: the board names the Bot, and the
  // Bot names its owner. `assignee` is only a Bot name, and a hand-built row may carry `ownerId`.
  const cardOwner = (row) => {
    const botId = text(rt.state?.tasks?.[String(row?.id ?? '')]?.ownerBotId)
    const bot = botId === '' ? undefined : rt.botOf?.(botId)
    if (bot !== undefined && bot !== null && text(bot.ownerId) !== '') return text(bot.ownerId)
    const named = text(row?.assignee)
    if (named !== '') {
      for (const candidate of Object.values(rt.state?.bots ?? {})) {
        if (text(candidate?.name) === named) return text(candidate.ownerId)
      }
    }
    return text(row?.ownerId)
  }

  // In-app delivery goes to the owner's own Session and never through the GitHub identity: the 2.5
  // refusal stays where a GitHub write happens, not on the way to a person's own chat (#1733).
  // Only the primary owner may fall back to the host's main Bot: a second owner's digest quotes
  // that owner's private memory, so another owner's Session is never a delivery address for it.
  const deliverTo = async (project, ownerId, body) => {
    const owner = text(ownerId)
    const member = owner === '' ? undefined : rt.state?.members?.[owner]
    const primary = owner === '' || owner === text(project?.ownerUserId)
    const toId = text(member?.designatedChiefId) || (primary ? text(rt.state?.mainBotIds?.[0]) : '')
    if (toId === '') return { delivered: false, reason: `owner ${owner || '(none)'} has no Session of their own to deliver to` }
    await rt.deliver?.({
      fromId: project.assistant?.botId ?? toId,
      toId,
      sessionId: rt.chatOf?.(toId) ?? toId,
      text: body,
      role: ASSISTANT_ROLE,
    })
    return { delivered: true, toId }
  }

  const bodyFor = (project, built, who) => (who.ok === true ? [attribution(project, who.login), built.text].join('\n\n') : built.text)

  // One owner's digest. Generation may proceed while a quiet window holds delivery; a window that
  // covers the due instant delivers nothing that day at all, and that is the expected outcome, not a
  // failure.
  const digestForOwner = async ({ project, owner, rows, cards, files, at, force, who }) => {
    const assistant = assistantOf(project) ?? project.assistant ?? null
    const record = assistant === null ? { } : ownerRecord(assistant, owner)
    const quiet = quietOf(assistant, owner)
    const day = dayIn(at)
    // 09:00 in the digest's own zone is an instant, and a window is wall clock in the owner's own
    // zone: two zones' wall clocks are not comparable (#P-194). Asia/Shanghai has no DST, so the
    // due instant is today's date at 09:00+08:00, read back as a clock in the owner's zone.
    const due = clockIn(quiet.zone, Date.parse(`${day}T${DIGEST_TIME}:00+08:00`))
    const clock = clockIn(quiet.zone, at)
    const coversDue = inQuietHours(quiet, due)
    const memory = memoryOf(project, owner)
    if (record.off === true) {
      return { owner, ok: true, skipped: true, optedOut: true, delivered: false, day, reason: 'this owner turned the digest off, so nothing is generated' }
    }
    // A digest held earlier today goes out once, when the window ends, labelled as held from the
    // instant it was held at — not from 09:00, which is another zone's wall clock.
    const held = typeof record.held === 'object' && record.held !== null ? record.held : null
    if (held !== null && held.day === day && coversDue === false && inQuietHours(quiet, clock) === false) {
      delete record.held
      const label = `held from ${clockIn(quiet.zone, held.at ?? at)} to ${clock} by quiet hours ${quiet.from}–${quiet.to}`
      const body = [bodyFor(project, { text: text(held.text) }, who), `(${label})`].join('\n')
      const sent = await deliverTo(project, owner, body)
      await rt.save?.()
      return { owner, ok: true, skipped: false, held: true, delivered: sent.delivered === true, day, changed: true, text: body, label, reason: label }
    }
    if (!force && memory.digest?.day === day) {
      return { owner, ok: true, skipped: true, delivered: false, day, reason: 'today already has a digest' }
    }
    const built = buildDigest({ project, rows, since: memory.digest?.at ?? null, files, at, owner, actionable: actionableFor(cards ?? rows, owner, cardOwner) })
    const note = { day: built.day, at, text: built.text, ...(who.ok === true ? {} : { error: `GitHub write refused: ${who.reason}` }) }
    rt.setProjectDigest?.(project.id, note, owner)
    if (coversDue) {
      return { owner, ok: true, skipped: false, delivered: false, held: true, dropped: true, day: built.day, changed: built.changed, text: built.text, reason: `quiet hours ${quiet.from}–${quiet.to} cover ${due}, so nothing is delivered — the expected outcome` }
    }
    if (inQuietHours(quiet, clock)) {
      record.held = { day: built.day, at, text: built.text, from: quiet.from, to: quiet.to }
      await rt.save?.()
      return { owner, ok: true, skipped: false, delivered: false, held: true, day: built.day, changed: built.changed, text: built.text, reason: `quiet hours ${quiet.from}–${quiet.to}: held, and delivered once when they end` }
    }
    const body = bodyFor(project, built, who)
    const sent = await deliverTo(project, owner, body)
    if (sent.delivered !== true) rt.setProjectDigest?.(project.id, { ...note, error: sent.reason }, owner)
    return { owner, ok: true, skipped: false, delivered: sent.delivered === true, day: built.day, changed: built.changed, text: body, ...(sent.delivered === true ? {} : { reason: sent.reason }) }
  }

  // One read of the board and one of Project State, then one render per owner (#1733): the facts
  // are shared, the personalisation is not, and neither side sees the other's memory. A render
  // that throws is that owner's failure, recorded on their own note; the other owners still go out.
  const digest = async (projectId, { at = Date.now(), force = false, ownerId = '' } = {}) => {
    const project = activeProject(projectId)
    if (text(ownerId) !== '' && !ownersOf(project).includes(text(ownerId))) throw outsideBoundary(project, ownerId)
    const listed = text(ownerId) === '' ? ownersOf(project) : [text(ownerId)]
    const owners = listed.length === 0 ? [''] : listed
    const who = identity(project.id)
    const rows = rt.projectBoard?.(project.id) ?? []
    const state = project.workDir === undefined ? null : await listProjectState(project.workDir).catch(() => null)
    const files = state?.ok === true ? state.files : []
    const results = []
    for (const owner of owners) {
      try {
        results.push(await digestForOwner({ project, owner, rows, cards: withTitles(rows), files, at, force, who }))
      } catch (error) {
        const failure = error?.message ?? String(error)
        rt.setProjectDigest?.(project.id, { day: dayIn(at), at, text: `digest failed: ${failure}`, error: failure }, owner)
        rt.warn?.('ds-bot: the digest of %s for %s failed: %s', project.name, owner, failure)
        results.push({ owner, ok: false, skipped: false, delivered: false, day: dayIn(at), error: failure, recorded: true })
      }
    }
    const first = results[0] ?? {}
    return {
      ok: true,
      day: first.day,
      skipped: first.skipped === true,
      changed: first.changed,
      reason: first.reason,
      text: first.text ?? '',
      project,
      owners: results,
      delivered: results.filter(row => row.delivered === true).length,
      identity: who.ok === true ? { ok: true, login: who.login } : { ok: false, escalated: who.escalate === true, reason: who.reason },
    }
  }

  rt.projectAssistant = { create, reconcile, remove, read, write, identity, digest, buildDigest, setOwner, ownersOf, actionableFor, MAX_ACTIONABLE }

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
