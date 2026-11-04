// Deterministic protocol driver for actual DSH/HTTP acceptance, never real-model evidence.
import { agentReply } from './agents.mjs'
const nodes = value => value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(nodes)] : []
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
export function inboxModel({ correctOnce = false } = {}) {
  const tasks = new Map(), observed = { nativeClaims: 0, nativeCompletions: 0, chiefQuestions: 0, chiefResumptions: 0, invalidChiefResponses: 0, chiefCorrections: 0 }
  const malformed = new Set(), corrected = new Set()
  return {
    observed, register: (marker, taskId) => tasks.set(marker, taskId),
    reply(options) {
      const { body } = options, system = JSON.stringify(body.system ?? ''), text = strings(body.messages ?? []).join('\n')
      if (system.includes('For each configured Chief job')) {
        const match = [...tasks].find(([marker]) => text.includes(marker))
        if (match) {
          const batchId = [...text.matchAll(/"batchId"\s*:\s*"(input-batch-[a-f0-9]+)"/g)].at(-1)?.[1]
          const ids = [...new Set([...text.matchAll(/"id"\s*:\s*"(task-input-[a-f0-9]+)"/g)].map(row => row[1]))].slice(-2)
          const resume = text.includes('Approved fixture option') && batchId && ids.length
          if (resume) observed.chiefResumptions++; else observed.chiefQuestions++
          const decision = resume ? { taskId: match[1], action: 'admit', reason: 'The scoped agent input resolves this question', inputReceipts: { batchId, read: ids, handled: ids } } : { taskId: match[1], action: 'needs-human', reason: 'Select the approved fixture option through your own project agent', requiresHuman: false }
          if (resume && correctOnce && !malformed.has(match[1])) { decision.requirements = { criteria: ['Invalid fixture array; Chief must correct this field'] }; malformed.add(match[1]); observed.invalidChiefResponses++ }
          else if (resume && malformed.has(match[1]) && !corrected.has(match[1]) && text.includes('Host protocol feedback')) { corrected.add(match[1]); observed.chiefCorrections++ }
          return [{ type: 'text', text: JSON.stringify({ summary: 'Isolated inbox protocol acceptance', decisions: [decision] }) }]
        }
      }
      const messageId = /Agent inbox notification (consultation-[a-f0-9]+)\./.exec(text)?.[1]
      if (system.includes('personal agent participating in this Project') && messageId) {
        const calls = nodes(body.messages).filter(row => row.type === 'tool_use' && row.name === 'project_agent_inbox' && row.input?.messageId === messageId)
        const call = (operation, fields) => [{ type: 'tool_use', id: `inbox-${operation}-${calls.length}`, name: 'project_agent_inbox', input: { operation, messageId, ...fields } }]
        if (!calls.some(row => row.input.operation === 'claim')) { observed.nativeClaims++; return call('claim', { requestId: 'native-inbox-claim' }) }
        let claim
        for (const value of strings(body.messages)) {
          try { const parsed = JSON.parse(value); if (parsed?.claim?.claimId) claim = parsed.claim } catch { /* Most model content is ordinary text. */ }
        }
        if (!claim) return [{ type: 'text', text: 'Inbox claim unavailable; no project action taken.' }]
        if (!calls.some(row => row.input.operation === 'get')) return call('get', { limit: 4000 })
        if (!calls.some(row => row.input.operation === 'complete')) { observed.nativeCompletions++; return call('complete', { claimId: claim.claimId, generation: claim.generation, requestId: 'native-inbox-answer', text: 'Approved fixture option', publish: true }) }
        return [{ type: 'text', text: 'Recorded the scoped inbox result; Chief retains Task adjudication.' }]
      }
      return agentReply(options)
    },
  }
}
