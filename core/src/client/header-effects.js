// The Session's page effects (#803) live here rather than in header.js so they carry no
// React: they are installed once from `apply` and only follow two plain sources.
import { t } from './i18n.js'
import { friendBotTitle, sharedRoomTitle } from '../shared/remote-label.js'
import { holdComposerLabel } from './composer-label.js'

// The pill's effects belong to the *Session being looked at*, not to the pill being
// painted. They used to sit in HeaderPill's own effects, which tied them to wherever
// the pill happened to render: when the pill moved into a seat the shell hides on a
// blank Session, a friend's empty chat lost its hint, the local stats footer stopped
// hiding in a friend's chat (#419), a new group chat lost its voice styling, the visit
// ledger stopped recording, the composer label went back to the shell's copy and a
// face room's "@" listed the wrong people (#305). Installing them once, over the main
// view's Session, keeps every one of them independent of the pill's seat.
/**
 * Keep the main-view Session's body flags, visit ledger, composer label and face "@"
 * filter in step with the Session the user is looking at, for as long as FlyBot runs.
 * @param root0 - the sessions list, the roster, their live sources and the client actions.
 * @returns teardown for the subscriptions and the last Session's effects.
 */
export function installHeaderEffects({ sessions, roster, actions, doc = globalThis.document }) {
  if (!doc) return () => {}
  // One slot per effect, keyed by that effect's own dependencies, the way a React
  // `useEffect` dependency list would be. A single "did the Session change" guard is
  // not enough: the roster answers after the sessions list does, so on the first pass a
  // friend's chat has no `bot` yet and its flags would never be set, and `blank` flips
  // on the same Session when the first message arrives. Restarting everything on either
  // would also record a second visit for a Session that had only just been opened.
  const slots = new Map()
  const run = (id, dep, setup) => {
    const held = slots.get(id)
    if (held !== undefined && held.dep === dep) return
    held?.off()
    slots.set(id, { dep, off: setup() ?? (() => {}) })
  }
  const apply = () => {
    const list = sessions.getSnapshot()
    const state = roster.getSnapshot()
    const row = Object.values(list?.byId ?? {}).find(entry => (entry?.retainedBy?.mainView ?? 0) > 0)
    const sessionId = row?.id
    const bot = sessionId === undefined ? undefined : state?.byId?.[sessionId]
    const room = sessionId === undefined ? undefined : state?.roomsById?.[sessionId]
    const name = bot?.remote
      ? friendBotTitle(bot)
      : (room?.displayName || (room?.sharedFrom ? sharedRoomTitle(room.sharedFrom.inviterName) : room?.name) || bot?.name || '')
    // A friend's Bot runs on its owner's home, so the local run stats are relay turns
    // (always 0): CSS hides the shell's stats footer in that chat (#419).
    run('friend-chat', `${sessionId}|${bot?.remote === true}`, () => {
      if (!bot?.remote) return undefined
      doc.body.dataset.btFriendChat = ''
      return () => { delete doc.body.dataset.btFriendChat }
    })
    // The hint is for an empty chat, which is exactly the state whose header seat the
    // shell hides (#173).
    run('remote-empty', `${sessionId}|${bot?.remote === true}|${row?.blank === true}`, () => {
      if (!bot?.remote || row?.blank !== true) return undefined
      doc.body.dataset.btRemoteChat = 'empty'
      doc.body.style.setProperty('--bt-remote-empty', JSON.stringify(t('Send a message. Your friend approves unless Auto-send is on.')))
      return () => {
        delete doc.body.dataset.btRemoteChat
        doc.body.style.removeProperty('--bt-remote-empty')
      }
    })
    // Before the first paint, and again whenever the shell renders its own composer copy (#419, #499).
    run('composer-label', `${sessionId}|${name}`, () => holdComposerLabel(doc, name ? t('Message {name}', { name }) : t('Message')))
    // Keyed by the Session alone: a roster answer that only names this Bot must not
    // close and reopen the visit, which would lose what the visit had already recorded.
    run('visit', sessionId, () => {
      if (sessionId === undefined) return undefined
      actions.beginVisit(sessionId)
      return () => actions.endVisit(sessionId)
    })
    // A face room's "@" lists the room's people and Bots, not the shell's Sessions (#305).
    run('face-at-menu', `${sessionId}|${room?.origin === 'face-to-face'}`, () => {
      if (room?.origin !== 'face-to-face') return undefined
      const stop = actions.filterFaceAtMenu?.(sessionId)
      return typeof stop === 'function' ? stop : undefined
    })
    // Group chats have no voice mode, so the composer CSS needs to know the Session kind.
    run('room-flag', `${sessionId}|${room !== undefined}`, () => {
      if (room === undefined) return undefined
      doc.body.dataset.btRoom = ''
      return () => { delete doc.body.dataset.btRoom }
    })
  }
  apply()
  const offSessions = sessions.subscribe(apply)
  const offRoster = roster.subscribe(apply)
  return () => {
    offSessions?.()
    offRoster?.()
    for (const held of slots.values()) held.off()
    slots.clear()
  }
}
