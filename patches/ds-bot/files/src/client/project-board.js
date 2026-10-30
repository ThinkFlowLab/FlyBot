// The Project board view (#1710): one Project, the rows its read model already aggregated
// (host `project-board`), grouped by where the work lives. The rows are the tasks themselves —
// `row.id` is the underlying task id — so opening one opens that task and nothing is copied here.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

export const PROJECT_BOARD_CSS = `
/* #1750: the board was a short dialog in the page flow — no stylesheet defines 'bt-overlay', so the
   bot tree and workflows stayed legible under its rows. It is a modal now, on the same tier as the
   Board and Settings layers, with kanban's own 'bt-scrim' sibling and 'bt-mem' surface. */
.bt-project-overlay{position:fixed;inset:0;z-index:121;isolation:isolate;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.bt-mem.bt-project-dialog{width:min(1080px,calc(100vw - 32px));height:min(760px,calc(100vh - 48px))}
.bt-project-body{flex:1 1 auto;min-height:0;overflow:auto}
.bt-project-board{padding:16px 18px}
.bt-project-group{margin:0 0 14px}
.bt-project-group h4{margin:0 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.bt-project-row{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;background:var(--bt-card,rgba(127,127,127,.08));margin:0 0 6px;cursor:default}
.bt-project-row[data-column="done"]{opacity:.7}
.bt-project-title-wrap{display:flex;flex-direction:column;gap:2px;min-width:0}
.bt-project-audit{font-size:11px;line-height:1.45;white-space:pre-wrap;opacity:.65;font-family:var(--bt-mono,ui-monospace,monospace)}
.bt-project-row .bt-project-ref{margin-left:auto;font-size:11px;opacity:.6}
.bt-project-empty{padding:22px 4px;opacity:.7}
/* #1767: the record beside the cards. The same surface as a row, one step quieter, and no new
   component language: a heading, a list, and a monospace hash the reader can compare. */
.bt-project-record{margin:18px 0 0;border-top:1px solid var(--bt-line,rgba(127,127,127,.22));padding:12px 0 0}
.bt-project-record h4{margin:0 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.bt-project-record h5{margin:10px 0 4px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.55}
.bt-project-decision,.bt-project-meeting{display:flex;gap:10px;align-items:baseline;padding:6px 10px;border-radius:8px;background:var(--bt-card,rgba(127,127,127,.08));margin:0 0 6px}
.bt-project-decision .bt-project-date,.bt-project-meeting .bt-project-date{font-size:11px;opacity:.6;min-width:76px;font-variant-numeric:tabular-nums}
.bt-project-decision .bt-project-hash{margin-left:auto;font-size:11px;opacity:.55;font-family:var(--bt-mono,ui-monospace,monospace)}
.bt-project-decision .bt-project-title,.bt-project-meeting .bt-project-title{min-width:0}
.bt-project-path{font-size:11px;opacity:.6;font-family:var(--bt-mono,ui-monospace,monospace)}
.bt-project-missing{font-size:11px;opacity:.6}
.bt-project-status{font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.6;margin-left:auto}
.bt-project-actions{display:flex;gap:8px;margin:0 0 14px}
.bt-project-counts{display:flex;gap:14px;align-items:center;margin:0 0 12px;font-size:12px;letter-spacing:.03em;opacity:.8}
.bt-project-counts b{font-weight:600}
.bt-project-group[data-queue="waiting"] .bt-project-row{cursor:default}
.bt-project-role{font-size:11px;opacity:.65;font-family:var(--bt-mono,ui-monospace,monospace)}
.bt-project-wait{font-size:11px;opacity:.65;margin-left:auto}
.bt-project-state{font-size:11px;margin-left:auto}
.bt-project-row[data-state="stalled"]{border-left:2px solid #d9822b}
.bt-project-reason{font-size:11px;opacity:.7}

/* #1749: management panels. Same surface as the board, one form row per control, and a status
   line that quotes the host's own answer — a refused save reads where the reader pressed it. */
.bt-project-panel{padding:16px 18px;display:flex;flex-direction:column;gap:12px}
.bt-project-panel h3{margin:0}
.bt-project-field{display:flex;flex-direction:column;gap:4px}
.bt-project-field label{font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.bt-project-field input,.bt-project-field select,.bt-project-field textarea{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--bt-line,rgba(127,127,127,.32));background:var(--bt-card,rgba(127,127,127,.08));color:inherit}
.bt-project-field textarea{min-height:88px;resize:vertical}
.bt-project-row-actions{display:flex;gap:8px;align-items:center}
.bt-project-members{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.bt-project-member{display:flex;gap:10px;align-items:baseline;padding:8px 10px;border-radius:8px;background:var(--bt-card,rgba(127,127,127,.08))}
.bt-project-member .bt-project-member-kind{margin-left:auto;font-size:11px;opacity:.6}
.bt-project-status-line{font-size:12px;opacity:.75;min-height:16px}
.bt-project-note{font-size:12px;opacity:.65;margin:0}
`

// Sources in the order the board reads them; a source with no rows is left out so three empty
// groups never crowd out the one that has work.
export const PROJECT_SOURCES = ['bot', 'group', 'workflow']
export const SOURCE_LABELS = { bot: 'Bots', group: 'Groups', workflow: 'Workflows' }

const text = value => (typeof value === 'string' ? value.trim() : '')

// The board a row opens, read from the host's own `source` rather than re-deciding membership:
// a group row names its room, a bot row its owner, and a workflow row is one the run carried in,
// so it has no board of its own to open.
const boardOfRow = (row, task) => {
  if (task === undefined) return null
  if (row.source === 'group') {
    const id = text(task.origin?.roomId)
    return id === '' ? null : { kind: 'group', id }
  }
  if (row.source === 'bot') {
    const id = text(task.ownerBotId)
    return id === '' ? null : { kind: 'bot', id }
  }
  return null
}

// One decision file as the board lists it: the name, the day in the name, the title line and the
// hash the host computed. Nothing here reads a body — the view receives what the read answered.
const decisionOf = (file) => {
  if (file === null || typeof file !== 'object') return null
  const path = text(file.path)
  if (path === '') return null
  return {
    key: `decision:${path}`,
    path,
    name: text(file.name) || path.slice(path.lastIndexOf('/') + 1),
    date: text(file.date),
    title: text(file.title),
    sha256: text(file.sha256),
    shortHash: text(file.sha256).slice(0, 12),
  }
}

const meetingOf = (meeting, status) => {
  if (meeting === null || typeof meeting !== 'object') return null
  const id = text(meeting.id)
  if (id === '') return null
  return {
    key: `meeting:${id}`,
    id,
    date: text(meeting.date),
    question: text(meeting.question) || text(meeting.title),
    owner: text(meeting.owner) || null,
    status,
    path: text(meeting.path),
    blockingQuestion: text(meeting.blockingQuestion) || null,
  }
}

const listOf = (value) => (Array.isArray(value) ? value.map(item => decisionOf(item)).filter(item => item !== null) : [])

// The record beside the cards (#1767). A section with nothing in it still says which folder was
// read and why it holds no file, because an empty box reads as "there is nothing to decide", and
// a Project naming no folder is a different answer from a folder with no decision in it.
export function projectBoardRecord({ decisions, meetings } = {}) {
  const dir = text(decisions?.dir) || null
  const files = listOf(decisions?.files)
  const decided = Array.isArray(meetings?.decided) ? meetings.decided.map(item => meetingOf(item, 'decided')).filter(item => item !== null) : []
  const pending = Array.isArray(meetings?.pending) ? meetings.pending.map(item => meetingOf(item, item?.status ?? 'deliberating')).filter(item => item !== null) : []
  return {
    decisions: {
      dir,
      files,
      count: files.length,
      empty: files.length === 0,
      emptyText: text(decisions?.reason) || (dir === null ? 'This Project names no working folder.' : `No decision file in ${dir}/decisions.`),
    },
    meetings: {
      decided,
      pending,
      count: decided.length + pending.length,
      empty: decided.length === 0 && pending.length === 0,
      emptyText: text(meetings?.reason) || 'No meeting of this Project is recorded.',
    },
  }
}

// Pure: no fetch, no React, no store. `rows` is the host's read model, `canManage` comes from
// `project-read` and only decides what the caller may *ask* for — the host refuses regardless.
// `tasks` is the one task read joined by id: the row carries an id and who holds it, not its text.
// `decisions` and `meetings` are the host's read of the Project's record (#1767), passed through.
// `queues` is the other half of that same read (#1768): the waiting, in-flight and blocked cards
// and their counts, as the host answered them.
export function projectBoardView({ project, rows, canManage, tasks, decisions, meetings, queues } = {}) {
  const list = Array.isArray(rows) ? rows.filter(row => row !== null && typeof row === 'object' && text(row.id) !== '') : []
  const byId = new Map((Array.isArray(tasks) ? tasks : [])
    .filter(task => task !== null && typeof task === 'object' && text(task.id) !== '')
    .map(task => [text(task.id), task]))
  const groups = PROJECT_SOURCES
    .map(source => ({
      source,
      label: SOURCE_LABELS[source],
      rows: list
        .filter(row => row.source === source)
        .map((row) => {
          const task = byId.get(text(row.id))
          return {
            id: text(row.id),
            key: `task:${text(row.id)}`,
            column: text(row.column) || 'not-started',
            assignee: text(row.assignee) || null,
            runId: text(row.runId) || null,
            nodeId: text(row.nodeId) || null,
            title: text(task?.title) || text(task?.note) || null,
            priority: text(task?.priority) || null,
            audit: text(row.audit) || null,
            board: boardOfRow(row, task),
          }
        }),
    }))
    .filter(group => group.rows.length > 0)
  // The three groups beside the columns (#1768). They are the host's own read of the queue, the
  // leases and the blocked cards; nothing is recomputed here, and a count the host could not read
  // stays `null` so the header says "unknown" instead of a zero nobody measured.
  const countOf = (value) => (value === undefined || value === null ? null : value)
  const queueItems = (items, annotate) => (Array.isArray(items) ? items : [])
    .filter(item => item !== null && typeof item === 'object' && text(item.id) !== '')
    .map((item) => {
      const id = text(item.id)
      const source = text(list.find(row => text(row.id) === id)?.source)
      const task = byId.get(id)
      return { id, key: `task:${id}`, title: text(task?.title) || text(task?.note) || null, priority: text(task?.priority) || null, board: boardOfRow({ source }, task), ...annotate(item) }
    })
  const waiting = queueItems(queues?.waiting, item => ({ role: text(item.role) || null, waitedMs: Number.isFinite(item.waitedMs) ? item.waitedMs : null }))
  const inflight = queueItems(queues?.inflight, item => ({ holder: text(item.holder) || null, state: item.stalled === true ? 'stalled' : 'running' }))
  const blocked = queueItems(queues?.blocked, item => ({ reason: text(item.reason) || null }))
  const queueGroups = [
    { group: 'waiting', label: 'Waiting', items: waiting },
    { group: 'inflight', label: 'In flight', items: inflight },
    { group: 'blocked', label: 'Blocked', items: blocked },
  ].filter(entry => entry.items.length > 0)
  const rawCounts = queues?.counts ?? null
  return {
    projectId: text(project?.id) || null,
    title: text(project?.name) || 'Project',
    canManage: canManage === true,
    groups,
    queues: queueGroups,
    counts: rawCounts === null ? null : { waiting: countOf(rawCounts.waiting), inflight: countOf(rawCounts.inflight), blocked: countOf(rawCounts.blocked), done: countOf(rawCounts.done) },
    count: list.length,
    empty: list.length === 0 && queueGroups.length === 0,
    emptyText: 'No cards yet.',
    record: projectBoardRecord({ decisions, meetings }),
  }
}

function ProjectBoardRows({ view, onOpen }) {
  // An empty Project is a state, not an error: the view says so and renders no groups.
  if (view.empty) return h('div', { className: 'bt-project-empty' }, t(view.emptyText))
  return view.groups.map(group => h('section', { key: group.source, className: 'bt-project-group', 'data-source': group.source },
    h('h4', null, t(group.label)),
    group.rows.map((row) => {
      const open = row.board === null ? undefined : () => onOpen?.(row.board)
      return h('div', {
        key: row.key,
        className: 'bt-project-row',
        'data-task-id': row.id,
        'data-column': row.column,
        'data-priority': row.priority ?? undefined,
        role: open === undefined ? undefined : 'button',
        tabIndex: open === undefined ? undefined : 0,
        onClick: open,
        onKeyDown: open === undefined ? undefined : event => { if (event.key === 'Enter' || event.key === ' ') open() },
      },
      h('span', { className: 'bt-project-column' }, t(row.column)),
      h('span', { className: 'bt-project-title-wrap' },
        h('span', { className: 'bt-project-title' }, row.title ?? (row.assignee ? `@${row.assignee}` : '—')),
        // The audit text the row already carries (#1730): shown inside the card detail, never a
        // second read. A row without one renders exactly as before.
        row.audit === null ? null : h('span', { className: 'bt-project-audit' }, row.audit)),
      row.priority === null ? null : h('span', { className: 'bt-project-priority' }, row.priority),
      row.runId === null ? null : h('span', { className: 'bt-project-ref' }, row.nodeId === null ? row.runId : `${row.runId} · ${row.nodeId}`))
    })))
}

// How long a card has waited, in the unit a reader wants: minutes under an hour, hours under a
// day. A card with no `createdAt` says nothing rather than "0m".
export function waitedLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// The three groups beside the columns (#1768): a role queue with its wait, the card a claim holds
// with its holder and lease state, and a blocked card with the reason it already stores.
function ProjectQueueGroups({ view, onOpen }) {
  return view.queues.map(entry => h('section', { key: `queue:${entry.group}`, className: 'bt-project-group', 'data-queue': entry.group },
    h('h4', null, t(entry.label)),
    entry.items.map(row => {
      const open = row.board === null ? undefined : () => onOpen?.(row.board)
      // The annotation is the group's own: a role and how long it waited, the holder and whether
      // the lease is live, or the reason the card is blocked. Never recomputed from the card here.
      const note = entry.group === 'waiting'
        ? h('span', { className: 'bt-project-wait' }, [row.role === null ? null : h('span', { key: 'role', className: 'bt-project-role' }, row.role), waitedLabel(row.waitedMs) === null ? null : ` · ${waitedLabel(row.waitedMs)}`])
        : entry.group === 'inflight'
          ? h('span', { className: 'bt-project-state' }, row.holder === null ? t(row.state) : `${row.holder} · ${t(row.state)}`)
          : h('span', { className: 'bt-project-reason' }, row.reason)
      return h('div', {
        key: row.key,
        className: 'bt-project-row',
        'data-task-id': row.id,
        'data-state': row.state ?? undefined,
        role: open === undefined ? undefined : 'button',
        tabIndex: open === undefined ? undefined : 0,
        onClick: open,
        onKeyDown: open === undefined ? undefined : event => { if (event.key === 'Enter' || event.key === ' ') open() },
      },
      h('span', { className: 'bt-project-title-wrap' },
        h('span', { className: 'bt-project-title' }, row.title ?? `#${row.id}`)),
      note)
    })))
}

const countText = value => (value === null ? t('unknown') : String(value))

// The record beside the cards (#1767): decisions first, then the meetings that reached one, and
// a meeting still open or blocked listed apart — never as a decision. Every row is text the host
// already answered; the only thing this reads again is the hash it was handed.
function ProjectBoardRecord({ record }) {
  const { decisions, meetings } = record
  const decisionRows = decisions.files.map(file => h('div', { key: file.key, className: 'bt-project-decision', 'data-path': file.path, 'data-sha256': file.sha256 },
    h('span', { className: 'bt-project-date' }, file.date),
    h('span', { className: 'bt-project-title' }, file.title === '' ? file.name : file.title),
    h('span', { className: 'bt-project-hash', title: file.sha256 }, file.shortHash)))
  const decidedRows = meetings.decided.map(meeting => h('div', { key: meeting.key, className: 'bt-project-meeting', 'data-status': 'decided' },
    h('span', { className: 'bt-project-date' }, meeting.date),
    h('span', { className: 'bt-project-title' }, meeting.question),
    meeting.owner === null ? null : h('span', { className: 'bt-project-owner' }, `@${meeting.owner}`),
    // A decided meeting whose file is gone still reads as decided; the missing path says so
    // instead of the row disappearing with the file.
    meeting.path === ''
      ? h('span', { className: 'bt-project-missing' }, 'decision file gone')
      : h('span', { className: 'bt-project-path' }, meeting.path)))
  const pendingRows = meetings.pending.map(meeting => h('div', { key: meeting.key, className: 'bt-project-meeting', 'data-status': meeting.status },
    h('span', { className: 'bt-project-date' }, meeting.date),
    h('span', { className: 'bt-project-title' }, meeting.blockingQuestion === null ? meeting.question : meeting.blockingQuestion),
    h('span', { className: 'bt-project-status' }, meeting.status)))
  return h('section', { className: 'bt-project-record', 'data-decisions': String(decisions.count), 'data-meetings': String(meetings.count) },
    h('h4', null, t('Decisions')),
    decisions.empty ? h('div', { className: 'bt-project-empty bt-project-record-empty' }, t(decisions.emptyText)) : decisionRows,
    h('h4', null, t('Meetings')),
    meetings.empty ? h('div', { className: 'bt-project-empty bt-project-record-empty' }, t(meetings.emptyText)) : decidedRows,
    meetings.pending.length === 0 ? null : h('h5', null, t('Not decided')),
    meetings.pending.length === 0 ? null : pendingRows)
}

export function ProjectBoardPane({ project, rows, canManage, tasks, decisions, meetings, queues, onOpen, onSettings, onMembers }) {
  const view = projectBoardView({ project, rows, canManage, tasks, decisions, meetings, queues })
  return h('div', { className: 'bt-project-board', 'data-can-manage': view.canManage ? 'true' : 'false' },
    h('h3', null, view.title),
    // Header counts (#1768): four numbers read from the host, an unreadable one shown as unknown.
    view.counts === null ? null : h('div', { className: 'bt-project-counts', 'data-counts': 'waiting,inflight,blocked,done' },
      h('span', null, [t('Waiting'), ': ', h('b', { key: 'w' }, countText(view.counts.waiting))]),
      h('span', null, [t('In flight'), ': ', h('b', { key: 'f' }, countText(view.counts.inflight))]),
      h('span', null, [t('Blocked'), ': ', h('b', { key: 'b' }, countText(view.counts.blocked))]),
      h('span', null, [t('Done'), ': ', h('b', { key: 'd' }, countText(view.counts.done))])),
    // #1749: both buttons open a panel and neither is hidden from a non-owner. The host refuses
    // every write a non-owner attempts, so the refusal is an answer the reader sees, not a
    // control that silently disappeared.
    h('div', { className: 'bt-project-actions' },
      h('button', { type: 'button', 'data-action': 'project-settings', onClick: () => onSettings?.() }, t('Project settings')),
      h('button', { type: 'button', 'data-action': 'project-members', onClick: () => onMembers?.() }, t('Members'))),
    h(ProjectBoardRows, { view, onOpen }),
    h(ProjectQueueGroups, { view, onOpen }),
    h(ProjectBoardRecord, { record: view.record }))
}

// #1749: the settings panel. It writes through the three paths the host already had — bind or
// unbind a member (`project-bind`), the assistant's per-owner controls
// (`project-assistant-owner`) and the assistant's memory (`project-memory-write`) — and adds no
// fourth. Fields the host has no write path for are not drawn, so every control here can save.
export function ProjectSettingsPanel({ project, call: request, onClose, onSaved } = {}) {
  const save = request ?? call
  const [kind, setKind] = useState('bot')
  const [memberId, setMemberId] = useState('')
  const [note, setNote] = useState('')
  const [assistantOff, setAssistantOff] = useState(project?.assistant?.off === true)
  const [status, setStatus] = useState('')
  const id = text(project?.id)
  const run = async (endpoint, payload, done) => {
    try {
      const result = await save(endpoint, payload)
      setStatus(done)
      onSaved?.(result)
      return result
    } catch (error) {
      // The host's refusal is the answer the reader acted for; quote it instead of guessing.
      setStatus(error?.message ?? String(error))
      return null
    }
  }
  return h('div', { className: 'bt-project-panel', 'data-panel': 'project-settings' },
    h('h3', null, t('Project settings')),
    h('div', { className: 'bt-project-field' },
      h('label', { htmlFor: 'bt-project-member-id' }, t('Bind a member to this Project')),
      h('div', { className: 'bt-project-row-actions' },
        h('select', { 'aria-label': t('Member kind'), value: kind, onChange: event => setKind(event.target.value) },
          h('option', { value: 'bot' }, t('Bot')),
          h('option', { value: 'group' }, t('Group'))),
        h('input', { id: 'bt-project-member-id', value: memberId, placeholder: t('Member id'), onChange: event => setMemberId(event.target.value) }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-action': 'project-bind', onClick: () => run('project-bind', { kind, id: text(memberId), projectId: id }, t('Member bound.')) }, t('Bind')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-action': 'project-unbind', onClick: () => run('project-bind', { kind, id: text(memberId), projectId: null }, t('Member unbound.')) }, t('Unbind')))),
    h('div', { className: 'bt-project-field' },
      h('label', null, t('Project Assistant')),
      h('div', { className: 'bt-project-row-actions' },
        h('label', null, h('input', { type: 'checkbox', 'data-action': 'assistant-off', checked: assistantOff, onChange: event => setAssistantOff(event.target.checked) }), ' ', t('Pause the daily digest')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-action': 'project-assistant-save', onClick: () => run('project-assistant-owner', { id, settings: { off: assistantOff === true } }, t('Assistant settings saved.')) }, t('Save')))),
    h('div', { className: 'bt-project-field' },
      h('label', { htmlFor: 'bt-project-note' }, t('Add to the assistant memory')),
      h('textarea', { id: 'bt-project-note', value: note, onChange: event => setNote(event.target.value) }),
      h('div', { className: 'bt-project-row-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-action': 'project-memory-save', onClick: () => run('project-memory-write', { id, kind: 'note', text: text(note) }, t('Memory saved.')) }, t('Save memory')))),
    h('div', { className: 'bt-project-status-line', role: 'status' }, status),
    h('div', { className: 'bt-project-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => onClose?.() }, t('Back to board'))))
}

// #1749: who is on this Project, read from the record and the board — never a second member read.
// The host keeps no membership set beyond a Project's owners and the members its board rows
// already name, so this panel is read-only and says so instead of offering a control it cannot save.
export function ProjectMembersPanel({ project, rows, onClose } = {}) {
  const owners = []
  const add = (id) => { const clean = text(id); if (clean !== '' && !owners.includes(clean)) owners.push(clean) }
  add(project?.ownerUserId)
  for (const id of Array.isArray(project?.ownerUserIds) ? project.ownerUserIds : []) add(id)
  const boardMembers = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = text(row?.assignee)
    if (name !== '' && !boardMembers.includes(name)) boardMembers.push(name)
  }
  return h('div', { className: 'bt-project-panel', 'data-panel': 'project-members' },
    h('h3', null, t('Members')),
    h('ul', { className: 'bt-project-members' },
      owners.map(owner => h('li', { key: `owner:${owner}`, className: 'bt-project-member', 'data-member-role': 'owner', 'data-member-id': owner },
        h('span', null, `@${owner}`),
        h('span', { className: 'bt-project-member-kind' }, t('Owner')))),
      boardMembers.map(name => h('li', { key: `board:${name}`, className: 'bt-project-member', 'data-member-role': 'board', 'data-member-id': name },
        h('span', null, `@${name}`),
        h('span', { className: 'bt-project-member-kind' }, t('On the board'))))),
    owners.length === 0 && boardMembers.length === 0 ? h('div', { className: 'bt-project-empty' }, t('No member is named yet.')) : null,
    h('p', { className: 'bt-project-note' }, t('Member management is not part of this slice; owners and the members their cards name are listed here.')),
    h('div', { className: 'bt-project-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => onClose?.() }, t('Back to board'))))
}

// The pane entry point (#1710): `#project=<id>` opens one Project's board, `#project` the first.
// Reading is a POST through the same host channel every other view uses.
export function ProjectBoardOverlay({ actions, call: request } = {}) {
  // `call` is a seam for the tests only; in the app it is the channel every other view uses.
  const read = request ?? call
  const [state, setState] = useState(null)
  const [panel, setPanel] = useState(null)
  // The hash is the whole entry point, so it has to be read again every time it changes: an
  // entry that writes `#project=<id>` while this mounts opened nothing when the read was one-shot.
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash))
  const close = useCallback(() => {
    if (typeof window !== 'undefined') window.location.hash = ''
    setPanel(null)
    setState(null)
  }, [])
  // Escape leaves the panel first, then the board — the same two steps the kanban dialog offers.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      if (panel !== null) setPanel(null)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, close])
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const sync = () => setHash(window.location.hash)
    window.addEventListener('hashchange', sync)
    sync()
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!hash.startsWith('#project')) { setState(null); return undefined }
    const wanted = hash.slice('#project'.length).replace(/^=/, '')
    let live = true
    void (async () => {
      try {
        const listing = await read('projects')
        const projects = listing?.projects ?? []
        const project = wanted === '' ? projects[0] : projects.find(item => item.id === wanted)
        if (project === undefined) { if (live) setState({ project: null, rows: [], canManage: false, tasks: [] }); return }
        // Four reads once, none polling: the Project, its record, its rows, and the task texts the
        // rows are joined against. Nothing here asks a Bot by Bot.
        const [record, board, taskList] = await Promise.all([
          read('project-read', { id: project.id }),
          read('project-board', { id: project.id }),
          read('tasks', {}),
        ])
        const tasks = Array.isArray(taskList) ? taskList : (taskList?.tasks ?? [])
        // The groups are the same read as the rows, so the header cannot disagree with the cards.
        const queues = { waiting: board?.waiting, inflight: board?.inflight, blocked: board?.blocked, counts: board?.counts ?? null }
        if (live) setState({ project: record?.project ?? project, rows: board?.tasks ?? [], canManage: record?.canManage === true, tasks, decisions: board?.decisions, meetings: board?.meetings, queues })
      } catch { if (live) setState({ project: null, rows: [], canManage: false, tasks: [] }) }
    })()
    return () => { live = false }
  }, [hash])
  if (state === null) return null
  // #1750: the scrim is a sibling in front of the dialog, exactly as the Board draws it, so a click
  // beside the board dismisses it and the shell behind reads as a backdrop rather than more rows.
  return h('div', { className: 'bt-project-overlay' },
    h('div', { className: 'bt-scrim', onClick: close }),
    h('div', { className: 'bt-mem bt-project-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('Project board') },
      h('div', { className: 'bt-mem-head' },
        h('h2', {}, t('Project board')),
        h('span', { className: 'bt-mem-head-gap' }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-project-close', autoFocus: true, onClick: close }, t('Close'))),
      h('div', { className: 'bt-project-body' },
        state.project === null
          ? h('div', { className: 'bt-project-empty' },
            h('p', null, t('No Project yet — create one.')),
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { close(); actions?.openSettings?.('projects') } }, t('Open Projects in Settings')))
          // A row opens the board its task lives on, carried by `#task=<id>`: the Tasks board reads
          // that hash and lands on the Bot or group the task belongs to.
          : panel === 'settings' ? h(ProjectSettingsPanel, { project: state.project, call: read, onClose: () => setPanel(null) })
          : panel === 'members' ? h(ProjectMembersPanel, { project: state.project, rows: state.rows, onClose: () => setPanel(null) })
          : h(ProjectBoardPane, {
            project: state.project, rows: state.rows, canManage: state.canManage, tasks: state.tasks,
            decisions: state.decisions, meetings: state.meetings, queues: state.queues,
            onSettings: () => setPanel('settings'),
            onMembers: () => setPanel('members'),
            // The task's own board is where a row leads: the Tasks dialog reads `#task=` on mount and
            // lands on that Bot or group. Nothing here re-decides which board that is.
            onOpen: (board) => {
              if (typeof window !== 'undefined') window.location.hash = `#task=${board.kind}:${board.id}`
              actions?.openBoard?.()
              setState(null)
            },
          }))))
}
