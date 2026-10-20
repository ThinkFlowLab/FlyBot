import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { isMainOf } from './sources.js'
import { HEADER, currentPart, stripHeader, usageOf } from './text.js'
import { PlusIcon, ShareIcon, CloseIcon, ChevronLeftIcon, GearIcon } from './icons.js'
import { botState, BotMark, BotAvatar, RoomAvatar, lookBotForRemote } from './mark.js'
import { GlobeIcon, Favicon } from './browser-pane.js'
import { useEscape } from './overlay-hooks.js'
import { BotSettingsForm } from './bot-settings.js'
import { FaceLead, FacePersonRow, GroupSettingsForm, ROOM_MODES, facePeople, roomSubtitle, shownMode } from './group-settings.js'
import { ModelMenu, modelOf } from './model-menu.js'
import { FolderMenu } from './folder-menu.js'
import { MemoryRow } from './memory-panel.js'
import { ScheduleSummary } from './schedules.js'
import { Segmented, useGlide, useMorph } from './motion.js'
import { MemberWork, useMemberWork } from './member-status.js'
import { t } from './i18n.js'
import { remoteBotTitle, sharedRoomTitle } from '../shared/remote-label.js'
import { FlyBotRoomOverview, FlyBotDetails } from './flybot-slots.js'
import { call } from './api.js'

function transcriptOf(list, id, name, hiddenTurns = []) {
  const outline = list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId[id]?.projectionValues?.turnOutline
  if (!Array.isArray(outline)) return ''
  const lines = []
  for (const entry of outline) {
    if (hiddenTurns.includes(entry.turn)) continue
    if (entry.prompt && !HEADER.test(entry.prompt)) lines.push(`**${t('You')}:** ${entry.prompt.trim()}`)
    if (entry.response) lines.push(`**${name}:** ${stripHeader(entry.response).trim()}`)
  }
  return lines.join('\n\n')
}

const TAB_LABELS = { details: 'Details', browser: 'Browser' }

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
const shortUrl = url => String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
const EMPTY_TABS = { ids: [], active: null }

// The Bot's browser inside the details page: its tabs as small window cards on
// Desktop, a pointer there on web.
const PERMISSION_LABELS = { 'read-only': 'Read only', 'workspace-write': 'Workspace', 'danger-full-access': 'Full access' }
const DANGER = new Set(['danger-full-access'])

// The Bot's permission preset, from the presets DeepSeek Harness offers.
function PermissionRow({ bot, roster, actions, run }) {
  const [pending, setPending] = useState(null)
  const catalog = roster.permissions
  const saved = bot.permission ?? catalog?.defaultPreset
  useEffect(() => { if (pending === saved) setPending(null) }, [pending, saved])
  if (!catalog?.options?.length) return null
  const current = pending ?? saved
  const pick = (value) => {
    // A Bot without its own preset may run on another one set in DSH, so its first pick always applies.
    if (value === current && bot.permission !== undefined) return
    setPending(value)
    void run(actions.updateBot(bot.id, { permission: value })).catch(() => setPending(null))
  }
  return h('div', { className: 'bt-drawer-permission' },
    h('div', { className: 'bt-section-title' }, t('Permissions')),
    h(Segmented, { label: t('Permissions'), value: current },
      catalog.options.map(option => h('button', {
        key: option.value, type: 'button', 'aria-pressed': option.value === current,
        title: option.description, onClick: () => pick(option.value),
        className: DANGER.has(option.value) ? 'bt-perm-danger' : undefined,
      }, PERMISSION_LABELS[option.value] ? t(PERMISSION_LABELS[option.value]) : option.name))))
}

function BrowserCards({ bot, sessionId, roster, actions, useBrowserTabs, useBrowserPages }) {
  const state = useBrowserTabs(map => map[bot.id] ?? EMPTY_TABS)
  const pages = useBrowserPages(map => map)
  useEffect(() => { actions.browserEnsure?.(bot.id) }, [bot.id])
  if (roster.browser !== true || !actions.browserShow) {
    return h('div', { className: 'bt-muted' }, t('The browser is in the DSH Desktop app.'))
  }
  if (state.ids.length === 0) {
    return h('div', { className: 'bt-browser-empty-mark' },
      h(BotMark, { bot, size: 40, state: 'idle', live: true }),
      h('div', { className: 'bt-browser-empty-title' }, t("{name}'s browser", { name: bot.name })),
      h('div', { className: 'bt-muted' }, t('Open a page here and {name} can read it with you. Logins and cookies stay with {name}; other Bots never see them.', { name: bot.name })),
      h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => actions.openBrowser(sessionId) }, t('Open browser')))
  }
  return h('div', { className: 'bt-bcards' },
    state.ids.map((tabId, index) => {
      const page = pages[tabId] ?? {}
      const label = page.title || shortUrl(page.url) || t('New tab')
      return h('div', { key: tabId, className: 'bt-bcard', 'data-active': state.active === tabId || undefined, style: { animationDelay: `${index * 30}ms` } },
        h('button', { type: 'button', className: 'bt-bcard-shot', 'aria-label': t('Open {title}', { title: label }), title: page.url, onClick: () => actions.browserPick(sessionId, tabId) },
          page.excerpt
            ? h('span', { className: 'bt-bcard-preview' },
                h('span', { className: 'bt-bcard-ptitle' }, label),
                h('span', { className: 'bt-bcard-excerpt' }, page.excerpt))
            : h('span', { className: 'bt-bcard-blank' }, h(GlobeIcon), h('span', null, label))),
        h('button', {
          type: 'button', className: 'bt-bcard-x', 'aria-label': t('Close tab'), title: t('Close tab'),
          onClick: () => { void actions.browserCloseTab(bot.id, tabId) },
        }, '×'),
        h('div', { className: 'bt-bcard-row' },
          h(Favicon, { src: page.favicon, className: 'bt-bcard-fav' }),
          h('span', { className: 'bt-bcard-title' }, label),
          page.url ? h('span', { className: 'bt-bcard-host' }, hostOf(page.url)) : null))
    }),
    h('button', { type: 'button', className: 'bt-bcard-new', style: { animationDelay: `${state.ids.length * 30}ms` }, onClick: () => actions.browserNewTab(sessionId) }, h(PlusIcon), t('New tab')))
}

// About: a Bot's instructions or a group's notice in the overview, folded to five lines.
function About({ text, title = 'About' }) {
  const [open, setOpen] = useState(false)
  const long = text.split('\n').length > 5 || text.length > 240
  const body = useRef(null)
  useMorph(body, open)
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t(title)),
    h('div', { ref: body, className: 'bt-about', 'data-open': open || undefined }, text),
    long ? h('button', { type: 'button', className: 'bt-more', onClick: () => setOpen(value => !value) }, open ? t('Show less') : t('Show more')) : null)
}

// A group's overview: what members read, who is in it, and who answers. Changes are
// made in its settings.
function SharedRoomApprovals({ room }) {
  const [items, setItems] = useState(room.pendingApprovals ?? [])
  const [busy, setBusy] = useState('')
  const face = room.origin === 'face-to-face'
  useEffect(() => {
    const haveItems = Array.isArray(room.pendingApprovals) && room.pendingApprovals.length
    if (haveItems) setItems(room.pendingApprovals)
    if (room.viewerRole !== 'invited-owner' && !face) return undefined
    let alive = true
    call('social/status', {}).then((value) => {
      if (!alive) return
      if (room.viewerRole === 'invited-owner' && !haveItems) {
        setItems(Array.isArray(value?.approvals) ? value.approvals : [])
      }
    }, () => {})
    return () => { alive = false }
  }, [room.id, room.viewerRole, room.pendingCount, face])
  if ((room.viewerRole !== 'invited-owner' && !face) || !items.length) return null
  const decide = async (item, decision) => {
    setBusy(item.id)
    try {
      await call('social/decide-approval', { approvalId: item.id, decision })
      setItems(list => list.filter(entry => entry.id !== item.id))
    } finally { setBusy('') }
  }
  return h('div', { key: 'approvals', className: 'bt-shared-wait', 'data-flybot': 'room-pending-approvals' },
    h('div', { className: 'bt-section-title' }, t('Waiting for your approval'), h('span', { className: 'bt-chip' }, t('{count} to approve', { count: items.length }))),
    items.map(item => h('div', { key: item.id, className: 'bt-set-row' },
      h('span', { className: 'bt-set-copy' }, item.text || item.summary || item.to || t('Outbound reply')),
      h('button', { type: 'button', className: 'bt-mini', disabled: busy === item.id, onClick: () => decide(item, 'approve') }, t('Approve')),
      h('button', { type: 'button', className: 'bt-mini', disabled: busy === item.id, onClick: () => decide(item, 'reject') }, t('Reject')))))
}

// One row per person, each with the Bots they brought; my own Bot opens its chat (#229, #457).
// The count is people, not Bots.
// The room lead (#476) sits above the people: the creator picks it with a button, never in chat.
function FaceMembers({ room, roster, actions }) {
  const people = facePeople(room, roster)
  const pick = bot => call('social/face-lead', { roomId: room.id, bot })
  return h('div', null,
    h(FaceLead, { room, roster, pick }),
    h('div', { className: 'bt-section-title' }, t('Members · {count}', { count: people.length })),
    h('div', { className: 'bt-members', role: 'list' }, people.map(person => h(FacePersonRow, {
      key: person.key, person, className: 'bt-member', onOpenBot: id => actions.openSession(id), lead: room.face?.lead?.handle,
    }))))
}

function GroupOverview({ room, roster, actions, usage, useWork, openSettings }) {
  const live = room.presentedParticipants ?? room.participants ?? []
  const humans = live.filter(p => p.kind === 'human' && p.leftSeq === undefined)
  const remotes = live.filter(p => p.remote && p.leftSeq === undefined)
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const { entries, now } = useMemberWork(room, useWork)
  const invited = room.viewerRole === 'invited-owner'
  const title = room.displayName || (room.sharedFrom ? sharedRoomTitle(room.sharedFrom.inviterName) : room.name)
  const leaveMine = () => {
    const mine = remotes.find(p => p.ownerId === roster.self?.memberId)
      || members.find(member => member.ownerId === roster.self?.memberId)
    if (mine) void actions.updateRoom(room.id, { removeParticipants: [{ kind: 'bot', id: mine.handle || mine.id, remote: Boolean(mine.handle) }] })
  }
  const face = room.origin === 'face-to-face'
  return [
    h(FlyBotRoomOverview, { key: 'plugin-overview', room, roster, actions }),
    invited && room.sharedFrom && !face
      ? h('div', { key: 'from', className: 'bt-shared-from' },
        h('div', { className: 'bt-section-title' }, title),
        h('div', { className: 'bt-set-hint' }, t('Your Bot was invited to this room by {name}', { name: room.sharedFrom.inviterName })),
        room.sharedFrom.invitedAt ? h('div', { className: 'bt-set-hint' }, t('Invited {when}', { when: new Date(room.sharedFrom.invitedAt).toLocaleString() })) : null,
        h('button', { type: 'button', className: 'bt-more', onClick: leaveMine }, t('Remove my Bot')))
      : face
        ? null
        : room.notice
          ? h(About, { key: 'notice', title: 'Notice', text: room.notice })
          : h('button', { key: 'notice', type: 'button', className: 'bt-more', onClick: openSettings }, t('Add a notice in group settings')),
    face ? null : h(SharedRoomApprovals, { key: 'approvals', room }),
    face && (room.face?.status === 'candidate' || room.face?.status === 'joining')
      ? null
      : face
        ? h(FaceMembers, { key: 'members', room, roster, actions })
        : h('div', { key: 'members' },
      h('div', { className: 'bt-section-title' }, t('Members · {count}', { count: members.length + humans.length + remotes.length })),
      h('div', { className: 'bt-members', role: 'list' }, [
        ...humans.map(person => h('div', { key: person.id, role: 'listitem' },
          h('div', { className: 'bt-member' },
            h('span', { className: 'bt-member-name' }, h('span', null, person.displayName || person.id)),
            h('span', { className: 'bt-chip' }, t('Human')),
            person.role === 'admin' ? h('span', { className: 'bt-chip bt-chip-admin' }, t('Admin')) : null))),
        ...remotes.map(person => h('div', { key: person.handle || person.id, role: 'listitem' },
          h('div', { className: 'bt-member' },
            h('span', { className: 'bt-member-name' },
              h(BotAvatar, { bot: lookBotForRemote(person, roster), size: 26, badge: false, live: false }),
              h('span', null, person.label || remoteBotTitle(person))),
            face ? null : h('span', { className: 'bt-chip' }, t('Friend\'s Bot'))))),
        ...members.map((member) => {
        const entry = entries.find(item => item.id === member.id)
        return h('div', { key: member.id, role: 'listitem' },
          h('div', { className: 'bt-member' },
            h('button', { type: 'button', className: 'bt-member-name', title: t("Open {name}'s chat", { name: member.name }), onClick: () => actions.openSession(member.id) },
              h(BotAvatar, { bot: member, size: 26, main: isMainOf(roster, member.id), admin: room.admin === member.id, live: false }),
              h('span', null, member.name)),
            room.admin === member.id ? h('span', { className: 'bt-chip bt-chip-admin' }, t('Admin')) : null),
          entry ? h(MemberWork, { entry, bot: member, room, roster, actions, now }) : null)
      })])),
    face ? null : h('div', { key: 'mode' }, h('div', { className: 'bt-section-title' }, t('Who answers')),
      h('div', { className: 'bt-kv' }, h('span', null, t(ROOM_MODES.find(([id]) => id === shownMode(room, roster))?.[1] ?? 'Everyone')))),
    face || !usage ? null : h('div', { key: 'usage' }, h('div', { className: 'bt-section-title' }, t('Usage')),
      h('div', { className: 'bt-kv' }, h('span', null, room.name), h('span', null, usage))),
  ]
}

export function DetailsDrawer({ sessionId, startRenaming, startTab, hasStrip, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages }) {
  const owner = roster.byId[sessionId]
  const part = owner ? currentPart(owner) : sessionId
  const isMainBot = isMainOf(roster, owner?.id)
  const [tab, setTab] = useState('details')
  const room = roster.roomsById[sessionId]
  // The info pane swaps its overview for the Bot or group settings view in place.
  const [view, setView] = useState(startTab === 'settings' && (owner || room) ? 'settings' : 'overview')
  const [editing, setEditing] = useState(Boolean(startRenaming && (roster.byId[sessionId] || roster.roomsById[sessionId])))
  const [draftName, setDraftName] = useState(roster.byId[sessionId]?.name ?? (roster.roomsById[sessionId]?.named ? roster.roomsById[sessionId].name : ''))
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const glide = useGlide(tab)
  // The settings view comes in from the right and the overview back from the left; a
  // new tab clears from a blur. The first view arrives with the panel.
  const last = useRef({ view, tab, move: undefined })
  if (last.current.view !== view) last.current = { view, tab, move: view === 'settings' ? 'in' : 'out' }
  else if (last.current.tab !== tab) last.current = { view, tab, move: 'tab' }
  const move = last.current.move
  const side = move === 'tab' ? undefined : move
  const close = () => actions.closeOverlay()
  useEscape(close)
  const bot = owner
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const doing = useActivity(map => map[bot?.id ?? sessionId])
  const transcript = useSessions(list => transcriptOf(list, part, bot?.name ?? room?.name ?? t('Bot'), roster.exchangeTurns[part]))
  const usage = useSessions(list => usageOf(list, [part, ...(bot?.parts ?? room?.parts ?? [])]))
  const run = promise => Promise.resolve(promise)
    .then(() => { setError(''); return true })
    .catch(failure => { setError(failure?.message ?? String(failure)); return false })
  const share = () => {
    void navigator.clipboard?.writeText(transcript).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  const errorLine = error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null
  if ((bot || room) && view === 'settings' && !(bot?.remote)) {
    return [
      h('div', { key: 'head', className: 'bt-subhead', 'data-move': move },
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'), onClick: () => setView('overview') }, h(ChevronLeftIcon)),
        h('span', { className: 'bt-subhead-title' }, bot ? t('Settings') : t('Group settings')),
        hasStrip ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon))),
      h('div', { key: 'set-body', className: 'bt-drawer-body bt-set-body', 'data-move': move }, errorLine,
        bot ? h(BotSettingsForm, { bot, roster, actions, run }) : h(GroupSettingsForm, { room, roster, actions, run, onDeleted: close })),
    ]
  }
  const top = h('div', { className: 'bt-drawer-top', 'data-move': side },
    bot || room ? h('button', {
      type: 'button', className: 'bt-round', 'aria-label': bot ? (bot.remote ? t('Bot settings') : t('Edit Bot')) : t('Group settings'),
      title: bot ? (bot.remote ? t('Bot settings') : t('Edit Bot')) : t('Group settings'), 'data-info-row': 'settings',
      onClick: () => (bot?.remote ? actions.openSettings('bots', bot.id) : setView('settings')),
    }, h(GearIcon)) : null,
    bot && !bot.remote && roster.browser === true && actions.openBrowser
      ? h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Open browser'), title: t("Open this Bot's browser"), onClick: () => actions.openBrowser(sessionId) }, h(GlobeIcon))
      : null,
    bot || room ? h('button', { type: 'button', className: 'bt-round', 'aria-label': copied ? t('Copied conversation') : t('Share conversation'), title: copied ? t('Copied') : t('Copy conversation as Markdown'), onClick: share }, copied ? h('span', { key: 'copied', className: 'bt-pop-in' }, '✓') : h(ShareIcon)) : null,
    hasStrip ? null : h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon)))
  if (!bot && !room) {
    return [h(Fragment, { key: 'top' }, top),
      h('div', { key: 'body', className: 'bt-drawer-body' }, h('div', { className: 'bt-muted' }, t('This conversation is not part of your Bot team.')))]
  }
  const current = bot?.name ?? room.name
  const saveName = async () => {
    setEditing(false)
    const next = draftName.trim()
    if (next === current || (room && !room.named && next === '')) return
    if (bot && next) await run(actions.updateBot(bot.id, { name: next }))
    // An empty group name goes back to naming the group after its members.
    if (room) await run(actions.updateRoom(room.id, { name: next }))
  }
  const subtitle = bot ? bot.role : roomSubtitle(room, roster)
  // Tab sets: a 1:1 Bot has Details and Browser; a group has Details.
  const tabs = bot ? ['details', 'browser'] : ['details']
  return [h(Fragment, { key: 'top' }, top),
    h('div', { key: 'id', className: 'bt-drawer-id', 'data-move': side },
      bot ? h(BotAvatar, { bot, size: 64, state: botState(running, doing, roster.questions?.[part] !== undefined), main: isMainBot, badge: false, gaze: true, pokeable: true })
        : h(RoomAvatar, { room, roster, size: 64 }),
      bot?.remote
        ? h('div', { className: 'bt-drawer-name' }, current)
        : room?.origin === 'face-to-face'
          ? h('div', { className: 'bt-drawer-name bt-drawer-name-face', title: current }, current)
        : editing
          ? h('input', {
              className: 'bt-drawer-name-input', autoFocus: true, value: draftName, 'aria-label': bot ? t('Bot name') : t('Group name'),
              placeholder: room ? t('Name after members') : undefined,
              onChange: event => setDraftName(event.target.value), onBlur: saveName,
              onKeyDown: (event) => { if (event.key === 'Enter') void saveName(); if (event.key === 'Escape') { event.stopPropagation(); setEditing(false) } },
            })
          : h('button', { type: 'button', className: 'bt-drawer-name', 'aria-label': t('Rename {name}', { name: current }), title: t('Rename'), onClick: () => { setDraftName(room && !room.named ? '' : current); setEditing(true) } }, current),
      subtitle ? h('span', { className: 'bt-drawer-role' }, subtitle) : bot?.remote ? h('span', { className: 'bt-drawer-role' }, t("Friend's Bot")) : null),
    bot?.remote ? null : h('div', { key: 'tabs', ref: glide.box, className: 'bt-tabs', role: 'tablist', 'data-move': side },
      h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
      tabs.map(key => h('button', { key, type: 'button', role: 'tab', className: 'bt-tab', 'aria-selected': tab === key, onClick: () => setTab(key) }, t(TAB_LABELS[key])))),
    h('div', { key: `body:${tab}`, className: 'bt-drawer-body', 'data-move': move },
      errorLine,
      room && tab === 'details' ? h(GroupOverview, { room, roster, actions, usage, useWork, openSettings: () => setView('settings') }) : null,
      bot && bot.remote && tab === 'details' ? [
        bot.remote.handle ? h('div', { key: 'handle', className: 'bt-muted' }, bot.remote.handle) : null,
        h(FlyBotDetails, { key: 'social', bot, roster, actions }),
      ] : null,
      bot && !bot.remote && tab === 'details' ? [
        h('div', { key: 'model', className: 'bt-drawer-model' },
          h('div', { className: 'bt-section-title' }, t('Model')),
          h(ModelMenu, { bot, roster, actions, run, wide: true }),
          modelOf(bot, roster) ? null : h('div', { className: 'bt-note' }, t('Pick a model and {name} can start.', { name: bot.name }))),
        h(PermissionRow, { key: 'permission', bot, roster, actions, run }),
        h('div', { key: 'folder', className: 'bt-drawer-model' },
          h('div', { className: 'bt-section-title' }, t('Working folder')),
          h(FolderMenu, { value: bot.workDir, actions, run, wide: true, onPick: workDir => run(actions.updateBot(bot.id, { workDir })) })),
        bot.instructions
          ? h(About, { key: 'about', text: bot.instructions })
          : h('button', { key: 'about', type: 'button', className: 'bt-more', onClick: () => setView('settings') }, t('Add instructions in Bot settings')),
        roster.memory === false ? null : h(MemoryRow, { key: 'memory', bot, actions }),
        usage ? h('div', { key: 'usage' }, h('div', { className: 'bt-section-title' }, t('Usage')),
          h('div', { className: 'bt-kv' }, h('span', null, bot.name), h('span', null, usage))) : null,
        h(ScheduleSummary, { key: 'routines', bot, actions }),
      ] : null,
      bot && !bot.remote && tab === 'browser' ? h(BrowserCards, { bot, sessionId, roster, actions, useBrowserTabs, useBrowserPages }) : null)]
}
