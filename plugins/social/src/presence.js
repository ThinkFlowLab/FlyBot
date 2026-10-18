// "Thinking" status for other people's Bots (#297). Bot Social's presence signal is ephemeral and
// content-free: `set_presence { state, to | room_id }` says one of my Bots is working toward a friend's
// Bot or a face room, `list_presence` says who is working toward me. Both need the server to list the
// `presence` feature (GET /v1/platform); against an older server nothing is sent or polled.
//
// Send: a local turn that answers a friend (`turn.start` whose trigger is a friend's line) or that runs in
// a face room announces `thinking` and repeats it while the turn runs; `turn.end` says `idle`.
// Receive: the host polls only while a social chat is on screen asking for it (`touch`), keeps the answer in
// memory and clears an entry when that Bot's message arrives. Text never travels: handle, name and state.

export const BEAT_MS = 10_000
export const POLL_MS = 2_500
export const WANTED_MS = 15_000
export const MAX_BEATS = 60
// A message from a Bot ends its thinking line; the server may still list it until the turn's `idle` lands.
export const AFTER_MESSAGE_MS = 4_000
const RECHECK_MS = 10 * 60_000

export function createPresence({
  flybot, api, supported, memberId, normHandle, cleanName,
  now = Date.now, every = globalThis.setInterval, clear = globalThis.clearInterval, warn = () => {},
} = {}) {
  const sending = new Map()
  const disposers = []
  let entries = []
  let wantedUntil = 0
  let pollTimer
  let polling
  let offUntil = 0
  const quiet = new Map()

  const unknown = error => /unknown tool|no tool|method not found|unrecognized tool|tool .* not found/i.test(`${error?.code ?? ''} ${error?.message ?? error ?? ''}`) || error?.code === 'unknown'
  const gone = error => /no_relationship|face_room_not_found|room_not_started|room_closed|forbidden|bot_not_found|bot_frozen/.test(`${error?.code ?? ''} ${error?.message ?? ''}`)

  // ------------------------------------------------------------ send
  function targetOf(event) {
    if (event?.place === 'chat' && event.trigger?.from?.kind === 'remote') {
      const handle = normHandle(event.trigger.from.handle)
      return handle ? { to: handle } : undefined
    }
    if (event?.place === 'group' && event.roomId) {
      const room = flybot.rooms?.list?.().find(item => item.id === event.roomId)
      if (room?.origin === 'face-to-face' && room.face?.roomId && room.face.status === 'open') return { room_id: room.face.roomId }
    }
    return undefined
  }

  async function beat(entry, state) {
    try {
      await api.callTool('set_presence', { bot_id: entry.botId, state, ...entry.target })
    } catch (error) {
      if (unknown(error)) { offUntil = now() + RECHECK_MS; stop(entry, false); return }
      // A refused signal (no longer friends, left the room) or a rate limit is not worth retrying.
      if (gone(error) || error?.code === 'rate_limited') { if (gone(error)) stop(entry, false); return }
      warn('presence not sent', error)
    }
  }

  function stop(entry, say = true) {
    if (entry.timer) clear(entry.timer)
    entry.timer = undefined
    if (sending.get(entry.turnId) === entry) sending.delete(entry.turnId)
    // `idle` only follows a `thinking` that went out.
    if (say && !entry.closed && entry.beats > 0) { entry.closed = true; void beat(entry, 'idle') }
    entry.closed = true
  }

  async function onTurnStart(event) {
    if (flybot.readOnly?.() || !event?.turnId || sending.has(event.turnId)) return
    const target = targetOf(event)
    const botId = event.botId ? memberId(event.botId) : undefined
    if (!target || !botId || now() < offUntil) return
    const entry = { turnId: event.turnId, botId, target, beats: 0, closed: false, timer: undefined }
    sending.set(event.turnId, entry)
    let ok = false
    try { ok = await supported() } catch { ok = false }
    // The turn may have ended while the probe ran.
    if (!ok || entry.closed || sending.get(event.turnId) !== entry) { sending.delete(event.turnId); return }
    const send = () => {
      if (entry.closed) return
      if (++entry.beats > MAX_BEATS) { stop(entry); return }
      void beat(entry, 'thinking')
    }
    send()
    entry.timer = every(send, BEAT_MS)
    entry.timer?.unref?.()
  }

  function onTurnEnd(event) {
    const entry = sending.get(event?.turnId)
    if (entry) stop(entry)
  }

  if (typeof flybot.on === 'function') {
    disposers.push(flybot.on('turn.start', event => { void onTurnStart(event).catch(error => warn('presence start failed', error)) }))
    disposers.push(flybot.on('turn.end', onTurnEnd))
  }

  // ------------------------------------------------------------ receive
  async function pollOnce() {
    if (polling) return polling
    polling = (async () => {
      try {
        if (flybot.readOnly?.() || now() < offUntil || !(await supported())) { entries = []; return }
        const answer = await api.callTool('list_presence', {})
        const base = Date.parse(answer?.server_time)
        const at = now()
        const next = []
        for (const item of Array.isArray(answer?.presence) ? answer.presence : []) {
          const handle = normHandle(item?.bot?.handle)
          if (!handle || item.state !== 'thinking') continue
          const left = Date.parse(item.expires_at) - (Number.isFinite(base) ? base : at)
          // Remaining time on this host's clock, so a skewed server clock does not matter.
          const until = at + Math.max(0, Math.min(Number.isFinite(left) ? left : 20_000, 60_000))
          next.push({ scope: item.scope === 'face_room' ? 'face_room' : 'direct', handle, name: cleanName(item.bot?.display_name, 'Bot'), ...(item.room_id ? { roomId: String(item.room_id) } : {}), until })
        }
        entries = next
      } catch (error) {
        entries = []
        if (unknown(error)) offUntil = now() + RECHECK_MS
        else warn('presence poll failed', error)
      } finally {
        polling = undefined
      }
    })()
    return polling
  }

  function sweep() {
    const at = now()
    entries = entries.filter(item => item.until > at)
    for (const [key, until] of quiet) if (until <= at) quiet.delete(key)
  }
  const keyOf = (handle, roomId) => `${roomId ?? ''}|${handle}`

  function arm() {
    if (pollTimer) return
    pollTimer = every(() => {
      if (now() >= wantedUntil) { clear(pollTimer); pollTimer = undefined; entries = []; return }
      void pollOnce()
    }, POLL_MS)
    pollTimer?.unref?.()
  }

  // The chat on screen asks; polling goes on for WANTED_MS after the last ask.
  function touch() {
    wantedUntil = now() + WANTED_MS
    if (!pollTimer) { arm(); void pollOnce() }
    sweep()
    return view()
  }

  function view() {
    const at = now()
    return {
      supported: now() >= offUntil,
      typing: entries
        .filter(item => item.until > at && !((quiet.get(keyOf(item.handle, item.roomId)) ?? 0) > at))
        .map(item => ({ scope: item.scope, handle: item.handle, name: item.name, ...(item.roomId ? { roomId: item.roomId } : {}), expiresIn: item.until - at })),
    }
  }

  // That Bot's message arrived: its thinking line ends now.
  function arrived({ handle, roomId } = {}) {
    const key = handle ? normHandle(handle) : ''
    if (!key) return
    entries = entries.filter(item => !(item.handle === key && item.roomId === roomId))
    quiet.set(keyOf(key, roomId), now() + AFTER_MESSAGE_MS)
  }

  return {
    touch,
    arrived,
    view,
    pollOnce,
    sending: () => sending.size,
    dispose() {
      for (const off of disposers.splice(0)) off?.()
      for (const entry of [...sending.values()]) stop(entry, false)
      if (pollTimer) clear(pollTimer)
      pollTimer = undefined
    },
  }
}
