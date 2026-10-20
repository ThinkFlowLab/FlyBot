import { t } from './i18n.js'

// A system notification for each approval that starts waiting, and each turn of the user's
// own Bots that finishes or fails (#353), while this window is in the background or shows
// another conversation. Only where the platform already allows notifications: DS Bot never
// asks for the permission. Settings → General → Notifications turns them all off. A
// notification only opens its chat: it never approves, rejects or sends anything.
export function noticeApprovals({ work, roster, shownSession, openSession, since = Date.now() }) {
  const told = new Set()
  const notify = () => {
    const { approvals = [], ended = [] } = work.getSnapshot()
    const events = [
      ...approvals.map(entry => ({ entry, kind: 'approval' })),
      ...ended.map(entry => ({ entry, kind: entry.failed === undefined ? 'finished' : 'failed' })),
    ]
    const key = ({ entry, kind }) => `${kind === 'approval' ? 'approval' : 'turn'}-${entry.id}`
    const current = new Set(events.map(key))
    for (const id of told) {
      if (!current.has(id)) told.delete(id)
    }
    if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
    const { byId, roomsById, prefs } = roster.getSnapshot()
    const on = prefs?.notifications !== false
    for (const event of events) {
      const id = key(event)
      if (told.has(id)) continue
      told.add(id)
      const { entry, kind } = event
      // Waiting or ending before this window opened is no news: the sidebar shows it.
      // Switched off, it stays told, so switching back on brings no old ones.
      if (!on || (entry.at ?? 0) < since) continue
      const place = entry.roomId ?? entry.sessionId
      if (document.visibilityState === 'visible' && shownSession() === place) continue
      const room = entry.roomId ? roomsById[entry.roomId] : undefined
      const name = byId[entry.botId]?.name ?? t('A Bot')
      const title = kind === 'approval' ? t('{name} is waiting for your approval', { name })
        : kind === 'finished' ? t('{name} finished', { name })
          : t('{name} failed: {reason}', { name, reason: entry.failed })
      const note = new Notification(title, {
        body: [room?.name, kind === 'approval' ? entry.tool : undefined].filter(Boolean).join(' · '),
        tag: `ds-bot-${id}`,
      })
      note.onclick = () => {
        window.focus()
        openSession(entry.roomId ?? entry.botId)
        note.close()
      }
    }
  }
  notify()
  return work.subscribe(notify)
}
