// Local hide of a friend's Bot (#90): persist the handle, drop it from Friends' Bots,
// and show it again only after it leaves the granted list (two successful home
// fetches in a row, or an explicit revoke) and comes back (re-grant).
export const HIDE_GONE_FETCHES = 2

export function normHiddenHandle(handle) {
  const raw = typeof handle === 'object' && handle !== null
    ? (handle.handle ?? handle.home ?? handle.member ?? '')
    : handle
  const body = String(raw ?? '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 120)
  return body ? `@${body}` : ''
}

// A home identity (@bob.home), not a Bot (@coder.bob.home) and not a legacy per-bot
// identity (@bob.bot). Handle === home is not enough: legacy friends use that shape.
export function isHomeLevelHandle(handle) {
  const key = normHiddenHandle(handle)
  if (!key || key === '@') return false
  const parts = key.slice(1).split('.')
  return parts.length === 2 && parts[1] === 'home'
}

export function hideRemoteInSettings(settings, handle, at = Date.now()) {
  const key = normHiddenHandle(handle)
  if (!key || key === '@') return settings
  return {
    ...settings,
    hiddenRemotes: { ...(settings?.hiddenRemotes ?? {}), [key]: { hiddenAt: at, absentFetches: 0 } },
  }
}

export function isHiddenRemote(settings, handle) {
  const key = normHiddenHandle(handle)
  const hidden = settings?.hiddenRemotes ?? {}
  if (hidden[key] || (typeof handle === 'string' && hidden[handle])) return true
  return Object.keys(hidden).some(entry => normHiddenHandle(entry) === key)
}

// @coder.bob.home → @bob.home; @bob.home stays @bob.home.
export function homeOfHiddenHandle(handle) {
  const key = normHiddenHandle(handle)
  const parts = key.slice(1).split('.')
  if (parts.length >= 2 && parts.at(-1) === 'home') return `@${parts.at(-2)}.home`
  return key
}

// Drop a hide at once (an explicit revoke event). Refresh still needs two successful
// absences before it forgets on its own.
export function revealHiddenIfPresent(settings, presentHandles) {
  let next = settings
  for (const handle of presentHandles ?? []) {
    if (isHiddenRemote(next, handle)) next = clearHiddenRemote(next, handle)
  }
  return next
}

export function clearHiddenRemote(settings, handle) {
  const key = normHiddenHandle(handle)
  if (!key || key === '@') return settings
  const hidden = { ...(settings?.hiddenRemotes ?? {}) }
  let changed = false
  for (const entry of Object.keys(hidden)) {
    if (normHiddenHandle(entry) === key) {
      delete hidden[entry]
      changed = true
    }
  }
  if (!changed) return settings
  return { ...settings, hiddenRemotes: hidden }
}

// Forget a hide only after the Bot has been absent from ≥2 consecutive successful
// non-legacy list_remote_bots results. A failed, partial, cached, or legacy
// (list_friends / per-bot identity) fetch must not un-hide anyone: a Mac on a
// high-latency link was wiping hiddenRemotes to {} on the first refresh after ×.
export function forgetHiddenIfGone(settings, presentHandles, { source = 'home', ok = true, homes } = {}) {
  if (!ok || source !== 'home') return settings
  const present = new Set((presentHandles ?? []).map(normHiddenHandle).filter(key => key && key !== '@'))
  const listedHomes = Array.isArray(homes)
    ? new Set(homes.map(entry => normHiddenHandle(entry?.home ?? entry)).filter(key => key && key !== '@'))
    : null
  const hidden = { ...(settings?.hiddenRemotes ?? {}) }
  let changed = false
  for (const handle of Object.keys(hidden)) {
    const key = normHiddenHandle(handle)
    const rec = hidden[handle] && typeof hidden[handle] === 'object' ? hidden[handle] : { hiddenAt: 0 }
    if (present.has(key)) {
      if ((rec.absentFetches ?? 0) !== 0) {
        hidden[handle] = { ...rec, absentFetches: 0 }
        changed = true
      }
      continue
    }
    // An empty or home-missing result is partial: not evidence that this Bot left.
    if (listedHomes) {
      if (listedHomes.size === 0) continue
      const homeKey = homeOfHiddenHandle(key)
      if (homeKey && !listedHomes.has(homeKey)) continue
    }
    const n = (rec.absentFetches ?? 0) + 1
    if (n >= HIDE_GONE_FETCHES) {
      delete hidden[handle]
      changed = true
    } else {
      hidden[handle] = { ...rec, absentFetches: n }
      changed = true
    }
  }
  if (!changed) return settings
  return { ...settings, hiddenRemotes: hidden }
}

export function filterHiddenHomes(homes, settings) {
  return (homes ?? []).map(entry => ({
    ...entry,
    bots: (entry.bots ?? []).filter(bot => !isHiddenRemote(settings, bot?.handle) && !isHomeLevelHandle(bot?.handle, entry.home)),
  }))
}

export function presentRemoteHandles(homes) {
  return (homes ?? []).flatMap(entry => (entry.bots ?? []).map(bot => normHiddenHandle(bot?.handle)).filter(key => key && key !== '@'))
}

export const WAITING_OWNER = 'Waiting for approval'
export const WAITING_OTHERS = "Waiting for the owner's approval"
export const REJECT_NOTE = 'Rejected.'

export function chatApprovalTitle(canDecide) {
  return canDecide ? WAITING_OWNER : WAITING_OTHERS
}

export function approvalsForSession(items, session = {}) {
  const list = Array.isArray(items) ? items : []
  const asText = (value) => {
    if (value == null) return ''
    if (typeof value === 'object') return String(value.handle ?? value.home ?? '')
    return String(value)
  }
  const handle = asText(session.handle) || asText(session.bot?.remote?.handle)
  const faceId = session.faceRoomId ?? session.room?.face?.roomId
  const roomId = session.roomId ?? session.room?.id
  const handles = new Set((session.handles ?? session.room?.participants ?? [])
    .map(p => (typeof p === 'string' ? p : p?.handle))
    .map(asText)
    .filter(Boolean))
  if (handle) handles.add(handle)
  return list.filter(item => {
    if (item.kind === 'face_room_message') {
      if (faceId && (!item.roomId || item.roomId === faceId)) return true
      if (roomId && item.roomId === roomId) return true
      return false
    }
    if (item.roomId) return item.roomId === roomId || (faceId && item.roomId === faceId)
    const to = asText(item.to)
    const fromHandle = asText(item.fromHandle)
    if (to && handles.has(to)) return true
    if (fromHandle && handles.has(fromHandle)) return true
    return false
  })
}
