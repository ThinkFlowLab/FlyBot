import { digest, requireValue } from './codec.mjs'
import { RuntimeRecoveryError, requireRuntimeEvidence } from './runtime-error.mjs'

export const input = {
  requirement: 'Analyze a retry loop for cancellation races.',
  excerpts: [{ id: 'excerpt-1', text: 'for (let n = 0; n < 3; n++) { if (cancelled) break; await attempt() }' }],
  criteria: 'Explain the race, bound retries, and cite the supplied excerpt.',
}
export class FakeClock {
  value = 1000
  now() { return this.value }
  advance(ms) { requireValue(ms >= 0, 'clock cannot go backwards'); this.value += ms }
}
export class MockPolicy {
  endpoints = { flybot: 'owner-a', opencode: 'owner-b', other: 'owner-c', sibling: 'owner-a' }
  grants = new Set(['flybot:opencode', 'opencode:flybot'])
  owner(bot) { requireValue(Object.hasOwn(this.endpoints, bot), 'unknown endpoint'); return this.endpoints[bot] }
  grant(from, to) {
    requireValue(this.owner(from) !== this.owner(to), 'same-owner friendship forbidden')
    this.grants.add(`${from}:${to}`)
  }
  allowed(from, to) {
    return this.owner(from) !== this.owner(to) && this.grants.has(`${from}:${to}`) && this.grants.has(`${to}:${from}`)
  }
  revoke(from, to) { this.grants.delete(`${from}:${to}`) }
}

// These are synthetic adapter semantics, not claims about OpenCode HTTP behavior.
// Methods intentionally permit duplicate calls so a faulty coordinator is visible.
export class ScriptedRuntime {
  sessions = []
  submissions = []
  aborts = []
  loseCreateReply = false
  loseSubmitReply = false
  offline = false
  confirmAbort = true
  capabilities = { history: true, abort: true }
  create(taskId) {
    requireRuntimeEvidence(!this.offline, 'runtime offline')
    const session = { id: `session-${this.sessions.length + 1}`, taskId }
    this.sessions.push(session)
    if (this.loseCreateReply) throw new RuntimeRecoveryError('lost create reply')
    return session.id
  }
  submit(sessionId, turnId, content) {
    requireRuntimeEvidence(!this.offline, 'runtime offline')
    this.submissions.push({ sessionId, turnId, digest: digest(content), content: { trust: 'peer-untrusted', data: structuredClone(content) } })
    if (this.loseSubmitReply) throw new RuntimeRecoveryError('lost submit reply')
  }
  history(taskId) {
    requireRuntimeEvidence(!this.offline && this.capabilities.history, 'history unavailable')
    return structuredClone({ sessions: this.sessions.filter(s => s.taskId === taskId), submissions: this.submissions })
  }
  abort(sessionId) {
    requireRuntimeEvidence(!this.offline && this.capabilities.abort, 'abort unavailable')
    this.aborts.push(sessionId)
    return this.confirmAbort ? 'stopped' : 'requested'
  }
}

export function eventFor(task, kind, overrides = {}) {
  const payload = kind === 'request' ? { input: task.input } : { text: 'mock event' }
  return { version: 1, kind, eventId: `${kind}-${task.id}`, taskId: task.id, turnId: 'turn-1', generation: task.generation, seq: 1, inputVersion: 1, inputDigest: task.inputDigest, payload, ...overrides }
}
