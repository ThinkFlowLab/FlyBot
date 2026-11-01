// The Project board's team dossier (#1864). One read-only answer for the people who serve a
// Project: its own Chief (#1859), the assistant that speaks for the caller (#1712) and the role
// pool the Project names (#1828). Nothing here writes persona, instructions or memory; editing stays
// in the Project settings panel, and a later slice that wants an editor opens its own issue.
//
// Persona is the Bot's `instructions`, memory is the head of its own MEMORY.md plus the topic names
// (never a topic body, never another Project's memory), and skills are the attached capabilities the
// library records as `skill` — a pack contributes the skills it contains. The owner decided on
// 2026-10-30 that persona and memory are shared by the Project's members and kept as files in the
// repository; this slice reads what the Bot carries today, and adds no writer.
//
// Every string and list is capped, and a Bot that was deleted is a `null` row: one dead Chief must
// not take the assistant and the pool down with it. The row shape is the contract the client's
// dossier panel draws, so it carries exactly those keys and nothing that names an owner, a working
// folder or a stored secret.
import { rolesOf } from './project-board.js'
import { cut } from './text.js'

export const DOSSIER_LIMITS = { persona: 4000, memoryHead: 4000, topics: 64, skills: 64, rooms: 32, name: 200, role: 120, model: 200, color: 64 }

const text = value => (typeof value === 'string' ? value.trim() : '')
// #2005: every capped field lands on a code point — a `slice` bound could end on the first half
// of an emoji, which the panel draws as a replacement character.
const capped = (value, limit) => cut(text(value), limit).text

export function install(rt) {
  // The attached names that are skills. A pack is expanded to its skill children; a capability the
  // library no longer holds is kept by name so a moved library does not erase what the Bot has.
  const skillNames = (bot) => {
    const library = typeof rt.capabilityLibraryView === 'function' ? rt.capabilityLibraryView() : []
    const byName = new Map((Array.isArray(library) ? library : []).map(item => [text(item?.name), item]))
    const names = []
    const add = (name) => {
      const clean = text(name)
      if (clean !== '' && !names.includes(clean)) names.push(clean)
    }
    for (const attached of Array.isArray(bot.capabilities) ? bot.capabilities : []) {
      const item = byName.get(text(attached))
      if (item === undefined) add(attached)
      else if (item.kind === 'skill') add(attached)
      else if (item.kind === 'pack') for (const child of item.items ?? []) if (byName.get(text(child))?.kind === 'skill') add(child)
    }
    return names.slice(0, DOSSIER_LIMITS.skills)
  }

  // Only this Project's rooms: a dossier is the Project's own read, so a Bot that also works in
  // another Project's room does not carry that room's name into this answer.
  const roomsOf = (bot, project) => Object.values(rt.state?.rooms ?? {})
    .filter(room => room !== null && typeof room === 'object' && Array.isArray(room.members) && room.members.includes(bot.id))
    .filter(room => rt.projectOfMember?.('group', room.id)?.id === project.id)
    .map(room => ({ id: text(room.id), name: cut(text(room.name), 200).text }))
    .slice(0, DOSSIER_LIMITS.rooms)

  const rowOf = (botId, project) => {
    const id = text(botId)
    if (id === '') return null
    const bot = rt.botOf?.(id)
    if (bot === undefined || bot === null) return null
    const digest = rt.memoryDigest?.(id) ?? { head: '', topics: [] }
    return {
      botId: id,
      name: capped(bot.name, DOSSIER_LIMITS.name),
      role: capped(bot.role, DOSSIER_LIMITS.role),
      persona: capped(bot.instructions, DOSSIER_LIMITS.persona),
      model: capped(bot.model, DOSSIER_LIMITS.model),
      color: capped(bot.color, DOSSIER_LIMITS.color),
      createdAt: Number.isFinite(bot.createdAt) ? bot.createdAt : null,
      memory: {
        head: cut(typeof digest.head === 'string' ? digest.head : '', DOSSIER_LIMITS.memoryHead).text,
        topics: (Array.isArray(digest.topics) ? digest.topics : []).map(name => text(name)).filter(name => name !== '').slice(0, DOSSIER_LIMITS.topics),
      },
      skills: skillNames(bot),
      rooms: roomsOf(bot, project),
    }
  }

  // The order is the board's own: Chief, assistant, then the pool. A Project with no Chief keeps
  // the first slot as `null`, so the client always reads the same three groups.
  const projectTeam = (projectId) => {
    const project = rt.readProject?.(text(projectId)) ?? null
    if (project === null) return { rows: [] }
    const roles = rolesOf(project)
    const pool = [...roles.maintainers, ...roles.members].filter((id, at, all) => all.indexOf(id) === at)
    const ids = [text(project.chief?.botId), text(project.assistant?.botId), ...pool]
    return { rows: ids.map(id => rowOf(id, project)) }
  }

  rt.projectTeam = projectTeam
}
