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
  const projectBoard = (projectId) => {
    const id = text(projectId)
    if (id === '') return []
    if (!rt.readProject?.(id)) return []
    const tasks = rt.state?.tasks ?? {}
    const refs = new Map()
    for (const ref of rt.projectRunRefs?.({ hasTask: taskId => Object.hasOwn(tasks, taskId) }) ?? []) {
      refs.set(ref.taskId, ref)
    }
    const rows = []
    for (const task of Object.values(tasks)) {
      if (task === null || typeof task !== 'object') continue
      const board = boardOf(task)
      const boardProject = board === null ? null : rt.projectOfMember?.(board.kind, board.id)
      const ref = refs.get(task.id)
      const runProject = ref === undefined ? null : rt.projectOfMember?.('run', ref.runId)
      // The card's own board wins; a card the run created has no Project of its own, so the
      // run's binding carries it and the row is reported as coming from the workflow.
      const source = boardProject?.id === id ? board.kind : runProject?.id === id ? 'workflow' : null
      if (source === null) continue
      rows.push({
        id: task.id,
        source,
        column: columnOf(task),
        assignee: task.assignee ?? null,
        updatedAt: task.updatedAt ?? task.createdAt ?? null,
        ...(ref === undefined ? {} : { runId: ref.runId, ...(ref.nodeId ? { nodeId: ref.nodeId } : {}) }),
      })
    }
    return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)))
  }
  rt.projectBoard = projectBoard
}
