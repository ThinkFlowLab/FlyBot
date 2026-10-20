import { t } from './i18n.js'

// An approval still waiting after this long gets one more reminder (#469, owner decision).
export const WAITING_TOO_LONG = 15 * 60 * 1000

// A system notification for each approval that starts waiting, one more when it has waited
// too long (#469), and each turn of the user's own Bots that finishes or fails (#353), while
// this window is in the background or shows another conversation. Only where the platform
// already allows notifications: DS Bot never asks for the permission. Settings → General →
// Notifications turns them all off, or each kind on its own (`prefs.notify`, #469). One chat
// keeps one notification: a newer one replaces it and counts the updates since the chat was
// last open. A notification only opens its chat: it never approves, rejects or sends anything.
export function noticeApprovals({ work, roster, shownSession, openSession, since = Date.now(), now = () => Date.now(), timers = globalThis }) {
  const told = new Set()
  const unseen = new Map()
  let timer
  const notify = () => {
    timers.clearTimeout?.(timer)
    timer = undefined
    const { approvals = [], ended = [] } = work.getSnapshot()
    const at = now()
    const lateAt = entry => Math.max(entry.at ?? 0, since) + WAITING_TOO_LONG
    const events = [
      ...approvals.map(entry => ({ entry, kind: 'approval', key: `approval-${entry.id}`, when: entry.at ?? 0 })),
      ...approvals.filter(entry => lateAt(entry) <= at).map(entry => ({ entry, kind: 'late', key: `late-${entry.id}`, when: lateAt(entry) })),
      ...ended.map(entry => ({ entry, kind: entry.failed === undefined ? 'finished' : 'failed', key: `turn-${entry.id}`, when: entry.at ?? 0 })),
    ]
    const current = new Set(events.map(event => event.key))
    for (const id of told) {
      if (!current.has(id)) told.delete(id)
    }
    const next = Math.min(...approvals.map(lateAt).filter(due => due > at))
    if (Number.isFinite(next)) timer = timers.setTimeout?.(notify, next - at)
    if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
    const { byId, roomsById, prefs } = roster.getSnapshot()
    const on = prefs?.notifications !== false
    const kinds = prefs?.notify ?? {}
    const visible = document.visibilityState === 'visible'
    const shown = shownSession()
    if (visible) unseen.delete(shown)
    const fresh = new Map()
    for (const event of events) {
      if (told.has(event.key)) continue
      told.add(event.key)
      const { entry, kind } = event
      // Waiting or ending before this window opened is no news: the sidebar shows it.
      // Switched off, it stays told, so switching back on brings no old ones.
      if (!on || kinds[kind === 'late' ? 'approval' : kind] === false) continue
      if (kind !== 'late' && (entry.at ?? 0) < since) continue
      const place = entry.roomId ?? entry.sessionId
      if (visible && shown === place) continue
      fresh.set(place, [...fresh.get(place) ?? [], event])
    }
    for (const [place, list] of fresh) {
      const { entry, kind } = list.reduce((last, event) => (event.when >= last.when ? event : last))
      const count = (unseen.get(place) ?? 0) + list.filter(event => event.kind !== 'late').length
      unseen.set(place, count)
      const room = entry.roomId ? roomsById[entry.roomId] : undefined
      const name = byId[entry.botId]?.name ?? t('A Bot')
      const title = kind === 'approval' ? t('{name} is waiting for your approval', { name })
        : kind === 'late' ? t('{name} has waited {n} min for your approval', { name, n: Math.max(15, Math.floor((at - (entry.at ?? at)) / 60000)) })
          : kind === 'finished' ? t('{name} finished', { name })
            : t('{name} failed: {reason}', { name, reason: entry.failed })
      const note = new Notification(title, {
        body: [room?.name, kind === 'approval' || kind === 'late' ? entry.tool : undefined, count > 1 ? t('{count} updates', { count }) : undefined].filter(Boolean).join(' · '),
        tag: `ds-bot-${place}`,
      })
      note.onclick = () => {
        window.focus()
        unseen.delete(place)
        openSession(entry.roomId ?? entry.botId)
        note.close()
      }
    }
  }
  notify()
  const off = work.subscribe(notify)
  return () => {
    off()
    timers.clearTimeout?.(timer)
  }
}
