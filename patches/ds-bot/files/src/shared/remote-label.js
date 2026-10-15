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
