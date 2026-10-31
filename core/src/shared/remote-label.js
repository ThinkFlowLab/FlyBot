// Display labels for a friend's published Bot and for a room the owner did not start.
// Peer-controlled strings (names, homes, handles) are untrusted: strip controls and
// markup so a name cannot look like instructions when it later reaches a model.
import { cut } from './text-boundary.js'

export function cleanPeerName(name, fallback = '') {
  const text = String(name ?? '').toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/[[\]"`<>]/g, '').replace(/\s+/g, ' ').trim()
  const label = cut(text, 60).text
  return label || fallback
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

// Two questions, two readers (#956). `isListedRemoteChat` answers "may I send to this Bot, offer it
// in a picker, mention it": a share that ended is not a place to send to. The sidebar asks "is this
// the user's conversation": a chat whose Bot left the published list keeps its row, its history and
// its way back, marked as no longer shared. Only a hide the user set (#611) takes a row out, and
// `remote.gone` never doubles as one — the two flags stay apart.
export function isShownRemoteChat(bot) {
  if (!bot) return false
  if (isListedRemoteChat(bot)) return true
  if (bot.remote?.gone !== true) return false
  // `hiddenByGone` is the marker a version before #956 wrote beside the hide it imposed: nothing here
  // writes it, and `remoteChats.sync` deletes it with that hide, so a state file not yet synced still
  // shows the row and a later hide of the user's is left alone.
  return bot.hidden !== true || bot.remote.hiddenByGone === true
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

// An owner name made up from an install id ("FlyBot 682b8a43") names nobody (#526): the owner's
// username, the part of the home handle Bot Social derived from it, does.
const AUTO_OWNER = /^flybot[\s._-]*(?=[0-9a-f]*\d)[0-9a-f]{6,}$/i
export function isAutoOwnerName(name) {
  return AUTO_OWNER.test(String(name ?? '').trim())
}

export function ownerNameOf(record) {
  if (!record) return ''
  const named = cleanPeerName(record.ownerName || record.owner || record.homeName || record.ownerHome || record.home || ownerFromHandle(record.handle), '')
  if (!isAutoOwnerName(named)) return named
  const other = [record.ownerName, record.owner, record.homeName].map(value => cleanPeerName(value, '')).find(value => value && !isAutoOwnerName(value))
  return other || cleanPeerName(ownerFromHandle(record.handle) || ownerFromHandle(record.ownerHome) || ownerFromHandle(record.home), '') || named
}

// The owner Bot Social stamped on my own Bot's seat, read the same way (#526); none: ''.
export function seatOwnerName(ownerName, handle) {
  return ownerName ? ownerNameOf({ ownerName, handle }) : ''
}

const ownerKey = value => String(value ?? '').toLowerCase().replace(/[\s._@-]+/g, '')

// Bot Social labels a room member "<Bot> · <owner>". As a Bot's name that repeats the owner the
// title adds anyway (#526: "Reviewer · FlyBot 682b8a43 (flybot682b8a43)"), so only the Bot's part
// stays. A name whose tail is not that owner is the Bot's own name and is kept whole.
export function remoteBotName(record, fallback = '') {
  const name = cleanPeerName(record?.displayName || record?.name, fallback)
  const at = name.lastIndexOf(' · ')
  if (at <= 0) return name
  const tail = ownerKey(name.slice(at + 3))
  const owners = [record?.ownerName, record?.owner, record?.homeName, ownerFromHandle(record?.handle), ownerNameOf(record)].map(ownerKey).filter(Boolean)
  return isAutoOwnerName(name.slice(at + 3)) || owners.includes(tail) ? name.slice(0, at).trim() : name
}

export function isChiefRecord(record) {
  if (!record) return false
  if (record.isChief === true) return true
  return /^chief$/i.test(String(record.displayName || record.name || ''))
}

// A friend's Bot, named one way everywhere (owner decision on #384/#305): the Bot's name, then
// its owner in parentheses: "Helper (Bob)", and a friend's Chief the same way: "Chief (Bob)".
export function remoteBotTitle(record) {
  const owner = ownerNameOf(record) || cleanPeerName(record?.handle, 'Friend')
  const name = remoteBotName(record, isChiefRecord(record) ? 'Chief' : cleanPeerName(record?.handle, 'Bot'))
  return `${name} (${owner})`
}

// What a group @ inserts and what the room routes on (#1141). The menu may still show
// remoteBotTitle ("Architect (flybot682b8a43)"); the token is the Bot's own name. A handle,
// a ".home" address, or the placeholder owner "Friend" is not a call token — a handle falls
// back to its first label (architect.flybot….home → architect).
export function remoteCallName(record) {
  const handle = String(record?.handle ?? '').replace(/^@+/, '').trim()
  const bare = remoteBotName(record, '').replace(/^@+/, '').trim()
  const unusable = (value) => {
    const text = String(value ?? '').replace(/^@+/, '').trim()
    if (!text || /^friend$/i.test(text)) return true
    if (text.includes('@') || /\.home\b/i.test(text)) return true
    if (handle && text.toLowerCase() === handle.toLowerCase()) return true
    return false
  }
  if (!unusable(bare)) return bare
  // The first label of a handle is peer-controlled (a ticket or a claim). The same
  // cleaner as a display name, so a newline or a fence fragment cannot be the token.
  const slug = cleanPeerName(handle.split('.')[0], '')
  if (slug && !unusable(slug)) return slug
  return 'Bot'
}

// The owner part of that name, for a badge next to the Bot's own name.
export function remoteOwnerBadge(record) {
  return ownerNameOf(record) || cleanPeerName(record?.handle, 'Friend')
}

// The record those two read for a friend's Bot as the roster lists it: its chat (`bot.remote` from
// remote-chat.js, named by the chat) or a published roster record (roster.remoteBots, which carries
// the name, owner and home at the top level and `remote: true`). Reading both shapes here is what
// keeps a Bot's name the same before and after its chat exists (#498, #967).
function friendRecord(bot) {
  const remote = bot?.remote && typeof bot.remote === 'object' ? bot.remote : {}
  return {
    displayName: remote.displayName || remote.name || bot?.name,
    ownerName: remote.ownerName || remote.owner || remote.homeName || bot?.ownerName || bot?.owner || bot?.homeName,
    handle: remote.handle ?? bot?.handle,
    isChief: remote.isChief ?? bot?.isChief,
  }
}

// A friend's Bot, one name on both homes (#498): the sidebar row, the chat header and tab, the
// composer placeholder and the @ menu all say "Chief (SelfB1233)", from this one function.
export function friendBotTitle(bot) {
  return remoteBotTitle(friendRecord(bot))
}

const mentionHandleOf = record => String((record?.remote && typeof record.remote === 'object' ? record.remote.handle : record?.handle) ?? '').replace(/^@+/, '').toLowerCase()

// The one name a friend's Bot wears where a mention is shown or picked (#967): the same title as
// its sidebar row (#498), so the `@` menu, the bubble and the preview never disagree. Two friends
// may publish a Bot with the same name, so a title that two different handles share carries the
// home: one name still names one Bot at the transport, and the handle stays the routing key.
export function remoteMentionLabel(record, others = []) {
  const title = friendBotTitle(record)
  const key = mentionHandleOf(record)
  const clash = (others ?? []).some((other) => {
    const otherKey = mentionHandleOf(other)
    return otherKey !== '' && otherKey !== key && friendBotTitle(other) === title
  })
  if (!clash) return title
  const home = cleanPeerName(String(record?.remote?.home ?? record?.home ?? '').replace(/^@+/, ''), '')
  return home ? `${title} · ${home}` : title
}

// The person who owns a friend's Bot: who a held reply to that Bot goes to (#418, #498).
export function friendBotOwner(bot) {
  return remoteOwnerBadge(friendRecord(bot))
}

export function sharedRoomTitle(inviterName) {
  return `Shared room from ${cleanPeerName(inviterName, 'a friend')}`
}

// What a room is called in the sidebar, the header and the details drawer. A room a link opened
// (#884) keeps the name its owner gave it, and who shared it is secondary text (#892); a friend's
// shared room, or a link room with no name, says who shared it.
export function roomTitle(room) {
  if (!room) return ''
  const name = cleanPeerName(room.name, '')
  if (room.sharedFrom?.ticket && name) return name
  return room.displayName || (room.sharedFrom ? sharedRoomTitle(room.sharedFrom.inviterName) : room.name) || ''
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
  // The older labels ("Bob · Chief", "Chief · Bob's Bot", "Bob's Chief") stay aliases, so a line typed
  // before the one-name rule (#384) still calls the same Bot.
  const legacy = owner ? [`${name} · ${owner}`, `${owner} · ${name}`, `${name} · ${owner}'s Bot`, ...(/^chief$/i.test(trimmed(name)) ? [`${owner}'s Chief`] : [])] : []
  const names = [name, participant.label, title, ...legacy, handle]
  return [...new Set(names.map(trimmed).filter(Boolean))]
}
