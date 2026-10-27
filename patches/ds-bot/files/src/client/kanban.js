// Per-Bot task board (#1058). The records are the task list in src/host/tasks.js.
// This is not the Agent inbox's board (#471): Inbox stays a list of what needs the
// owner. Tasks opens one Bot's board, a child of that Bot, or a group an admin can see.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { columnOf, priorityOf, progressOf } from '../shared/task-board.js'
import { taskCard } from '../shared/board-card.js'
import { BoardCard as BoardCardFrame, TASK_SKIN } from './board-card.js'
import { CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'

const POLL_MS = 15_000

function BoardIcon() {
  return h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 2.5, y: 3, width: 4, height: 14, rx: 1 }),
    h('rect', { x: 8, y: 3, width: 4, height: 9, rx: 1 }),
    h('rect', { x: 13.5, y: 3, width: 4, height: 12, rx: 1 }))
}

export function shortId(id) {
  const hex = String(id ?? '').replace(/^task-/, '')
  return `#${hex.slice(-6)}`
}

// #1252: the board lists active work; the Done column reads a bounded slice of the archive,
// so a room with hundreds of finished cards still renders a column, not the whole history.
export const ARCHIVE_SHOWN = 20

export function boardTasksFor(tasks, archive, limit = ARCHIVE_SHOWN) {
  // Newest first before the cut: a card finished a minute ago has an old `createdAt`, so ordering
  // by it would drop exactly the card a member just finished (#1252).
  const newest = [...(archive ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return [...(tasks ?? []), ...newest.slice(0, limit)]
}

export function boardColumns(tasks) {
  const columns = { 'not-started': [], 'in-progress': [], done: [] }
  for (const task of tasks ?? []) {
    const column = columnOf(task)
    ;(columns[column] ?? columns['not-started']).push(task)
  }
  for (const list of Object.values(columns)) list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return columns
}

// Group scope: an overall task (kind group) keeps the subtasks that share its
// column nested under it. A subtask whose parent sits in another column stays
// loose so the column can name the parent.
export function columnTree(tasks) {
  const ids = new Set((tasks ?? []).map(task => task.id))
  const childrenOf = new Map()
  const nested = new Set()
  for (const task of tasks ?? []) {
    if (!task.parentId || !ids.has(task.parentId)) continue
    const parent = tasks.find(item => item.id === task.parentId)
    if (parent?.kind !== 'group') continue
    const list = childrenOf.get(parent.id) ?? []
    list.push(task)
    childrenOf.set(parent.id, list)
    nested.add(task.id)
  }
  const nests = []
  const loose = []
  for (const task of tasks ?? []) {
    if (nested.has(task.id)) continue
    if (task.kind === 'group') nests.push({ task, children: childrenOf.get(task.id) ?? [] })
    else loose.push(task)
  }
  return { nests, loose }
}

function adminOf(roster, room) {
  const me = roster?.self?.memberId
  if (!me) return room?.origin !== 'face-to-face'
  const human = (room?.participants ?? []).find(person => person.kind === 'human' && person.id === me && person.leftSeq === undefined)
  if (human?.role === 'admin') return true
  const admin = roster?.byId?.[room?.admin]
  return Boolean(admin && !admin.remote && admin.ownerId === me)
}

// Own Bots, nested by who created them, then the groups this person administers.
export function boardRail(roster) {
  const me = roster?.self?.memberId
  const bots = (roster?.bots ?? []).filter(bot => bot && !bot.remote && (!me || !bot.ownerId || bot.ownerId === me))
  const ids = new Set(bots.map(bot => bot.id))
  const children = new Map()
  for (const bot of bots) {
    const parent = bot.createdBy && ids.has(bot.createdBy) ? bot.createdBy : ''
    const list = children.get(parent) ?? []
    list.push(bot)
    children.set(parent, list)
  }
  for (const list of children.values()) list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.name).localeCompare(String(b.name)))
  const rows = []
  const walk = (parent, depth) => {
    for (const bot of children.get(parent) ?? []) {
      rows.push({ kind: 'bot', id: bot.id, name: bot.name, depth, bot })
      walk(bot.id, depth + 1)
    }
  }
  walk('', 0)
  const groups = (roster?.rooms ?? [])
    .filter(room => room && room.hidden !== true && room.origin !== 'face-to-face' && adminOf(roster, room))
    .map(room => ({ kind: 'group', id: room.id, name: room.displayName || room.name || t('Group'), room }))
  return { bots: rows, groups }
}

export function canMoveTask(roster, task) {
  const me = roster?.self?.memberId
  if (!me) return true
  const bot = roster?.byId?.[task?.ownerBotId]
  return Boolean(bot && !bot.remote && (!bot.ownerId || bot.ownerId === me))
}

function priorityLabel(priority) {
  if (priority === 'urgent') return t('Highest')
  if (priority === 'high') return t('High')
  if (priority === 'low') return t('Low')
  return t('Normal')
}

function statusLabel(status) {
  switch (status) {
    case 'claimed': return t('Claimed')
    case 'working': return t('In progress')
    case 'blocked': return t('Blocked')
    case 'result-ready': return t('Result ready')
    case 'accepted': return t('Done')
    case 'cancelled': return t('Cancelled')
    case 'failed': return t('Failed')
    default: return t('Not started')
  }
}

function dropLabel(column) {
  if (column === 'in-progress') return t('Start task')
  if (column === 'done') return t('Complete task')
  return t('Not started')
}

function columnTitle(column) {
  if (column === 'in-progress') return t('In progress')
  if (column === 'done') return t('Done')
  return t('Not started')
}

function botName(roster, task) {
  return roster?.byId?.[task.ownerBotId]?.name || task.ownerBotName || ''
}

function lanesOf(tasks, roster) {
  const order = []
  const map = new Map()
  for (const task of tasks) {
    const id = task.ownerBotId ?? ''
    if (!map.has(id)) { map.set(id, []); order.push(id) }
    map.get(id).push(task)
  }
  return order.map(id => ({ id, name: botName(roster, map.get(id)[0]) || id, tasks: map.get(id) }))
}

const upsert = (list, task) => (list.some(item => item.id === task.id) ? list.map(item => item.id === task.id ? task : item) : [...list, task])
const without = (list, id) => list.filter(item => item.id !== id)

export function useBoardTasks(actions, scope) {
  const [own, setOwn] = useState([])
  const [groupTasks, setGroupTasks] = useState([])
  const [archive, setArchive] = useState([])
  const key = scope?.kind === 'group' ? `group:${scope.roomId}` : 'own'
  useEffect(() => {
    let stopped = false
    const load = () => {
      const query = scope?.kind === 'group' ? { roomId: scope.roomId } : {}
      // #1252: the host cuts the archive page before the board can see it, so a Bot board has to
      // name the Bot it asks for — an unfiltered page spends its whole budget on other Bots' newer
      // cards and this Bot's Done column empties. The default read stays unfiltered on purpose: it
      // is active work, a superset the board filters below without losing a card.
      const archiveQuery = scope?.kind === 'bot' ? { botId: scope.botId } : query
      // #1252: the default list is active work, so the Done column asks for the archive.
      const job = scope?.kind === 'group'
        ? Promise.resolve(actions?.tasks?.(query))
        : Promise.resolve(actions?.tasks?.())
      // A reading host or an older core has no board; keep the list already shown.
      void job.then((list) => {
        if (stopped || !Array.isArray(list)) return
        if (scope?.kind === 'group') setGroupTasks(list)
        else setOwn(list)
      }).catch(() => undefined)
      void Promise.resolve(actions?.tasks?.({ ...archiveQuery, archive: true, limit: ARCHIVE_SHOWN })).then((list) => {
        if (stopped || !Array.isArray(list)) return
        setArchive(list.filter(task => columnOf(task) === 'done'))
      }).catch(() => undefined)
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [key])
  const tasks = scope?.kind === 'group' ? groupTasks : own.filter(task => !scope?.botId || task.ownerBotId === scope.botId)
  // A finished card moves off the active list into the archive immediately, before the next poll.
  const replace = (task) => {
    const done = columnOf(task) === 'done'
    if (scope?.kind === 'group') setGroupTasks(list => done ? without(list, task.id) : upsert(list, task))
    else setOwn(list => done ? without(list, task.id) : upsert(list, task))
    setArchive(list => done ? [task, ...without(list, task.id)] : without(list, task.id))
  }
  const done = scope?.kind === 'group' ? archive : archive.filter(task => !scope?.botId || task.ownerBotId === scope.botId)
  return { own, tasks, archive: done, replace }
}

function RailButton({ row, selected, meta, onSelect }) {
  return h('button', {
    type: 'button',
    className: 'bt-board-rail-item',
    'data-kind': row.kind,
    'data-id': row.id,
    'data-selected': selected || undefined,
    'aria-current': selected ? 'true' : undefined,
    style: row.depth ? { paddingLeft: `${10 + row.depth * 14}px` } : undefined,
    onClick: () => onSelect(row.kind === 'group' ? { kind: 'group', roomId: row.id } : { kind: 'bot', botId: row.id }),
  },
  h('span', { className: 'bt-board-rail-name' }, row.name),
  meta ? h('span', { className: 'bt-board-rail-meta' }, meta) : null)
}

// A task record as a card. The shared frame draws the identity line; this board hangs its own
// attributes and actions off it.
export function BoardCard({ task, roster, movable, onMove, onDrag, partOf }) {
  const column = columnOf(task)
  const priority = priorityOf(task)
  const progress = progressOf(task)
  const who = botName(roster, task)
  const question = task.waitingFor === 'input' ? task.inputRequest?.question : ''
  const overall = task.kind === 'group'
  return h(BoardCardFrame, {
    card: taskCard(task),
    skin: TASK_SKIN,
    attrs: {
      'data-task': task.id,
      'data-column': column,
      'data-priority': priority,
      'data-kind': overall ? 'group' : undefined,
    },
    idText: shortId(task.id),
    emptyTitle: t('Untitled task'),
    topExtra: [
      h('span', { key: 'priority', className: 'bt-board-priority', 'data-priority': priority }, priorityLabel(priority)),
      h('span', { key: 'status', className: 'bt-board-status' }, statusLabel(task.status)),
    ],
    note: task.note ?? '',
    meta: [
      overall ? h('span', { key: 'kind', className: 'bt-board-kind' }, t('Group task')) : null,
      partOf ? h('span', { key: 'part', className: 'bt-board-part' }, t('Part of {title}', { title: partOf })) : null,
      question ? h('span', { key: 'wait', className: 'bt-board-wait' }, question) : null,
    ],
    footer: h('span', { className: 'bt-board-foot' },
      who ? h('span', { className: 'bt-board-who' }, who) : null,
      h('span', { className: 'bt-board-progress' },
        h('span', { className: 'bt-board-progress-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': progress, 'aria-label': t('Progress') },
          h('span', { style: { width: `${progress}%` } })),
        h('span', { className: 'bt-board-percent' }, t('{percent}%', { percent: progress })))),
    actions: [
      movable && column === 'not-started'
        ? h('button', { key: 'start', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => onMove?.(task.id, 'in-progress') }, t('Start'))
        : null,
      movable && column === 'in-progress' && task.status !== 'blocked'
        ? h('button', { key: 'complete', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => onMove?.(task.id, 'done') }, t('Complete'))
        : null,
    ],
    draggable: movable,
    dragValue: task.id,
    onDragStart: () => onDrag?.(task.id),
    onDragEnd: () => onDrag?.(null),
  })
}

function cardProps(task, roster, onMove, onDrag, partOf) {
  return { task, roster, movable: canMoveTask(roster, task), onMove, onDrag, partOf }
}

function BoardColumn({ column, tasks, roster, lanes, dragging, onMove, onDrag }) {
  const tree = lanes ? columnTree(tasks) : null
  const linked = tree ? tree.loose.filter(task => task.parentId || task.parentTitle) : []
  const plain = tree ? tree.loose.filter(task => !task.parentId && !task.parentTitle) : tasks
  return h('section', {
    className: 'bt-board-column',
    'data-column': column,
    'aria-label': columnTitle(column),
    onDragOver: (event) => { if (!dragging) return; event.preventDefault() },
    onDrop: (event) => {
      event.preventDefault()
      const id = event.dataTransfer?.getData('text/plain')
      if (id) onMove?.(id, column)
      onDrag?.(null)
    },
  },
  h('h3', { className: 'bt-board-column-head' },
    h('span', null, columnTitle(column)),
    h('span', { className: 'bt-board-count' }, String(tasks.length))),
  dragging ? h('div', { className: 'bt-board-drop' }, dropLabel(column)) : null,
  tasks.length === 0 && !dragging ? h('p', { className: 'bt-board-empty' }, t('Nothing in this column.')) : null,
  tree ? tree.nests.map(nest => h('div', { key: nest.task.id, className: 'bt-board-nest' },
    h(BoardCard, cardProps(nest.task, roster, onMove, onDrag)),
    nest.children.map(child => h('div', { key: child.id, className: 'bt-board-subtask', 'data-parent': nest.task.id },
      h(BoardCard, cardProps(child, roster, onMove, onDrag)))))) : null,
  linked.map(task => h(BoardCard, { key: task.id, ...cardProps(task, roster, onMove, onDrag, task.parentTitle || '') })),
  lanes
    ? lanesOf(plain, roster).map(lane => h('div', { key: lane.id, className: 'bt-board-lane' },
        h('span', { className: 'bt-board-lane-name' }, lane.name),
        lane.tasks.map(task => h(BoardCard, { key: task.id, ...cardProps(task, roster, onMove, onDrag) }))))
    : plain.map(task => h(BoardCard, { key: task.id, ...cardProps(task, roster, onMove, onDrag) })))
}

export function BoardView({ roster, tasks, rail, scope, counts, dragging, error, draft, onDraft, onSelect, onMove, onDrag, onCreate }) {
  const columns = boardColumns(tasks)
  const lanes = scope?.kind === 'group'
  const selectedBot = scope?.kind === 'bot' ? scope.botId : ''
  const selectedRoom = scope?.kind === 'group' ? scope.roomId : ''
  return h('div', { className: 'bt-board-body' },
    h('aside', { className: 'bt-board-rail', 'aria-label': t('Task board') },
      h('h3', { className: 'bt-board-rail-head' }, t('Your Bots')),
      rail.bots.length === 0 ? h('p', { className: 'bt-board-empty' }, t('No tasks yet.')) : rail.bots.map(row => {
        const count = counts?.[row.id] ?? { done: 0, total: 0 }
        return h(RailButton, {
          key: row.id, row, selected: row.id === selectedBot, onSelect,
          meta: count.total > 0 ? t('{done}/{total}', { done: count.done, total: count.total }) : '',
        })
      }),
      rail.groups.length > 0 ? h('h3', { className: 'bt-board-rail-head' }, t('Groups you admin')) : null,
      rail.groups.map(row => h(RailButton, { key: row.id, row, selected: row.id === selectedRoom, onSelect }))),
    h('div', { className: 'bt-board-main' },
      error ? h('p', { className: 'bt-board-error', role: 'alert' }, error) : null,
      lanes ? h('p', { className: 'bt-board-hint' }, t('Assign, claim, and progress live on this board: one overall task, a subtask per part, an assignee, a column, and progress. @ only wakes someone.')) : null,
      scope?.kind === 'bot' && onCreate ? h('form', { className: 'bt-board-add', onSubmit: (event) => { event.preventDefault(); onCreate(draft) } },
        h('input', { 'aria-label': t('Task title'), placeholder: t('New task'), value: draft ?? '', onChange: (event) => onDraft?.(event.target.value) }),
        h('button', { type: 'submit', className: 'bt-soft bt-soft-sm' }, t('Add task'))) : null,
      h('div', { className: 'bt-board-columns' },
        ['not-started', 'in-progress', 'done'].map(column => h(BoardColumn, {
          key: column, column, tasks: columns[column], roster, lanes, dragging, onMove, onDrag,
        })))))
}

export function KanbanRow({ wide, useUi, actions }) {
  const open = useUi ? useUi(value => Boolean(value.board)) : false
  const label = t('Tasks')
  return h('button', {
    type: 'button', className: 'bt-row bt-board-row', 'aria-label': label, title: wide ? undefined : label,
    'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => actions.openBoard(),
  },
  h('span', { className: 'bt-board-mark' }, h(BoardIcon)),
  wide ? h('span', { className: 'bt-board-label' }, label) : null)
}

function scopeName(roster, scope) {
  if (scope?.kind === 'group') return roster.roomsById?.[scope.roomId]?.name || t('Group')
  if (scope?.kind === 'bot') return roster.byId?.[scope.botId]?.name || ''
  return ''
}

export function KanbanDialog({ roster, actions, leaving = false }) {
  // Per-Bot task board. The GitHub metrics panel is not part of this dialog (#1363).
  const rail = boardRail(roster)
  const [scope, setScope] = useState(() => (rail.bots[0] ? { kind: 'bot', botId: rail.bots[0].id } : rail.groups[0] ? { kind: 'group', roomId: rail.groups[0].id } : null))
  const [dragging, setDragging] = useState(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const { own, tasks, archive, replace } = useBoardTasks(actions, scope)
  const boardTasks = boardTasksFor(tasks, archive)
  const close = useCallback(() => actions.closeBoard(), [])
  useEscape(close)
  const counts = {}
  for (const task of [...own, ...archive]) {
    const id = task.ownerBotId
    const bucket = counts[id] ?? (counts[id] = { done: 0, total: 0 })
    if (task.status === 'cancelled' || task.status === 'failed') continue
    bucket.total += 1
    if (columnOf(task) === 'done') bucket.done += 1
  }
  const move = async (id, column) => {
    const task = tasks.find(item => item.id === id) ?? own.find(item => item.id === id)
    if (!task || !canMoveTask(roster, task) || columnOf(task) === column) return
    setError('')
    try {
      replace(await actions.taskUpdate({ id, column }))
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }
  const create = async (title) => {
    const text = String(title ?? '').trim()
    if (!text || scope?.kind !== 'bot') return
    setError('')
    try {
      replace(await actions.taskCreate({ botId: scope.botId, title: text, column: 'not-started' }))
      setDraft('')
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }
  const name = scopeName(roster, scope)
  return h('div', { className: 'bt-mem-layer bt-board-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onClick: close }),
    h('div', { className: 'bt-mem bt-board', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'bt-board-heading' },
      h('div', { className: 'bt-mem-head' },
        h('h2', { id: 'bt-board-heading' }, t('Board')),
        h('span', { className: 'bt-mem-status' }, name),
        h('span', { className: 'bt-mem-head-gap' }),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close board'), autoFocus: true, onClick: close }, h(CloseIcon))),
      h(BoardView, {
        roster, tasks: boardTasks, rail, scope, counts, dragging, error, draft,
        onDraft: setDraft, onSelect: setScope, onMove: move, onDrag: setDragging, onCreate: create,
      })))
}

export const KANBAN_CSS = `
.bt-board-row{min-height:40px;padding:6px 8px;gap:10px}
.bt-board-mark{flex:none;width:36px;height:28px;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-2)}
.bt-board-mark svg{width:18px;height:18px}
.bt-board-label{flex:1 1 auto;min-width:0;font-size:14px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-mem.bt-board{width:min(1080px,calc(100vw - 32px));height:min(760px,calc(100vh - 48px))}
.bt-board-body{flex:1 1 auto;min-height:0;display:flex;gap:0}
.bt-board-rail{flex:none;width:232px;overflow:auto;border-right:.5px solid var(--bt-line);padding:8px 8px 16px;display:flex;flex-direction:column;gap:2px}
.bt-board-rail-head{margin:10px 8px 4px;font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-3)}
.bt-board-rail-item{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 10px;border:0;border-radius:10px;background:transparent;color:var(--bt-ink);text-align:left;cursor:pointer}
.bt-board-rail-item:hover{background:var(--bt-hover)}
.bt-board-rail-item[data-selected]{background:var(--bt-active,var(--bt-hover))}
.bt-board-rail-name{flex:1 1 auto;min-width:0;font-size:13.5px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-board-rail-meta{flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:10px;padding:12px 14px 16px}
.bt-board-add{display:flex;gap:8px}
.bt-board-add input{flex:1 1 auto;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card,var(--bt-main));color:var(--bt-ink);font:inherit}
.bt-board-columns{flex:1 1 auto;min-height:0;display:flex;gap:10px}
.bt-board-column{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:8px;padding:8px;border-radius:14px;background:var(--bt-hover);overflow:auto}
.bt-board-column-head{display:flex;align-items:center;gap:6px;margin:0;padding:2px 4px;font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink-2)}
.bt-board-count{font-weight:500;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-drop{margin:0;padding:18px 8px;border:1px dashed var(--bt-line-2);border-radius:12px;text-align:center;font-size:13px;line-height:18px;color:var(--bt-ink-3)}
.bt-board-empty{margin:0;padding:8px 4px;font-size:13px;line-height:18px;color:var(--bt-ink-3)}
.bt-board-hint{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-board-error{margin:0;font-size:13px;line-height:18px;color:#c21d2e}
.bt-board-lane{display:flex;flex-direction:column;gap:6px}
.bt-board-lane-name{font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-3);padding:0 2px}
.bt-board-nest{display:flex;flex-direction:column;gap:6px}
.bt-board-subtask{margin-left:12px;padding-left:8px;border-left:2px solid var(--bt-line)}
.bt-board-kind{font-size:11px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-board-part{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-board-wait{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-board-card{display:flex;flex-direction:column;gap:6px;padding:10px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card,var(--bt-main));cursor:grab}
.bt-board-card-top{display:flex;align-items:center;gap:6px;min-width:0}
.bt-board-id{flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-priority{flex:none;height:18px;padding:0 6px;border-radius:999px;font-size:11px;line-height:18px;font-weight:600}
.bt-board-priority[data-priority=urgent]{background:rgba(224,33,53,.12);color:#c21d2e}
.bt-board-priority[data-priority=high]{background:rgba(217,119,6,.14);color:#b45309}
.bt-board-priority[data-priority=normal]{background:color-mix(in srgb,var(--bt-accent) 14%,transparent);color:color-mix(in srgb,var(--bt-accent) 80%,var(--bt-ink))}
.bt-board-priority[data-priority=low]{background:color-mix(in srgb,var(--bt-green) 16%,transparent);color:color-mix(in srgb,var(--bt-green) 70%,var(--bt-ink))}
.bt-board-status{margin-left:auto;font-size:11.5px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap}
.bt-board-title{font-size:13.5px;line-height:19px;color:var(--bt-ink)}
.bt-board-note{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-board-foot{display:flex;align-items:center;gap:8px}
.bt-board-who{flex:none;max-width:40%;font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-board-progress{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px}
.bt-board-progress-bar{flex:1 1 auto;height:4px;border-radius:999px;background:var(--bt-line);overflow:hidden}
.bt-board-progress-bar>span{display:block;height:100%;background:var(--bt-accent)}
.bt-board-percent{flex:none;font-size:11.5px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-card .bt-soft{align-self:flex-start}
@media (max-width:800px){
  .bt-mem.bt-board{width:min(100vw,calc(100vw - 16px));height:100%}
  .bt-board-body{flex-direction:column}
  .bt-board-rail{width:auto;max-height:180px;border-right:0;border-bottom:.5px solid var(--bt-line)}
  .bt-board-columns{overflow:auto}
  .bt-board-column{min-width:220px}
}
@media (max-width:640px){
  .bt-mem.bt-board{width:100vw;border-radius:0;border:0}
  .bt-board-columns{flex-direction:column}
  .bt-board-column{min-width:0}
}
`
