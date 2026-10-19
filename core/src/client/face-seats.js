// Who sits in a face-to-face room, named one way everywhere: the Members panel, the waiting
// tiles and the @ chips in a bubble (#229, #305). Pure, so the bubble module can use it.
import { t } from './i18n.js'
import { cleanPeerName, ownerNameOf } from '../shared/remote-label.js'

// A face-to-face room lists people, each with the Bot they brought, named one way for every
// member: "Chief (Bob)", "Chief (you)" (#229, #384). Names come from the participant records
// (server member fields for a friend, the roster for my own Bot), never from message text.
export function faceSeats(room, roster) {
  const live = (room.presentedParticipants ?? room.participants ?? []).filter(p => p.kind !== 'human' && p.leftSeq === undefined)
  const seats = live.map((p) => {
    const local = p.remote ? undefined : roster.byId[p.id]
    return {
      key: p.handle || p.id,
      local,
      record: p,
      person: local ? cleanPeerName(p.ownerName || roster.self?.displayName, '') : ownerNameOf(p),
      bot: local ? local.name : cleanPeerName(p.displayName || p.name, 'Bot'),
      mine: Boolean(local),
    }
  })
  for (const id of room.members ?? []) {
    const bot = roster.byId[id]
    if (!bot || seats.some(seat => seat.local?.id === id)) continue
    seats.push({ key: id, local: bot, record: { id }, person: cleanPeerName(roster.self?.displayName, ''), bot: bot.name, mine: true })
  }
  return seats
}

// One name per Bot (#384, #305): "Chief (Bob)", and my own "Chief (you)".
export function faceSeatLabel(seat) {
  if (seat.mine) return t('{bot} (you)', { bot: seat.bot })
  if (!seat.person) return seat.bot
  return `${seat.bot} (${seat.person})`
}
