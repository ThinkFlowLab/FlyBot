import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sdkContinuationArchive } from '../src/host/project-session-continuation.js'
const sha = text => createHash('sha256').update(text).digest('hex')

test('host reconstruction archives exact prior conclusions, tool facts, handled input state and operation receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-session-continuation-'))
  try {
    const text = 'Original role convention and Task goal', log = join(root, 'source.jsonl')
    const events = [{ type: 'sdk-event', event: { type: 'item.completed', item: { type: 'command_execution', command: 'git diff', exit_code: 0 } } }, { type: 'completed', text: 'Prior conclusion: code sealed; needs Tester verification' }]
    const sourceLog = events.map(row => JSON.stringify(row)).join('\n') + '\n'
    await writeFile(log, sourceLog)
    const restoration = { version: 'task-role-cwd-restoration/v1', mode: 'reconstructed', projectId: 'p', taskId: 't', logicalSessionId: 'logical', sourceWorkerId: 'old', sourceSessionId: 'old-thread', sourceAttemptId: 'a1', attemptId: 'a2' }
    const session = { id: 'source-role', projectId: 'p', taskId: 't', role: 'developer', context: { text, sha256: sha(text) } }
    const worker = { id: 'old', projectId: 'p', taskId: 't', attemptId: 'a1', role: 'developer', logicalSessionId: 'logical', sessionKey: session.id, backendSessionId: 'old-thread', sealedLog: log, eventSha256: sha(sourceLog), status: 'released', generation: 1, releaseProof: { kind: 'sdk-stop-ack-and-process-exit', generation: 1 } }
    const state = { tasks: { t: { id: 't', projectId: 'p', deliveryAttemptId: 'a2', title: 'Original Task', collaboration: { history: [{ id: 'handoff-1', reason: 'Return for missing coverage' }] } } }, projectAttempts: { a1: { id: 'a1', projectId: 'p', taskId: 't', roleSessions: { developer: session }, candidateSha: 'a'.repeat(40), pr: { number: 5, sha: 'a'.repeat(40) }, publicationEffectId: 'publish-1' }, a2: { id: 'a2', projectId: 'p', taskId: 't' } }, projectHarnessWorkers: { old: worker }, projectTaskInputs: { input: { id: 'input', projectId: 'p', taskId: 't', status: 'handled', sha256: 'b'.repeat(64) }, foreign: { id: 'foreign', projectId: 'elsewhere', taskId: 't', status: 'accepted' } }, projectEffects: { publish: { id: 'publish-1', taskId: 't', projectId: 'p', kind: 'github.publish', status: 'completed' } } }
    const archive = await sdkContinuationArchive(state, { workerId: 'old', restoration })
    assert.equal(archive.sha256, sha(archive.text))
    const data = JSON.parse(archive.text)
    assert.equal(data.previousContext.text, text); assert.equal(data.previousEvents.length, 2)
    assert.match(data.previousConclusion, /needs Tester verification/)
    assert.deepEqual(data.facts.inputs.map(row => row.id), ['input']); assert.equal(data.facts.inputs[0].status, 'handled')
    assert.equal(data.facts.effects[0].id, 'publish-1'); assert.equal(data.facts.attempts[0].pr.number, 5)
    assert.match(data.warning, /Do not repeat handled receipts/)
    await writeFile(log, 'changed')
    await assert.rejects(sdkContinuationArchive(state, { workerId: 'old', restoration }), { code: 'bot/context-resume' })
    await writeFile(log, sourceLog)
    worker.status = 'unreachable'
    await assert.rejects(sdkContinuationArchive(state, { workerId: 'old', restoration }), { code: 'bot/context-resume' })
    worker.status = 'released'; restoration.projectId = 'foreign'
    await assert.rejects(sdkContinuationArchive(state, { workerId: 'old', restoration }), { code: 'bot/context-resume' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
