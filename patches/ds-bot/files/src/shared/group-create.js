// Helpers for the New group form. The host already creates a room from an
// admin plus members; this file only matches a search and says when Create
// can run, so the form can align its layout and empty states without a
// second create path.

import { pickerBotLabel } from './remote-label.js'

export function groupMemberQuery(query) {
  return String(query ?? '').trim().toLowerCase()
}

export function groupMemberMatches(bot, query) {
  const wanted = groupMemberQuery(query)
  if (!wanted) return true
  if (!bot) return false
  const name = String(bot.name ?? '').toLowerCase()
  const role = String(bot.role ?? '').toLowerCase()
  const label = pickerBotLabel(bot).toLowerCase()
  return name.includes(wanted) || role.includes(wanted) || label.includes(wanted)
}

// A group needs a local admin and at least one more member (local or a friend's Bot).
export function canCreateGroup(admin, members) {
  return admin != null && admin !== '' && Array.isArray(members) && members.length > 0
}
