// The Project board view (#1710): one Project, the rows its read model already aggregated
// (host `project-board`), grouped by where the work lives. The rows are the tasks themselves —
// `row.id` is the underlying task id — so opening one opens that task and nothing is copied here.
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { dateLocale, hostText, t } from './i18n.js'
import { roleText } from './role-labels.js'

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
/* #2041: the decision row became a button, so it keeps the row's look and drops the control's. */
button.bt-project-decision{width:100%;font:inherit;color:inherit;text-align:left;border:0;cursor:pointer}
button.bt-project-decision:hover{background:var(--bt-card-hover,rgba(127,127,127,.16))}
button.bt-project-decision:focus-visible{outline:2px solid var(--bt-accent,#4c8dff);outline-offset:1px}
button.bt-project-decision[data-open="true"]{outline:1px solid var(--bt-accent,#4c8dff)}
.bt-project-decision-wrap{margin:0}
.bt-project-decision-text{margin:0 0 8px;padding:8px 10px;border-radius:8px;background:var(--bt-card,rgba(127,127,127,.08));white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font-size:12px;font-family:var(--bt-mono,ui-monospace,monospace)}
.bt-project-decision-refusal{opacity:.75}
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

/* #1855: the finished cards are one group of their own, closed until the reader opens it — a
   Project with months of history reads as the work in flight, not as its archive. */
.bt-project-done{margin:18px 0 0;border-top:1px solid var(--bt-line,rgba(127,127,127,.22));padding:12px 0 0}
.bt-project-done>summary{cursor:pointer;font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.7;list-style:none}
.bt-project-done>summary::-webkit-details-marker{display:none}
.bt-project-done>summary::before{content:'\\25B8';display:inline-block;width:12px;opacity:.6}
.bt-project-done[open]>summary::before{content:'\\25BE'}
.bt-project-done[open]>summary{margin:0 0 8px}

/* #1749: management panels. Same surface as the board, one form row per control, and a status
   line that quotes the host's own answer — a refused save reads where the reader pressed it. */
.bt-project-panel{padding:16px 18px;display:flex;flex-direction:column;gap:12px}
.bt-project-panel h3{margin:0}
.bt-project-field{display:flex;flex-direction:column;gap:4px}
.bt-project-field label{font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.bt-project-field input,.bt-project-field select,.bt-project-field textarea{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--bt-line,rgba(127,127,127,.32));background:var(--bt-card,rgba(127,127,127,.08));color:inherit}
.bt-project-field textarea{min-height:88px;resize:vertical}
/* #1887: the counter under the memory box. It stays quiet until the text passes the bound, and
   past it turns the one colour that says so; the disabled Save is the state a reader acts on. */
.bt-project-count{font-size:11px;opacity:.6;font-variant-numeric:tabular-nums}
.bt-project-count[data-over="true"]{opacity:1;color:#c2410c}
.bt-project-row-actions{display:flex;gap:8px;align-items:center}
.bt-project-members{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.bt-project-member{display:flex;gap:10px;align-items:baseline;padding:8px 10px;border-radius:8px;background:var(--bt-card,rgba(127,127,127,.08))}
.bt-project-member .bt-project-member-kind{margin-left:auto;font-size:11px;opacity:.6}
.bt-project-status-line{font-size:12px;opacity:.75;min-height:16px}
.bt-project-note{font-size:12px;opacity:.65;margin:0}

/* #1860: the Project team — who runs the Project, who speaks for the reader, and the role pool.
   One quiet block above the cards, and a Bot row is a button because a reader is looking a
   person up. The pool row keeps the rank it plays and the ranks the host said it may switch to. */
.bt-project-team{margin:0 0 14px}
.bt-project-team h4{margin:0 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.bt-project-team-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:8px 10px;border-radius:8px;background:var(--bt-card,rgba(127,127,127,.08));margin:0 0 6px}
.bt-project-team-row[data-open-bot]{cursor:pointer}
.bt-project-team-row[data-open-bot]:hover{background:var(--bt-hover,rgba(127,127,127,.14))}
.bt-project-team-label{font-size:12px;opacity:.7;min-width:96px}
.bt-project-team-bot{font-size:12px;font-family:var(--bt-mono,ui-monospace,monospace)}
.bt-project-team-roles{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;opacity:.75}
.bt-project-team-role{font-family:var(--bt-mono,ui-monospace,monospace)}
.bt-project-team-myrole{margin-left:auto;font-size:11px;opacity:.65}

/* #1864: the team dossier. A Dossier control on each team row opens one read-only panel; the
   owner's own chat header carries the same entry to the Project assistant's chat. */
.bt-project-team-dossier{margin-left:auto;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--bt-line,rgba(127,127,127,.32));background:transparent;color:inherit;cursor:pointer}
.bt-project-team-dossier:hover{background:var(--bt-hover,rgba(127,127,127,.14))}
.bt-project-dossier{padding:16px 18px;display:flex;flex-direction:column;gap:12px}
.bt-project-dossier-section{display:flex;flex-direction:column;gap:4px}
.bt-project-dossier-section h4{margin:0;font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.bt-project-dossier-text{margin:0;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-project-dossier-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;opacity:.7}
.bt-project-dossier-topics{display:flex;gap:6px;flex-wrap:wrap}
.bt-project-dossier-topic{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--bt-card,rgba(127,127,127,.08))}
.bt-project-agent-entry{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--bt-line,rgba(127,127,127,.32));background:transparent;color:inherit;cursor:pointer}
.bt-project-agent-entry:hover{background:var(--bt-hover,rgba(127,127,127,.14))}
`

// Sources in the order the board reads them; a source with no rows is left out so three empty
// groups never crowd out the one that has work.
export const PROJECT_SOURCES = ['bot', 'group', 'workflow']
export const SOURCE_LABELS = { bot: 'Bots', group: 'Groups', workflow: 'Workflows' }

const text = value => (typeof value === 'string' ? value.trim() : '')

// #1887: the memory box warns about the bound before the click, the way the host bounds it. One
// entry is at most `MAX_ENTRY` (`src/host/constants.js`, #1847) and the host counts its code points
// (#1886), so the counter counts the same unit on the trimmed text the host would store — which is
// also why the field carries no `maxLength`: that counts UTF-16 units and would call a 600-emoji
// entry twice its real length.
export const MEMORY_TEXT_MAX = 600
const memoryLength = (value) => [...text(value)].length

// #1855: the column a finished card reads. The host sends those cards apart (`done`) and the view
// keeps them out of every group of work in flight.
const DONE_COLUMN = 'done'

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
  // #2021: the host caps these lists, so it also says how many rows it found before the cut. The
  // record carries that number beside the rows it drew; a host that sends no total answers `null`,
  // which draws nothing, so the section then reads exactly as it did before this slice.
  const totalOf = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const hiddenOf = (total, rows) => (total === null ? 0 : Math.max(0, total - rows))
  const decisionsTotal = totalOf(decisions?.total)
  const decidedTotal = totalOf(meetings?.decidedTotal)
  const pendingTotal = totalOf(meetings?.pendingTotal)
  return {
    decisions: {
      dir,
      files,
      count: files.length,
      total: decisionsTotal,
      hidden: hiddenOf(decisionsTotal, files.length),
      empty: files.length === 0,
      emptyText: text(decisions?.reason) || (dir === null ? 'This Project names no working folder.' : `No decision file in ${dir}/decisions.`),
    },
    meetings: {
      decided,
      pending,
      count: decided.length + pending.length,
      decidedTotal,
      pendingTotal,
      decidedHidden: hiddenOf(decidedTotal, decided.length),
      pendingHidden: hiddenOf(pendingTotal, pending.length),
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
export function projectBoardView({ project, rows, done, canManage, tasks, decisions, meetings, queues, metrics } = {}) {
  const isRow = row => row !== null && typeof row === 'object' && text(row.id) !== ''
  const byId = new Map((Array.isArray(tasks) ? tasks : [])
    .filter(task => task !== null && typeof task === 'object' && text(task.id) !== '')
    .map(task => [text(task.id), task]))
  // #1855: the host sends the finished cards beside the rows, in the same shape. A page that talks
  // to a host which still sends them inside `rows` folds them into the archive on its own: a
  // finished card is never a row, and no card is dropped or painted twice.
  const list = []
  const archived = []
  const seen = new Set()
  for (const row of [...(Array.isArray(done) ? done : []), ...(Array.isArray(rows) ? rows : [])]) {
    if (!isRow(row)) continue
    const id = text(row.id)
    if (seen.has(id)) continue
    seen.add(id)
    const column = text(row.column) || 'not-started'
    ;(column === DONE_COLUMN ? archived : list).push(row)
  }
  const projectRow = (row) => {
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
  }
  const groups = PROJECT_SOURCES
    .map(source => ({
      source,
      label: SOURCE_LABELS[source],
      rows: list.filter(row => row.source === source).map(projectRow),
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
      const source = text([...list, ...archived].find(row => text(row.id) === id)?.source)
      const task = byId.get(id)
      return { id, key: `task:${id}`, title: text(task?.title) || text(task?.note) || null, priority: text(task?.priority) || null, board: boardOfRow({ source }, task), ...annotate(item) }
    })
  const waiting = queueItems(queues?.waiting, item => ({ role: text(item.role) || null, waitedMs: Number.isFinite(item.waitedMs) ? item.waitedMs : null }))
  const inflight = queueItems(queues?.inflight, item => ({ holder: text(item.holder) || null, state: item.stalled === true ? 'stalled' : 'running' }))
  // #2029: a blocked row carries the age the host measured beside its reason, the same way the
  // waiting row does — the view never measures it here.
  const blocked = queueItems(queues?.blocked, item => ({ reason: text(item.reason) || null, waitedMs: Number.isFinite(item.waitedMs) ? item.waitedMs : null }))
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
    // #1855: one group, closed until the reader opens it. Rows keep the row shape above, so a
    // finished card is still a card — only its place on the board changed.
    done: { group: 'done', label: 'Done cards', collapsed: true, rows: archived.map(projectRow) },
    queues: queueGroups,
    counts: rawCounts === null ? null : { waiting: countOf(rawCounts.waiting), inflight: countOf(rawCounts.inflight), blocked: countOf(rawCounts.blocked), done: countOf(rawCounts.done) },
    count: list.length,
    empty: list.length === 0 && queueGroups.length === 0 && archived.length === 0,
    emptyText: 'No cards yet.',
    record: projectBoardRecord({ decisions, meetings }),
    metrics: metricsView(metrics, { tasks }),
  }
}

// One card, drawn once: the rows in flight and the archived rows go through this same projection,
// so a finished card is the card it was with no second markup to keep in step.
function projectRowNode(row, onOpen) {
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
}

function ProjectBoardRows({ view, onOpen }) {
  // An empty Project is a state, not an error: the view says so and renders no groups.
  if (view.empty) return h('div', { className: 'bt-project-empty' }, t(view.emptyText))
  return view.groups.map(group => h('section', { key: group.source, className: 'bt-project-group', 'data-source': group.source },
    h('h4', null, t(group.label)),
    group.rows.map(row => projectRowNode(row, onOpen))))
}

// #1855: the archive. A <details> with no `open` attribute is closed until the reader opens it, so
// a Project with 191 finished cards paints the work in flight; the rows are built with the same
// renderer as the rest of the board and the header keeps counting them.
function ProjectDoneGroup({ view, onOpen }) {
  if (view.done.rows.length === 0) return null
  return h('details', { className: 'bt-project-group bt-project-done', 'data-group': 'done' },
    h('summary', { className: 'bt-project-done-summary' }, `${t(view.done.label)} · ${view.done.rows.length}`),
    view.done.rows.map(row => projectRowNode(row, onOpen)))
}

// How long a card has waited, in the unit a reader wants: seconds under a minute, minutes under an
// hour, hours under a day. A card with no `createdAt` says nothing rather than "0m", and a span over
// zero never floors to "0s" — the way `elapsedLabel` never says "0m" (#1896).
export function waitedLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 60000) return `${ms === 0 ? 0 : Math.max(1, Math.floor(ms / 1000))}s`
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
          // #2029: a blocked row says why and, when the host measured it, how long — `reason · 2d`.
          // With no stamp it keeps the reason alone; an invented age would read as a wait nobody measured.
          : h('span', { className: 'bt-project-reason' }, row.reason === null ? null : waitedLabel(row.waitedMs) === null ? row.reason : `${row.reason} · ${waitedLabel(row.waitedMs)}`)
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
// #2041: a decision row opens. The row is a button, so it is reachable with a keyboard and by
// activation; one row is open at a time, and the text under it is the host's answer to that one
// name — the board's own listing, never a second read of the folder.
function ProjectBoardRecord({ record, projectId, call }) {
  const { decisions, meetings } = record
  const [open, setOpen] = useState(null)
  const toggle = (path) => {
    if (open !== null && open.path === path) { setOpen(null); return }
    if (typeof call !== 'function') return
    setOpen({ path, answer: null })
    // An answer that lands after another row was opened must not paint this one: it is kept only
    // while its own row is the open one.
    const settle = (answer) => setOpen(current => (current !== null && current.path === path ? { path, answer } : current))
    call('project-decision', { id: projectId, path }).then(settle, error => settle({ ok: false, reason: String(error?.message ?? error) }))
  }
  const decisionBody = (file) => {
    if (open === null || open.path !== file.path) return null
    const answer = open.answer
    if (answer === null) return h('div', { className: 'bt-project-decision-text', 'data-open-decision': file.path }, t('Reading the decision…'))
    // `absent` and `too large` read as the sentence the host sent, the same words `project_state`
    // reports them in; the text of a decision is drawn as text, never as markup it contains.
    if (answer.ok !== true) return h('div', { className: 'bt-project-decision-text bt-project-decision-refusal', 'data-open-decision': file.path, 'data-refused': 'true' }, text(answer.reason) || t('not listed'))
    return h('pre', { className: 'bt-project-decision-text', 'data-open-decision': file.path }, typeof answer.text === 'string' ? answer.text : '')
  }
  const decisionRows = decisions.files.map(file => h('div', { key: file.key, className: 'bt-project-decision-wrap' },
    h('button', {
      type: 'button',
      className: 'bt-project-decision',
      'data-path': file.path,
      'data-sha256': file.sha256,
      'data-open': open !== null && open.path === file.path ? 'true' : undefined,
      'aria-expanded': open !== null && open.path === file.path ? 'true' : 'false',
      onClick: () => toggle(file.path),
    },
    h('span', { className: 'bt-project-date' }, file.date),
    h('span', { className: 'bt-project-title' }, file.title === '' ? file.name : file.title),
    h('span', { className: 'bt-project-hash', title: file.sha256 }, file.shortHash)),
    decisionBody(file)))
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
  const pendingRows = meetings.pending.map(meeting => h('div', { key: meeting.key, className: 'bt-project-meeting', 'data-status': meeting.status, 'data-level': meeting.level },
    h('span', { className: 'bt-project-date' }, meeting.date),
    h('span', { className: 'bt-project-title' }, meeting.blockingQuestion === null ? meeting.question : meeting.blockingQuestion),
    levelOf(meeting),
    recipientText(meeting.recipients) === null ? null : h('span', { className: 'bt-project-recipients' }, recipientText(meeting.recipients)),
    meeting.advance.allowed ? null : h('span', { className: 'bt-project-paused' }, meeting.advance.reason),
    proxyRow(meeting),
    h('span', { className: 'bt-project-status' }, meeting.status)))
  // #2021: one line under a capped list says how many rows the host left out. A host that sends no
  // total, or one that matches the rows drawn, renders nothing at all.
  const moreLine = (hidden, key) => (hidden > 0
    ? h('div', { key, className: 'bt-project-more' }, t('{count} more not shown', { count: hidden }))
    : null)
  return h('section', {
    className: 'bt-project-record',
    // `data-decisions` stays "rows drawn"; the total rides beside it so the view can be asserted.
    'data-decisions': String(decisions.count),
    ...(decisions.total === null ? {} : { 'data-decisions-total': String(decisions.total) }),
    'data-meetings': String(meetings.count),
  },
    h('h4', null, t('Decisions')),
    decisions.empty ? h('div', { className: 'bt-project-empty bt-project-record-empty' }, t(decisions.emptyText)) : decisionRows,
    moreLine(decisions.hidden, 'decisions-more'),
    h('h4', null, t('Meetings')),
    meetings.empty ? h('div', { className: 'bt-project-empty bt-project-record-empty' }, t(meetings.emptyText)) : decidedRows,
    moreLine(meetings.decidedHidden, 'decided-more'),
    meetings.pending.length === 0 ? null : h('h5', null, t('Not decided')),
    meetings.pending.length === 0 ? null : pendingRows,
    moreLine(meetings.pendingHidden, 'pending-more'))
}

// #1860: the Project team — the Project's own Chief (#1859), the assistant that speaks for the
// caller (#1712) and the role pool (#1828) — read off the one `project-read` record. A record
// written before `chief` landed answers no id, and a spawn that failed answers `{ error }`; both
// keep the row and read "not set", so neither slice has to wait for the other.
const botIdOf = entry => (entry !== null && typeof entry === 'object' ? text(entry.botId) : '')
const idList = value => (Array.isArray(value) ? value.map(id => text(id)).filter(id => id !== '') : [])

export function projectTeamView(project) {
  const stored = project?.roles !== null && typeof project?.roles === 'object' ? project.roles : {}
  // The Owner is derived, never stored twice: the host reads it from `ownerUserIds` and so does
  // the pool, so a record that never ran `setProjectRoles` still names its Owner.
  const owner = []
  const addOwner = (id) => { const clean = text(id); if (clean !== '' && !owner.includes(clean)) owner.push(clean) }
  addOwner(project?.ownerUserId)
  for (const id of idList(project?.ownerUserIds)) addOwner(id)
  const maintainers = idList(stored.maintainers).filter(id => !owner.includes(id))
  const members = idList(stored.members).filter(id => !owner.includes(id) && !maintainers.includes(id))
  return {
    chief: botIdOf(project?.chief),
    agent: botIdOf(project?.assistant),
    roles: { owner, maintainers, members },
    empty: owner.length === 0 && maintainers.length === 0 && members.length === 0,
    // Both come from the `projects` listing (#1828), which the overlay keeps on the record: the
    // `project-read` record answers no rank, and the panel never re-derives the host's policy.
    role: text(project?.role),
    choices: idList(project?.choices),
  }
}

const teamRow = (role, label, botId, onOpenBot, onOpenDossier) => h('div', {
  key: role, className: 'bt-project-team-row', 'data-team-role': role,
  // A row with no Bot is the fallback the slice specifies: still drawn, with nothing to open.
  ...(botId === ''
    ? { 'data-team-state': 'not-set' }
    : {
      'data-open-bot': botId, role: 'button', tabIndex: 0,
      'aria-label': t("Open {name}'s chat", { name: botId }),
      onClick: () => onOpenBot?.(botId),
      onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenBot?.(botId) } },
    }),
},
h('span', { key: 'label', className: 'bt-project-team-label' }, label),
botId === ''
  ? h('span', { key: 'value', className: 'bt-project-missing' }, t('Not set'))
  : h('span', { key: 'value', className: 'bt-project-team-bot' }, `@${botId}`),
// #1864: the dossier control sits inside the row, so the row still opens the chat (#1860) and a
// reader can look a Bot up first. A row with no Bot keeps the control: its panel reads "not set".
h('button', {
  key: 'dossier', type: 'button', className: 'bt-project-team-dossier',
  'data-dossier-role': role, ...(botId === '' ? {} : { 'data-dossier-bot': botId }),
  'aria-label': t('Open {name}\'s dossier', { name: botId === '' ? label : botId }),
  onClick: (event) => { event?.stopPropagation(); onOpenDossier?.({ role, label, botId }) },
  onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event?.stopPropagation(); onOpenDossier?.({ role, label, botId }) } },
}, t('Dossier')))

const POOL_RANKS = [['owner', 'owner'], ['maintainer', 'maintainers'], ['member', 'members']]

export function ProjectTeam({ project, onOpenBot, onOpenDossier }) {
  const view = projectTeamView(project)
  // #1892: a pool entry is a rank, not a Bot this board holds a dossier answer for — `project-team`
  // answers rows keyed by the Project's own Bots, so the old control opened a row the host never
  // sent. The Chief and my-agent rows above keep theirs.
  const poolId = (id) => h('span', { key: id }, `@${id}`)
  const ranks = view.empty
    ? h('span', { className: 'bt-project-missing' }, t('No one in this pool yet.'))
    : h('span', { className: 'bt-project-team-roles' },
      POOL_RANKS.map(([role, key]) => (view.roles[key].length === 0
        ? null
        : h('span', { key: role, className: 'bt-project-team-role', 'data-pool-role': role },
          `${roleText(role)}: `, view.roles[key].map(id => poolId(id))))))
  return h('section', { className: 'bt-project-team', 'data-team': 'chief,agent,pool' },
    h('h4', null, t('Project team')),
    teamRow('chief', t('Project Chief'), view.chief, onOpenBot, onOpenDossier),
    teamRow('agent', t('My agent'), view.agent, onOpenBot, onOpenDossier),
    h('div', { key: 'pool', className: 'bt-project-team-row', 'data-team-role': 'pool' },
      h('span', { key: 'label', className: 'bt-project-team-label' }, t('Role pool')),
      ranks,
      // The caller's own rank and what the host said they may switch to: the same answer the
      // sidebar menu reads, printed where the pool is.
      view.role === ''
        ? null
        : h('span', { key: 'mine', className: 'bt-project-team-myrole', 'data-team-my-role': view.role },
          [t('My role'), ': ', roleText(view.role),
            view.choices.length === 0 ? null : ` · ${t('Can switch to {roles}', { roles: view.choices.map(roleText).join(', ') })}`])))
}

// #1864: the dossier panel. It draws only the answer it was handed — persona, the memory head and
// topic names, and the skill names — so it cannot re-fetch per section. A `null` row is the host's
// "this Bot is gone" answer: the panel says "not set" and draws no invented persona.
export function dossierRowOf(team, botId) {
  const id = text(botId)
  if (id === '') return null
  const rows = Array.isArray(team?.rows) ? team.rows : []
  return rows.find(row => row !== null && typeof row === 'object' && text(row.botId) === id) ?? null
}

const dossierSection = (title, children) => h('div', { key: title, className: 'bt-project-dossier-section' },
  h('h4', null, title), children)

export function ProjectDossierPanel({ row, label, onClose, onOpenBot } = {}) {
  const known = row !== null && typeof row === 'object'
  const botId = known ? text(row.botId) : ''
  const topics = known && Array.isArray(row.memory?.topics) ? row.memory.topics.map(name => text(name)).filter(name => name !== '') : []
  const skills = known && Array.isArray(row.skills) ? row.skills.map(name => text(name)).filter(name => name !== '') : []
  const meta = known
    ? [text(row.role), text(row.model)].filter(value => value !== '')
    : []
  return h('div', { className: 'bt-project-panel bt-project-dossier', 'data-panel': 'project-dossier', 'data-dossier-bot': botId === '' ? undefined : botId },
    h('h3', null, label === '' || label === undefined ? t('Dossier') : `${label} · ${t('Dossier')}`),
    known
      ? [
        dossierSection(t('Persona'), [
          meta.length === 0 ? null : h('div', { key: 'meta', className: 'bt-project-dossier-meta' }, meta.map(value => h('span', { key: value }, value))),
          h('p', { key: 'persona', className: 'bt-project-dossier-text' }, text(row.persona) || t('Not set')),
        ]),
        dossierSection(t('Memory'), [
          h('p', { key: 'head', className: 'bt-project-dossier-text' }, text(row.memory?.head) || t('No memory yet.')),
          topics.length === 0
            ? null
            : h('div', { key: 'topics', className: 'bt-project-dossier-topics' }, topics.map(topic => h('span', { key: topic, className: 'bt-project-dossier-topic' }, topic))),
        ]),
        dossierSection(t('Skills'), h('p', { key: 'skills', className: 'bt-project-dossier-text' }, skills.length === 0 ? t('No skills attached.') : skills.join(', '))),
      ]
      : h('p', { className: 'bt-project-missing' }, t('Not set')),
    botId === '' || !known
      ? null
      : h('div', { key: 'actions', className: 'bt-project-row-actions' },
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', 'data-open-bot': botId,
          onClick: () => onOpenBot?.(botId),
        }, t('Open chat'))),
    h('div', { className: 'bt-project-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => onClose?.() }, t('Back to board'))))
}

// #1864: the entry in the owner's own Bot chat. The roster already carries a Bot's `projectId`
// (the binding writes it on the record), so the header needs no second list read; the assistant id
// comes from the Project record when the reader presses the entry.
export function projectAgentFor(bot, selfId) {
  if (bot === null || typeof bot !== 'object' || bot.remote !== undefined) return null
  const projectId = text(bot.projectId)
  if (projectId === '') return null
  const owner = text(bot.ownerId)
  const self = text(selfId)
  if (self !== '' && owner !== '' && owner !== self) return null
  return { projectId }
}

export function ProjectAgentEntry({ projectId, read, onOpen } = {}) {
  const [agentId, setAgentId] = useState('')
  const id = text(projectId)
  const open = async () => {
    let target = agentId
    if (target === '') {
      try {
        const record = await (read ?? call)('project-read', { id })
        target = botIdOf(record?.project?.assistant)
      } catch {
        // A Project that cannot be read offers no agent; the chat is unchanged.
        target = ''
      }
      if (target !== '') setAgentId(target)
    }
    if (target !== '') onOpen?.(target)
  }
  if (id === '') return null
  return h('button', {
    type: 'button', className: 'bt-project-agent-entry',
    'data-project-agent': id, 'data-open-bot': agentId === '' ? undefined : agentId,
    title: t('Open my agent'), 'aria-label': t('Open my agent'),
    onClick: open,
  }, t('My agent'))
}

export function ProjectBoardPane({ project, rows, done, canManage, tasks, decisions, meetings, queues, metrics, onOpen, onSettings, onMembers, onOpenBot, onOpenDossier, call }) {
  const view = projectBoardView({ project, rows, done, canManage, tasks, decisions, meetings, queues, metrics })
  return h('div', { className: 'bt-project-board', 'data-can-manage': view.canManage ? 'true' : 'false' },
    h('h3', null, view.title),
    h(ProjectTeam, { project, onOpenBot, onOpenDossier }),
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
    h(ProjectDoneGroup, { view, onOpen }),
    h(ProjectBoardRecord, { record: view.record, projectId: view.projectId, call }))
}

// #1749: the settings panel. It writes through the three paths the host already had — bind or
// unbind a member (`project-bind`), the assistant's per-owner controls
// (`project-assistant-owner`) and the assistant's memory (`project-memory-write`) — and adds no
// fourth. Fields the host has no write path for are not drawn, so every control here can save.
export function ProjectSettingsPanel({ project, assistantMine, call: request, onClose, onSaved } = {}) {
  const save = request ?? call
  const [kind, setKind] = useState('bot')
  const [memberId, setMemberId] = useState('')
  const [note, setNote] = useState('')
  // #1887: an empty box has nothing to save and an over-long one can never land, so neither
  // reaches the host — the reader sees the state before the click instead of a refusal after it.
  const noteLength = memoryLength(note)
  const noteOver = noteLength > MEMORY_TEXT_MAX
  const noteSaveDisabled = text(note) === '' || noteOver
  // #1845: the digest opt-out is per owner, and the host keeps it on `owners[<ownerId>]`; the
  // Project record has no such field, so reading it there showed a paused digest as unticked and
  // the next Save turned it back on. `project-read` answers the caller's own record beside the
  // Project; `project.assistant.off` survives only as the fallback a caller without that read had.
  const [assistantOff, setAssistantOff] = useState(assistantMine === undefined ? project?.assistant?.off === true : assistantMine?.off === true)
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
      h('div', { className: 'bt-project-count', 'data-role': 'project-memory-count', 'data-over': noteOver ? 'true' : 'false' }, `${noteLength}/${MEMORY_TEXT_MAX}`),
      h('div', { className: 'bt-project-row-actions' },
        h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          'data-action': 'project-memory-save',
          disabled: noteSaveDisabled,
          // A disabled button draws no click, but the guard is what a keyboard or a stale tree
          // could still reach: neither state sends a request or writes anything.
          onClick: () => {
            if (noteSaveDisabled) return
            run('project-memory-write', { id, kind: 'decision', text: text(note) }, t('Memory saved.'))
          },
        }, t('Save memory')))),
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
  // The Project's own Chief (#1859), read from the record: created with the Project, never the
  // user's main Chief acting part-time.
  const chief = text(project?.chief?.botId)
  return h('div', { className: 'bt-project-panel', 'data-panel': 'project-members' },
    h('h3', null, t('Members')),
    h('ul', { className: 'bt-project-members' },
      owners.map(owner => h('li', { key: `owner:${owner}`, className: 'bt-project-member', 'data-member-role': 'owner', 'data-member-id': owner },
        h('span', null, `@${owner}`),
        h('span', { className: 'bt-project-member-kind' }, t('Owner')))),
      chief === '' ? null : h('li', { key: `chief:${chief}`, className: 'bt-project-member', 'data-member-role': 'chief', 'data-member-id': chief },
        h('span', null, t('Project Chief')),
        h('span', { className: 'bt-project-member-kind' }, t('Chief of this Project'))),
      boardMembers.map(name => h('li', { key: `board:${name}`, className: 'bt-project-member', 'data-member-role': 'board', 'data-member-id': name },
        h('span', null, `@${name}`),
        h('span', { className: 'bt-project-member-kind' }, t('On the board'))))),
    owners.length === 0 && boardMembers.length === 0 && chief === '' ? h('div', { className: 'bt-project-empty' }, t('No member is named yet.')) : null,
    h('p', { className: 'bt-project-note' }, t('Member management is not part of this slice; owners and the members their cards name are listed here.')),
    h('div', { className: 'bt-project-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => onClose?.() }, t('Back to board'))))
}

// #1864: one read for the whole board, exported so a test can prove the dossier comes from a single
// `project-team` call. `read` is the channel seam (`call` in the app). #1900: the dossier is the one
// answer the poll hands back — `knownTeam` is what the open read — because the host builds it by
// reading persona and memory files, and a five-second refresh must not pay that again. A refusal
// leaves the rest of the board standing, so a dossier problem is never the empty-Project answer.
// #1910: a refusal is "no answer yet", not an empty team. `teamFresh` is false exactly when the
// dossier could not be read, so the caller keeps no answer to hand back and the next tick asks again.
export async function readProjectBoard(read, wanted, knownTeam) {
  const listing = await read('projects')
  const projects = Array.isArray(listing?.projects) ? listing.projects : []
  const project = wanted === '' ? projects[0] : projects.find(item => item.id === wanted)
  if (project === undefined) return { project: null, rows: [], done: [], canManage: false, tasks: [], team: { rows: [] }, teamFresh: true }
  const zone = typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function'
    ? undefined
    : Intl.DateTimeFormat().resolvedOptions().timeZone
  const [record, board, taskList, dossier] = await Promise.all([
    read('project-read', { id: project.id }),
    read('project-board', { id: project.id, timeZone: zone }),
    read('tasks', {}),
    // #1910: #1902 turned this failure into an ordinary empty team, which the poll then served for
    // the rest of the open. Keep the two answers apart: a refusal is not fresh, so nothing is cached
    // and the next tick asks again, while a real `{ rows: [] }` answer is fresh and frozen as usual.
    knownTeam !== undefined
      ? { answer: knownTeam, fresh: true }
      : read('project-team', { id: project.id }).then(
        answer => ({ answer, fresh: answer !== null && typeof answer === 'object' }),
        () => ({ answer: null, fresh: false }),
      ),
  ])
  const tasks = Array.isArray(taskList) ? taskList : (taskList?.tasks ?? [])
  // The groups are the same read as the rows, so the header cannot disagree with the cards.
  const queues = { waiting: board?.waiting, inflight: board?.inflight, blocked: board?.blocked, counts: board?.counts ?? null }
  // #1860: `project-read` answers the stored record, which carries no caller rank — `role` and
  // `choices` are the `projects` listing's answer (#1828). They stay on the record the pane
  // reads, so the team block prints the rank without a second listing read.
  const base = record?.project ?? project
  const withRole = { ...base, role: project.role ?? null, choices: Array.isArray(project.choices) ? project.choices : [] }
  return {
    project: withRole, assistantMine: record?.assistantMine ?? null, rows: board?.tasks ?? [], done: board?.done ?? [], canManage: record?.canManage === true,
    tasks, decisions: board?.decisions, meetings: board?.meetings, queues, metrics: board?.metrics ?? null,
    team: dossier.answer !== null && typeof dossier.answer === 'object' ? dossier.answer : { rows: [] },
    teamFresh: dossier.fresh,
  }
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
  const [dossier, setDossier] = useState(null)
  // #1913: the dossier answer the board hands back on every poll (#1900, #1910), and a generation
  // counter an explicit Dossier open bumps so a tick already in flight cannot write the older
  // answer back over the fresh one.
  const team = useRef(undefined)
  const teamGen = useRef(0)
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
    // #1864: the board, its record, its rows, the task texts and the team dossier are one read path,
    // and the dossier comes from the single `project-team` call that read makes. #1900: that call is
    // this open's, not the poll's — the answer is handed back on every later read, so a tick
    // re-reads only the three answers that change and the dossier is read again on the next board
    // open. #1910: only an answer is kept. A refused read is drawn as the empty team it always was,
    // but nothing is cached, so the next tick asks `project-team` again instead of serving it.
    // #1913: an explicit open of the Dossier panel replaces that answer with a fresh read; the
    // generation it bumps tells a tick that was already in flight to keep the newer answer.
    team.current = undefined
    teamGen.current = 0
    const loadBoard = () => readProjectBoard(read, wanted, team.current)
    const refresh = async (first) => {
      const gen = teamGen.current
      try {
        const next = await loadBoard()
        if (!gone) {
          const newer = teamGen.current !== gen
          if (next.teamFresh !== false && !newer) team.current = next.team
          setState(newer && team.current !== undefined ? { ...next, team: team.current } : next)
        }
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
  // #1913: reading the dossier is the one deliberate act on this board, so opening its panel pays
  // for one `project-team` read (the host caps the answer at ~16 KB) instead of showing whatever the
  // board opened with. The poll keeps handing back the answer this leaves, so #1900's saving stands,
  // and a refused read draws nothing new: the rows the panel already had stay on screen.
  const openDossier = async (value) => {
    setDossier(value)
    setPanel('dossier')
    const id = state?.project?.id
    if (typeof id !== 'string' || id === '') return
    const gen = teamGen.current + 1
    teamGen.current = gen
    try {
      const answer = await read('project-team', { id })
      if (teamGen.current !== gen || answer === null || typeof answer !== 'object') return
      team.current = answer
      setState(previous => (previous === null ? previous : { ...previous, team: answer }))
    } catch {
      // A refresh that fails keeps the answer the open had; the next explicit open asks again.
    }
  }
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
          : panel === 'dossier' ? h(ProjectDossierPanel, {
            row: dossierRowOf(state.team, dossier?.botId),
            label: dossier?.label ?? '',
            onClose: () => setPanel(null),
            onOpenBot: (id) => { close(); actions?.openSession?.(id) },
          })
          : panel === 'settings' ? h(ProjectSettingsPanel, { project: state.project, assistantMine: state.assistantMine, call: read, onClose: () => setPanel(null) })
          : panel === 'members' ? h(ProjectMembersPanel, { project: state.project, rows: state.rows, onClose: () => setPanel(null) })
          : h(ProjectBoardPane, {
            project: state.project, rows: state.rows, done: state.done, canManage: state.canManage, tasks: state.tasks,
            decisions: state.decisions, meetings: state.meetings, queues: state.queues, metrics: state.metrics, team: state.team,
            // #2041: a decision row opens through the same channel read the page polls with.
            call: read,
            onSettings: () => setPanel('settings'),
            onMembers: () => setPanel('members'),
            // #1864: a team row's Dossier control opens the read-only panel, fed by the same read.
            onOpenDossier: (value) => { void openDossier(value) },
            // #1860: a team row opens that Bot's chat. The board is a modal over the conversation,
            // so it closes first — otherwise the chat opens behind it.
            onOpenBot: (id) => { close(); actions?.openSession?.(id) },
            // The task's own board is where a row leads: the Tasks dialog reads `#task=` on mount and
            // lands on that Bot or group. Nothing here re-decides which board that is.
            onOpen: (board) => {
              if (typeof window !== 'undefined') window.location.hash = `#task=${board.kind}:${board.id}`
              actions?.openBoard?.()
              setState(null)
            },
          }))))
}
