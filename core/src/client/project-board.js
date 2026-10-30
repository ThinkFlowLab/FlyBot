// The Project board view (#1710): one Project, the rows its read model already aggregated
// (host `project-board`), grouped by where the work lives. The rows are the tasks themselves —
// `row.id` is the underlying task id — so opening one opens that task and nothing is copied here.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { call } from './api.js'
import { dateLocale, hostText, t } from './i18n.js'

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
/* #1831: the card's level, the people it is addressed to, and the identity a row or a comment
   carries. A severe card is the only one painted louder, because it is the only one that waits. */
.bt-project-level{font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:1px 6px;border-radius:999px;border:1px solid var(--bt-line,rgba(127,127,127,.32));opacity:.75}
.bt-project-level[data-level="severe"]{opacity:1;border-color:#c2410c;color:#c2410c}
.bt-project-recipients{font-size:11px;opacity:.65}
.bt-project-paused{font-size:11px;opacity:.75;color:#c2410c}
.bt-project-holder{font-size:11px;opacity:.7}
.bt-project-speaks-for{font-size:11px;opacity:.7;font-style:italic}
.bt-project-actions{display:flex;gap:8px;margin:0 0 14px}
.bt-project-metrics{margin:0 0 14px}
.bt-project-metric-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
.bt-project-metric{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid rgba(127,127,127,.24);border-radius:8px}
.bt-project-metric-value{font-size:18px;font-weight:600}
.bt-project-metric-label{font-size:12px;font-weight:600}
.bt-project-metric-caption{font-size:10px;opacity:.6;line-height:1.3}
.bt-project-metrics-note{margin:0 0 6px;font-size:11px;opacity:.7}
.bt-project-running{margin:0 0 14px}
.bt-project-running-head,.bt-project-running-row{display:grid;grid-template-columns:2fr 1fr 1fr .8fr .8fr 1.2fr;gap:8px;font-size:12px;padding:3px 0}
.bt-project-running-head{opacity:.6;font-size:10px;letter-spacing:.03em}
.bt-project-running-row[role="button"]{cursor:pointer}
.bt-project-running-row[data-overdue="true"]{color:#c2410c}
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
    // #1831: the level and recipients the host answered, and the refusal to advance a severe card.
    // Nothing is inferred here: a record written before the slice carries an ordinary card and no
    // recipients, exactly as the host reads it.
    level: text(meeting.level) || 'ordinary',
    recipients: Array.isArray(meeting.recipients) ? meeting.recipients.map(item => text(item)).filter(name => name !== '') : [],
    advance: meeting.advance !== null && typeof meeting.advance === 'object'
      ? { allowed: meeting.advance.allowed === true, reason: text(meeting.advance.reason) || null }
      : { allowed: true, reason: null },
    // #1861: the host's participants with who each position speaks for, so the row can say a
    // Project Chief or an agent held it for someone rather than for themselves.
    participants: Array.isArray(meeting.participants)
      ? meeting.participants
        .map(participant => ({ name: text(participant?.name), speaksFor: text(participant?.speaksFor) || null }))
        .filter(participant => participant.name !== '')
      : [],
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
export function projectBoardView({ project, rows, canManage, tasks, decisions, meetings, queues, metrics } = {}) {
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
            // #1831: who is doing the card, and who is speaking for whom. Both are host truth;
            // a card carrying neither renders exactly as before.
            holder: text(row.holder) || null,
            speaksFor: text(row.speaksFor) || null,
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
    metrics: metricsView(metrics, { tasks }),
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
      // "Who is doing" is the claim, never the assignee label; a card the Assistant speaks for
      // says so, so the three identities (Bot, Assistant, user) never read as one.
      row.holder === null ? null : h('span', { className: 'bt-project-holder', 'data-holder': row.holder }, `@${row.holder}`),
      row.speaksFor === null ? null : h('span', { className: 'bt-project-speaks-for', 'data-speaks-for': row.speaksFor }, t('for {user}', { user: row.speaksFor })),
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

// The board's seven numbers (#1829). Each card carries its caption: a reader must be able to check
// what a number counts without opening the host. The order here is the order the issue fixed.
export const METRIC_CARDS = [
  { key: 'prsOpenedToday', label: 'PRs opened today', caption: 'Natural day in your time zone, by created_at.' },
  { key: 'prsMergedToday', label: 'PRs merged today', caption: 'Natural day in your time zone, by merged_at.' },
  { key: 'issuesOpenedToday', label: 'Issues opened today', caption: 'Natural day in your time zone, by created_at.' },
  { key: 'issuesClosedToday', label: 'Issues closed today', caption: 'Natural day in your time zone, by closed_at.' },
  { key: 'prMergeMedianMs', label: 'PR merge time', caption: 'Median of the last 7 days, opened to merged.' },
  { key: 'issueCloseMedianMs', label: 'Issue close time', caption: 'Median of the last 7 days, opened to closed.' },
  { key: 'taskDoneMedianMs', label: 'Task completion', caption: 'Median of the last 7 days, created to done.' },
]
// A number the host could not read is a dash, never a zero: zero claims "none today" and the
// host said "cannot read".
export const METRIC_DASH = '\u2014'
const DURATION_KEYS = new Set(['prMergeMedianMs', 'issueCloseMedianMs', 'taskDoneMedianMs'])
export const RUNNING_OVERDUE_MS = 2 * 60 * 60 * 1000

const metricText = (key, value) => {
  if (!Number.isFinite(value)) return METRIC_DASH
  if (DURATION_KEYS.has(key)) return waitedLabel(value) ?? METRIC_DASH
  return String(value)
}

// Pure: metrics is the host's own read. An unavailable read is a state with a reason, not an empty
// board — the cards still draw, each value reading the dash.
export function metricsView(metrics, { tasks } = {}) {
  const source = metrics !== null && typeof metrics === 'object' ? metrics : null
  const values = source?.metrics !== null && typeof source?.metrics === 'object' ? source.metrics : {}
  const byId = new Map((Array.isArray(tasks) ? tasks : [])
    .filter(task => task !== null && typeof task === 'object' && text(task.id) !== '')
    .map(task => [text(task.id), task]))
  const running = (Array.isArray(source?.running) ? source.running : [])
    .filter(row => row !== null && typeof row === 'object' && text(row.id) !== '')
    .map((row) => {
      const id = text(row.id)
      const task = byId.get(id)
      return {
        id,
        key: 'task:' + id,
        title: text(row.title) || text(task?.title) || text(task?.note) || id,
        status: text(row.status),
        who: text(row.who) || null,
        sinceMs: Number.isFinite(row.sinceMs) ? row.sinceMs : null,
        source: text(row.source) || null,
        lastActivityAt: Number.isFinite(row.lastActivityAt) ? row.lastActivityAt : null,
        overdue: Number.isFinite(row.sinceMs) && row.sinceMs > RUNNING_OVERDUE_MS,
        board: boardOfRow({ source: text(row.source) }, task),
      }
    })
  return {
    available: source?.ok === true,
    reason: text(source?.reason) || null,
    cards: METRIC_CARDS.map(card => ({ ...card, value: metricText(card.key, values[card.key]) })),
    running,
    empty: source === null,
    emptyText: 'No metrics read yet.',
  }
}

function ProjectMetrics({ view }) {
  return h('section', { className: 'bt-project-metrics', 'data-available': view.available ? 'true' : 'false' },
    view.available || view.reason === null ? null : h('p', { className: 'bt-project-metrics-note' }, t('Metrics unavailable') + ': ' + view.reason),
    h('div', { className: 'bt-project-metric-cards' },
      view.cards.map(card => h('div', { key: card.key, className: 'bt-project-metric', 'data-metric': card.key },
        h('span', { className: 'bt-project-metric-value' }, card.value),
        h('span', { className: 'bt-project-metric-label' }, t(card.label)),
        h('span', { className: 'bt-project-metric-caption' }, t(card.caption))))))
}

// The running table (#1829): a claimed card is a row. Every row carries who holds it, how long the
// claim has run and where the work lives; a row past the overdue mark says so, and a row whose
// card still exists opens through the same onOpen the board rows use.
function ProjectRunningTable({ view, onOpen }) {
  if (view.running.length === 0) return h('section', { className: 'bt-project-running', 'data-running': '0' }, h('h4', null, t('Running tasks')), h('div', { className: 'bt-project-empty' }, t('Nothing is running.')))
  return h('section', { className: 'bt-project-running', 'data-running': String(view.running.length) },
    h('h4', null, t('Running tasks')),
    h('div', { className: 'bt-project-running-head' },
      h('span', null, t('Task')), h('span', null, t('Status')), h('span', null, t('Who')), h('span', null, t('Claimed for')), h('span', null, t('Source')), h('span', null, t('Last activity'))),
    view.running.map((row) => {
      const open = row.board === null ? undefined : () => onOpen?.(row.board)
      return h('div', {
        key: row.key, className: 'bt-project-running-row', 'data-task-id': row.id,
        'data-overdue': row.overdue ? 'true' : 'false',
        role: open === undefined ? undefined : 'button', tabIndex: open === undefined ? undefined : 0, onClick: open,
      },
      h('span', { className: 'bt-project-running-title' }, row.title),
      h('span', { className: 'bt-project-running-status' }, t(row.status)),
      h('span', null, row.who ?? METRIC_DASH),
      h('span', null, metricText('since', row.sinceMs)),
      h('span', null, row.source === null ? METRIC_DASH : t(SOURCE_LABELS[row.source] ?? row.source)),
      h('span', null, row.lastActivityAt === null ? METRIC_DASH : new Date(row.lastActivityAt).toLocaleString(dateLocale())))
    }))
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
    proxyRow(meeting),
    // A decided meeting whose file is gone still reads as decided; the missing path says so
    // instead of the row disappearing with the file.
    meeting.path === ''
      ? h('span', { className: 'bt-project-missing' }, 'decision file gone')
      : h('span', { className: 'bt-project-path' }, meeting.path)))
  // #1831: a pending decision card carries its level, who it is addressed to, and — for a severe
  // card — the host's own refusal to advance it. The words are the host's; the badge only says
  // which level it is, so a reader can see a severe card without opening it.
  const recipientText = list => (list.length === 0 ? null : list.map(name => `@${name}`).join(', '))
  // A proxy line reads in the same words a task row already uses for a proxy holder.
  const proxyText = meeting => meeting.participants
    .filter(participant => participant.speaksFor !== null)
    .map(participant => `${participant.name} ${t('for {user}', { user: participant.speaksFor })}`)
    .join(', ')
  const proxyRow = meeting => (proxyText(meeting) === ''
    ? null
    : h('span', { className: 'bt-project-speaks-for', 'data-speaks-for': meeting.participants.filter(p => p.speaksFor !== null).map(p => p.speaksFor).join(', ') }, proxyText(meeting)))
  const levelOf = meeting => h('span', { className: 'bt-project-level', 'data-level': meeting.level }, t(meeting.level))
  const pendingRows = meetings.pending.map(meeting => h('div', { key: meeting.key, className: 'bt-project-meeting', 'data-status': meeting.status, 'data-level': meeting.level },
    h('span', { className: 'bt-project-date' }, meeting.date),
    h('span', { className: 'bt-project-title' }, meeting.blockingQuestion === null ? meeting.question : meeting.blockingQuestion),
    levelOf(meeting),
    recipientText(meeting.recipients) === null ? null : h('span', { className: 'bt-project-recipients' }, recipientText(meeting.recipients)),
    meeting.advance.allowed ? null : h('span', { className: 'bt-project-paused' }, meeting.advance.reason),
    proxyRow(meeting),
    h('span', { className: 'bt-project-status' }, meeting.status)))
  return h('section', { className: 'bt-project-record', 'data-decisions': String(decisions.count), 'data-meetings': String(meetings.count) },
    h('h4', null, t('Decisions')),
    decisions.empty ? h('div', { className: 'bt-project-empty bt-project-record-empty' }, t(decisions.emptyText)) : decisionRows,
    h('h4', null, t('Meetings')),
    meetings.empty ? h('div', { className: 'bt-project-empty bt-project-record-empty' }, t(meetings.emptyText)) : decidedRows,
    meetings.pending.length === 0 ? null : h('h5', null, t('Not decided')),
    meetings.pending.length === 0 ? null : pendingRows)
}

export function ProjectBoardPane({ project, rows, canManage, tasks, decisions, meetings, queues, metrics, onOpen, onSettings, onMembers }) {
  const view = projectBoardView({ project, rows, canManage, tasks, decisions, meetings, queues, metrics })
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
    h(ProjectMetrics, { view: view.metrics }),
    h(ProjectRunningTable, { view: view.metrics, onOpen }),
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
      // The host's refusal is the answer the reader acted for; quote it instead of guessing, in the
      // interface language — the record is English, the reader is not.
      setStatus(hostText(error?.message ?? String(error)))
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
      // The host knows two memory kinds; the free text the panel takes is recorded as a decision,
      // never as a third kind the host would refuse (#1820).
      h('label', { htmlFor: 'bt-project-note' }, t('Add to the assistant memory')),
      h('textarea', { id: 'bt-project-note', value: note, onChange: event => setNote(event.target.value) }),
      h('div', { className: 'bt-project-row-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-action': 'project-memory-save', onClick: () => run('project-memory-write', { id, kind: 'decision', text: text(note) }, t('Memory saved.')) }, t('Save memory')))),
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

// #1814: what a card has waited (`waitedMs`) and whether the lease it holds is live are computed by
// the host at read time — a lease lasts 30 minutes (`tasks.js` `LEASE_TTL_SEC`) — so a board that
// reads once freezes: an expiry that happens while the page is open never turns the card `stalled`
// and `3h` stays `3h`. Five seconds is the cadence the client already polls a board on
// (`flybot-slots.js`), not a new one.
export const PROJECT_BOARD_POLL_MS = 5000

// Polling pauses while this board is not on screen, or while the tab is hidden and a read would only
// spend channel calls. A row's click writes `#task=…` and the board unmounts, so the hash test below
// is not that unmount: it covers the tick that lands between the write and the effect's cleanup,
// which would otherwise read for a board nobody is looking at. A drag or an edit state the page may
// grow later sets its flag here, beside these two, instead of a second condition at the call site.
const boardPollPaused = () => (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  || (typeof window !== 'undefined' && !window.location.hash.startsWith('#project'))

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
    let gone = false
    // Four reads of one board: the Project, its record, its rows, and the task texts the rows are
    // joined against. Nothing here asks a Bot by Bot.
    const loadBoard = async () => {
      const listing = await read('projects')
      const projects = listing?.projects ?? []
      const project = wanted === '' ? projects[0] : projects.find(item => item.id === wanted)
      if (project === undefined) return { project: null, rows: [], canManage: false, tasks: [] }
      const [record, board, taskList] = await Promise.all([
        read('project-read', { id: project.id }),
        read('project-board', { id: project.id, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        read('tasks', {}),
      ])
      const tasks = Array.isArray(taskList) ? taskList : (taskList?.tasks ?? [])
      // The groups are the same read as the rows, so the header cannot disagree with the cards.
      const queues = { waiting: board?.waiting, inflight: board?.inflight, blocked: board?.blocked, counts: board?.counts ?? null }
      return { project: record?.project ?? project, rows: board?.tasks ?? [], canManage: record?.canManage === true, tasks, decisions: board?.decisions, meetings: board?.meetings, queues, metrics: board?.metrics ?? null }
    }
    const refresh = async (first) => {
      try {
        const next = await loadBoard()
        if (!gone) setState(next)
      } catch {
        // The first read is the page's answer, so it takes the empty state it always took. A poll
        // that fails keeps the board the last good read drew (#1814): a board that vanishes under
        // the reader is worse than one a tick old, and the next tick asks again.
        if (!gone && first) setState({ project: null, rows: [], canManage: false, tasks: [] })
      }
    }
    void refresh(true)
    const timer = setInterval(() => { if (!boardPollPaused()) void refresh(false) }, PROJECT_BOARD_POLL_MS)
    return () => { gone = true; clearInterval(timer) }
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
            decisions: state.decisions, meetings: state.meetings, queues: state.queues, metrics: state.metrics,
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
