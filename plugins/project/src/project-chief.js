// The Project Chief (#1859): every Project gets its own Chief, created with the Project. It is not
// the user's main Chief acting part-time for a Project — the main Chief stays outside, and this one
// speaks for exactly one Project. The record carries `chief: { botId, sessionId, createdAt }`, the
// same place and shape the assistant uses, and `project-delete` retires it with the Project.
//
// Nothing here invents a schedule or a memory of its own: the Chief is one hidden Bot with a Session
// and instructions, bound to the Project through `bindProject`, so a host that has no Chief seam
// still creates the Project and records why (the store owns that fallback, not this module).
const CHIEF_ROLE = 'Project Chief'

export const chiefName = project => `${CHIEF_ROLE} (${project.name})`

// The one boundary that matters: the instructions name this Project and forbid answering for any
// other. Another Project's name is never quoted here, so two Chiefs cannot learn each other's scope
// from their own prompt.
export const chiefInstructions = project => [
  `You are the Project Chief of "${project.name}" (Project id ${project.id}). You are that Project's own Chief, not the user's main Chief acting part-time.`,
  'You speak for that Project and for no other: never answer for, decide for, or report on another Project, and never let another Project\'s work be attributed to this one.',
  'The user\'s main Chief stays outside this Project. Report to it when asked, but keep this Project\'s work and its record here.',
].join('\n\n')

const text = value => (typeof value === 'string' ? value.trim() : '')
const refusal = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })

export function install(rt) {
  const projectOf = id => rt.readProject?.(text(id)) ?? null

  const activeProject = (id) => {
    const project = projectOf(id)
    if (project === null) throw refusal(`Unknown Project ${text(id) || '(none)'}`, 'bot/not-found')
    if (project.status === 'archived') throw refusal(`Project ${project.name} is archived`, 'bot/refused')
    return project
  }

  // The record is the answer; a Bot that has since been deleted is not a Chief, so the read
  // resolves `null` instead of handing back a dead id.
  const chiefOf = (projectId) => {
    const project = projectOf(projectId)
    if (project === null) return null
    const chief = project.chief
    if (typeof chief?.botId !== 'string' || chief.botId === '') return null
    return rt.botOf?.(chief.botId) === undefined ? null : chief
  }

  const create = async (projectId) => {
    const project = activeProject(projectId)
    const existing = chiefOf(project.id)
    if (existing !== null) return { project, chief: existing, created: false }
    const bot = await rt.createBot({
      name: chiefName(project),
      role: CHIEF_ROLE,
      instructions: chiefInstructions(project),
      hidden: true,
      ownerId: text(project.ownerUserId) || rt.initialOwnerId?.(),
    })
    // The Chief and its binding are plumbing, not a change of the Project: a Project created with
    // one still answers `createdAt === updatedAt`.
    const stamped = project.updatedAt
    rt.bindProject?.({ kind: 'bot', id: bot.id, projectId: project.id })
    project.updatedAt = stamped
    const chief = { botId: bot.id, sessionId: rt.chatOf?.(bot.id) ?? bot.id, createdAt: Date.now() }
    project.chief = chief
    await rt.save?.()
    return { project, chief, created: true }
  }

  // Retirement goes through the host's own Bot deletion, so the Session, the memory archive and the
  // board cards are handled by the same path every other Bot deletion takes.
  const remove = async (projectId) => {
    const project = projectOf(projectId)
    if (project === null) return null
    const chief = chiefOf(project.id) ?? (typeof project.chief?.botId === 'string' ? project.chief : null)
    if (chief === null) return null
    await rt.deleteBot?.(chief.botId)
      .catch(error => rt.warn?.('ds-bot: removing the Project Chief Bot failed: %s', error?.message ?? error))
    delete project.chief
    await rt.save?.()
    return chief
  }

  rt.projectChief = { create, chiefOf, remove, chiefName, chiefInstructions, CHIEF_ROLE }
}
