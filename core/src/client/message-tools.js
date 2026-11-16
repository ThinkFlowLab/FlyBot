import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SmileIcon, ReplyIcon, DotsIcon, CheckIcon, DownloadIcon, CopyIcon } from './icons.js'
import { t } from './i18n.js'
import { MESSAGE_REACTIONS, isLockedRoster, messageActionIds } from '../shared/message-actions.js'

// Closes a popover on a press outside the given elements or on Escape.
export function useDismiss(open, close, refs) {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (refs.some(ref => ref.current?.contains(event.target))) return
      close()
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open, close])
}

function downloadMessage(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: `${name}-message.md` })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// The hover toolbar and the overflow / right-click menu for one message. Only
// actions the client can run are drawn: add a reaction, quote into the composer,
// copy, or download. A locked window hides Reply (it writes into the composer).
export function MessageTools({
  text,
  name,
  sessionId,
  react,
  actions,
  roster,
  contextAt,
  className = 'bt-tools',
}) {
  const [panel, setPanel] = useState(null)
  const [place, setPlace] = useState(null)
  const [copied, setCopied] = useState(false)
  const tools = useRef(null)
  const pop = useRef(null)
  const locked = isLockedRoster(roster)
  const ids = messageActionIds({
    text,
    sessionId,
    canReact: typeof react === 'function',
    canReply: typeof actions?.quote === 'function',
    locked,
  })
  const [dismissed, setDismissed] = useState(null)
  const [note, setNote] = useState('')
  const close = () => {
    setDismissed(contextAt?.token ?? dismissed)
    setPanel(null)
  }
  const cursorPlace = (at) => {
    if (!at) return null
    const width = typeof window === 'undefined' ? 1400 : window.innerWidth
    const height = typeof window === 'undefined' ? 800 : window.innerHeight
    const below = at.y + 220 < height
    return {
      left: Math.max(8, Math.min(at.x, width - 228)),
      ...(below ? { top: at.y } : { bottom: height - at.y + 4, '--bt-origin': 'bottom left' }),
    }
  }
  const openFromContext = Boolean(contextAt?.token && contextAt.token !== dismissed && ids.length > 0)
  const shown = openFromContext ? 'more' : panel
  const menuPlace = openFromContext ? cursorPlace(contextAt) : place
  const openAt = (kind, event, { cursor = false } = {}) => {
    if (!cursor && panel === kind) { close(); return }
    setDismissed(contextAt?.token ?? dismissed)
    const width = typeof window === 'undefined' ? 1400 : window.innerWidth
    const height = typeof window === 'undefined' ? 800 : window.innerHeight
    const rect = event?.currentTarget?.getBoundingClientRect?.()
    const below = cursor
      ? event.clientY + 220 < height
      : rect && rect.bottom + 220 < height
    const left = cursor
      ? Math.min(event.clientX, width - 228)
      : Math.min(rect.left, width - 228)
    setPlace(kind === 'react' && !cursor
      ? { left: rect.left + rect.width / 2, top: rect.top - 6, '--bt-origin': 'bottom center' }
      : { left: Math.max(8, left), ...(below
        ? { top: cursor ? event.clientY : rect.bottom + 4 }
        : { bottom: height - (cursor ? event.clientY : rect.top) + 4, '--bt-origin': 'bottom left' }) })
    setPanel(kind)
  }
  useDismiss(shown !== null, close, [tools, pop])
  useEffect(() => { if (shown) pop.current?.querySelector?.('button')?.focus?.() }, [shown, contextAt?.token])
  const copy = async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') { setNote(t('Clipboard unavailable')); return }
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setNote(t('Copied'))
      setTimeout(() => setCopied(false), 1000)
    } catch { setNote(t('Could not copy message')) }
  }
  const download = () => {
    try { downloadMessage(text, name); close() }
    catch { setNote(t('Could not download message')) }
  }
  const reply = () => actions.quote(sessionId, text)
  const item = (label, Icon, run, keepOpen = false) => h('button', { key: label, type: 'button', role: 'menuitem', onClick: () => { if (!keepOpen) close(); run() } }, h(Icon), label)
  const menuItems = []
  if (ids.includes('reply')) menuItems.push(item(t('Reply'), ReplyIcon, reply))
  if (ids.includes('copy')) menuItems.push(item(copied ? t('Copied') : t('Copy'), copied ? CheckIcon : CopyIcon, copy, true))
  if (ids.includes('download')) menuItems.push(item(t('Download'), DownloadIcon, download, true))
  if (ids.length === 0) return null
  return h('div', { ref: tools, className, 'data-open': shown !== null || undefined },
    ids.includes('react') ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Add reaction'), title: t('Add reaction'), 'aria-expanded': shown === 'react', onClick: event => openAt('react', event) }, h(SmileIcon)) : null,
    ids.includes('reply') ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Reply'), title: t('Reply'), onClick: reply }, h(ReplyIcon)) : null,
    menuItems.length > 0 || ids.includes('react')
      ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('More message actions'), title: t('More'), 'aria-haspopup': 'menu', 'aria-expanded': shown === 'more', onClick: event => openAt('more', event) }, copied ? h(CheckIcon) : h(DotsIcon))
      : null,
    shown === 'react' ? createPortal(h('div', { ref: pop, className: 'bt-react-strip', role: 'menu', 'aria-label': t('Reactions'), style: menuPlace },
      MESSAGE_REACTIONS.map(emoji => h('button', { key: emoji, type: 'button', role: 'menuitem', 'aria-label': emoji, onClick: () => { close(); react(emoji) } }, emoji))), document.body) : null,
    shown === 'more' ? createPortal(h('div', { ref: pop, className: 'bt-menu', role: 'menu', 'aria-label': t('Message actions'), style: menuPlace,
      onKeyDown: event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const buttons = [...(pop.current?.querySelectorAll?.('button:not(:disabled)') ?? [])]
        if (!buttons.length) return
        event.preventDefault()
        const at = buttons.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next].focus()
      } },
      ids.includes('react')
        ? h('div', { key: 'reacts', className: 'bt-menu-reacts', role: 'group', 'aria-label': t('Reactions') },
          MESSAGE_REACTIONS.map(emoji => h('button', { key: emoji, type: 'button', role: 'menuitem', 'aria-label': emoji, onClick: () => { close(); react(emoji) } }, emoji)))
        : null,
      ids.includes('react') && menuItems.length > 0 ? h('div', { key: 'sep', className: 'bt-menu-sep', role: 'separator' }) : null,
      ...menuItems,
      note ? h('div', { role: 'status', 'aria-live': 'polite', className: 'bt-menu-hint bt-message-note' }, note) : null), document.body) : null)
}

let contextToken = 0

export function onMessageContextMenu(event, setContextAt, { live = false } = {}) {
  if (live) return
  if (event.target?.closest?.('a[href], input, textarea, [role="menu"]')) return
  event.preventDefault()
  event.stopPropagation()
  setContextAt({ x: event.clientX, y: event.clientY, token: ++contextToken })
}
