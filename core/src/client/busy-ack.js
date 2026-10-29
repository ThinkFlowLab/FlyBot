import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark } from './mark.js'
import { RUNNING_HOST } from './activity-row.js'
import { busyAckText, busyAckVisible, pendingBusyPlacement } from './busy-ack-logic.js'

export { busyAckPending, busyAckText, busyAckVisible, pendingBusyPlacement } from './busy-ack-logic.js'

// Spoken busy-ack (#1584): when a human send is accepted while the Bot is running
// (host live busyAcks, or a local pending queue/steer submission), show one short
// bot bubble promptly instead of silence until a blocking job wait ends. While the
// host's ack is still on its way the bubble holds only a blinking indicator, never
// a fixed sentence; the host's line replaces it when it lands.

function useRunningHost(active) {
  const [host, setHost] = useState(null)
  useEffect(() => {
    if (!active) { setHost(null); return undefined }
    let frame = 0
    const find = () => {
      frame = 0
      const node = document.querySelector(RUNNING_HOST)
      setHost(prev => (prev === node ? prev : node))
    }
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(find) })
    observer.observe(document.querySelector('[data-conversation-scroll]') ?? document.body, { childList: true, subtree: true })
    find()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [active])
  return host
}

export function BusyAckBubble({ sessionId, useRoster, useBusyAcks, useSessionStatus, useSession, useLive }) {
  const roster = useRoster(value => value)
  const hostAck = useBusyAcks(map => map?.[sessionId] ?? null)
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const pendingBusy = useSession(snapshot => pendingBusyPlacement(snapshot?.pendingSubmissions))
  const streamingText = useLive(state => Object.values(state[sessionId] ?? {}).some(entry => entry?.text))
  const visible = running && busyAckVisible({ hostAck, pendingBusy, streamingText })
  const bot = roster.byId[sessionId]
  const host = useRunningHost(visible)
  const shown = useRef(null)
  if (visible) shown.current = { text: busyAckText(hostAck), at: hostAck?.at ?? Date.now() }
  const text = shown.current?.text ?? ''
  if (!visible || !host || !shown.current || !bot) return null
  return createPortal(h('div', {
    className: 'bt-busy-ack',
    'data-flybot': 'busy-ack',
    role: 'status',
    'aria-live': 'polite',
    'aria-busy': text ? undefined : 'true',
    'data-pending': text ? undefined : '',
  },
    h(BotMark, { bot, size: 28, state: 'thinking', live: true }),
    h('div', { className: 'bt-astack' },
      h('div', { className: 'bt-msg' },
        h('div', { className: 'bt-msg-line' },
          text
            ? h('div', { className: 'bt-bubble' }, text)
            : h('div', { className: 'bt-bubble bt-busy-dots', 'aria-hidden': 'true' },
              h('span', null), h('span', null), h('span', null)))))), host)
}

export const BUSY_ACK_CSS = `
.bt-busy-ack{display:flex;align-items:flex-end;gap:8px;width:100%;margin-top:var(--dsh-chat-flow-gap,12px);margin-bottom:4px}
.bt-busy-ack .bt-astack{align-items:flex-start}
.bt-busy-ack .bt-bubble{opacity:.92}
.bt-busy-dots{display:inline-flex;align-items:center;gap:4px;height:22px}
.bt-busy-dots>span{width:5px;height:5px;border-radius:50%;background:var(--bt-ink-3);animation:bt-busy-blink 1.2s ease-in-out infinite}
.bt-busy-dots>span:nth-child(2){animation-delay:.2s}.bt-busy-dots>span:nth-child(3){animation-delay:.4s}
@keyframes bt-busy-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.bt-busy-dots>span{animation:none;opacity:.6}}
`
