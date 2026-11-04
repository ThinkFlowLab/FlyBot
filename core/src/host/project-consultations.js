import { operationsContact, assistanceScope, consultationCurrent } from './project-chief-assistance.js'
// Consultation records reuse per-participation transcripts; no Task initiative transfer.
import { createHash } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
const refuse = message => Object.assign(new Error(message), { code: 'bot/forbidden' })
export function createProjectConsultations(rt, { ensure, chiefQuestion, serial }) {
  const state = rt.state
  const agents = () => (state.projectAgents ??= {})
  const transcripts = () => (state.projectAgentTranscripts ??= {})
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const messages = id => { const rows = ownEntry(transcripts(), id); if (rows) return rows; const created = []; setEntry(transcripts(), id, created); return created }
  async function parent(body, actor, create = false) {
    rt.requireProjectAccess(actor, body.projectId)
    if (actor.personalAgentCredentialId && body.agentId && body.agentId !== actor.agentId) throw refuse('Consultation belongs to another personal agent')
    const selected = actor.personalAgentCredentialId ? actor.agentId : body.agentId
    const participation = selected ? rt.personalAgents.participationFor(selected, body.projectId) : rt.personalAgents.defaultParticipation(body.projectId, actor.memberId)
    if (!participation) {
      if (selected) throw refuse('Personal agent participation is unavailable')
      return create ? ensure(body.projectId, actor) : null
    }
    const identity = rt.personalAgents.agentOf(participation.agentId)
    if (!identity || identity.ownerId !== actor.memberId || participation.ownerId !== actor.memberId) throw refuse('Only the personal-agent owner may read this consultation')
    if (create && !selected && identity.kind === 'internal') return ensure(body.projectId, actor)
    const carrier = { id: participation.carrierId, projectId: body.projectId, memberId: actor.memberId, personalAgentId: identity.id, participationId: participation.id, visibility: 'private', kind: 'consultation-mailbox' }
    if (create) rt.personalAgents.requireParticipation(carrier)
    const existing = ownEntry(agents(), carrier.id)
    if (existing && (existing.memberId !== carrier.memberId || existing.projectId !== carrier.projectId || existing.personalAgentId !== carrier.personalAgentId)) throw refuse('Consultation carrier scope changed')
    if (!existing && create) { rt.projects.requireActive(body.projectId); setEntry(agents(), carrier.id, carrier) }
    return existing ?? carrier
  }
  function view(parent, receipt, { offset = 0, limit = 20, includeReplies = true } = {}) {
    if (!receipt || receipt.projectId !== parent.projectId || receipt.initiatedBy !== parent.memberId || receipt.returnTo !== parent.id || receipt.version !== 'conversation-handoff/v1') throw refuse('Unknown private consultation')
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw refuse('Invalid consultation reply page')
    const replies = (ownEntry(transcripts(), parent.id) ?? []).filter(row => row.conversationHandoffId === receipt.id)
    return { version: 'project-consultation/v1', transportVersion: receipt.version, id: receipt.id, projectId: receipt.projectId,
      agentId: parent.personalAgentId ?? null, requestId: receipt.requestId, initiatedBy: receipt.initiatedBy, returnTo: receipt.returnTo,
      target: { botId: receipt.to, role: receipt.direction === 'incoming' ? 'personal-agent' : 'chief' }, direction: receipt.direction ?? 'outgoing', linkedTaskId: receipt.linkedTaskId ?? null, requiresHuman: Boolean(receipt.requiresHuman), question: receipt.text, assistance: receipt.assistance ?? null, assistanceScope: receipt.assistanceScope ?? null, state: receipt.status, initiativeTransferred: false,
      replies: includeReplies ? replies.slice(offset, offset + limit).map(({ id, text, at, speaker, state, inputId, approvedBy }) => ({ id, text, at, speaker, ...(state ? { state } : {}), ...(inputId ? { inputId } : {}), ...(approvedBy ? { approvedBy } : {}) })) : [],
      replyCount: replies.length, nextReplyOffset: includeReplies && offset + limit < replies.length ? offset + limit : null, createdAt: receipt.at, finishedAt: receipt.finishedAt ?? null }
  }
  async function endpoint(endpoint, body, actor) {
    if (!['project-consultation-ask', 'project-consultation-get', 'project-consultation-list', 'project-consultation-reply'].includes(endpoint)) throw refuse('Unknown consultation operation')
    if (endpoint === 'project-consultation-ask') return chiefQuestion(body, actor)
    if (endpoint === 'project-consultation-reply') return rt.projectAgentInbox ? rt.projectAgentInbox.legacyReply(body, actor) : serial(() => reply(body, actor))
    return serial(async () => {
      const carrier = await parent(body, actor)
      const rows = carrier ? (ownEntry(transcripts(), carrier.id) ?? []).filter(row => row.version === 'conversation-handoff/v1' && row.returnTo === carrier.id && row.initiatedBy === actor.memberId) : []
      if (endpoint === 'project-consultation-get') return { consultation: view(carrier ?? {}, rows.find(row => row.id === body.consultationId), body) }
      const limit = body.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw refuse('Invalid consultation page limit')
      const index = body.after === undefined ? -1 : rows.findIndex(row => row.id === body.after)
      if (body.after !== undefined && index < 0) throw refuse('Unknown consultation cursor')
      const page = rows.slice(index + 1, index + 1 + limit)
      return { items: page.map(receipt => view(carrier, receipt, { includeReplies: false })), next: index + 1 + page.length < rows.length ? page.at(-1).id : null }
    })
  }
  function contactUser(task, question, actor) {
    rt.projectChiefControl.requireJobActor(actor, task.projectId)
    const contact = question.recipient === 'operations' ? operationsContact(rt, task.projectId, state.projectChiefPolicies?.[task.projectId]?.operationsContact) : null
    if (question.recipient === 'operations' && !contact) throw refuse('No operations contact is configured; Chief must choose a lawful recipient')
    const memberId = contact?.memberId ?? task.collaboration?.initiatedBy ?? task.requesterId ?? rt.readProject(task.projectId).ownerUserId
    const participation = contact ? rt.personalAgents.participationFor(contact.agentId, task.projectId) : rt.personalAgents.defaultParticipation(task.projectId, memberId)
    const identity = participation && rt.personalAgents.agentOf(participation.agentId)
    if (!participation || participation.status !== 'active' || identity?.status !== 'active' || identity.ownerId !== memberId || !rt.projectCan({ memberId }, task.projectId)) return { kind: 'human', memberId, reason: 'No active authorized personal agent' }
    const carrier = ownEntry(agents(), participation.carrierId) ?? { id: participation.carrierId, projectId: task.projectId, memberId, personalAgentId: identity.id, participationId: participation.id, visibility: 'private', kind: 'consultation-mailbox' }
    rt.personalAgents.requireParticipation(carrier)
    setEntry(agents(), carrier.id, carrier)
    const id = `consultation-${hash([task.projectId, task.id, question.id, identity.id])}`
    if (!messages(carrier.id).some(row => row.id === id)) messages(carrier.id).push({ id, kind: 'consultation', version: 'conversation-handoff/v1', direction: 'incoming', projectId: task.projectId, linkedTaskId: task.id, chiefDecisionId: question.id, assistanceScope: assistanceScope(state, task, question.recipient), ...(question.assistance ? { assistance: structuredClone(question.assistance) } : {}), requestedBy: { role: 'chief', runId: actor.chiefJobId }, initiatedBy: memberId, from: `${task.projectId}:chief`, to: carrier.id, returnTo: carrier.id, text: question.reason, requestId: question.id, status: 'accepted', requiresHuman: Boolean(question.requiresHuman), at: Date.now() })
    const receipt = messages(carrier.id).find(row => row.id === id)
    const token = rt.projectAgentInbox?.stage(carrier, receipt) ?? rt.projectEffects?.stage({ kind: 'consultation.notify', key: id, projectId: task.projectId, taskId: task.id, payload: { consultationId: id, agentId: identity.id, carrierId: carrier.id, memberId } })
    return { kind: 'personal-agent', memberId, agentId: identity.id, participationId: participation.id, consultationId: id, ...(token ? { effectId: token.id } : {}) }
  }
  async function reply(body, actor) {
    if (rt.readOnly?.() !== undefined) throw refuse('Consultations are read-only')
    const carrier = await parent(body, actor)
    if (!carrier) throw refuse('Unknown private consultation')
    rt.personalAgents.requireParticipation(carrier)
    const receipt = messages(carrier.id).find(row => row.id === body.consultationId)
    view(carrier, receipt)
    if (receipt.direction !== 'incoming') throw refuse('Only the delegated Chief executor may answer an outgoing consultation')
    const task = ownEntry(state.tasks, receipt.linkedTaskId)
    if (!consultationCurrent(state, receipt, task)) throw refuse('This Chief question is no longer current')
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw refuse('Reply needs a stable requestId and bounded text')
    let answer = messages(carrier.id).find(row => row.conversationHandoffId === receipt.id && row.requestId === body.requestId)
    if (answer && answer.text !== body.text) throw refuse('Reply requestId was reused with another answer')
    if (!answer) { answer = { id: `consultation-reply-${hash([receipt.id, body.requestId])}`, kind: 'agent', speaker: 'Personal agent', text: body.text, conversationHandoffId: receipt.id, requestId: body.requestId, at: Date.now(), state: 'private-suggestion' }; messages(carrier.id).push(answer) }
    const proxy = actor.personalAgentCredentialId || actor.consultationProxyAgentId
    const delegated = proxy ? await rt.projectDelegations.actorFor(carrier.id) : null
    if (!consultationCurrent(state, receipt, task)) throw refuse('This Chief question is no longer current')
    const canPublish = (!proxy || Boolean(delegated)) && (!receipt.requiresHuman || !proxy) && rt.projectCan(actor, task.projectId, 'task-write', task)
    if (body.publish !== true || !canPublish) { await rt.save(); return { consultation: view(carrier, receipt), replyId: answer.id, published: false, requiresUserApproval: true } }
    // Existing Task inbox performs durable admission and Chief wake-up. A reply
    // supplies explicit new input; it cannot close the Task or confirm a Project.
    const result = await rt.projectInputs.publish({ projectId: task.projectId, taskId: task.id, requestId: answer.id, text: answer.text }, actor)
    answer.state = 'published'; answer.inputId = result.input.id; answer.approvedBy = proxy ? null : actor.memberId
    answer.publishedBy = { memberId: actor.memberId, agentId: proxy ? carrier.personalAgentId : null, credentialId: actor.personalAgentCredentialId ?? null }
    receipt.status = 'completed'; receipt.finishedAt ??= Date.now()
    await rt.save()
    return { consultation: view(carrier, receipt), replyId: answer.id, published: true, input: result.input }
  }
  return { parent, view, endpoint, contactUser, replyDirect: (body, actor) => serial(() => reply(body, actor)) }
}
