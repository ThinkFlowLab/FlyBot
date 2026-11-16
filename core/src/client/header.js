import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { currentPart, faceRowTitle, latestMemoryChange } from './text.js'
import { ArrowUpIcon, CloseIcon, ArrowDownIcon, DotsIcon, GearIcon, MemoryIcon, ShareIcon, SearchIcon, UnreadIcon, PinIcon } from './icons.js'
import { botState, BotAvatar, RoomAvatar } from './mark.js'
import { clockLabel, movedOnSince, openingTurn, unseenSince } from './cells.js'
import { ActivityIndicator } from './activity-row.js'
import { BusyAckBubble } from './busy-ack.js'
import { t } from './i18n.js'
import { call } from './api.js'
import { ProjectAgentEntry, projectAgentFor } from './project-board.js'
import { friendBotTitle, roomTitle } from '../shared/remote-label.js'
import { isManuallyUnread, unreadEntryId } from '../shared/session-unread.js'
import { canPinSession, sessionPinned } from '../shared/session-pin.js'

// -------------------------------------------------------------------------
// Conversation header

// The pill's tail: a → that springs in on hover, flipping to ← while details are open.
const GoArrow = () => h('svg', { width: 14, height: 14, viewBox: '-12 -12 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M-7 0H7M2 -5L7 0L2 5' }))

// How long the pill says "Memory updated" after the change reaches this window.
const MEMORY_NOTICE_MS = 3_200
const noNews = select => select({})

// True while the latest memory change of the Bots in this conversation is news.
function useMemoryNotice(ids, useMemoryNews) {
  const seen = useMemoryNews(map => Math.max(0, ...ids.map(id => map?.[id]?.seen ?? 0)))
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const left = seen + MEMORY_NOTICE_MS - Date.now()
    setShown(seen > 0 && left > 0)
    if (seen === 0 || left <= 0) return undefined
    const timer = setTimeout(() => setShown(false), left)
    return () => clearTimeout(timer)
  }, [seen])
  return shown
}

// The notice the pill stretches to show. Its width is measured, so the pill's spring
// runs between two real widths.
function MemoryNotice({ shown }) {
  const inner = useRef(null)
  const [width, setWidth] = useState(0)
  const label = t('Memory updated')
  useLayoutEffect(() => { if (shown) setWidth(inner.current?.scrollWidth ?? 0) }, [label, shown])
  return h('span', { className: 'bt-pill-mem', 'aria-hidden': true, style: { '--bt-mem-w': `${width}px` } },
    h('span', { className: 'bt-pill-mem-in', ref: inner }, h('span', { className: 'bt-pill-mem-ico' }, h(MemoryIcon)), label))
}

function SessionOverflow({ sessionId, roster, actions, unread }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const button = useRef(null)
  const menu = useRef(null)
  const [box, setBox] = useState(null)
  const bot = roster.byId?.[sessionId]
  const targetId = unreadEntryId(roster, sessionId)
  const marked = isManuallyUnread(unread, targetId)
  const social = typeof globalThis !== 'undefined' ? globalThis.__flybot__?.social : undefined
  const canInvite = Boolean(bot && !bot.remote && typeof social?.createInvite === 'function' && social.canInvite?.(bot.id) !== false)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if ([button.current, menu.current].some(node => node?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2400)
    return () => clearTimeout(timer)
  }, [note])
  const toggle = () => {
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ right: window.innerWidth - rect.right, top: rect.bottom + 6 })
    setOpen(value => !value)
    setNote('')
  }
  const openDetails = () => { setOpen(false); actions.toggleDetails(sessionId) }
  const copyInvite = async () => {
    try {
      const invite = await social.createInvite(bot.id)
      const link = invite?.link ?? invite?.url ?? invite?.text
      if (!link) throw new Error('missing link')
      await navigator.clipboard.writeText(link)
      setNote(t('Invite link copied'))
    } catch {
      setNote(t('Could not copy the invite link'))
    }
  }
  return h(Fragment, null,
    h('div', { className: 'bt-head-actions' },
      typeof actions?.openPalette === 'function'
        ? h('button', {
            type: 'button', className: 'bt-head-more', 'aria-label': t('Search'), title: t('Search'),
            onClick: () => actions.openPalette(),
          }, h(SearchIcon))
        : null,
      h('button', {
        ref: button, type: 'button', className: 'bt-head-more', 'aria-label': t('Conversation settings'),
        title: t('Conversation settings'), 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: toggle,
      }, h(DotsIcon))),
    open && box ? createPortal(h('div', {
      ref: menu, className: 'bt-menu bt-head-menu', role: 'menu', 'aria-label': t('Conversation settings'),
      style: { right: box.right, top: box.top },
    },
      h('button', { type: 'button', role: 'menuitem', onClick: openDetails }, h(GearIcon), h('span', { className: 'bt-menu-label' }, t('Conversation settings'))),
      typeof actions?.openPalette === 'function'
        ? h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); actions.openPalette() } }, h(SearchIcon), h('span', { className: 'bt-menu-label' }, t('Search')))
        : null,
      marked
        ? h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); actions.clearUnread?.(targetId) } }, h(UnreadIcon), h('span', { className: 'bt-menu-label' }, t('Clear unread mark')))
        : h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); actions.markUnread?.(targetId) } }, h(UnreadIcon), h('span', { className: 'bt-menu-label' }, t('Mark as Unread'))),
      canPinSession(roster, sessionId) && typeof actions?.setFlags === 'function'
        ? h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); void Promise.resolve(actions.setFlags(sessionId, { pinned: !sessionPinned(roster, sessionId) })).catch(error => actions.reportError?.(error, 'menu')) } }, h(PinIcon), h('span', { className: 'bt-menu-label' }, sessionPinned(roster, sessionId) ? t('Unpin') : t('Pin')))
        : null,
      canInvite
        ? h('button', { type: 'button', role: 'menuitem', onClick: () => { void copyInvite() } }, h(ShareIcon), h('span', { className: 'bt-menu-label' }, t('Copy invite link')))
        : null,
      note ? h('div', { className: 'bt-menu-hint', role: 'status' }, note) : null), document.body) : null)
}

export function HeaderPill({ sessionId, useRoster, useSessions, useSessionStatus, useSession, useActivity, useBusyAcks, useMemoryNews, useTurnClock, useUi, useLive, actions }) {
  const roster = useRoster(value => value)
  const title = useSessions(list => list.byId[sessionId]?.displayTitle ?? list.byId[sessionId]?.title ?? '')
  const firstTurns = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.slice(0, 8).map(entry => entry.turn).join(',') : ''
  })
  const hiddenTurns = roster.exchangeTurns?.[sessionId]
  const visit = useUi(state => state.visits?.[sessionId])
  // The opening separator is the one page effect that stays with the pill: it needs a turn, so
  // the shell always draws the header for it, and it reads `useTurnClock`, which the installer
  // in header-effects.js deliberately does not carry.
  const opening = useTurnClock((state) => {
    const first = openingTurn(state[sessionId], firstTurns, hiddenTurns)
    return first && !unseenSince(visit, first.start) ? clockLabel(first.start) : ''
  })
  useEffect(() => {
    if (opening) document.body.style.setProperty('--bt-first-sep', JSON.stringify(opening))
    else document.body.style.removeProperty('--bt-first-sep')
    return () => document.body.style.removeProperty('--bt-first-sep')
  }, [opening])
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const owner = roster.byId[sessionId]?.id ?? sessionId
  const doing = useActivity(map => map[owner])
  const bot = roster.byId[sessionId]
  // #1864: an owner's Bot that belongs to a Project gets the entry to that Project's assistant in
  // its own chat header. The roster already carries the binding, so nothing else is read here.
  const projectAgent = projectAgentFor(bot, roster.self?.memberId)
  const room = roster.roomsById[sessionId]
  const detailsOpen = useUi(state => state.details === sessionId)
  const unread = useUi(state => state.unread)
  const full = bot?.remote
    ? friendBotTitle(bot)
    : (roomTitle(room) || bot?.name || '')
  // The pill is one short row. The number-first title fits where
  // "Face-to-face · SelfA1025, SelfB…" does not, and the full title stays on hover (#1102).
  const face = room?.origin === 'face-to-face'
  const name = face ? faceRowTitle(full) : full
  const useNews = useMemoryNews ?? noNews
  const memoryIds = bot ? [bot.id] : room?.members ?? []
  const notice = useMemoryNotice(memoryIds, useNews)
  // While the notice shows, the pill opens the memory of the Bot that changed.
  const changed = useNews(map => latestMemoryChange(map, memoryIds))
  const memoryNotice = notice && changed !== null && roster.memory !== false
  return h('div', { className: 'bt-head' },
    h('button', {
      type: 'button', className: 'bt-pill', 'aria-expanded': detailsOpen, 'data-memory': memoryNotice ? 'updated' : undefined,
      'aria-label': memoryNotice ? t('Memory updated. Open {name}\'s memory', { name: roster.byId[changed]?.name ?? full }) : t('View conversation details'),
      onClick: () => (memoryNotice ? actions.openMemory(changed) : actions.toggleDetails(sessionId)),
    },
    bot ? h(BotAvatar, { bot, size: 24, state: botState(running, doing, roster.questions?.[currentPart(bot)] !== undefined), badge: false })
      : room ? h(RoomAvatar, { room, roster, size: 24 }) : null,
    h('span', { className: face ? 'bt-pill-name bt-pill-name-face' : 'bt-pill-name', title: face ? full : undefined }, name || title || t('New chat')),
    h(MemoryNotice, { shown: memoryNotice }),
    h('span', { className: 'bt-pill-go', 'aria-hidden': true }, h(GoArrow))),
    h('span', { className: 'bt-sr', role: 'status' }, memoryNotice ? t('Memory updated') : ''),
    projectAgent === null ? null : h(ProjectAgentEntry, {
      projectId: projectAgent.projectId, read: call, onOpen: id => actions?.openSession?.(id),
    }),
    h(NewMessagePills, { key: sessionId, sessionId, hiddenTurns, useSessions, useUi, useTurnClock, actions }),
    h(ActivityIndicator, { key: `activity:${sessionId}`, sessionId, useRoster, useSessionStatus, useSession, useLive, actions }),
    h(BusyAckBubble, { key: `busy-ack:${sessionId}`, sessionId, useRoster, useBusyAcks, useSessionStatus, useSession, useLive }),
    h(SessionOverflow, { sessionId, roster, actions, unread }))
}

// New-message pills. "N new messages ↓" takes Back to bottom's place when
// replies land while the user is scrolled up; "N new messages ↑" points at an unread
// divider above the viewport until it has been seen. The shell shows Back to bottom
// only while unpinned, so its presence is the pinned signal.
function useTranscriptView() {
  const [view, setView] = useState(null)
  useEffect(() => {
    let frame = 0
    let watched = null
    const observer = new MutationObserver(() => schedule())
    const measure = () => {
      frame = 0
      const scroller = document.querySelector('[data-conversation-scroll]')
      if (scroller !== watched) {
        observer.disconnect()
        watched = scroller
        if (scroller) observer.observe(scroller, { childList: true, subtree: true })
      }
      if (!scroller) { setView(null); return }
      const box = scroller.getBoundingClientRect()
      const headerBottom = document.querySelector('header[class*="_header"]')?.getBoundingClientRect().bottom ?? box.top + 50
      const sep = scroller.querySelector('.bt-new-sep')
      let divider = null
      if (sep) {
        const at = sep.getBoundingClientRect()
        divider = at.bottom <= headerBottom ? 'above' : at.top >= box.bottom ? 'below' : 'in-view'
      }
      const composer = parseFloat(getComputedStyle(scroller).getPropertyValue('--dsh-composer-height')) || 152
      // The newest turn whose row is on screen. Leaving writes only this, so a turn that arrived
      // below the fold, or after the user scrolled up, stays unseen and its divider comes back (#3079).
      let tail
      for (const row of scroller.querySelectorAll('[data-chat-turn]')) {
        const turn = Number(row.dataset.chatTurn)
        const at = row.getBoundingClientRect()
        if (Number.isFinite(turn) && at.bottom > box.top && at.top < box.bottom && (tail === undefined || turn > tail)) tail = turn
      }
      const next = {
        unpinned: scroller.querySelector('[class*="_toBottomSlot"]>button') !== null,
        divider,
        tail,
        center: Math.round(box.left + box.width / 2),
        top: Math.round(headerBottom + 8),
        bottom: Math.round(window.innerHeight - box.bottom + composer + 8),
      }
      setView(prev => (prev && Object.keys(next).every(key => prev[key] === next[key]) ? prev : next))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [])
  return view
}

function NewMessagePills({ sessionId, hiddenTurns, useSessions, useUi, useTurnClock, actions }) {
  const replies = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.reduce((count, entry) => count + (entry.response ? 1 : 0), 0) : 0
  })
  const visit = useUi(state => state.visits?.[sessionId])
  const unread = useTurnClock((state) => {
    if (typeof visit?.seen !== 'number') return 0
    let count = 0
    for (const entry of Object.values(state[sessionId] ?? {})) {
      if (entry.first !== undefined && entry.first > visit.seen && entry.first <= visit.entered) count += 1
    }
    return count
  })
  const view = useTranscriptView()
  // The newest turn on screen, resolved to the time the leave mark compares against (a running
  // turn has no end yet, so its start counts). A Session with nothing rendered reports nothing,
  // and the leave keeps the old fallback (#3079).
  const tailAt = useTurnClock((state) => {
    if (view?.tail === undefined) return null
    const entry = state[sessionId]?.[view.tail]
    return entry?.end ?? entry?.first ?? null
  })
  useEffect(() => { if (tailAt !== null) actions?.noteVisitTail?.(sessionId, tailAt) }, [tailAt, sessionId])
  const unpinned = view?.unpinned === true
  const [release, setRelease] = useState({ base: null, dismissed: false })
  const [above, setAbove] = useState({ seen: false, dismissed: false })
  useEffect(() => { setRelease({ base: unpinned ? replies : null, dismissed: false }) }, [unpinned])
  useEffect(() => { if (view?.divider === 'in-view') setAbove(state => (state.seen ? state : { ...state, seen: true })) }, [view?.divider])
  // Once the divider has been on screen, the next turn the chat shows (a friend's new line, the
  // user's own message) settles the visit and the divider goes, in every chat (#275).
  const movedOn = useTurnClock(state => movedOnSince(visit, state[sessionId], hiddenTurns))
  useEffect(() => { if (above.seen && movedOn) actions?.settleVisit?.(sessionId) }, [above.seen, movedOn, sessionId])
  const fresh = release.base === null ? 0 : replies - release.base
  const showDown = unpinned && fresh > 0 && !release.dismissed
  const showUp = view?.divider === 'above' && !above.seen && !above.dismissed
  useEffect(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (!scroller) return undefined
    scroller.toggleAttribute('data-bt-news', showDown)
    return () => scroller.removeAttribute('data-bt-news')
  }, [showDown])
  if (!view || (!showDown && !showUp)) return null
  const label = count => (count === 1 ? t('1 new message') : count > 0 ? t('{count} new messages', { count }) : t('New messages'))
  const pill = (direction, count, style, onJump, onDismiss) => h('div', { className: 'bt-news', 'data-direction': direction, style },
    h('button', { type: 'button', className: 'bt-news-jump', onClick: onJump },
      h('span', { className: 'bt-news-ico' }, h(direction === 'up' ? ArrowUpIcon : ArrowDownIcon)), label(count)),
    h('button', {
      type: 'button', className: 'bt-news-x', 'aria-label': t('Dismiss new messages'),
      onClick: (event) => { event.stopPropagation(); onDismiss() },
    }, h(CloseIcon)))
  const toLatest = () => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    const back = scroller?.querySelector('[class*="_toBottomSlot"]>button')
    if (back) back.click()
    else scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }
  const toDivider = () => document.querySelector('[data-conversation-scroll] .bt-new-sep')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return createPortal(h(Fragment, null,
    showUp ? pill('up', unread, { left: view.center, top: view.top }, toDivider, () => setAbove(state => ({ ...state, dismissed: true }))) : null,
    showDown ? pill('down', fresh, { left: view.center, bottom: view.bottom }, toLatest, () => setRelease(state => ({ ...state, dismissed: true }))) : null),
  document.body)
}
