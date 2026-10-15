// -------------------------------------------------------------------------
// FlyBot frontend slots. Feature plugins' client bundles register into one shared
// registry at globalThis.__flybot__ (created by whichever bundle loads first), and
// ds-bot's own components render whatever is registered:
//
//   flybot.sidebar.section  { id, order, component({ roster, actions, call }) }   below the Bot list
//   flybot.sidebar.structure { id, order, parentOf(botId), menuItems?, nodeActions? }   the Bot list becomes one tree under the Main Bot;
//                            menuItems({ bot }) → [{ id, label, visible, run({ bot }) }] adds items to a Bot's right-click
//                            menu (visible false hides one; a string from run shows as a toast; a throw as the error toast);
//                            nodeActions({ bot }) is drawn after each tree row
//   flybot.composer.mention { id, order, candidates(query, { sessionId, roster, call }) → rows }   rows in the "@" menu
//   flybot.bot.details      { id, order, component({ bot, roster, call }) }        in a Bot's settings
//   flybot.approvals        { id, order, component({ approval, decide, call }) }   custom card for a held send
//   flybot.room.overview    { id, order, component({ room, roster, actions, call }) }  top of a group's overview
//   flybot.session.dock     { id, order, component({ sessionId, roster, room, bot, actions, call }) }  above the composer
//   flybot.new-chat.action  { id, order, label, hint?, visible?, run({ close, actions, roster }) }   a row in the sidebar '+' menu (next to Create group chat)
//
// Types: ds-bot/types/flybot.d.ts (FlyBotClientRegistry).
import { Component, createElement as h, Fragment, useEffect, useState } from 'react'
import { call as callHost } from './api.js'
import { isListedRemoteChat } from '../shared/remote-label.js'
import { registry as baseRegistry } from './flybot-registry.js'
import { t } from './i18n.js'

import { createClientApi as createClientApiWith } from './flybot-registry.js'

export { SLOTS, createRegistry, mentionCandidates, newChatActionRows, botTree } from './flybot-registry.js'

// Calls a FlyBot endpoint on the host: "approvals", "decide", or a plugin's "social/...".
export const call = (endpoint, payload) => callHost(`flybot/${endpoint}`, payload)

export function registry() {
  const slots = baseRegistry()
  globalThis.__flybot__.call ??= call
  return slots
}

// The browser `flybot` service bound to this bundle's host route.
export const createClientApi = (options = {}) => createClientApiWith({ call, registry, ...options })

function useSlot(name) {
  const slots = registry()
  const [, setVersion] = useState(0)
  useEffect(() => slots.subscribe(() => setVersion(slots.version())), [slots])
  return slots.entries(name)
}

// Renders a plugin component without letting its failure take the sidebar down.
// A plugin component that throws (in render or in an effect) draws nothing; the rest of
// the sidebar keeps working.
class SlotBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { console.error(`flybot: ${this.props.id} failed`, error) }
  render() { return this.state.failed ? null : this.props.children }
}
function Safe({ entry, props }) {
  return h(SlotBoundary, { id: entry.id }, h(entry.component, props))
}

// The first 'flybot.sidebar.structure' entry, or undefined: the sidebar then lists Bots flat.
export function useSidebarStructure() {
  return useSlot('flybot.sidebar.structure')[0]
}

// Sections get { roster, actions, call, renderBot, remoteChats }: renderBot(bot) draws a
// Bot row exactly like the team's (avatar, preview, unread, click to open); remoteChats
// are the friends' Bots that have a chat here (bot.remote: { handle, home, homeName }).
export function FlyBotSections({ roster, actions, renderBot }) {
  // Entries from the FlyBot registry plus any a plugin put in DSH's own slot of that name.
  const shell = (actions.flybotSlotEntries?.('flybot.sidebar.section') ?? [])
    .map((entry, index) => ({ id: entry.id ?? `slot-${index}`, order: entry.order ?? 0, component: entry.component }))
  const entries = [...useSlot('flybot.sidebar.section'), ...shell].sort((a, b) => a.order - b.order)
  const remoteChats = (roster.bots ?? []).filter(bot => bot.remote && isListedRemoteChat(bot))
  return h(Fragment, null, entries.map(entry => h('div', { key: entry.id, className: 'bt-flybot-section', 'data-flybot': entry.id },
    h(Safe, { entry, props: { roster, actions, call, renderBot, remoteChats } }))))
}

export function FlyBotSessionDock({ sessionId, useRoster, actions }) {
  const entries = useSlot('flybot.session.dock')
  const roster = typeof useRoster === 'function' ? useRoster(value => value) : undefined
  if (entries.length === 0) return null
  const room = roster?.roomsById?.[sessionId]
  const bot = room ? undefined : roster?.byId?.[sessionId]
  return h(Fragment, null, entries.map(entry => h('div', { key: entry.id, className: 'bt-flybot-session-dock', 'data-flybot': entry.id },
    h(Safe, { entry, props: { sessionId, roster, room, bot, actions, call } }))))
}

export function FlyBotRoomOverview({ room, roster, actions }) {
  const entries = useSlot('flybot.room.overview')
  if (entries.length === 0) return null
  return h(Fragment, null, entries.map(entry => h('div', { key: entry.id, className: 'bt-flybot-room-overview', 'data-flybot': entry.id },
    h(Safe, { entry, props: { room, roster, actions, call } }))))
}

export function FlyBotDetails({ bot, roster }) {
  const entries = useSlot('flybot.bot.details')
  if (entries.length === 0) return null
  return h(Fragment, null, entries.map(entry => h('div', { key: entry.id, className: 'bt-flybot-details', 'data-flybot': entry.id },
    h(Safe, { entry, props: { bot, roster, call } }))))
}

const POLL_MS = 5000

// The owner's queue of held sends: a card each, approve or reject. A plugin's
// flybot.approvals entry may draw the card for its own policy's approvals.
export function FlyBotApprovals() {
  const entries = useSlot('flybot.approvals')
  const [pending, setPending] = useState([])
  const [busy, setBusy] = useState('')
  const refresh = () => call('approvals', { status: ['pending', 'failed'] }).then(list => setPending(Array.isArray(list) ? list : [])).catch(() => {})
  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [])
  if (pending.length === 0) return null
  const [error, setError] = useState('')
  const decide = async (id, decision) => {
    setBusy(id)
    setError('')
    try {
      await call('decide', { id, decision })
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy('')
      await refresh()
    }
  }
  return h('div', { className: 'bt-flybot-approvals', role: 'region', 'aria-label': t('Messages waiting for your approval') },
    pending.map((approval) => {
      const custom = entries.find(entry => entry.policy === undefined || entry.policy === approval.by)
      if (custom) return h('div', { key: approval.id }, h(Safe, { entry: custom, props: { approval, decide: decision => decide(approval.id, decision), call } }))
      const to = typeof approval.request.to === 'object' ? approval.request.to.handle : approval.request.to
      return h('div', { key: approval.id, className: 'bt-flybot-approval' },
        h('div', { className: 'bt-flybot-approval-head' }, approval.status === 'failed' ? t('Not sent to {to} · {reason}', { to, reason: approval.error ?? t('failed') }) : t('Message to {to} · {reason}', { to, reason: approval.reason })),
        h('div', { className: 'bt-flybot-approval-text' }, approval.request.text),
        approval.request.attachments?.length
          ? h('ul', { className: 'bt-flybot-approval-files', 'aria-label': t('Attached files') }, approval.request.attachments.map((file, index) =>
            h('li', { key: index, title: file.path ?? file.name }, `${file.name} · ${fileSize(file.size)}`, file.path ? h('div', { className: 'bt-flybot-approval-path' }, file.path) : null)))
          : null,
        h('div', { className: 'bt-flybot-approval-actions' },
          approval.status === 'failed' ? h('button', { type: 'button', disabled: busy === approval.id, onClick: () => decide(approval.id, 'retry') }, t('Retry')) : null,
          approval.status === 'failed' ? null : h('button', { type: 'button', disabled: busy === approval.id, onClick: () => decide(approval.id, 'approve') }, t('Approve')),
          approval.status === 'failed' ? null : h('button', { type: 'button', disabled: busy === approval.id, onClick: () => decide(approval.id, 'reject') }, t('Reject'))))
    }),
    error ? h('div', { className: 'bt-flybot-approval-error', role: 'alert' }, error) : null)
}

export const fileSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

export const FLYBOT_CSS = `
.bt-flybot-approval-files { margin: 0 0 8px; padding-left: 18px; font-size: 12px; }
.bt-file-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 0 30px; }
.bt-file-chip { font-size: 12px; padding: 3px 8px; border-radius: 8px; border: 1px solid var(--bt-line, rgba(0,0,0,.15)); background: transparent; cursor: pointer; }

.bt-flybot-section { margin-top: 8px; border-top: 1px solid var(--bt-line, rgba(0,0,0,.08)); padding-top: 6px; }
.bt-flybot-approvals { position: fixed; right: 16px; bottom: 16px; z-index: 50; display: flex; flex-direction: column; gap: 8px; max-width: 360px; max-height: calc(100vh - 32px); overflow-y: auto; }
.bt-flybot-approval-error { color: var(--bt-danger, #d33); font-size: 12px; }
.bt-flybot-approval { background: var(--bt-card, #fff); border: 1px solid var(--bt-line, rgba(0,0,0,.12)); border-radius: 10px; padding: 10px 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12); font-size: 13px; }
.bt-flybot-approval-head { font-weight: 600; margin-bottom: 4px; }
.bt-flybot-approval-text { white-space: pre-wrap; max-height: 120px; overflow: auto; margin-bottom: 8px; }
.bt-flybot-approval-path { font-family: ui-monospace, monospace; font-size: 11px; opacity: .7; overflow-wrap: anywhere; }
.bt-flybot-approval-actions { display: flex; gap: 8px; justify-content: flex-end; }
`
