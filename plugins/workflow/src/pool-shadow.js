// The shadow pass of #1550 Stage 3 P1 (#1862): the P0 contract (#1853) runs over a handoff that
// is already in hand, and its answer is only recorded. Nothing in this file decides anything — the
// pass reads plain facts and returns a record, so the pull request fast lane still decides whether
// a card moves. A verdict of `reject` here must leave the run and the card exactly as they were.
import { validateHandoff } from './pool-contract.js'

const MAX_REASON = 200

const text = (value) => (value === undefined || value === null ? '' : String(value))
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The contract records an accepted key in `ctx.seen`. The shadow pass must not, or a real handoff
// that follows it would look like a duplicate, so every mutation-capable shape is copied first.
const cloneSeen = (seen) => {
  if (seen instanceof Set) return new Set(seen)
  if (seen instanceof Map) return new Map(seen)
  if (Array.isArray(seen)) return [...seen]
  if (isObject(seen)) return { ...seen }
  return seen
}

const clip = (value) => {
  const body = text(value).replace(/\s+/g, ' ').trim()
  return body.length > MAX_REASON ? `${body.slice(0, MAX_REASON - 1)}…` : body
}

// One record, two shapes: a refusal names the check that produced it, so the shadow can be
// compared check by check with what the human path did; a pass names the key the real contract
// would have recorded, so the two passes can be joined when the shadow is read later.
export function shadowVerdict(handoff = {}, ctx = {}) {
  let result
  try {
    result = validateHandoff(handoff, { ...ctx, seen: cloneSeen(ctx?.seen) })
  } catch (error) {
    return { verdict: 'reject', code: 'contract-error', reason: clip(error?.message ?? error) }
  }
  if (result?.ok !== true) {
    return {
      verdict: 'reject',
      ...(result?.code ? { code: result.code } : {}),
      ...(result?.reason ? { reason: clip(result.reason) } : {}),
    }
  }
  return { verdict: 'pass', ...(result?.key ? { key: String(result.key) } : {}) }
}

const roleOf = (node) => text(node?.role).trim() || text(node?.name).trim()

// The handoff a run already holds: the card it carries, the node it is handing the card to, the
// node that produced it, its acceptance gate and evidence, and the exec that owns it. A root node
// has no producer, so its handoff names no `fromRole`. This is what lets a real pull request carry
// a verdict without any caller learning a new contract.
export function runHandoff(item = {}, task = {}, run = {}, facts = {}) {
  const nodes = (Array.isArray(item.nodes) ? item.nodes : []).filter(isObject)
  const target = nodes.find(node => node.id === facts.nodeId) ?? nodes[0]
  const edge = (Array.isArray(item.edges) ? item.edges : []).find(candidate => (
    isObject(candidate) && target?.id !== undefined && candidate.to === target.id && candidate.loop !== true && candidate.onFail !== true
  ))
  const producer = edge ? nodes.find(node => node.id === edge.from) : undefined
  const handoff = {
    card: text(task.id) || text(run.id),
    fromRole: roleOf(producer),
    toRole: roleOf(target),
    attempt: 0,
    ...(isObject(task.acceptance) ? { acceptance: task.acceptance } : {}),
    ...(Array.isArray(task.evidence) ? { evidence: task.evidence } : {}),
  }
  const roles = [...new Set(nodes.map(roleOf).filter(name => name !== ''))]
  const declared = Number(item.maxConcurrent)
  const workers = Number.isInteger(facts.workers) && facts.workers > 0
    ? facts.workers
    : Number.isInteger(declared) && declared > 0 ? declared : 1
  const inflight = Number.isFinite(Number(facts.inflight)) ? Number(facts.inflight) : 0
  const ctx = {
    roles,
    // A workflow's declared node role is its pool, and its concurrency cap is how many cards that
    // pool takes at once.
    pools: Object.fromEntries(roles.map(role => [role, { workers }])),
    // One exec per run: the Bot whose call started it, else the Bot that saved the graph, else the
    // workflow row that owns the lane.
    execOwner: text(task.callerBotId) || text(item.authoredBy) || text(item.id),
    // The run holds no other card while this handoff is written.
    worker: { wip: 0 },
    pool: { inflight, workers },
    seen: new Set(),
    quota: {},
    used: {},
  }
  return { handoff, ctx }
}

// The run's own comment: one line beginning `shadow:`, never `Verdict:`, so neither a reader nor a
// gate can mistake it for a conclusion about the pull request.
export function shadowLine(shadow) {
  if (!shadow || typeof shadow.verdict !== 'string' || shadow.verdict === '') return null
  const detail = [shadow.code, shadow.reason].filter((part) => typeof part === 'string' && part !== '')
  return {
    kind: 'system',
    key: 'shadow: {verdict}',
    params: { verdict: shadow.verdict },
    text: [`shadow: ${shadow.verdict}`, ...detail].join(' · '),
  }
}
