// Display labels for a friend's published Bot and for a room the owner did not start.
// Peer-controlled strings (names, homes, handles) are untrusted: strip controls and
// markup so a name cannot look like instructions when it later reaches a model.

export function cleanPeerName(name, fallback = '') {
  const text = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/[[\]"`<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return text || fallback
}

export function normRemoteHandle(handle) {
  return `@${String(handle ?? '').trim().replace(/^@+/, '').toLowerCase()}`
}

function ownerFromHandle(handle) {
  const parts = String(handle ?? '').replace(/^@/, '').split('.')
  if (parts.length >= 3 && parts.at(-1) === 'home') return parts.at(-2)
  if (parts.length === 2 && parts[1] === 'home') return parts[0]
  return ''
}

export function isHomeLevelRemote(record) {
  const handle = String(record?.handle ?? record?.remote?.handle ?? '')
  const key = normRemoteHandle(handle)
  const parts = key.replace(/^@/, '').split('.')
  return parts.length === 2 && parts[1] === 'home'
}

export function isListedRemoteChat(bot) {
  if (!bot) return false
  if (bot.hidden) return false
  const remote = bot.remote
  if (!remote || typeof remote.handle !== 'string') return true
  if (remote.gone || remote.hidden) return false
  if (isHomeLevelRemote(remote)) return false
  return true
}

export function listedChatBots(roster) {
  return (roster?.bots ?? []).filter(isListedRemoteChat)
}

// New-chat / create-room: local Bot ids stay members; a friend's chat becomes a remote participant.
export function splitRoomPicks(roster, ids) {
  const byId = roster?.byId ?? Object.fromEntries((roster?.bots ?? []).map(bot => [bot.id, bot]))
  const members = []
  const remotes = []
  const seen = new Set()
  for (const id of ids ?? []) {
    const bot = byId[id]
    const handle = bot?.remote?.handle
    if (typeof handle === 'string' && handle) {
      const key = normRemoteHandle(handle)
      if (seen.has(key)) continue
      seen.add(key)
      remotes.push({ kind: 'bot', remote: true, handle: key })
    } else {
      members.push(id)
    }
  }
  return { members, remotes }
}

export function pickerBotLabel(bot) {
  if (!bot) return ''
  if (!bot.remote) return bot.name ?? ''
  return remoteBotTitle({
    displayName: bot.name,
    name: bot.name,
    ownerName: bot.remote.owner || bot.remote.homeName,
    owner: bot.remote.owner,
    homeName: bot.remote.homeName,
    home: bot.remote.home,
    handle: bot.remote.handle,
    isChief: bot.remote.isChief,
  })
}

export function ownerNameOf(record) {
  if (!record) return ''
  return cleanPeerName(record.ownerName || record.homeName || record.owner || record.ownerHome || record.home || ownerFromHandle(record.handle), '')
}

export function isChiefRecord(record) {
  if (!record) return false
  if (record.isChief === true) return true
  return /^chief$/i.test(String(record.displayName || record.name || ''))
}

// Inviter and every other human in the room: "Coder · Bob's Bot", or "Bob's Chief".
export function remoteBotTitle(record) {
  const owner = ownerNameOf(record) || cleanPeerName(record?.handle, 'Friend')
  const name = cleanPeerName(record?.displayName || record?.name, cleanPeerName(record?.handle, 'Bot'))
  if (isChiefRecord(record)) return `${owner}'s Chief`
  return `${name} · ${owner}'s Bot`
}

export function remoteOwnerBadge(record) {
  const owner = ownerNameOf(record) || cleanPeerName(record?.handle, 'Friend')
  return isChiefRecord(record) ? `${owner}'s Chief` : `${owner}'s Bot`
}

export function sharedRoomTitle(inviterName) {
  return `Shared room from ${cleanPeerName(inviterName, 'a friend')}`
}

// Same name from two owners: keep the owner in the label (remoteBotTitle already does).
export function disambiguatedRemoteTitle(record, others = []) {
  const title = remoteBotTitle(record)
  const name = cleanPeerName(record?.displayName || record?.name)
  if (!name) return title
  const clash = others.some(item => item !== record && cleanPeerName(item?.displayName || item?.name) === name && ownerNameOf(item) !== ownerNameOf(record))
  return clash ? title : title
}

// The host refuses a group that mixes a friend's Bot with one of my Bots that is not shared with
// that friend, and says which (`details.reason === 'ungranted-local'`). Read it defensively: it is
// a plain JSON object from the host, and the names inside are shown, never executed.
export function ungrantedLocalFix(details) {
  if (details?.reason !== 'ungranted-local' || !Array.isArray(details.bots)) return undefined
  const bots = details.bots
    .filter(bot => typeof bot?.id === 'string' && bot.id !== '')
    .map(bot => ({ id: bot.id, name: cleanPeerName(bot.name, bot.id) }))
  if (bots.length === 0) return undefined
  const friends = [...new Set((Array.isArray(details.remotes) ? details.remotes : [])
    .map(remote => cleanPeerName(remote?.owner || remote?.name, '')).filter(Boolean))]
  return { bots, friends }
}

// Puts `text` on the clipboard and says whether it really got there. A page with no clipboard
// (an insecure context, a locked-down WebView) or a refused write is `false`, never a quiet success.
export async function copiedToClipboard(text, nav = globalThis.navigator) {
  const write = nav?.clipboard?.writeText
  if (typeof write !== 'function') return false
  try {
    await write.call(nav.clipboard, text)
    return true
  } catch {
    return false
  }
}

const trimmed = value => String(value ?? '').trim()

// Every name one face-room participant answers to (#287): its own name, the label the picker gave
// it, the other home's title for it, `Bot · Person` and the bare handle. Longest first is left to
// mentionSpans. The host routes on these and the bubble draws them as one chip (#305).
export function faceAliases(participant, name) {
  const owner = trimmed(participant.ownerName)
  const handle = trimmed(participant.handle).replace(/^@+/, '')
  const title = remoteBotTitle({ displayName: name, name, ownerName: owner, handle: participant.handle })
  const names = [name, participant.label, title, owner ? `${name} · ${owner}` : '', owner ? `${name} · ${owner}'s Bot` : '', handle]
  return [...new Set(names.map(trimmed).filter(Boolean))]
}
