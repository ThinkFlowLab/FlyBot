// bot.send middleware for tree Bots: a tree Bot may message only its parent and direct children.
// - Remote targets (msg.target.remote === true, else bot.isRemote(to)) are never tree members:
//   no opinion (undefined), left to social; their fields are not read.
// - A REMOTE sender (a friend's Bot) may reach a tree Bot only if the core says it has a
//   person-grant (flybot.bot.hasAnyGrant, #90): an ungranted tree Bot is denied, a granted
//   one is reached directly, never through the root. Tree does not redirect it.
// - A non-root tree Bot sending to a LOCAL Bot outside the tree is denied; the root (Chief, the
//   user's main bot) may message any local bot.
// - A local non-tree sender may reach only the tree root; other tree nodes are denied.
// - Granted Bots on both sides (someone accepted Sharing → Copy invite link) are not the tree's call
//   across trees or to non-tree Bots: undefined, and the core's owner policy decides who may
//   reach whom. Inside one tree the parent/child rule still holds.
// - Non-tree -> non-tree traffic is not the tree's call: undefined.
// - Control notices (role 'stopped' from stop_bot, 'report' from groups) bypass tree policy:
//   a Main Bot / admin must be able to stop or report to any tree bot (ThinkFlowLab/FlyBot#15).
// - Allowed edges: undefined, or allow + bypass:['social'] when config.bypassSocial === true.
const DENY_EDGE = 'tree: a bot may message only its parent and its direct children'
const DENY_INTO = 'tree: bots outside the tree may message only the tree root'
export const DENY_UNGRANTED = 'tree: this bot has not been granted to this sender, so it cannot be reached from outside'
export const DENY_UNPUBLISHED = DENY_UNGRANTED
export const CONTROL_ROLES = new Set(['stopped', 'report'])
const DENY_OUTSIDE = 'tree: a tree bot may not message local bots outside the tree'

// `hasAnyGrant(id)`: true / false from the core, undefined where the core has no such flag.
export function treeSendMiddleware(tree, { bypassSocial = false, isRemote = () => false, hasAnyGrant = () => undefined, isPublished } = {}) {
  const grantedFn = typeof hasAnyGrant === 'function' ? hasAnyGrant : isPublished
  const granted = id => grantedFn(id) === true
  return function treeSend(msg) {
    const from = msg?.from
    const to = msg?.target && msg.target.remote === false ? msg.target.id : msg?.to ?? msg?.target?.id
    if (!from || !to) return undefined
    // A remote sender is judged first: it never reaches the control-role bypass below.
    if (typeof from !== 'string' || isRemote(from)) {
      if (typeof to === 'string' && tree.isMember(to) && grantedFn(to) === false) return { action: 'deny', reason: DENY_UNGRANTED }
      return undefined
    }
    if (CONTROL_ROLES.has(msg.role)) return bypassSocial ? { action: 'allow', bypass: ['social'] } : undefined
    if (msg.target?.remote === true || isRemote(to)) return undefined
    const { fromIn, toIn, allowed } = tree.isTreeEdge(from, to)
    const bothGranted = granted(from) && granted(to)
    if (!fromIn) {
      if (!toIn) return undefined // non-tree traffic: not the tree's call
      if (tree.isRoot(to) || bothGranted) return undefined
      return { action: 'deny', reason: DENY_INTO }
    }
    if (!toIn) return tree.isRoot(from) || bothGranted ? undefined : { action: 'deny', reason: DENY_OUTSIDE } // the root (Chief) may message any local bot
    if (!allowed) return bothGranted && tree.rootOf(from) !== tree.rootOf(to) ? undefined : { action: 'deny', reason: DENY_EDGE }
    return bypassSocial ? { action: 'allow', bypass: ['social'] } : undefined
  }
}
