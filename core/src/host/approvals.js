// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat keeps DSH's card; its requests are only noted, so
// the team view can say who is waiting.
import { randomUUID } from 'node:crypto'
import { OWNER, settled } from './turn-origin.js'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected', 'always-bot': 'allowed-once', 'always-room': 'allowed-once' }

// DSH has no standing grant (its outcomes are one-shot, #540), so the owner's "Always
// allow" lives here: on the Bot or on the group, keyed by the kind of permission asked.
// A sandbox escalation names its mode in DSH's reason; any other ask is keyed by tool.
export function approvalKind(tool, reason) {
  const mode = /^escalate sandbox to ([\w-]+):/.exec(String(reason ?? ''))?.[1]
  return mode ? `${tool}:escalate:${mode}` : String(tool)
}
const kindLabel = (tool, reason) => {
  const mode = /^escalate sandbox to ([\w-]+):/.exec(String(reason ?? ''))?.[1]
  return mode ? `${tool} · ${mode}` : String(tool)
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {id:string, sessionId:string, botId:string, roomId?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, answer?:(outcome:string)=>void}>} */
  const pending = new Map()

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const owner = sessionId === undefined ? undefined : rt.groupOwners.get(sessionId)
    const botId = owner?.botId ?? (sessionId === undefined ? undefined : rt.chatOwners.get(sessionId))
    if (botId === undefined) return next()
    if (standingCovers(sessionId, botId, owner?.roomId, approvalKind(String(request.toolName ?? ''), request.reason))) return 'allowed-once'
    const id = randomUUID()
    const entry = {
      id,
      sessionId,
      botId,
      ...(owner ? { roomId: owner.roomId } : {}),
      tool: String(request.toolName ?? ''),
      reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(sessionId, request.callId) ?? {},
      at: Date.now(),
    }
    pending.set(id, entry)
    rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    const settled = () => {
      pending.delete(id)
      rt.noteApproval?.(sessionId, undefined)
    }
    if (owner === undefined) return Promise.resolve(next()).finally(settled)
    rt.yieldRoomTurn?.(sessionId)
    return new Promise((resolve) => {
      entry.answer = (outcome) => {
        if (!pending.has(id)) return
        settled()
        resolve(outcome)
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
    })
  }, { prepend: true })

  // A group grant covers the owner's Bots working in that group: the Bot it was granted
  // from and any other Bot of the same owner. Before anyone signs in there is one person,
  // and a Bot made then carries no owner, so every local Bot is theirs.
  function standingGrant(botId, roomId, kind) {
    const bot = rt.botOf(botId)
    if (bot === undefined || bot.remote !== undefined) return false
    if ((bot.standingApprovals ?? []).some(grant => grant.kind === kind)) return true
    const room = roomId === undefined ? undefined : rt.roomOf(roomId)
    const sameOwner = grant => !rt.authzEnforced?.() || grant.ownerId === bot.ownerId
    return (room?.standingApprovals ?? []).some(grant => grant.kind === kind && sameOwner(grant))
  }

  // The grant is the owner's: it answers only a turn the owner started (turn-origin.js). A
  // friend's message, a room with other people in it, or a turn with no verdict still asks.
  const standingCovers = (sessionId, botId, roomId, kind) => settled(rt, sessionId) === OWNER && standingGrant(botId, roomId, kind)

  async function grantStanding(entry, scope) {
    await rt.load()
    const bot = rt.botOf(entry.botId)
    const target = scope === 'room' ? rt.roomOf(entry.roomId) : bot
    if (bot === undefined || bot.remote !== undefined) throw Object.assign(new Error('Only your own Bot can be given a standing approval'), { code: 'bot/forbidden' })
    if (target === undefined) throw Object.assign(new Error('This approval did not come from a group'), { code: 'bot/invalid' })
    const kind = approvalKind(entry.tool, entry.reason)
    const grants = target.standingApprovals ?? []
    if (!grants.some(grant => grant.kind === kind && grant.ownerId === bot.ownerId)) {
      const grant = { kind, label: kindLabel(entry.tool, entry.reason), at: Date.now(), ...(bot.ownerId === undefined ? {} : { ownerId: bot.ownerId }) }
      target.standingApprovals = [...grants, grant]
      await rt.save()
    }
    // Other cards the new grant already covers stop waiting too.
    for (const other of pending.values()) {
      if (other.id !== entry.id && other.answer !== undefined && standingCovers(other.sessionId, other.botId, other.roomId, approvalKindOf(other))) other.answer('allowed-once')
    }
  }
  const approvalKindOf = entry => approvalKind(entry.tool, entry.reason)

  // A group's grants are per owner: a signed-in remover (`ownerId`) takes only their own.
  async function removeStandingApproval(scope, id, kind, ownerId) {
    await rt.load()
    const target = scope === 'room' ? rt.roomOf(String(id ?? '')) : rt.botOf(String(id ?? ''))
    if (target === undefined) throw Object.assign(new Error('Not found'), { code: 'bot/not-found' })
    const before = target.standingApprovals ?? []
    const after = before.filter(grant => grant.kind !== String(kind ?? '') || (scope === 'room' && ownerId !== undefined && grant.ownerId !== ownerId))
    if (after.length === before.length) return false
    if (after.length === 0) delete target.standingApprovals
    else target.standingApprovals = after
    await rt.save()
    return true
  }

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined }))
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)

  async function answerApproval(id, choice) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    if (choice === 'always-bot' || choice === 'always-room') await grantStanding(entry, choice === 'always-room' ? 'room' : 'bot')
    entry.answer(outcome)
  }

  // A group Session that leaves its group has no card left to answer from.
  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId) entry.answer?.('cancelled')
    }
  }

  Object.assign(rt, { approvalsView, waitsForApproval, answerApproval, cancelApprovals, removeStandingApproval })
}
