// Who sits in a face-to-face room, named one way everywhere: the Members panel, the waiting
// tiles, the @ menu, the bubble headers and the @ chips in a bubble (#229, #305, #457). Pure, so
// the bubble module can use it.
import { t } from './i18n.js'
import { cleanPeerName, ownerNameOf, remoteBotName, seatOwnerName } from '../shared/remote-label.js'

// A face-to-face room lists people, each with the Bots they brought, and names every Bot one way
// for every member: "Chief (Bob)", my own "Chief (Ann)" too (#229, #384, #457). Names come from
// the participant records (server member fields for a friend, the roster for my own Bot), never
// from message text. `left: true` keeps the seats of people who left, after the live ones, so a
// line sent before a leave still names the Bot it named (#457).
export function faceSeats(room, roster, { left = false } = {}) {
  const records = (room.presentedParticipants ?? room.participants ?? []).filter(p => p.kind !== 'human')
  const seat = (p) => {
    const local = p.remote ? undefined : roster.byId[p.id]
    return {
      key: p.handle || p.id,
      local,
      record: p,
      person: local ? (seatOwnerName(p.ownerName, p.handle) || cleanPeerName(roster.self?.displayName, '')) : ownerNameOf(p),
      bot: local ? local.name : remoteBotName(p, 'Bot'),
      mine: Boolean(local),
    }
  }
  const seats = records.filter(p => p.leftSeq === undefined).map(seat)
  for (const id of room.members ?? []) {
    const bot = roster.byId[id]
    if (!bot || seats.some(item => item.local?.id === id)) continue
    seats.push({ key: id, local: bot, record: { id }, person: cleanPeerName(roster.self?.displayName, ''), bot: bot.name, mine: true })
  }
  if (!left) return seats
  const gone = records.filter(p => p.leftSeq !== undefined && !seats.some(item => item.key === (p.handle || p.id))).map(item => ({ ...seat(item), left: true }))
  return [...seats, ...gone]
}

// One name per Bot (#384, #305, #457): "Chief (Bob)", and my own the same way, "Chief (Ann)".
// "(you)" belongs to a person, never to a Bot.
export function faceSeatLabel(seat) {
  if (!seat.person) return seat.bot
  return `${seat.bot} (${seat.person})`
}

// My own Bot as the room names it (#457): "Chief (Ann)", the person being the owner name Bot
// Social stamped on its seat, else my own name. Outside a face room a Bot is its plain name.
export function faceBotLabel(room, roster, bot) {
  if (room?.origin !== 'face-to-face' || !bot) return bot?.name
  const seat = faceSeats(room, roster, { left: true }).find(item => item.local?.id === bot.id || (item.record?.id !== undefined && item.record.id === bot.id))
  return seat ? faceSeatLabel(seat) : bot.name
}

// People are told apart by home, not by display name: two owners may both be "Alex".
export function facePersonKey(seat) {
  if (seat.mine) return ':you'
  const record = seat.record ?? {}
  const home = String(record.ownerHome || record.home || '').trim().toLowerCase()
  if (home) return `home:${home}`
  const parts = String(record.handle || '').trim().toLowerCase().replace(/^@+/, '').split('.')
  if (parts.length >= 3 && parts.at(-1) === 'home') return `home:${parts.slice(-2).join('.')}`
  return `name:${(ownerNameOf(record) || seat.person || seat.key).toLowerCase()}`
}

// The room person-first (#457): one entry per person, mine first, each with the Bots they brought.
export function facePeople(room, roster) {
  const people = []
  for (const seat of faceSeats(room, roster)) {
    const key = facePersonKey(seat)
    const known = people.find(person => person.key === key)
    if (known) { known.seats.push(seat); continue }
    people.push({ key, name: seat.person || (seat.mine ? cleanPeerName(roster.self?.displayName, '') : '') || t('Someone'), mine: seat.mine, seats: [seat] })
  }
  return [...people.filter(person => person.mine), ...people.filter(person => !person.mine)]
}

// "Ann (you)" for me, "Bob" for anyone else: "(you)" only ever on a person (#457).
export function facePersonLabel(person) {
  return person.mine ? t('{name} (you)', { name: person.name }) : person.name
}
