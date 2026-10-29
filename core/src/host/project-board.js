// One Project, one board read model (#1696). The core task record is the identity: a workflow
// run names the same id through `run.task.id` and never mints a second task, so a card a run
// consumed is one row that carries the run, not two views of the same work.
//
// Read-only by construction: it reads `state.tasks` and the Project bindings, asks each
// registered provider for the workflow refs of tasks that still exist, and returns rows. It
// writes nothing, starts nothing and is not called unless someone asks for the board.
import { columnOf } from '../shared/task-board.js'

const text = value => (typeof value === 'string' ? value.trim() : '')

// The board a card belongs to. A group card names its room; a Bot card names its owner. A card
// with neither (a run-only card) has no board and resolves through the run's own binding.
const boardOf = (task) => {
  const roomId = text(task?.origin?.roomId)
  if (task?.kind === 'group' && roomId !== '') return { kind: 'group', id: roomId }
  const botId = text(task?.ownerBotId)
  if (botId !== '') return { kind: 'bot', id: botId }
  return null
}

export function install(rt) {
  // Rows for one Project, deduped by task id. An unknown Project and a Project with nothing
  // under it both answer `[]`: reading a board is not a reason to throw.
  const projectBoard = (projectId, actor) => {
    const id = text(projectId)
    if (id === '') return []
    if (!rt.readProject?.(id)) return []
    const tasks = rt.state?.tasks ?? {}
    const refs = new Map()
    for (const ref of rt.projectRunRefs?.({ hasTask: taskId => Object.hasOwn(tasks, taskId) }) ?? []) {
      refs.set(ref.taskId, ref)
    }
    // #1723: a row is painted only when the caller could open that card through `tasks`. The
    // predicate lives in tasks.js (`rt.taskVisible`); a host that has not installed it shows
    // nothing, because an unreadable rule is not a reason to widen a board.
    const visible = typeof rt.taskVisible === 'function' ? rt.taskVisible : () => false
    const rows = []
    for (const task of Object.values(tasks)) {
      if (task === null || typeof task !== 'object') continue
      if (!visible(task, actor)) continue
      const board = boardOf(task)
      // The Project of the card's own board. A card that has a board already belongs somewhere; a
      // board whose member is unbound names no Project, and only then may a run carry the card.
      const ownProject = board === null ? null : rt.projectOfMember?.(board.kind, board.id)
      const ref = refs.get(task.id)
      const runProject = ref === undefined ? null : rt.projectOfMember?.('run', ref.runId)
      // The card's own board wins, and it is read whether or not it names this Project: a card
      // bound elsewhere is not borrowed through the run that happened to consume it. The run
      // carries only a card with no Project of its own, and it lends its id only to this board
      // — #1713: both halves let the far Project's run put its card here and its id on our row.
      const source = ownProject !== null
        ? ownProject.id === id ? board.kind : null
        : runProject?.id === id ? 'workflow' : null
      if (source === null) continue
      const fromRun = ref !== undefined && (runProject === null || runProject.id === id)
      const audit = typeof rt.taskAudit === 'function' ? rt.taskAudit(task.id) : ''
      rows.push({
        id: task.id,
        source,
        column: columnOf(task),
        assignee: task.assignee ?? null,
        updatedAt: task.updatedAt ?? task.createdAt ?? null,
        // The typed contract (#1720) is read from the same row, not a second copy: a board that
        // shows a rework or a held lease shows what the task store wrote. A record stored before
        // the slice carries none of the keys and reads back exactly as it did.
        ...(task.taskClass ? { taskClass: task.taskClass } : {}),
        ...(task.reworkOf ? { reworkOf: task.reworkOf } : {}),
        ...(task.handoff && typeof task.handoff === 'object' ? { handoff: task.handoff } : {}),
        ...(Array.isArray(task.evidence) ? { evidence: task.evidence } : {}),
        ...(task.lease && typeof task.lease === 'object' ? { lease: task.lease } : {}),
        // The same projection the task store renders (#1730): one text block a card detail can
        // show, with nothing written back. A pre-slice card answers the empty string and the row
        // carries no `audit` key at all.
        ...(audit !== '' ? { audit } : {}),
        ...(fromRun ? { runId: ref.runId, ...(ref.nodeId ? { nodeId: ref.nodeId } : {}) } : {}),
      })
    }
    return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)))
  }
  rt.projectBoard = projectBoard
}
