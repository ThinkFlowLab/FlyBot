// #1828: Projects as a first-level sidebar entry. The row expands to the Projects this caller can
// see, each with the role they hold there; a row opens that board straight (`#project=<id>`), and
// the right-click menu offers only the roles the host says the caller may switch to, with the
// current one marked. The policy itself lives in the host (`roleChoices`/`changeRole`), so this
// module never decides who may switch what — it draws what the host answered and shows a refusal
// as the host worded it.
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call as callHost } from './api.js'
import { t } from './i18n.js'

// #1854: `projects` and `project-role` are core endpoints, dispatched by bare name in
// `core/src/host/channel.js`; a `flybot/` prefix here names an endpoint the host does not have.

export const PROJECTS_NAV_CSS = `
.bt-projects-row { display: flex; align-items: center; gap: 8px; }
.bt-projects-chevron { margin-left: auto; display: inline-flex; transition: transform 120ms ease; }
.bt-projects-row[aria-expanded="true"] .bt-projects-chevron { transform: rotate(90deg); }
.bt-projects-list { display: flex; flex-direction: column; margin: 0 0 4px; padding-left: 30px; }
.bt-project-entry { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; border: 0; background: none; color: inherit; font: inherit; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
.bt-project-entry:hover, .bt-project-entry:focus-visible { background: var(--bt-hover, rgba(127,127,127,.14)); outline: none; }
.bt-project-entry[aria-current="true"] { background: var(--bt-hover, rgba(127,127,127,.14)); }
.bt-project-entry-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-project-entry-role { margin-left: auto; opacity: .62; font-size: .85em; white-space: nowrap; }
.bt-projects-empty, .bt-projects-note { padding: 2px 8px 6px; opacity: .7; font-size: .85em; }
.bt-project-menu { position: fixed; z-index: 60; min-width: 168px; padding: 4px; border-radius: 8px; background: var(--bt-menu-bg, #1f2126); border: 1px solid var(--bt-menu-border, rgba(255,255,255,.12)); box-shadow: 0 8px 24px rgba(0,0,0,.32); }
.bt-project-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none; color: inherit; font: inherit; text-align: left; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.bt-project-menu-item:hover, .bt-project-menu-item:focus-visible { background: var(--bt-hover, rgba(127,127,127,.14)); outline: none; }
.bt-project-menu-item[aria-checked="true"]::before { content: "✓"; margin-right: 2px; }
.bt-project-menu-item:not([aria-checked="true"])::before { content: " "; margin-right: 2px; }
.bt-project-menu-item[disabled] { opacity: .6; cursor: default; }
`

const ROLE_LABELS = { owner: 'Owner', maintainer: 'Maintainer', member: 'Member' }

export function roleText(role) {
  if (role === null || role === undefined || role === '') return ''
  return t(ROLE_LABELS[role] ?? String(role))
}

// `#project=<id>` is the one entry point the board reads (`ProjectBoardOverlay`), so opening a row
// writes the hash instead of mounting a second copy of the board.
export function projectHash(id) {
  return `#project=${encodeURIComponent(String(id ?? ''))}`
}

export function projectName(project) {
  const name = typeof project?.name === 'string' ? project.name.trim() : ''
  return name === '' ? `#${project?.id ?? ''}` : name
}

// The menu lists what the host said this caller may switch to, with the current rank marked. A
// Project written before roles existed answers `role: null`, so the row reads without a rank
// rather than guessing owner-only.
export function projectMenuItems(project) {
  const current = project?.role ?? null
  const choices = Array.isArray(project?.choices) ? project.choices : []
  const items = current === null ? [] : [{ role: current, label: roleText(current), current: true, pick: false }]
  for (const role of choices) {
    if (role === current) continue
    items.push({ role, label: roleText(role), current: false, pick: true })
  }
  return items
}

// A refusal names a machine-readable reason (`not-owner`, `cannot-self-promote`, `last-owner`); the
// reader gets the code back unchanged, as the brief asks, rather than a guess at its meaning.
export function roleNote(answer) {
  if (answer?.changed === true) return t('Role changed.')
  const reason = typeof answer?.reason === 'string' && answer.reason !== '' ? answer.reason : t('refused')
  return t('Role unchanged: {reason}', { reason })
}

// The expanded list on its own, so a test can draw it without a fetch or a click.
export function ProjectList({ projects, error, note, onOpen, onRole }) {
  const rows = projects === null
    ? h('div', { className: 'bt-projects-note' }, t('Reading Projects…'))
    : error !== ''
      ? h('div', { className: 'bt-projects-note' }, error)
      : projects.length === 0
        ? h('div', { className: 'bt-projects-empty' }, t('No Projects yet'))
        : projects.map(project => h('button', {
          key: String(project.id),
          type: 'button', className: 'bt-project-entry', 'data-project-id': String(project.id),
          'aria-current': project.current === true ? 'true' : undefined,
          title: roleText(project.role) === '' ? projectName(project) : `${projectName(project)} · ${roleText(project.role)}`,
          onClick: () => onOpen?.(project.id),
          onContextMenu: (event) => { event.preventDefault(); onRole?.(project, event) },
        },
        h('span', { className: 'bt-project-entry-name' }, projectName(project)),
        roleText(project.role) === '' ? null : h('span', { className: 'bt-project-entry-role' }, roleText(project.role))))
  return h('div', { className: 'bt-projects-list', role: 'group', 'aria-label': t('Projects') },
    rows,
    note === '' || note === undefined ? null : h('div', { className: 'bt-projects-note', role: 'status' }, note))
}

function Chevron() {
  return h('svg', { width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M7.5 4.5L13 10l-5.5 5.5' }))
}

function ProjectsMark() {
  return h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M2.5 5.5h6l1.5 2h7.5v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z' }),
    h('path', { d: 'M2.5 5.5v-1a1 1 0 0 1 1-1h4l1.5 2' }))
}

// The menu is a portal at the cursor, closed by a click anywhere else, by Escape, and by picking.
export function ProjectRoleMenu({ project, x, y, onPick, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const onDown = (event) => { if (!ref.current?.contains(event.target)) onClose() }
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  const items = projectMenuItems(project)
  // A member has nothing to switch: the menu still opens and marks the rank they hold, so the
  // right-click answers "where am I" instead of doing nothing.
  return createPortal(h('div', {
    ref, className: 'bt-project-menu', role: 'menu', 'aria-label': t('My role'),
    style: { left: `${x}px`, top: `${y}px` }, 'data-project-id': String(project?.id ?? ''),
  },
  h('div', { className: 'bt-projects-note' }, projectName(project)),
  items.length === 0
    ? h('div', { className: 'bt-projects-note' }, t('No role to switch here.'))
    : items.map(item => h('button', {
      key: item.role, type: 'button', role: 'menuitemradio', className: 'bt-project-menu-item',
      'aria-checked': item.current ? 'true' : 'false', disabled: !item.pick,
      onClick: () => { if (item.pick) onPick(item.role); else onClose() },
    }, item.label))), document.body)
}

export function ProjectsNav({ wide = true, request, onOpen } = {}) {
  const read = request ?? callHost
  const open = useCallback((id) => {
    if (onOpen) { onOpen(id); return }
    if (typeof window !== 'undefined') window.location.hash = projectHash(id)
  }, [onOpen])
  const [expanded, setExpanded] = useState(false)
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [menu, setMenu] = useState(null)
  const load = useCallback(async () => {
    try {
      const listing = await read('projects')
      const list = Array.isArray(listing?.projects) ? listing.projects : []
      setProjects(list)
      setError('')
    } catch (failure) {
      setProjects([])
      setError(failure?.message ?? String(failure))
    }
  }, [read])
  useEffect(() => {
    if (!expanded) return
    void load()
  }, [expanded, load])
  const toggle = () => {
    setNote('')
    if (!wide) { void open(''); return }
    setExpanded(value => !value)
  }
  const listed = expanded && wide
  return h('div', { className: 'bt-projects' },
    h('button', {
      type: 'button', className: 'bt-row bt-projects-row', 'aria-expanded': listed ? 'true' : 'false',
      'aria-label': t('Projects'), title: wide ? undefined : t('Projects'), onClick: toggle,
    },
    h('span', { className: 'bt-projects-mark' }, h(ProjectsMark)),
    wide ? h('span', { className: 'bt-projects-label' }, t('Projects')) : null,
    wide ? h('span', { className: 'bt-projects-chevron', 'aria-hidden': true }, h(Chevron)) : null),
    listed ? h(ProjectList, { projects, error, note, onOpen: open, onRole: (project, event) => setMenu({ project, x: event.clientX, y: event.clientY }) }) : null,
    menu === null ? null : h(ProjectRoleMenu, {
      project: menu.project, x: menu.x, y: menu.y,
      onClose: () => setMenu(null),
      onPick: async (role) => {
        const project = menu.project
        setMenu(null)
        try {
          const answer = await read('project-role', { id: project.id, role })
          setNote(roleNote(answer))
          if (answer?.changed === true) void load()
        } catch (failure) {
          // The host's sentence is the answer; quoting it beats a generic failure line.
          setNote(failure?.message ?? String(failure))
        }
      },
    }))
}
