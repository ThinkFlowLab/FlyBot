import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { openSqliteState } from '../src/host/project-state-sqlite.js'
import { fakeContext } from './fake-ctx.js'

test('original Project APIs persist Task/intake intent in SQL without model calls or positioning changes', async t => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-sql-api-')), contexts = []
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, revision: 1, members: { 'owner-1': { id: 'owner-1', designatedChiefId: 'chief' } }, mainBotIds: ['chief'], bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', ownerId: 'owner-1', projectId: 'p' } }, projects: { p: { id: 'p', name: 'Existing Project', status: 'active', ownerUserId: 'owner-1', goal: 'Retain the agreed product goal', scope: 'Original Project scope', roles: { members: [], maintainers: [] } } }, tasks: {} }))
  let modelCalls = 0
  async function start(stateStorage) {
    const ctx = fakeContext()
    Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [], generate: async () => { ++modelCalls; throw Error('No inference expected') } }, workspaceRegistry: { get: () => undefined, archiveSession: async () => {} }, sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
    contexts.push(ctx)
    const rt = createRuntime(ctx, { home, projectWorkbench: true, ...(stateStorage ? { stateStorage } : {}) })
    await rt.load()
    assert.equal(rt.readOnly(), undefined)
    return { ctx, rt }
  }
  t.after(async () => { for (const ctx of contexts.reverse()) await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const first = await start('sqlite'), actor = { memberId: 'owner-1' }
  const task = await first.rt.taskEndpoint('task-create', { botId: 'chief', projectId: 'p', title: 'Improve backend query', criteria: 'Query regression passes', impact: 'Improve Project observability' }, actor)
  assert.equal(task.projectTask.admission.status, 'proposed')
  await first.rt.taskEndpoint('task-update', { id: task.id, note: 'Keep the agreed scope and required evidence' }, actor)
  const body = { version: 'project-development/v1', kind: 'query', name: 'tasks', projectId: 'p', payload: { limit: 10 } }
  const view = await first.rt.projectEndpoint('project-development', body, actor)
  assert.equal(view.result.tasks[0].taskId, task.id)
  assert.equal(view.result.tasks[0].waitingFor, 'admission')
  const database = openSqliteState({ path: join(home, 'state.sqlite'), readOnly: true }), disk = database.read(); database.close()
  assert.equal(disk.tasks[task.id].note, 'Keep the agreed scope and required evidence')
  const intake = Object.values(disk.projectEffects).find(row => row.kind === 'task.intake' && row.taskId === task.id)
  assert.ok(intake)
  assert.equal(first.rt.projectEffects.intentCommitted({ id: intake.id, generation: intake.generation }), true)
  assert.equal(disk.projects.p.goal, 'Retain the agreed product goal')
  assert.equal(disk.projects.p.scope, 'Original Project scope')
  assert.equal(modelCalls, 0)
  const snapshotBody = { version: 'project-development/v1', kind: 'query', name: 'project.snapshot', projectId: 'p', payload: {} }
  const baseline = (await first.rt.projectEndpoint('project-development', snapshotBody, actor)).result
  const proposalBody = { version: 'project-development/v1', kind: 'command', name: 'task.propose', projectId: 'p', requestId: 'propose-through-service',
    payload: { botId: 'chief', title: 'A second explicit Project change', criteria: 'Independent regression passes', impact: 'Improve the Project service' } }
  const proposal = await first.rt.projectEndpoint('project-development', proposalBody, actor)
  assert.equal(proposal.receipt.status, 'completed'); assert.equal(proposal.receipt.committed, true)
  const proposedId = proposal.result.id
  assert.equal(first.rt.state.tasks[proposedId].commandSource.commandReceiptId, proposal.receipt.id)
  assert.equal((await first.rt.projectEndpoint('project-development', proposalBody, actor)).result.id, proposedId)
  assert.equal(Object.keys(first.rt.state.tasks).length, 2)
  const eventBody = { version: 'project-development/v1', kind: 'query', name: 'events', projectId: 'p', payload: { after: baseline.cursor } }
  const facts = (await first.rt.projectEndpoint('project-development', eventBody, actor)).result
  assert.deepEqual(facts.events.map(row => row.entityId), [proposedId])
  const receiptBody = { version: 'project-development/v1', kind: 'query', name: 'command.receipt', projectId: 'p', payload: { commandRequestId: proposalBody.requestId } }
  assert.equal((await first.rt.projectEndpoint('project-development', receiptBody, actor)).result.id, proposal.receipt.id)
  await first.ctx.dispose()
  const second = await start()
  assert.equal(second.rt.stateStorage.status().backend, 'sqlite')
  assert.equal((await second.rt.projectEndpoint('project-development', proposalBody, actor)).result.id, proposedId)
  assert.equal(Object.keys(second.rt.state.tasks).length, 2)
  assert.deepEqual((await second.rt.projectEndpoint('project-development', eventBody, actor)).result.events.map(row => row.entityId), [proposedId])

  assert.equal((await second.rt.projectEndpoint('project-development', body, actor)).result.tasks[0].taskId, task.id)
  assert.equal(second.rt.state.tasks[task.id].projectTask.admission.status, 'proposed')
  assert.equal(modelCalls, 0)
})
