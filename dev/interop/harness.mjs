import { decode, digest, requireValue, validateInput } from './codec.mjs'
import { Journal } from './journal.mjs'
import { RuntimeRecoveryError, requireRuntimeEvidence } from './runtime-error.mjs'

const DEFAULTS = { turns: 4, messages: 8, progress: 12, durationMs: 600000 }
const TERMINAL = new Set(['accepted', 'cancelled', 'failed'])
const HOST_KINDS = new Set(['request', 'answer', 'cancel'])
const get = (map, id) => Object.hasOwn(map, id) ? map[id] : undefined
const contentOf = event => ({ kind: event.kind, turnId: event.turnId, payload: event.payload, inReplyTo: event.inReplyTo ?? null })

// An offline contract simulator. All identity/approval arguments are fixture
// inputs; none of these methods is a production authentication boundary.
export class Pilot {
  constructor({ dir, clock, policy, runtime }) {
    this.clock = clock; this.policy = policy; this.runtime = runtime
    this.journal = new Journal(dir)
    this.journal.transaction(state => {
      for (const task of Object.values(state.tasks)) {
        if (task.execution && !TERMINAL.has(task.status)) task.recovery = 'uncertain'
      }
    })
  }
  close() { this.journal.close() }
  task(id) {
    const task = get(this.journal.state.tasks, id)
    requireValue(task, 'unknown task')
    return structuredClone(task)
  }
  enroll({ id, actor, from, to, input, limits = {} }) {
    requireValue(typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(id), 'invalid task id')
    validateInput(input)
    requireValue(actor === this.policy.owner(from), 'only requester can enroll')
    requireValue(this.policy.allowed(from, to), 'grant required; same-owner friendship forbidden')
    requireValue(Object.keys(limits).every(key => Object.hasOwn(DEFAULTS, key)), 'unknown budget')
    const budget = { ...DEFAULTS, ...limits }
    for (const key of Object.keys(budget)) requireValue(Number.isSafeInteger(budget[key]) && budget[key] > 0 && budget[key] <= DEFAULTS[key], 'invalid budget')
    return this.journal.transaction(state => {
      requireValue(!get(state.tasks, id) && Object.keys(state.tasks).length < 64, 'duplicate task or journal full')
      requireValue(Object.values(state.tasks).filter(t => !TERMINAL.has(t.status) && t.status !== 'result-ready').length < 2, 'concurrency limit')
      const task = {
        id, requester: actor, from, to, fromOwner: this.policy.owner(from), toOwner: this.policy.owner(to),
        input: structuredClone(input), budget, inputDigest: digest({ id, from, to, actor, input, budget }),
        deadline: this.clock.now() + budget.durationMs, status: 'open', generation: 0,
        counts: { turns: 0, messages: 0, progress: 0 }, seq: {}, turns: {}, sessionId: null,
        active: null, pending: null, waiting: null, recovery: null, execution: null, cancel: null,
        usage: { modelRequests: null, tokens: null, cost: null }, result: null,
      }
      state.tasks[id] = task
      return task
    })
  }
  checkPolicy(task) {
    requireValue(this.policy.allowed(task.from, task.to), 'grant revoked')
    requireValue(this.policy.owner(task.from) === task.fromOwner && this.policy.owner(task.to) === task.toOwner, 'owner binding changed')
  }
  checkEvent(task, event) {
    this.checkPolicy(task)
    requireValue(!TERMINAL.has(task.status), 'task terminal')
    requireValue(event.inputVersion === 1 && event.inputDigest === task.inputDigest, 'input version mismatch')
    requireValue(event.generation === task.generation, 'stale generation')
    if (event.kind !== 'cancel') {
      requireValue(this.clock.now() < task.deadline, 'deadline exceeded')
      requireValue(!task.recovery, 'execution uncertain')
    }
  }
  receive(raw, context) {
    const event = decode(raw), task = this.task(event.taskId)
    requireValue(context && Object.keys(context).every(key => ['server', 'sender', 'recipient', 'cursor'].includes(key)), 'unsupported transport context')
    const host = HOST_KINDS.has(event.kind)
    const sender = host ? task.from : task.to, recipient = host ? task.to : task.from
    requireValue(context.server === 'mock-social' && context.sender === sender && context.recipient === recipient, 'transport identity mismatch')
    if (context.cursor !== undefined) requireValue(Number.isSafeInteger(context.cursor) && context.cursor >= 0, 'invalid cursor')
    this.checkEvent(task, event)
    const fingerprint = digest({ event, sender, recipient, server: context.server })
    const prior = get(this.journal.state.inbox, event.eventId)
    if (prior) {
      requireValue(prior.fingerprint === fingerprint, 'event conflict')
      return { action: 'duplicate' }
    }
    requireValue(event.kind !== 'cancel-observed', 'stop must be observed through the runtime')
    requireValue(!task.pending || event.kind === 'cancel', 'task has pending approval')
    requireValue(event.seq === (task.seq[sender] ?? 0) + 1, 'out-of-order event')
    this.checkShape(task, event)
    const stages = event.kind === 'cancel' ? [] : [{ stage: 'delivery', owner: this.policy.owner(sender), approved: false }]
    if (event.kind === 'request' || event.kind === 'answer') stages.push({ stage: 'execution', owner: task.toOwner, approved: false })
    this.journal.transaction(state => {
      requireValue(Object.keys(state.inbox).length < 256, 'inbox full')
      const current = state.tasks[task.id]
      const counter = event.kind === 'progress' ? 'progress' : 'messages'
      if (event.kind !== 'cancel') {
        requireValue(current.counts[counter] < current.budget[counter], 'message budget exhausted')
        current.counts[counter] += 1
        current.pending = event.eventId
      }
      current.seq[sender] = event.seq
      state.inbox[event.eventId] = { event, fingerprint, sender, recipient, stages, status: 'held' }
      if (context.cursor !== undefined) {
        const key = `${context.server}:${recipient}`
        state.cursors[key] = Math.max(state.cursors[key] ?? 0, context.cursor)
      }
    })
    return stages.length ? { action: 'held' } : this.apply(event.eventId)
  }
  checkShape(task, event) {
    const kind = event.kind
    if (kind === 'request' || kind === 'answer') {
      requireValue(task.status !== 'result-ready', 'result awaits acceptance')
      const turn = get(task.turns, `${event.generation}:${event.turnId}`)
      if (turn) {
        requireValue(turn.digest === digest(contentOf(event)), 'turn conflict')
        return
      }
      requireValue(task.counts.turns < task.budget.turns, 'turn budget exhausted')
      if (kind === 'request') {
        requireValue(task.status === 'open' && !task.active, 'request already started')
        requireValue(digest(event.payload.input) === digest(task.input), 'request input changed')
      } else {
        requireValue(task.waiting?.kind === 'input' && task.waiting.eventId === event.inReplyTo, 'no matching question')
      }
    } else if (kind !== 'cancel') {
      requireValue(task.status === 'working' && task.active?.eventId === event.inReplyTo && task.active.turnId === event.turnId, 'no matching active turn')
      if (kind === 'result') requireValue(event.payload.evidence.every(id => task.input.excerpts.some(e => e.id === id)), 'unknown result evidence')
    }
  }
  approve(eventId, actor, stage, approved) {
    const record = get(this.journal.state.inbox, eventId)
    requireValue(record && record.status === 'held', 'no pending approval')
    const task = this.task(record.event.taskId)
    this.checkEvent(task, record.event)
    const index = record.stages.findIndex(item => item.stage === stage)
    requireValue(index >= 0 && record.stages[index].owner === actor, 'wrong approval owner')
    requireValue(typeof approved === 'boolean' && !record.stages[index].approved, 'invalid approval decision')
    this.journal.transaction(state => {
      const pending = state.inbox[eventId]
      pending.stages[index].approved = approved
      if (!approved) {
        pending.status = 'rejected'
        state.tasks[task.id].pending = null
        state.tasks[task.id].status = 'blocked'
        state.tasks[task.id].waiting = { kind: 'approval-rejected', eventId }
      }
    })
    const next = this.journal.state.inbox[eventId]
    if (next.status === 'held' && next.stages.every(item => item.approved)) return this.apply(eventId)
    return { action: approved ? 'held' : 'rejected' }
  }
  apply(eventId) {
    const record = this.journal.state.inbox[eventId], event = record.event, task = this.task(event.taskId)
    this.checkEvent(task, event)
    this.checkShape(task, event)
    requireValue(record.stages.every(item => item.approved), 'approval required')
    if (event.kind === 'cancel') {
      this.cancel(task.id, task.requester)
      this.journal.transaction(state => { state.inbox[eventId].status = 'applied' })
    } else if (event.kind === 'request' || event.kind === 'answer') {
      return this.dispatch(record)
    } else {
      this.journal.transaction(state => {
        const current = state.tasks[task.id]
        current.pending = null
        if (event.kind === 'question') {
          current.status = 'blocked'; current.waiting = { kind: 'input', eventId }
        } else if (event.kind === 'result') {
          current.status = 'result-ready'; current.result = event.payload
          current.waiting = null; current.active = null
        } else if (event.kind === 'failure') {
          current.status = 'failed'; current.waiting = { kind: 'failure', text: event.payload.text }
        }
        state.inbox[eventId].status = 'applied'
      })
    }
    return { action: 'applied' }
  }
  dispatch(record) {
    const event = record.event, task = this.task(event.taskId), key = `${event.generation}:${event.turnId}`
    const previous = get(task.turns, key)
    if (previous) {
      this.journal.transaction(state => { state.inbox[event.eventId].status = 'duplicate-turn'; state.tasks[task.id].pending = null })
      return { action: 'duplicate-turn' }
    }
    requireValue(this.runtime.capabilities.history && this.runtime.capabilities.abort, 'runtime capabilities unavailable')
    this.journal.transaction(state => {
      const current = state.tasks[task.id]
      requireValue(current.counts.turns < current.budget.turns, 'turn budget exhausted')
      current.counts.turns += 1
      current.turns[key] = { digest: digest(contentOf(event)), status: 'reserved' }
      current.execution = { phase: current.sessionId ? 'submitting' : 'creating', eventId: event.eventId, key }
      current.status = 'working'; current.waiting = null
    })
    try {
      this.checkPolicy(this.task(task.id))
      if (!task.sessionId) {
        const sessionId = this.runtime.create(task.id)
        this.journal.transaction(state => { state.tasks[task.id].sessionId = sessionId; state.tasks[task.id].execution.phase = 'submitting' })
      }
      const current = this.task(task.id)
      if (TERMINAL.has(current.status)) {
        this.finishDispatch(task.id, record)
        return { action: 'stopped' }
      }
      this.checkEvent(current, event)
      this.runtime.submit(current.sessionId, event.turnId, contentOf(event))
      return { action: this.finishDispatch(task.id, record) ? 'submitted' : 'stopped' }
    } catch (error) {
      if (!(error instanceof RuntimeRecoveryError)) throw error
      return this.journal.transaction(state => {
        const current = state.tasks[task.id]
        const stopped = TERMINAL.has(current.status)
        if (!stopped) current.recovery = 'uncertain'
        current.pending = null
        state.inbox[event.eventId].status = stopped ? 'stopped' : 'uncertain'
        return { action: stopped ? 'stopped' : 'uncertain' }
      })
    }
  }
  finishDispatch(id, record) {
    return this.journal.transaction(state => {
      const task = state.tasks[id], event = record.event
      if (TERMINAL.has(task.status)) {
        task.pending = null
        state.inbox[event.eventId].status = 'stopped'
        return false
      }
      requireValue(event.generation === task.generation, 'execution generation mismatch')
      task.active = { eventId: event.eventId, turnId: event.turnId }
      task.turns[`${event.generation}:${event.turnId}`].status = 'submitted'
      task.execution = null; task.recovery = null; task.pending = null; task.waiting = null; task.status = 'working'
      state.inbox[event.eventId].status = 'applied'
      return true
    })
  }
  reconcile(id) {
    const task = this.task(id)
    this.checkPolicy(task)
    if (TERMINAL.has(task.status) || !task.execution) return { action: 'unchanged' }
    try {
      const history = this.runtime.history(id)
      const sessions = history.sessions.filter(s => s.taskId === id)
      requireRuntimeEvidence(sessions.length === 1 && (!task.sessionId || task.sessionId === sessions[0].id), 'ambiguous session')
      const record = this.journal.state.inbox[task.execution.eventId]
      const matches = history.submissions.filter(s => s.sessionId === sessions[0].id && s.turnId === record.event.turnId)
      requireRuntimeEvidence(matches.length === 1 && matches[0].digest === digest(contentOf(record.event)), 'ambiguous submission')
      requireRuntimeEvidence(this.clock.now() < task.deadline, 'deadline exceeded')
      this.journal.transaction(state => { state.tasks[id].sessionId = sessions[0].id })
      return { action: this.finishDispatch(id, record) ? 'reconciled' : 'stopped' }
    } catch (error) {
      if (!(error instanceof RuntimeRecoveryError)) throw error
      return { action: 'uncertain' }
    }
  }
  cancel(id, actor) {
    const task = this.task(id)
    requireValue(actor === task.requester, 'only requester can cancel')
    requireValue(task.status !== 'accepted' && task.status !== 'failed', 'task terminal')
    if (task.status !== 'cancelled') this.journal.transaction(state => {
      const current = state.tasks[id]
      current.status = 'cancelled'; current.generation += 1; current.cancel = 'requested'; current.pending = null
    })
    return this.observeStop(id)
  }
  observeStop(id) {
    const task = this.task(id)
    requireValue(task.status === 'cancelled', 'cancel not requested')
    try {
      let sessionId = task.sessionId
      if (!sessionId && task.execution) {
        const sessions = this.runtime.history(id).sessions
        requireRuntimeEvidence(sessions.length === 1, 'session uncertain')
        sessionId = sessions[0].id
      }
      const stopped = sessionId ? this.runtime.abort(sessionId) === 'stopped' : !task.execution
      this.journal.transaction(state => { state.tasks[id].cancel = stopped ? 'observed' : 'requested'; state.tasks[id].recovery = stopped ? null : 'uncertain' })
    } catch (error) {
      if (!(error instanceof RuntimeRecoveryError)) throw error
      this.journal.transaction(state => { state.tasks[id].recovery = 'uncertain' })
    }
    return this.task(id)
  }
  enforce() {
    for (const task of Object.values(this.journal.state.tasks)) {
      if (TERMINAL.has(task.status) || task.status === 'result-ready') continue
      const exhausted = this.clock.now() >= task.deadline
      let allowed = true
      try { this.checkPolicy(task) } catch { allowed = false }
      if (!allowed || exhausted) this.cancel(task.id, task.requester)
    }
  }
  accept(id, actor) {
    const task = this.task(id)
    requireValue(actor === task.requester, 'only requester accepts')
    this.checkPolicy(task)
    requireValue(task.status === 'result-ready' && !task.recovery && !task.cancel, 'result not ready')
    this.journal.transaction(state => { state.tasks[id].status = 'accepted' })
  }
}
