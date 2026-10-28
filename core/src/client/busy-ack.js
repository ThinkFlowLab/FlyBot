import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark } from './mark.js'
import { RUNNING_HOST } from './activity-row.js'
import { t } from './i18n.js'
import { BUSY_ACK_KEY, busyAckVisible, pendingBusyPlacement } from './busy-ack-logic.js'

export { BUSY_ACK_KEY, busyAckVisible, pendingBusyPlacement } from './busy-ack-logic.js'

// Spoken busy-ack (#1584): when a human send is accepted while the Bot is running
// (host live busyAcks, or a local pending queue/steer submission), show one short
// bot bubble promptly instead of silence until a blocking job wait ends.

export function busyAckText(hostAck) {
  return hostAck?.text || t(BUSY_ACK_KEY)
}

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
  if (!visible || !host || !shown.current || !bot) return null
  return createPortal(h('div', {
    className: 'bt-busy-ack',
    'data-flybot': 'busy-ack',
    role: 'status',
    'aria-live': 'polite',
  },
    h(BotMark, { bot, size: 28, state: 'thinking', live: true }),
    h('div', { className: 'bt-astack' },
      h('div', { className: 'bt-msg' },
        h('div', { className: 'bt-msg-line' },
          h('div', { className: 'bt-bubble' }, shown.current.text))))), host)
}

export const BUSY_ACK_CSS = `
.bt-busy-ack{display:flex;align-items:flex-end;gap:8px;width:100%;margin-top:var(--dsh-chat-flow-gap,12px);margin-bottom:4px}
.bt-busy-ack .bt-astack{align-items:flex-start}
.bt-busy-ack .bt-bubble{opacity:.92}
`
