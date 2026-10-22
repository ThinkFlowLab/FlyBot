// -------------------------------------------------------------------------
// FlyBot frontend slots. Feature plugins' client bundles register into one shared
// registry at globalThis.__flybot__ (created by whichever bundle loads first), and
// ds-bot's own components render whatever is registered:
//
//   flybot.sidebar.section  { id, order, component({ roster, actions, call }) }   below the Bot list
//   flybot.sidebar.structure { id, order, parentOf(botId), include?(botId), menuItems?, nodeActions? }   the Bot list becomes one tree under the Main Bot;
//     include(botId) === false hides that Bot from the default list (e.g. tree-archived);
//                            menuItems({ bot }) → [{ id, label, visible, run({ bot }) }] adds items to a Bot's right-click
//                            menu (visible false hides one; a string from run shows as a toast; a throw as the error toast);
//                            nodeActions({ bot }) is drawn after each tree row
//   flybot.composer.mention { id, order, candidates(query, { sessionId, roster, call }) → rows }   rows in the "@" menu
//   flybot.bot.details      { id, order, component({ bot, roster, call }) }        in a Bot's settings
//   flybot.approvals        { id, order, component({ approval, decide, call }) }   custom card for a held send
//                            `inline: true` with `policy`: instead, the buttons drawn on a held reply's own bubble in the
//                            chat (#418), component({ held, decide, call, actions }); held = { id, by, status, to, toName, from }
//   flybot.room.overview    { id, order, component({ room, roster, actions, call }) }  top of a group's overview
//   flybot.session.dock     { id, order, policy?, component({ sessionId, roster, room, bot, actions, call, claim, t }) }  above the composer;
//                            a dock that draws the cards of one approval policy sets `policy` and calls claim(ids) with the
//                            approval ids it shows: the overlay then draws no second card for them (#260)
//   flybot.new-chat.action  { id, order, label, hint?, icon?, visible?, run({ close, actions, roster }) }   a row in the sidebar '+' menu (after New group chat; Face-to-face room, Add friend)
//   flybot.account.header   { id, order, component({ actions, call }) }   top of the account menu (the owner's own Bot Social handle)
//   flybot.settings.page    { id, order, label, icon?, component({ roster, actions, call, run, t, Section, Row }) }   a page in the Settings list
//                            (after Connectors); `label` is English and goes through the host's t(); the component gets the host's t(),
//                            Section(title) and Row(label, hint) so the page looks like the others and reads zh in a zh UI
//
// The same registry object also carries the host Bot look so a plugin can draw a Bot
// exactly as the sidebar does: __flybot__.BotAvatar / BotMark / lookOf, and name a friend's Bot
// or its owner the same way: __flybot__.names.friendBotTitle / friendBotOwner (set in registry()).
//
// Types: ds-bot/types/flybot.d.ts (FlyBotClientRegistry).
import { Component, createElement as h, Fragment, useEffect, useState } from 'react'
import { call as callHost } from './api.js'
import { friendBotOwner, friendBotTitle, isListedRemoteChat } from '../shared/remote-label.js'
import { registry as baseRegistry } from './flybot-registry.js'
import { BotAvatar, BotMark, lookOf } from './mark.js'
import { t } from './i18n.js'
import { chatOpened, claimApprovals, claimedIds, onClaims } from './approval-claims.js'
import { isApprovalWaiting, WAITING_STATUSES } from './approval-waiting.js'

import { createClientApi as createClientApiWith } from './flybot-registry.js'

export { chatOpened, claimApprovals } from './approval-claims.js'
export { SLOTS, createRegistry, mentionCandidates, newChatActionRows, botTree } from './flybot-registry.js'

// Calls a FlyBot endpoint on the host: "approvals", "decide", or a plugin's "social/...".
export const call = (endpoint, payload) => callHost(`flybot/${endpoint}`, payload)

export function registry() {
  const slots = baseRegistry()
  globalThis.__flybot__.call ??= call
  // Classic-script plugins cannot import mark.js; they render the same Bot look
  // the sidebar / session list / chat header use via these host components.
  globalThis.__flybot__.BotMark ??= BotMark
  globalThis.__flybot__.BotAvatar ??= BotAvatar
  globalThis.__flybot__.lookOf ??= lookOf
  // The same for a friend's Bot's one name and its owner (#498), so the social plugin says it as the sidebar does.
  globalThis.__flybot__.names ??= { friendBotTitle, friendBotOwner }
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
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children }
}
// A plugin's + menu mark (#385), behind its own boundary: a mark that throws shows `fallback`, not a broken menu.
export function SlotIcon({ id, icon, fallback }) {
  return h(SlotBoundary, { id, fallback }, h(icon))
}
function Safe({ entry, props }) {
  return h(SlotBoundary, { id: entry.id }, h(entry.component, props))
}

// Pages plugins add to Settings (flybot.settings.page), in order.
export function useSettingsPages() {
  return useSlot('flybot.settings.page')
}

// Renders a plugin's Settings page without letting its failure close the dialog.
export function SettingsPageSlot({ entry, props }) {
  return h(Safe, { entry, props })
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

// Approval ids a dock draws in its chat. The overlay skips them, so one approval has one card, in the
// chat it belongs to; an approval no open chat shows becomes a small pointer to that chat instead (#260).
// The claims live in approval-claims.js, which a chat cell can import without the slot components (#418).
function useClaimed() {
  const [claimed, setClaimed] = useState(claimedIds)
  useEffect(() => {
    const fn = () => setClaimed(claimedIds())
    const off = onClaims(fn)
    fn()
    return off
  }, [])
  return claimed
}

export function FlyBotSessionDock({ sessionId, useRoster, actions }) {
  const entries = useSlot('flybot.session.dock')
  useEffect(() => {
    if (!sessionId) return undefined
    chatOpened(sessionId, 1)
    return () => chatOpened(sessionId, -1)
  }, [sessionId])
  const roster = typeof useRoster === 'function' ? useRoster(value => value) : undefined
  if (entries.length === 0) return null
  const room = roster?.roomsById?.[sessionId]
  const bot = room ? undefined : roster?.byId?.[sessionId]
  return h(Fragment, null, entries.map(entry => h('div', { key: entry.id, className: 'bt-flybot-session-dock', 'data-flybot': entry.id },
    h(Safe, { entry, props: { sessionId, roster, room, bot, actions, call, t, claim: ids => claimApprovals(`${entry.id}:${sessionId}`, ids) } }))))
}

export function FlyBotRoomOverview({ room, roster, actions }) {
  const entries = useSlot('flybot.room.overview')
  if (entries.length === 0) return null
  return h(Fragment, null, entries.map(entry => h('div', { key: entry.id, className: 'bt-flybot-room-overview', 'data-flybot': entry.id },
    h(Safe, { entry, props: { room, roster, actions, call } }))))
}

export function FlyBotAccountHeader({ actions }) {
  const entries = useSlot('flybot.account.header')
  if (entries.length === 0) return null
  return h(Fragment, null, entries.map(entry => h('div', { key: entry.id, className: 'bt-flybot-account-header', 'data-flybot': entry.id },
    h(Safe, { entry, props: { actions, call } }))))
}

// `wrap` draws the entries inside a host frame (Bot settings' titled card); with no entries it draws nothing.
export function FlyBotDetails({ bot, roster, actions, wrap }) {
  const entries = useSlot('flybot.bot.details')
  if (entries.length === 0) return null
  const list = entries.map(entry => h('div', { key: entry.id, className: 'bt-flybot-details', 'data-flybot': entry.id },
    h(Safe, { entry, props: { bot, roster, actions, call } })))
  return wrap ? wrap(list) : h(Fragment, null, list)
}

const POLL_MS = 5000

// The owner's queue of held sends. An approval a chat dock draws (its policy is a dock's `policy`) has
// its card in the chat it belongs to and nowhere else; when no open chat shows it, a small line points
// to that chat. Any other approval is a card here: approve or reject. A plugin's flybot.approvals entry
// may draw the card for its own policy's approvals. Same two lines on every card: what it is, then
// "Sender → Recipient" (#260).
const POINTER_DELAY_MS = 1200
const handleOf = ref => (typeof ref === 'object' && ref ? ref.handle : typeof ref === 'string' && ref.startsWith('@') ? ref : undefined)
const friendChatOf = (approval, roster) => {
  const handle = handleOf(approval.request?.to)
  return handle ? (roster?.bots ?? []).find(item => item.remote && String(item.remote.handle ?? '').toLowerCase() === handle.toLowerCase()) : undefined
}
// The one chat an approval belongs to: its room, else the friend's chat it is addressed to, else the
// Bot that wrote it (#278). The chat's dock draws its card; the pointer opens that chat.
// A Bot's held reply to a friend is decided on its bubble in the chat it answers (#418).
const chatOf = (approval, roster) => approval.request?.meta?.roomId ?? approval.request?.meta?.replyIn?.sessionId ?? friendChatOf(approval, roster)?.id ?? (typeof approval.request?.from === 'string' ? approval.request.from : undefined)
// The person who gets it (#418, #498): the host's `recipientName`, else the owner of the friend's chat,
// else what the host called it. "Chief → SelfB1233", never two Bot names side by side.
function recipientName(approval, roster) {
  const handle = handleOf(approval.request?.to)
  const bot = friendChatOf(approval, roster)
  return approval.recipientName || (bot ? friendBotOwner(bot) : '') || approval.targetName || handle || String(approval.request?.to ?? '')
}

export function FlyBotApprovals({ useRoster, actions } = {}) {
  const entries = useSlot('flybot.approvals')
  const docks = useSlot('flybot.session.dock')
  const claimed = useClaimed()
  const roster = typeof useRoster === 'function' ? useRoster(value => value) : undefined
  const [pending, setPending] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [shown, setShown] = useState('')
  // The dock asks the host for the statuses the shared rule calls waiting, plus `failed` (retry).
  const refresh = () => call('approvals', { status: [...WAITING_STATUSES, 'failed'] }).then(list => setPending(Array.isArray(list) ? list : [])).catch(() => {})
  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [])
  const policies = new Set(docks.map(entry => entry.policy).filter(Boolean))
  const open = pending.filter(approval => !claimed.has(approval.id))
  const cards = open.filter(approval => !policies.has(approval.by))
  // An approval of the chat that is open is that chat's to show, never a pointer (#271).
  const inOpenChat = approval => {
    const chat = chatOf(approval, roster)
    return Boolean(chat) && (claimed.chats?.has(chat) === true || claimed.chats?.has(roster?.byId?.[chat]?.sessionId) === true)
  }
  const away = open.filter(approval => policies.has(approval.by) && isApprovalWaiting(approval.status) && !inOpenChat(approval))
  // Only when no chat took it for a moment: moving between chats must not flash the pointer.
  const awayKey = away.map(approval => approval.id).join(',')
  useEffect(() => {
    if (!awayKey) { setShown(''); return undefined }
    const timer = setTimeout(() => setShown(awayKey), POINTER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [awayKey])
  // Every hook above runs on every render: a hook after an early return made React throw
  // ("Rendered more hooks") the moment the first held message arrived, so no card ever drew (#254).
  const pointers = shown === awayKey && awayKey ? away : []
  if (cards.length === 0 && pointers.length === 0) return null
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
  const byChat = new Map()
  for (const approval of pointers) {
    const key = chatOf(approval, roster) ?? approval.id
    byChat.set(key, [...(byChat.get(key) ?? []), approval])
  }
  return h(Fragment, null,
    byChat.size > 0 ? h('div', { className: 'bt-flybot-pointers', role: 'status', 'aria-label': t('Messages waiting for your approval') },
      [...byChat].map(([chat, list]) => h('div', { key: chat, className: 'bt-flybot-pointer' },
        h('span', { className: 'bt-flybot-pointer-text' },
          t('{from} → {to}', { from: list[0].senderName ?? t('A Bot'), to: recipientName(list[0], roster) }),
          list.length > 1 ? ` ${t('+{count} more', { count: list.length - 1 })}` : ''),
        h('span', { className: 'bt-flybot-pointer-note' }, t('Waiting for approval')),
        typeof actions?.openSession === 'function' && chatOf(list[0], roster) ? h('button', { type: 'button', onClick: () => actions.openSession(chatOf(list[0], roster)) }, t('Review')) : null))) : null,
    cards.length > 0 ? h('div', { className: 'bt-flybot-approvals', role: 'region', 'aria-label': t('Messages waiting for your approval') },
      cards.map((approval) => {
        const custom = entries.find(entry => entry.inline !== true && (entry.policy === undefined || entry.policy === approval.by))
        if (custom) return h('div', { key: approval.id }, h(Safe, { entry: custom, props: { approval, decide: decision => decide(approval.id, decision), call } }))
        const failed = approval.status === 'failed'
        const waiting = isApprovalWaiting(approval.status)
        return h('div', { key: approval.id, className: 'bt-flybot-approval', title: approval.reason ?? undefined },
          h('div', { className: 'bt-flybot-approval-head' }, failed ? t('Not sent') : t('Waiting for approval')),
          h('div', { className: 'bt-flybot-approval-origin' },
            t('{from} → {to}', { from: approval.senderName ?? t('A Bot'), to: recipientName(approval, roster) }),
            approval.request.hop > 0 ? ` · ${t('delegated')}` : ''),
          failed && approval.error ? h('div', { className: 'bt-flybot-approval-error' }, approval.error) : null,
          h('div', { className: 'bt-flybot-approval-text' }, approval.request.text),
          approval.request.attachments?.length
            ? h('ul', { className: 'bt-flybot-approval-files', 'aria-label': t('Attached files') }, approval.request.attachments.map((file, index) =>
              h('li', { key: index, title: file.path ?? file.name }, `${file.name} · ${fileSize(file.size)}`, file.path ? h('div', { className: 'bt-flybot-approval-path' }, file.path) : null)))
            : null,
          h('div', { className: 'bt-flybot-approval-actions' },
            failed ? h('button', { type: 'button', disabled: busy === approval.id, onClick: () => decide(approval.id, 'retry') }, t('Retry')) : null,
            waiting ? h('button', { type: 'button', disabled: busy === approval.id, onClick: () => decide(approval.id, 'reject') }, t('Reject')) : null,
            waiting ? h('button', { type: 'button', className: 'bt-flybot-approve', disabled: busy === approval.id, onClick: () => decide(approval.id, 'approve') }, t('Approve')) : null))
      }).concat(error ? [h('div', { key: 'error', className: 'bt-flybot-approval-error', role: 'alert' }, error)] : [])) : null)
}

export const fileSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

export const FLYBOT_CSS = `
.bt-flybot-session-dock{width:100%;max-width:min(992px,100%);margin:0 auto;padding:0 0 6px;box-sizing:border-box}
.bt-flybot-session-dock [data-flybot=chat-approvals]{align-items:flex-end;padding-bottom:4px}
.bt-flybot-session-dock .fs-hold{margin-left:auto}
.bt-flybot-approval-files { margin: 0 0 8px; padding-left: 18px; font-size: 12px; }
.bt-file-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 0 30px; }
.bt-file-chip { font-size: 12px; padding: 3px 8px; border-radius: 8px; border: 1px solid var(--bt-line, rgba(0,0,0,.15)); background: transparent; cursor: pointer; }

.bt-flybot-section { margin-top: 8px; border-top: 1px solid var(--bt-line, rgba(0,0,0,.08)); padding-top: 6px; }
.bt-flybot-approvals { position: fixed; right: 16px; bottom: 16px; z-index: 50; display: flex; flex-direction: column; gap: 8px; max-width: 360px; max-height: calc(100vh - 32px); overflow-y: auto; }
.bt-flybot-approval-error { color: var(--bt-danger, #d33); font-size: 12px; }
.bt-flybot-approval { background: var(--bt-card, #fff); border: 1px solid var(--bt-line, rgba(0,0,0,.12)); border-radius: 10px; padding: 10px 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12); font-size: 13px; }
.bt-flybot-approval-head { font-weight: 600; margin-bottom: 4px; }
.bt-flybot-approval-origin { font-size: 12px; opacity: .7; margin-bottom: 4px; }
.bt-flybot-approval-text { white-space: pre-wrap; max-height: 120px; overflow: auto; margin-bottom: 8px; }
.bt-flybot-approval-path { font-family: ui-monospace, monospace; font-size: 11px; opacity: .7; overflow-wrap: anywhere; }
.bt-flybot-approval-actions { display: flex; gap: 8px; justify-content: flex-end; }
.bt-flybot-approve { font-weight: 600; }
.bt-held-reply[data-state=pending] .bt-bubble { background: transparent; border: 1px dashed var(--bt-line-2); color: var(--bt-ink-2); }
.bt-held-reply[data-state=rejected] .bt-bubble, .bt-held-reply[data-state=failed] .bt-bubble { background: transparent; border: 1px dashed var(--bt-line-2); color: var(--bt-ink-3); }
.bt-held-actions { margin: 6px 0 2px; max-width: 420px; }
.bt-held-card { background: var(--bt-card, #fff); border: 1px solid var(--bt-line, rgba(0,0,0,.12)); border-radius: 10px; padding: 8px 10px; font-size: 13px; }
.bt-held-head { font-weight: 600; margin-bottom: 2px; }
.bt-held-note { margin: 2px 0 0; font-size: 12px; color: var(--bt-ink-3); display: flex; gap: 8px; align-items: center; }
.bt-held-note[data-state=failed] { color: var(--bt-danger, #d33); }
.bt-held-retry { border: 0; background: transparent; color: var(--bt-accent, #2563eb); font-size: 12px; cursor: pointer; padding: 0; }
.bt-flybot-pointers { position: fixed; top: 12px; right: 16px; z-index: 50; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; max-width: 360px; }
.bt-flybot-pointer { display: flex; align-items: center; gap: 8px; background: var(--bt-card, #fff); border: 1px solid var(--bt-line, rgba(0,0,0,.12)); border-radius: 999px; padding: 5px 6px 5px 12px; box-shadow: 0 2px 10px rgba(0,0,0,.1); font-size: 12px; }
.bt-flybot-pointer-text { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.bt-flybot-pointer-note { opacity: .65; white-space: nowrap; }
.bt-flybot-pointer button { border: 0; border-radius: 999px; padding: 3px 10px; font-size: 12px; cursor: pointer; background: var(--bt-accent, #2563eb); color: #fff; }
`
