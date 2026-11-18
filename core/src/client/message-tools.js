import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SmileIcon, ReplyIcon, DotsIcon, CheckIcon, DownloadIcon, CopyIcon } from './icons.js'
import { t } from './i18n.js'

export const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

const hasMessageText = text => String(text ?? '').trim() !== ''

// Only the actions this window can run: a reaction needs a key to store it under, Reply a chat to
// quote into, and a copy or a download the line's own text.
export function messageActionIds({ text, sessionId, canReact = false, canReply = true } = {}) {
  if (!hasMessageText(text)) return []
  return [
    ...(canReact ? ['react'] : []),
    ...(sessionId && canReply ? ['reply'] : []),
    'copy', 'download',
  ]
}

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
  }, [open])
}

function downloadMessage(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: `${name}-message.md` })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// The hover toolbar and the right-click menu for one message: the same actions a reply bubble and a
// person's own line can offer, and a note in the menu when a copy or a download cannot be done.
export function MessageTools({ text, name, sessionId, react, actions, contextAt, className = 'bt-tools' }) {
  const [panel, setPanel] = useState(null)
  const [place, setPlace] = useState(null)
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState('')
  const [dismissed, setDismissed] = useState(null)
  const tools = useRef(null)
  const pop = useRef(null)
  const ids = messageActionIds({ text, sessionId, canReact: typeof react === 'function', canReply: typeof actions?.quote === 'function' })
  const close = () => { setDismissed(contextAt?.token ?? dismissed); setPanel(null) }
  // A right-click sets a new token each time; the menu stays closed once this one is dismissed.
  const openedAt = contextAt?.token && contextAt.token !== dismissed ? 'more' : null
  const shown = openedAt ?? panel
  useDismiss(shown !== null, close, [tools, pop])
  const at = (x, y) => {
    const width = typeof window === 'undefined' ? 1400 : window.innerWidth
    const height = typeof window === 'undefined' ? 800 : window.innerHeight
    const below = y + 220 < height
    return { left: Math.max(8, Math.min(x, width - 228)), ...(below ? { top: y } : { bottom: height - y + 4, '--bt-origin': 'bottom left' }) }
  }
  const menuPlace = openedAt ? at(contextAt.x, contextAt.y) : place
  const open = (kind, event) => {
    if (panel === kind) { close(); return }
    const rect = event.currentTarget.getBoundingClientRect()
    setPlace(kind === 'react'
      ? { left: rect.left + rect.width / 2, top: rect.top - 6, '--bt-origin': 'bottom center' }
      : at(rect.left, rect.bottom + 4))
    setPanel(kind)
  }
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
    try { downloadMessage(text, name) } catch { setNote(t('Could not download message')) }
  }
  if (ids.length === 0) return null
  const item = (label, Icon, run, keepOpen = false) => h('button', { key: label, type: 'button', role: 'menuitem', onClick: () => { if (!keepOpen) close(); run() } }, h(Icon), label)
  return h('div', { ref: tools, className, 'data-open': shown !== null || undefined },
    ids.includes('react') ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Add reaction'), title: t('Add reaction'), 'aria-expanded': shown === 'react', onClick: event => open('react', event) }, h(SmileIcon)) : null,
    ids.includes('reply') ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Reply'), title: t('Reply'), onClick: () => actions.quote(sessionId, text) }, h(ReplyIcon)) : null,
    h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('More message actions'), title: t('More'), 'aria-haspopup': 'menu', 'aria-expanded': shown === 'more', onClick: event => open('more', event) }, copied ? h(CheckIcon) : h(DotsIcon)),
    shown === 'react' ? createPortal(h('div', { ref: pop, className: 'bt-react-strip', role: 'menu', 'aria-label': t('Reactions'), style: place },
      MESSAGE_REACTIONS.map(emoji => h('button', { key: emoji, type: 'button', role: 'menuitem', 'aria-label': emoji, onClick: () => { close(); react(emoji) } }, emoji))), document.body) : null,
    shown === 'more' ? createPortal(h('div', { ref: pop, className: 'bt-menu', role: 'menu', 'aria-label': t('Message actions'), style: menuPlace },
      ids.includes('reply') ? item(t('Reply'), ReplyIcon, () => actions.quote(sessionId, text)) : null,
      ids.includes('copy') ? item(copied ? t('Copied') : t('Copy'), copied ? CheckIcon : CopyIcon, copy, true) : null,
      ids.includes('download') ? item(t('Download'), DownloadIcon, download, true) : null,
      note ? h('div', { role: 'status', 'aria-live': 'polite', className: 'bt-menu-hint bt-message-note' }, note) : null), document.body) : null)
}

let contextToken = 0

// A right-click on a message opens the same menu the More button does, at the cursor. Links, inputs
// and an already open menu keep their own right-click; a part still streaming has no menu.
export function onMessageContextMenu(event, setContextAt, { live = false } = {}) {
  if (live) return
  if (event.target?.closest?.('a[href], input, textarea, [role="menu"]')) return
  event.preventDefault()
  event.stopPropagation()
  setContextAt({ x: event.clientX, y: event.clientY, token: ++contextToken })
}
