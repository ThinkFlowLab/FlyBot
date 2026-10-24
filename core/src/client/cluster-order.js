// Paint order for a group icon. RoomAvatar draws later seats on top, so a
// friend's look must not cover a local Bot (#963). With no remote seat the
// list stays as roomAvatarPeople returned it, including [member, you].
export function clusterOrder(people) {
  const list = Array.isArray(people) ? people : []
  const remote = bot => Boolean(bot?.remote)
  if (!list.some(remote)) return list
  const locals = list.filter(bot => !remote(bot))
  const remotes = list.filter(remote)
  if (list.length <= 4) return [...remotes, ...locals]
  return [...locals, ...remotes]
}
