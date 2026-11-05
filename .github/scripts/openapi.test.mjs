import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { buildSpec, renderSpec, artifactPath, inventory } from '../../scripts/openapi.mjs'
import { readSpec, validate, operationFor } from '../../scripts/api-contract-validation.mjs'

test('published OpenAPI artifact matches all allowlisted endpoints and v1 operations', () => {
  assert.equal(readFileSync(artifactPath, 'utf8'), renderSpec())
  const spec = readSpec(), inv = inventory(), ops = spec['x-flybot-operations']
  assert.equal(spec.openapi, '3.1.0')
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/api/bot', '/api/project-events', '/health', '/ready'])
  assert.deepEqual([...new Set(ops.map(row => row.transport.endpoint))].sort(), inv.endpoints.sort())
  assert.deepEqual(ops.filter(row => row.transport.kind === 'query').map(row => row.transport.name).sort(), inv.queries.sort())
  assert.deepEqual(ops.filter(row => row.transport.kind === 'command').map(row => row.transport.name).sort(), inv.commands.sort())
  assert.equal(new Set(ops.map(row => row.operationId)).size, ops.length)
  const walk = value => {
    if (!value || typeof value !== 'object') return
    if (value.$ref) assert.ok(spec.components.schemas[value.$ref.split('/').at(-1)], value.$ref)
    Object.values(value).forEach(walk)
  }
  walk(spec)
  for (const row of ops) {
    assert.ok(row.requestSchema.$ref && row.resultSchema.$ref && row.successSchema.$ref)
    assert.ok(row.security.length && row.permission && row.implementation.sha256.length === 64)
    assert.ok(Array.isArray(row.preconditions) && Array.isArray(row.stateChanges.effects))
    assert.ok(row.idempotency.mechanism)
    assert.equal(row.stateChanges.acknowledgementIsCompletion, false)
  }
})

test('FBA safe/watch contracts preserve native asymmetries and human/host-only boundaries', () => {
  const spec = buildSpec(), op = (endpoint, kind, name) => operationFor(spec, endpoint, { kind, name })
  assert.equal(op('project-roles').personalAgent.safe, false)
  assert.equal(op('project-roles').personalAgent.watch, true)
  assert.equal(op('project-development', 'query', 'roles').personalAgent.safe, true)
  assert.equal(op('project-development', 'query', 'attempt.integration-state').personalAgent.safe, false)
  assert.equal(op('project-development', 'command', 'consultation.ask').personalAgent.safe, true)
  assert.equal(op('project-development', 'command', 'task.propose').personalAgent.safe, false)
  assert.deepEqual(op('project-role').humanRoles, ['owner'])
  for (const endpoint of ['personal-agent-token-create', 'personal-agent-delegation-set', 'project-close-prepare', 'project-close-confirm', 'project-terminal-open', 'project-agent-history']) assert.equal(op(endpoint).personalAgent.watch, false, endpoint)
  assert.deepEqual(op('personal-agent-propose-task').security, [{ personalAgentToken: [] }])
  assert.equal(op('feishu').personalAgent.safe, false)
  assert.equal(op('feishu').personalAgent.watch, false)
  assert.deepEqual(op('feishu').security, [{ memberSession: [] }])
  for (const name of ['claim', 'handoff.offer', 'handoff.accept', 'complete', 'arbitrate', 'split']) assert.throws(() => op('project-development', 'command', name), /Unspecified/)
  assert.equal(spec.components.schemas.PersonalAgentTokenCreateResult.properties.token.readOnly, true)
  assert.equal(spec.components.schemas.PersonalAgentTokenCreateResult.properties.token.writeOnly, undefined)
})

test('canonical requests catch wrong kind, unknown/mis-scoped fields and missing command identity', () => {
  const spec = readSpec(), request = { endpoint: 'project-development', payload: { version: 'project-development/v1', projectId: 'example-project', kind: 'command', name: 'task.propose', requestId: 'example-intent', payload: { title: 'Change project', criteria: 'Checked', impact: 'Improve project' } } }
  validate(spec.components.schemas.BotRequest, request, spec)
  for (const mutate of [row => { delete row.payload.requestId }, row => { row.payload.kind = 'query' }, row => { row.payload.payload.projectId = 'other-project' }, row => { row.payload.payload.claim = { role: 'chief' } }]) {
    const row = structuredClone(request); mutate(row)
    assert.throws(() => validate(spec.components.schemas.BotRequest, row, spec))
  }
  validate(spec.components.schemas.BotResponse, { ok: false, error: { code: 'bot/forbidden', message: 'Refused' } }, spec)
  assert.throws(() => validate(spec.components.schemas.DomainError, { ok: true, error: { code: 'bot/forbidden', message: 'Refused' } }, spec))
  assert.throws(() => validate(spec.components.schemas.AuthRevokeSuccess, { ok: true, value: { revoked: true } }, spec))
  validate(spec.components.schemas.AuthRevokeSuccess, { ok: true, value: true }, spec)
  validate(spec.components.schemas.AuthWhoamiSuccess, { ok: true, value: null }, spec)
})

test('every onboarding example validates against exactly one actual request branch', () => {
  const spec = readSpec()
  for (const example of spec['x-flybot-examples']) {
    const { endpoint, payload } = example.request
    const operation = operationFor(spec, endpoint, payload)
    validate(operation.requestSchema, example.request, spec, example.id)
    validate(spec.components.schemas.BotRequest, example.request, spec, example.id)
  }
})

test('third-party guide links and examples remain usable and its inventory is current', () => {
  const file = resolve(import.meta.dirname, '../../docs/third-party-bot-integration.md'), text = readFileSync(file, 'utf8'), spec = readSpec(), inv = spec['x-flybot-inventory']
  assert.ok(text.includes(`${inv.nativeEndpointCount}个`))
  assert.ok(text.includes(`${inv.versionedQueryCount}个 v1 查询`))
  assert.ok(text.includes(`${inv.versionedCommandCount}个 v1 命令`))
  assert.ok(text.includes(`${inv.dispatchVariantCount}种请求分支`))
  assert.ok(text.includes(`${spec['x-flybot-examples'].length}个经过 Schema`))
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (target && !/^[a-z]+:/i.test(target)) assert.ok(existsSync(resolve(dirname(file), target)), target)
  }
  for (const match of text.matchAll(/```json\n([\s\S]*?)\n```/g)) JSON.parse(match[1])
  for (const match of text.matchAll(/```bash\n([\s\S]*?)\n```/g)) execFileSync('bash', ['-n'], { input: match[1] })
})


test('Chief response contract accepts combined protocol-correction and inspection-recovery budgets', () => {
  const spec = readSpec(), operation = operationFor(spec, 'project-development', { kind: 'query', name: 'chief.state' })
  const value = { compensation: [], health: { enabled: true, status: 'healthy', lastSuccessAt: 9, lastAppliedDecisionAt: null, active: [] }, policy: { enabled: true }, template: {}, schedule: null, runs: [{ id: 'chief-bounded-history', projectId: 'project', status: 'done', invocationHistory: Array.from({ length: 9 }, (_, index) => ({ number: index + 1, snapshotSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64), at: index + 1 })) }] }
  validate(operation.resultSchema, value, spec)
})


test('Chief assistance API exposes explicit operations scope and bounded compensation metadata', () => {
  const spec = readSpec(), query = operationFor(spec, 'project-development', { kind: 'query', name: 'chief.state' })
  const value = { compensation: [{ id: 'hourly', enabled: true, status: 'active', when: { kind: 'every', seconds: 3600 }, nextCheckAt: 9000, deliveries: [] }], health: { enabled: true, status: 'healthy', lastSuccessAt: 8, lastAppliedDecisionAt: null, active: [] }, policy: { enabled: true, operationsContact: { memberId: 'operator', agentId: 'ops-agent' }, autonomy: { maxRecoveryActions: 2, maxRecoveryMs: 60000, guidance: 'Shared guidance' } }, template: {}, schedule: null, runs: [] }
  validate(query.resultSchema, value, spec)
  assert.throws(() => validate(query.resultSchema, { ...value, policy: { enabled: true, autonomy: { maxRecoveryActions: 21 } } }, spec), /maxRecoveryActions: number out of bounds/)
  assert.throws(() => validate(query.resultSchema, { ...value, compensation: [{ ...value.compensation[0], nextCheckAt: 'guessed' }] }, spec), /nextCheckAt:/)
})

test('Chief source/acceptance failures and incomplete correction transport remain machine readable', () => {
  const spec = readSpec(), query = operationFor(spec, 'project-development', { kind: 'query', name: 'chief.state' })
  const recovery = { version: 'chief-recovery/v1', kind: 'source-changed', retryable: false, conditions: ['fresh source'], actions: ['Chief reassesses'], candidateSha: 'a'.repeat(40) }
  const value = { compensation: [], health: { enabled: true, status: 'degraded', lastSuccessAt: null, lastAppliedDecisionAt: null, active: [] }, policy: { enabled: true }, template: {}, schedule: null, runs: [{ id: 'run', projectId: 'project', status: 'failed', recoveryIssue: recovery, correction: { version: 'chief-correction/v1', round: 1, limit: 2, status: 'transport-incomplete', feedback: [] }, lastResult: { ok: false, invocation: 2, source: 'host-dispatch', responseSha256: null, diagnosticSha256: 'b'.repeat(64), receivedAt: 2 }, failureDetail: { invocation: 2, stage: 'dispatch', code: 'bot/chief', responseSha256: null, diagnosticSha256: 'b'.repeat(64), recoveryKind: 'source-changed', criteriaIssues: [], at: 2 } }] }
  validate(query.resultSchema, value, spec)
  for (const kind of ['input-protocol', 'acceptance-evidence-missing']) { value.runs[0].recoveryIssue.kind = kind; validate(query.resultSchema, value, spec) }
})

test('merged candidate handoff separates transport receipt, Chief outcome and Task acceptance', () => {
  const spec = readSpec(), value = { effectId: 'handoff-effect', candidateSha: 'a'.repeat(40), status: 'delivered', reason: null, waitingFor: null, runId: 'chief-run', runStatus: 'failed', runFailure: 'Execution transport unavailable', waitingRunId: null, createdAt: 1, requestedAt: 2 }
  validate({ $ref: '#/components/schemas/MergeHandoff' }, value, spec)
  assert.throws(() => validate({ $ref: '#/components/schemas/MergeHandoff' }, { ...value, status: 'accepted' }, spec), /status:/)
  assert.throws(() => validate({ $ref: '#/components/schemas/MergeHandoff' }, { ...value, candidateSha: 'unverified' }, spec), /candidateSha:/)
})

test('dispatch gates and Chief input declarations are typed without treating declarations as acceptance', () => {
  const spec = readSpec()
  validate({ $ref: '#/components/schemas/DispatchState' }, { effectId: 'e', status: 'pending', generation: 1, committed: true, executions: 89, failures: 0, waitingFor: 'project-capacity', reason: 'Capacity admission is pending', dueAt: 1 }, spec)
  const receipt = { provided: true, batchId: 'batch', read: ['i'], handled: ['i'], remaining: 2 }
  validate({ $ref: '#/components/schemas/ChiefInputReceiptSummary' }, receipt, spec)
  assert.throws(() => validate({ $ref: '#/components/schemas/ChiefInputReceiptSummary' }, { ...receipt, handled: ['a', 'b', 'c'] }, spec), /handled:/)
})
