// One private message protocol over the original consultation records and Effects.
// A message lease grants no Task initiative and is never a worker-exit proof.
import { createHash, randomUUID } from 'node:crypto'
import { ownEntry } from './store.js'
import { EffectCancelled, EffectDeferred } from './project-effects.js'
import { sendAgentWebhook } from './project-agent-webhook.js'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message, code = 'bot/conflict') => Object.assign(new Error(message), { code })
const stable = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const copy = value => structuredClone(value)

export function createProjectAgentInbox(rt, consultations, { now = Date.now, notify = sendAgentWebhook } = {}) {
  let tail = Promise.resolve()
  const serial = action => { const result = tail.then(action, action); tail = result.catch(() => {}); return result }
  const policy = () => {
    const config = { leaseMs: 120000, attentionMs: 1800000, ...rt.config?.projectAgentInbox }
    if (!Number.isSafeInteger(config.leaseMs) || config.leaseMs < 1000 || config.leaseMs > 3600000 || !Number.isSafeInteger(config.attentionMs) || config.attentionMs < 1000) throw fail('Invalid agent inbox timing configuration')
    return config
  }
  const records = carrier => (ownEntry(rt.state.projectAgentTranscripts ?? {}, carrier.id) ?? []).filter(row => row.version === 'conversation-handoff/v1' && row.projectId === carrier.projectId && row.returnTo === carrier.id && row.initiatedBy === carrier.memberId && (row.direction === 'incoming' || ['completed', 'failed'].includes(row.status)))
  const version = row => digest([row.id, row.projectId, row.returnTo, row.direction ?? 'outgoing', row.text, row.chiefDecisionId ?? null, row.requiresHuman === true])
  const principal = (actor, carrier) => digest([actor.memberId, carrier.personalAgentId, actor.personalAgentCredentialId ?? null, actor.personalAgentCredentialGeneration ?? null, actor.watchGrantId ?? null, actor.watchGeneration ?? null, actor.sessionId ?? null])
  function current(carrier, row) {
    rt.personalAgents.requireParticipation(carrier)
    if (!records(carrier).includes(row)) throw fail('Message belongs to another private mailbox', 'bot/forbidden')
    if (row.direction === 'incoming') {
      const task = ownEntry(rt.state.tasks ?? {}, row.linkedTaskId)
      if (!task || ['accepted', 'cancelled'].includes(task.status) || task.projectId !== carrier.projectId || task.chiefQuestion?.decisionId !== row.chiefDecisionId) throw fail('Chief question is no longer current')
    }
  }
  async function access(body, actor, message = false, live = true) {
    if (!actor?.memberId) throw fail('Sign in to the agent inbox', 'bot/unauthorized')
    if (actor.watchGrantId) await rt.projectDelegations.validateActor(actor)
    else if (rt.validateHumanActor && !await rt.validateHumanActor(actor)) throw fail('Inbox principal is no longer authorized', 'bot/forbidden')
    const carrier = await consultations.parent(body, actor)
    if (!carrier) { if (!message) return { carrier: null }; throw fail('Private mailbox is unavailable', 'bot/forbidden') }
    rt.personalAgents.requireParticipation(carrier)
    const row = message ? records(carrier).find(item => item.id === body.messageId) : null
    if (message) {
      if (!row) throw fail('Unknown private consultation inbox message', 'bot/forbidden')
      if (live) current(carrier, row)
      if (body.expectedVersion !== undefined && body.expectedVersion !== version(row)) throw fail('Inbox message version changed')
    }
    return { carrier, row }
  }
  const committed = row => !row.inbox?.commit || rt.projectEffects.intentCommitted(row.inbox.commit)
  function stateOf(row) {
    if (!committed(row)) throw fail('Inbox state is awaiting durable commit')
    return row.inbox ?? { version: 'agent-inbox/v1', phase: row.direction === 'incoming' && row.status === 'completed' ? 'handled' : 'pending', generation: 0 }
  }
  function metadata(carrier, row) {
    const state = stateOf(row), effect = ownEntry(rt.state.projectEffects ?? {}, row.notificationEffect?.id)
    const task = ownEntry(rt.state.tasks ?? {}, row.linkedTaskId)
    const superseded = row.direction === 'incoming' && state.phase !== 'handled' && (!task || ['accepted', 'cancelled'].includes(task.status) || task.chiefQuestion?.decisionId !== row.chiefDecisionId)
    return { version: 'agent-inbox/v1', id: row.id, projectId: row.projectId, agentId: carrier.personalAgentId, participationId: carrier.participationId,
      kind: row.direction === 'incoming' ? 'consultation.question' : 'consultation.answer', consultationId: row.id, taskId: row.linkedTaskId ?? null, initiativeTransferred: false, requiresHuman: row.requiresHuman === true,
      phase: superseded ? 'superseded' : state.phase, generation: state.generation, messageVersion: version(row), createdAt: row.at, updatedAt: state.updatedAt ?? row.at,
      claim: state.phase === 'processing' && state.claim ? { claimId: state.claim.id, generation: state.generation, expiresAt: state.claim.expiresAt } : null,
      notification: effect ? { status: effect.status, delivery: effect.receipt?.status ?? null, transport: effect.receipt?.transport ?? null, attempts: effect.executions, nextAt: effect.status === 'pending' ? effect.dueAt : null } : { status: 'mailbox-only', delivery: 'private-mailbox', transport: null, attempts: 0, nextAt: null },
      attentionRequired: !superseded && (['failed', 'blocked', 'awaiting-approval'].includes(state.phase) || state.claim && state.phase === 'processing' && state.claim.expiresAt <= now() || state.phase !== 'handled' && now() - (state.updatedAt ?? row.at) > policy().attentionMs || effect?.status === 'failed'),
      source: { query: 'inbox.get', messageId: row.id } }
  }
  async function persist(carrier, row, next, requestId, action) {
    const previous = row.inbox
    const token = rt.projectEffects.stage({ kind: 'agent.inbox.state', key: `${row.id}:${action}:${requestId}`, projectId: row.projectId, taskId: row.linkedTaskId ?? null,
      payload: { memberId: carrier.memberId, agentId: carrier.personalAgentId, messageId: row.id, action, fingerprint: digest(next) } })
    row.inbox = { ...next, updatedAt: now(), commit: token }
    try { await rt.projectEffects.persist(token) }
    catch (error) { if (rt.projectEffects.discardUncommitted(token)) row.inbox = previous; throw error }
    return row.inbox
  }
  function checkedClaim(carrier, row, body, actor) {
    const state = stateOf(row)
    if (!state.claim || state.claim.id !== body.claimId || state.generation !== body.generation || state.claim.principal !== principal(actor, carrier) || state.claim.expiresAt <= now()) throw fail('Inbox claim or generation is no longer current')
    return state
  }
  async function claim(carrier, row, body, actor) {
    const state = stateOf(row)
    if (['handled', 'awaiting-approval'].includes(state.phase)) throw fail('Message already has a completed processing result')
    if (state.claim?.expiresAt > now()) {
      if (state.claim.principal === principal(actor, carrier) && state.claim.requestId === body.requestId) return { message: metadata(carrier, row), claim: { claimId: state.claim.id, generation: state.generation, expiresAt: state.claim.expiresAt } }
      throw fail('Another live inbox claim owns this message')
    }
    const identity = rt.personalAgents.agentOf(carrier.personalAgentId)
    if (state.generation > 0 && identity?.kind === 'internal' && rt.projectAgents.inboxExecutionActive?.(carrier)) throw fail('Native execution exit is still active or unconfirmed')
    const next = await persist(carrier, row, { version: 'agent-inbox/v1', phase: 'processing', generation: state.generation + 1, claim: { id: `inbox-claim-${randomUUID()}`, principal: principal(actor, carrier), requestId: body.requestId, expiresAt: now() + policy().leaseMs }, sourceVersion: version(row) }, body.requestId, 'claim')
    return { message: metadata(carrier, row), claim: { claimId: next.claim.id, generation: next.generation, expiresAt: next.claim.expiresAt } }
  }
  async function complete(carrier, row, body, actor) {
    const state = stateOf(row), intent = digest([body.text ?? null, body.publish === true, body.acknowledge === true])
    if (state.result?.requestId === body.requestId) {
      if (state.result.principal !== principal(actor, carrier) || state.result.intent !== intent) throw fail('Inbox result requestId was reused with different content or identity')
      return copy(state.result.value)
    }
    checkedClaim(carrier, row, body, actor)
    if (state.sourceVersion !== version(row)) throw fail('Claim source version changed')
    let value
    if (row.direction !== 'incoming') {
      if (body.acknowledge !== true || body.text !== undefined || body.publish === true) throw fail('A consultation answer accepts acknowledgement only')
      value = { acknowledged: true, messageId: row.id }
    } else value = await consultations.replyDirect({ projectId: row.projectId, agentId: carrier.personalAgentId, consultationId: row.id, requestId: body.requestId, text: body.text, publish: body.publish === true }, actor)
    await access({ projectId: row.projectId, agentId: carrier.personalAgentId, messageId: row.id }, actor, true, false)
    const next = { ...state, phase: value.requiresUserApproval ? 'awaiting-approval' : 'handled', result: { requestId: body.requestId, principal: principal(actor, carrier), intent, value: copy(value) } }
    await persist(carrier, row, next, body.requestId, 'complete')
    return value
  }
  async function legacyReply(body, actor) {
    return serial(async () => {
      if (rt.readOnly?.() !== undefined || !stable(body.requestId)) throw fail('Inbox mutation needs a writable store and stable requestId')
      rt.projects?.requireActive(body.projectId)
      const args = { ...body, messageId: body.consultationId }
      const parent = await consultations.parent(body, actor)
      const original = parent && (ownEntry(rt.state.projectAgentTranscripts ?? {}, parent.id) ?? []).find(item => item.id === body.consultationId)
      if (original && original.direction !== 'incoming') throw fail('Only the delegated Chief executor may answer an outgoing consultation', 'bot/forbidden')
      const { carrier, row } = await access(args, actor, true), state = stateOf(row)
      if (!row.inbox && state.phase === 'handled') {
        const previous = (ownEntry(rt.state.projectAgentTranscripts ?? {}, carrier.id) ?? []).find(item => item.conversationHandoffId === row.id && item.requestId === body.requestId && item.text === body.text)
        if (!previous) throw fail('Legacy consultation already completed; no matching reply may be replayed')
        return consultations.replyDirect(body, actor)
      }
      // Legacy human approval may publish the exact already-recorded safe suggestion.
      if (!actor.personalAgentCredentialId && !actor.consultationProxyAgentId && state.phase === 'awaiting-approval' && body.publish === true) {
        const value = await consultations.replyDirect(body, actor)
        await persist(carrier, row, { ...state, phase: value.published ? 'handled' : 'awaiting-approval', result: { requestId: body.requestId, principal: principal(actor, carrier), intent: digest([body.text ?? null, body.publish === true, false]), value: copy(value) } }, body.requestId, 'human-approval')
        return value
      }
      if (state.result?.requestId === body.requestId) return complete(carrier, row, { ...args, claimId: state.claim?.id, generation: state.generation }, actor)
      const owned = state.claim?.principal === principal(actor, carrier) && state.claim.expiresAt > now()
      const acquired = owned ? { claim: { claimId: state.claim.id, generation: state.generation } } : await claim(carrier, row, args, actor)
      return complete(carrier, row, { ...args, ...acquired.claim }, actor)
    })
  }
  function connectionSettings(carrier, connectionId) {
    const setting = ownEntry(rt.config.projectAgentWebhooks ?? {}, connectionId)
    if (!setting || setting.ownerId !== carrier.memberId || setting.agentId !== carrier.personalAgentId || setting.projectId !== carrier.projectId) throw fail('Webhook connection is not provisioned for this agent and Project', 'bot/forbidden')
    return setting
  }
  const connectionHash = setting => digest(setting)
  async function endpoint(operation, body, actor) {
    if (!['list', 'get', 'claim', 'renew', 'complete', 'fail', 'connection', 'connection.configure'].includes(operation)) throw fail('Unknown inbox operation', 'bot/invalid')
    return serial(async () => {
      const reading = ['list', 'get', 'connection'].includes(operation)
      if (!reading && (rt.readOnly?.() !== undefined || !stable(body.requestId))) throw fail('Inbox mutation needs a writable store and stable requestId')
      if (!reading) rt.projects?.requireActive(body.projectId)
      const { carrier, row } = await access(body, actor, !['list', 'connection', 'connection.configure'].includes(operation), operation !== 'get')
      if (operation === 'list') {
        const limit = body.limit ?? 50
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('Inbox page limit must be1–100', 'bot/invalid')
        const rows = carrier ? records(carrier).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) : []
        const index = body.after === undefined ? -1 : rows.findIndex(item => item.id === body.after)
        if (body.after !== undefined && index < 0) throw fail('Inbox cursor belongs to another mailbox')
        const page = rows.slice(index + 1, index + 1 + limit)
        return { items: page.map(item => metadata(carrier, item)), next: index + 1 + page.length < rows.length ? page.at(-1).id : null }
      }
      if (!carrier) throw fail('Agent participation is unavailable', 'bot/forbidden')
      const participation = rt.personalAgents.participationFor(carrier.personalAgentId, carrier.projectId)
      if (operation === 'connection') return { connection: participation.notification ? { enabled: participation.notification.enabled, connectionId: participation.notification.connectionId, revision: participation.notification.revision, verifiedAt: participation.notification.verifiedAt } : null }
      if (operation === 'connection.configure') {
        if (actor.agentId || actor.personalAgentCredentialId || actor.watchGrantId || actor.chiefJobId || actor.consultationProxyAgentId || typeof body.enabled !== 'boolean') throw fail('Only the signed-in human may configure agent notification', 'bot/forbidden')
        const previous = participation.notification, revision = (previous?.revision ?? 0) + 1
        let setting
        if (body.enabled) {
          setting = connectionSettings(carrier, body.connectionId)
          const before = connectionHash(setting)
          await notify(setting, { version: 'flybot-agent-notification/v1', type: 'connection.verify', eventId: `verify-${randomUUID()}`, projectId: carrier.projectId, agentId: carrier.personalAgentId, challenge: randomUUID() })
          await access(body, actor)
          if (connectionHash(connectionSettings(carrier, body.connectionId)) !== before || participation.notification !== previous) throw fail('Notification connection changed during verification')
        }
        const next = { enabled: body.enabled, connectionId: body.enabled ? body.connectionId : previous?.connectionId ?? null, revision, verifiedAt: body.enabled ? now() : previous?.verifiedAt ?? null, binding: setting ? connectionHash(setting) : previous?.binding ?? null }
        const token = rt.projectEffects.stage({ kind: 'agent.inbox.state', key: `connection:${carrier.personalAgentId}:${body.requestId}`, projectId: carrier.projectId, payload: { memberId: carrier.memberId, agentId: carrier.personalAgentId, messageId: null, action: 'connection', fingerprint: digest(next) } })
        participation.notification = { ...next, commit: token }
        const pending = []
        try {
          if (body.enabled) for (const item of records(carrier).filter(candidate => !['handled', 'awaiting-approval'].includes(stateOf(candidate).phase))) pending.push({ item, previous: item.notificationEffect, token: stage(carrier, item) })
          await rt.projectEffects.persist(token)
        }
        catch (error) {
          if (rt.projectEffects.discardUncommitted(token)) {
            participation.notification = previous
            for (const candidate of pending) if (rt.projectEffects.discardUncommitted(candidate.token)) candidate.item.notificationEffect = candidate.previous
          }
          throw error
        }
        rt.projectScheduler?.wake()
        return { connection: { enabled: body.enabled, connectionId: participation.notification.connectionId, revision, verifiedAt: participation.notification.verifiedAt } }
      }
      if (operation === 'get') {
        const text = JSON.stringify(consultations.view(carrier, row)), offset = body.offset ?? 0, limit = body.limit ?? 4000, sha256 = createHash('sha256').update(text).digest('hex')
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 4000 || body.expectedSha256 !== undefined && body.expectedSha256 !== sha256) throw fail('Inbox source changed or page is invalid')
        return { message: metadata(carrier, row), text: text.slice(offset, offset + limit), sha256, offset, totalChars: text.length, nextOffset: offset + limit < text.length ? offset + limit : null }
      }
      if (operation === 'claim') return claim(carrier, row, body, actor)
      if (operation === 'complete') return complete(carrier, row, body, actor)
      const state = checkedClaim(carrier, row, body, actor)
      if (operation === 'renew') {
        if (state.claim.renewRequestId !== body.requestId) await persist(carrier, row, { ...state, claim: { ...state.claim, renewRequestId: body.requestId, expiresAt: now() + policy().leaseMs } }, body.requestId, 'renew')
        return { message: metadata(carrier, row), claim: { claimId: state.claim.id, generation: state.generation, expiresAt: row.inbox.claim.expiresAt } }
      }
      if (typeof body.retryable !== 'boolean') throw fail('Inbox failure needs an explicit retryable flag', 'bot/invalid')
      await persist(carrier, row, { ...state, phase: body.retryable ? 'pending' : 'failed', claim: null, failure: { code: 'agent-processing-failed', at: now() } }, body.requestId, 'fail')
      return { message: metadata(carrier, row) }
    })
  }
  function stage(carrier, row) {
    const revision = rt.personalAgents.participationFor(carrier.personalAgentId, carrier.projectId)?.notification?.revision ?? 0
    const token = rt.projectEffects.stage({ kind: 'consultation.notify', key: row.id, projectId: carrier.projectId, taskId: row.linkedTaskId ?? null, replace: true, payload: { consultationId: row.id, agentId: carrier.personalAgentId, carrierId: carrier.id, memberId: carrier.memberId, notificationRevision: revision } })
    row.notificationEffect = token
    return token
  }
  async function deliver(effect) {
    const carrier = ownEntry(rt.state.projectAgents ?? {}, effect.payload.carrierId), row = carrier && records(carrier).find(item => item.id === effect.payload.consultationId)
    try { if (!carrier || carrier.personalAgentId !== effect.payload.agentId || carrier.projectId !== effect.projectId || !row) throw Error('missing'); current(carrier, row); rt.requireProjectAccess({ memberId: carrier.memberId }, carrier.projectId) }
    catch { throw new EffectCancelled('Agent message recipient or original business request is no longer authorized') }
    if (['handled', 'awaiting-approval'].includes(stateOf(row).phase)) return { messageId: row.id, status: 'already-handled' }
    if (stateOf(row).claim?.expiresAt > now()) return { messageId: row.id, status: 'already-claimed' }
    const identity = rt.personalAgents.agentOf(carrier.personalAgentId)
    if (identity.kind === 'internal') {
      if (!rt.projectDelegations.forAgent(carrier.id) || rt.personalAgents.carrierId(carrier.projectId, carrier.memberId) !== carrier.id) return { messageId: row.id, status: 'private-mailbox' }
      try {
        await rt.projectAgents.wakeWatch(carrier.projectId, carrier.memberId, `Agent inbox notification ${row.id}. Use project_agent_inbox to list/get, claim before processing, then complete or fail with its claimId/generation and stable requestId. Renew before expiry. Consultations never transfer Task initiative. Do not treat this notification as permission.`, carrier.id)
        return { messageId: row.id, status: 'notified', transport: 'native' }
      } catch { throw new EffectDeferred('Native inbox receiver is busy or its authority is unavailable', { waitingFor: 'agent' }) }
    }
    const participation = rt.personalAgents.participationFor(identity.id, carrier.projectId), selected = participation.notification
    if (!selected?.enabled) return { messageId: row.id, status: 'private-mailbox' }
    if (selected.commit && !rt.projectEffects.intentCommitted(selected.commit)) throw new EffectDeferred('Webhook connection is awaiting durable authorization', { waitingFor: 'authority' })
    const settings = connectionSettings(carrier, selected.connectionId)
    if (selected.binding !== connectionHash(settings)) throw new EffectCancelled('Webhook connection changed; human re-verification is required')
    await rt.projectDelegations.background(carrier.memberId)
    current(carrier, row)
    if (participation.notification !== selected || !selected.enabled || connectionHash(connectionSettings(carrier, selected.connectionId)) !== selected.binding) throw new EffectCancelled('Webhook connection changed before delivery')
    await notify(settings, { version: 'flybot-agent-notification/v1', type: 'inbox.available', eventId: `${effect.id}:${effect.generation}`, messageId: row.id, projectId: row.projectId, agentId: identity.id, messageVersion: version(row), connectionRevision: selected.revision })
    if (participation.notification !== selected || !selected.enabled) throw new EffectCancelled('Webhook connection was disabled or replaced')
    current(carrier, row)
    return { messageId: row.id, status: 'received', transport: 'webhook' }
  }
  function recover() {
    if (rt.readOnly?.() !== undefined) return false
    let changed = false
    for (const carrier of Object.values(rt.state.projectAgents ?? {})) {
      if (carrier.visibility !== 'private' || !carrier.personalAgentId || !carrier.participationId) continue
      for (const row of records(carrier)) {
        if (row.direction !== 'incoming' || row.notificationEffect || row.status === 'completed') continue
        try { current(carrier, row) } catch { continue /* Superseded or revoked history never creates new delivery. */ }
        stage(carrier, row); changed = true
      }
    }
    return changed
  }
  rt.projectEffects.register('agent.inbox.state', { run: effect => ({ messageId: effect.payload.messageId, status: 'durable-inbox-state' }) })
  return { endpoint, legacyReply, stage, deliver, recover }
}
