// The Project board view (#1710): one Project, the rows its read model already aggregated
// (host `project-board`), grouped by where the work lives. The rows are the tasks themselves —
// `row.id` is the underlying task id — so opening one opens that task and nothing is copied here.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

export const PROJECT_BOARD_CSS = `
.bt-project-board{padding:16px 18px}
.bt-project-group{margin:0 0 14px}
.bt-project-group h4{margin:0 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.bt-project-row{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;background:var(--bt-card,rgba(127,127,127,.08));margin:0 0 6px;cursor:default}
.bt-project-row[data-column="done"]{opacity:.7}
.bt-project-row .bt-project-ref{margin-left:auto;font-size:11px;opacity:.6}
.bt-project-empty{padding:22px 4px;opacity:.7}
.bt-project-actions{display:flex;gap:8px;margin:0 0 14px}
`

// Sources in the order the board reads them; a source with no rows is left out so three empty
// groups never crowd out the one that has work.
export const PROJECT_SOURCES = ['bot', 'group', 'workflow']
export const SOURCE_LABELS = { bot: 'Bots', group: 'Groups', workflow: 'Workflows' }

const text = value => (typeof value === 'string' ? value.trim() : '')

// Pure: no fetch, no React, no store. `rows` is the host's read model, `canManage` comes from
// `project-read` and only decides what the caller may *ask* for — the host refuses regardless.
export function projectBoardView({ project, rows, canManage } = {}) {
  const list = Array.isArray(rows) ? rows.filter(row => row !== null && typeof row === 'object' && text(row.id) !== '') : []
  const groups = PROJECT_SOURCES
    .map(source => ({
      source,
      label: SOURCE_LABELS[source],
      rows: list
        .filter(row => row.source === source)
        .map(row => ({
          id: text(row.id),
          key: `task:${text(row.id)}`,
          column: text(row.column) || 'not-started',
          assignee: text(row.assignee) || null,
          runId: text(row.runId) || null,
          nodeId: text(row.nodeId) || null,
        })),
    }))
    .filter(group => group.rows.length > 0)
  return {
    projectId: text(project?.id) || null,
    title: text(project?.name) || 'Project',
    canManage: canManage === true,
    groups,
    count: list.length,
    empty: list.length === 0,
    emptyText: 'Nothing under this Project yet.',
  }
}

function ProjectBoardRows({ view, onOpen }) {
  // An empty Project is a state, not an error: the view says so and renders no groups.
  if (view.empty) return h('div', { className: 'bt-project-empty' }, t(view.emptyText))
  return view.groups.map(group => h('section', { key: group.source, className: 'bt-project-group', 'data-source': group.source },
    h('h4', null, t(group.label)),
    group.rows.map(row => h('div', {
      key: row.key,
      className: 'bt-project-row',
      'data-task-id': row.id,
      'data-column': row.column,
      role: 'button',
      tabIndex: 0,
      onClick: () => onOpen?.(row.id),
      onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') onOpen?.(row.id) },
    },
    h('span', { className: 'bt-project-column' }, t(row.column)),
    h('span', { className: 'bt-project-title' }, row.assignee ? `@${row.assignee}` : '—'),
    row.runId === null ? null : h('span', { className: 'bt-project-ref' }, row.nodeId === null ? row.runId : `${row.runId} · ${row.nodeId}`)))))
}

export function ProjectBoardPane({ project, rows, canManage, onOpen }) {
  const view = projectBoardView({ project, rows, canManage })
  return h('div', { className: 'bt-project-board', 'data-can-manage': view.canManage ? 'true' : 'false' },
    h('h3', null, view.title),
    // Management affordances are drawn only for the owner; the refusal itself is the host's.
    view.canManage ? h('div', { className: 'bt-project-actions' }, h('button', { type: 'button' }, t('Project settings')), h('button', { type: 'button' }, t('Members'))) : null,
    h(ProjectBoardRows, { view, onOpen }))
}

// The pane entry point (#1710): `#project=<id>` opens one Project's board, `#project` the first.
// Reading is a POST through the same host channel every other view uses.
export function ProjectBoardOverlay() {
  const [state, setState] = useState(null)
  const close = useCallback(() => {
    if (typeof window !== 'undefined') window.location.hash = ''
    setState(null)
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!window.location.hash.startsWith('#project')) return
    const wanted = window.location.hash.slice('#project'.length).replace(/^=/, '')
    let live = true
    void (async () => {
      try {
        const listing = await call('projects')
        const projects = listing?.projects ?? []
        const project = wanted === '' ? projects[0] : projects.find(item => item.id === wanted)
        if (project === undefined) { if (live) setState({ project: null, rows: [], canManage: false }); return }
        const [read, board] = await Promise.all([call('project-read', { id: project.id }), call('project-board', { id: project.id })])
        if (live) setState({ project: read?.project ?? project, rows: board?.tasks ?? [], canManage: read?.canManage === true })
      } catch { if (live) setState({ project: null, rows: [], canManage: false }) }
    })()
    return () => { live = false }
  }, [])
  if (state === null) return null
  return h('div', { className: 'bt-overlay bt-project-overlay', role: 'dialog', 'aria-label': t('Project board') },
    h('button', { type: 'button', className: 'bt-project-close', onClick: close }, t('Close')),
    state.project === null
      ? h('div', { className: 'bt-project-empty' }, t('No Project here.'))
      : h(ProjectBoardPane, { project: state.project, rows: state.rows, canManage: state.canManage, onOpen: id => { window.location.hash = `#task=${id}` } }))
}
