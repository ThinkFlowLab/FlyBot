// Generate the public wire specification; never register a second runtime API.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { schemas, native, queries, commands, personal, workflows, obj, result, ref, lit, id, requestId, int, str, nullable } from './api-contracts.mjs'
import { integrationExamples } from './api-examples.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const hash = text => createHash('sha256').update(text).digest('hex')
const strings = text => [...text.matchAll(/'([^']+)'/g)].map(match => match[1])
const source = 'core/src/host/project-development-service.js'
export function inventory() {
  const service = read(source), gateway = read('core/src/host/workbench-gateway.js'), auth = read('core/src/host/personal-agent-auth.js')
  const set = (text, name) => strings(new RegExp(`(?:const|export const) ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(text)?.[1] ?? '')
  const operations = Object.fromEntries([...service.match(/const operations = Object.freeze\(\{([\s\S]*?)\}\)/)[1].matchAll(/'([^']+)': '([^']+)'/g)].map(match => [match[1], match[2]]))
  const queryNames = set(service, 'queries')
  return { endpoints: set(gateway, 'WORKBENCH_ENDPOINTS'), queries: queryNames, commands: Object.keys(operations).filter(name => !queryNames.includes(name)), aliases: operations, fbaReads: set(auth, 'reads'), fbaReserved: set(auth, 'reserved') }
}
const inv = inventory()
const clone = value => structuredClone(value)
const key = value => value.split(/[^A-Za-z0-9]+/).map(word => word[0].toUpperCase() + word.slice(1)).join('')
const equalNames = (actual, expected, label) => { if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} catalog differs from runtime: missing=${expected.filter(name => !actual.includes(name))}; extra=${actual.filter(name => !expected.includes(name))}`) }

function nativeCatalog() {
  const rows = new Map(native)
  for (const [name, endpoint] of Object.entries(inv.aliases)) {
    if (!inv.endpoints.includes(endpoint) || rows.has(endpoint)) continue
    const entry = queries.get(name) ?? commands.get(name)
    if (!entry) throw new Error(`No wire contract for ${name}`)
    const request = clone(entry.request)
    request.properties = { projectId: id, ...request.properties }
    request.required = [...new Set(['projectId', ...(request.required ?? [])])]
    if (commands.has(name) && name !== 'execution.input') {
      request.properties.requestId = requestId
      // Canonical clients carry a stable identity even where a legacy alias ignores it.
      request.required.push('requestId')
    }
    rows.set(endpoint, { ...entry, name: endpoint, request, aliasOf: `${queries.has(name) ? 'query' : 'command'}.${name}`, idempotency: commands.has(name) ? 'domain-specific-only-no-unified-command-receipt-use-v1' : entry.idempotency })
  }
  return rows
}

const permissionRules = {
  anonymous: { humanRoles: [], condition: 'anonymous-discovery-or-valid-login-material' },
  session: { humanRoles: ['owner', 'maintainer', 'member'], condition: 'authenticated-active-principal; Project-scoped reads still filter membership' },
  'identity-discovery': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'optional-identity; missing-or-invalid-credential-returns-null-not-authentication-success' },
  read: { humanRoles: ['owner', 'maintainer', 'member'], condition: 'current-project-membership' },
  create: { humanRoles: ['owner', 'maintainer', 'member'], condition: 'current-project-membership-and-active-project' },
  configure: { humanRoles: ['owner', 'maintainer'], condition: 'current-manager-and-active-project' },
  manage: { humanRoles: ['owner'], condition: 'current-Project-Owner-and-active-project; valid-Owner-watch-delegation-permitted-except-personal-confirmation-operations' },
  invite: { humanRoles: ['owner', 'maintainer'], condition: 'current-manager-and-active-project' },
  accept: { humanRoles: ['owner', 'maintainer'], condition: 'legacy-only; new Task completion requires host-authenticated Chief' },
  'run-control': { humanRoles: ['owner', 'maintainer'], condition: 'current-manager-and-active-project' },
  'task-write': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'current-manager-or-task-requester; current-Task-contract-still-applies' },
  'human-manager': { humanRoles: ['owner', 'maintainer'], condition: 'current-signed-in-human-manager; no-agent-or-watch-credential' },
  'human-self': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'human-only-and-own-personal-agent-or-session' },
  'human-owner': { humanRoles: ['owner'], condition: 'Owner-personally; primary-owner-required-by-legacy-lifecycle' },
  'human-conversation': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'human-only; own-private-or-explicitly-approved-public-conversation' },
  'human-resource-admin': { humanRoles: ['owner', 'maintainer'], condition: 'live-human-session-and-explicit-resource-adminMemberIds' },
  'closure-suggestion': { humanRoles: ['owner', 'maintainer'], condition: 'manager-or-authorized-active-personal-agent; suggestion-only' },
  'private-consultation': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'own-active-private-personal-agent-participation' },
  'own-consultation': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'own-agent-mailbox; never-other-agent-even-same-human' },
  'same-command-principal': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'exact-original-command-principal; human-and-each-personal-agent-are-distinct' },
  'role-policy': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'Owner-for-other-person; otherwise-self-demotion-only; Owner-never-assignable' },
  'remove-member-policy': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'self-nonowner-or-Owner-removes-Maintainer-or-manager-removes-Member' },
  'room-read-or-create': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'current-room-participant; creation-also-needs-active-project-create' },
  'conversation-initiator-or-manager': { humanRoles: ['owner', 'maintainer', 'member'], condition: 'matching-conversation-initiator-or-current-manager; native-stop-private-owner-checks' },
  'fba-proposal': { humanRoles: [], condition: 'FBA-only; current-token-scope-and-participation' },
}

function access(entry, endpoint, kind, name) {
  const rule = permissionRules[entry.permission]
  if (!rule) throw new Error(`Unknown permission ${entry.permission} on ${name}`)
  let safe = false, watch = false
  if (endpoint === 'project-development') {
    safe = kind === 'query' || ['consultation.ask', 'consultation.reply', 'inbox.claim', 'inbox.renew', 'inbox.complete', 'inbox.fail'].includes(name)
    watch = kind === 'query' || !['agent.mode', 'proposal.publish', 'inbox.connection.configure', 'github.connection.configure'].includes(name)
    if (entry.permission === 'configure') safe = false // downstream gate, even for a query
  } else {
    safe = inv.fbaReads.includes(endpoint) || ['auth-whoami', 'auth-revoke', 'personal-agent-propose-task', 'project-close-request', 'project-consultation-ask', 'project-consultation-reply', 'project-chief-question', 'project-agents'].includes(endpoint)
    watch = safe || endpoint.startsWith('project-') && !inv.fbaReserved.includes(endpoint) && endpoint !== 'project-agents' || ['task-create', 'task-update', 'task-cancel', 'task-answer-input'].includes(endpoint)
  }
  if (entry.permission.startsWith('human-') || ['project-create', 'project-join', 'personal-space'].includes(endpoint)) safe = watch = false
  const schemes = []
  if (entry.permission === 'identity-discovery') schemes.push({})
  if (entry.permission === 'anonymous') schemes.push({})
  else if (entry.permission !== 'fba-proposal') schemes.push({ memberSession: [] })
  if (safe || watch) schemes.push({ personalAgentToken: [] })
  return { security: schemes, permission: entry.permission, ...rule, personalAgent: { safe, watch, checks: ['unexpired-unrevoked-token', 'enabled-current-owner-principal', 'active-agent', 'explicit-token-project-scope', 'active-agent-project-participation', 'current-owner-project-rights', ...(watch ? ['writes-require-current-watch-grant-and-generation'] : []), ...(endpoint === 'project-agents' ? ['view-must-be-summary'] : []), 'all-operation-specific-domain-preconditions'] }, effective: 'intersection-of-current-human-rights-token-scope-participation-delegation-and-domain-fences; never-role-name' }
}

const transitions = {
  'task.propose': [['Task', 'absent', 'awaiting-chief']],
  'task.change.request': [['TaskChangeRequest', 'absent', 'pending-chief']],
  'task.run': [['Task', 'awaiting-chief', 'awaiting-chief'], ['QueueEntry', 'absent', 'waiting|blocked|started']],
  'task.accept': [['LegacyTask', 'awaiting-acceptance', 'accepted']],
  'task.reject': [['Attempt', 'waiting-acceptance|running', 'failed|returned']],
  'attempt.stop': [['Execution', 'active', 'stopping|stop-unconfirmed|exited']],
  'queue.cancel': [['QueueEntry', 'waiting|blocked', 'cancelled']],
  'queue.retry': [['QueueEntry', 'blocked', 'waiting']],
  'consultation.ask': [['Consultation', 'absent', 'pending']],
  'consultation.reply': [['ConsultationReply', 'absent', 'private|published']],
  'role.decide': [['RoleProposal', 'pending', 'approved|rejected']],
  'release.request': [['Release', 'absent', 'authorized']],
  'release.reconcile': [['Release', 'authorized|unknown|awaiting-artifact|failed', 'observed|unknown|awaiting-artifact|failed']],
  'project-create': [['Project', 'absent', 'active|archived']],
  'project-archive': [['Project', 'active', 'archived']],
  'project-delete': [['Project', 'active|archived', 'deleted']],
  'project-close-confirm': [['Project', 'active', 'closed']],
  'personal-agent-create': [['PersonalAgent', 'absent', 'active']],
  'personal-agent-join': [['Participation', 'absent|left', 'active']],
  'personal-agent-leave': [['Participation', 'active', 'left']],
  'personal-agent-retire': [['PersonalAgent', 'active', 'retired']],
  'personal-agent-token-create': [['AgentCredential', 'absent', 'active']],
  'personal-agent-token-revoke': [['AgentCredential', 'active', 'revoked']],
}

export function buildSpec() {
  equalNames([...queries.keys()], inv.queries, 'query')
  equalNames([...commands.keys()], inv.commands, 'command')
  const catalog = nativeCatalog()
  equalNames([...catalog.keys(), 'project-development'], inv.endpoints, 'gateway')
  const components = clone(schemas), operations = [], nativeBranches = [], v1Branches = []
  const register = (entry, endpoint, kind, name, suboperation) => {
    const operationId = kind ? `development.${kind}.${name}` : suboperation ? `${endpoint}.${suboperation}` : endpoint
    const prefix = key(operationId), payloadKey = `${prefix}Payload`, requestKey = `${prefix}Request`, resultKey = `${prefix}Result`, successKey = `${prefix}Success`
    components[payloadKey] = clone(entry.request)
    const v1 = obj({ version: lit('project-development/v1'), kind: lit(kind), name: lit(name), projectId: id, payload: ref(payloadKey), ...(kind === 'command' ? { requestId } : {}), expectedGeneration: int(), expectedCandidateSha: nullable(schemas.Attempt.properties.candidateSha) }, ['version', 'kind', 'name', 'projectId', 'payload', ...(kind === 'command' ? ['requestId'] : [])])
    components[requestKey] = obj({ endpoint: lit(endpoint), payload: kind ? v1 : ref(payloadKey) }, ['endpoint', 'payload'])
    components[resultKey] = clone(entry.response)
    const value = kind ? result({ version: lit('project-development/v1'), requestId, result: ref(resultKey), receipt: ref('CommandReceipt'), replayed: { type: 'boolean' }, reconstructed: { type: 'boolean' } }, ['version', 'result', ...(kind === 'command' ? ['requestId'] : [])]) : ref(resultKey)
    components[successKey] = obj({ ok: lit(true), value }, ['ok', 'value'])
    const auth = access(entry, endpoint, kind, name)
    const mutation = entry.effects.length > 0
    operations.push({ operationId, transport: { method: 'POST', path: '/api/bot', endpoint, ...(kind ? { kind, name, version: 'project-development/v1' } : {}), ...(suboperation ? { operation: suboperation } : {}) }, requestSchema: ref(requestKey), resultSchema: ref(resultKey), successSchema: ref(successKey), errorSchema: ref('DomainError'), ...auth,
      preconditions: entry.preconditions.map(code => ({ code, enforcedBy: 'server', clientCheckIsAuthority: false })),
      stateChanges: { effects: entry.effects, effectsAreConditional: true, transitions: (transitions[name] ?? transitions[endpoint] ?? []).map(([entity, from, to]) => ({ entity, from: from.split('|'), to: to.split('|'), conditional: true })), noTaskCreated: name?.startsWith('consultation.') || endpoint === 'project-chief-question', acknowledgementIsCompletion: false },
      idempotency: { mechanism: entry.idempotency, retry: kind === 'command' ? 'same-principal-project-name-requestId-and-identical-payload; read-command.receipt-on-uncertain-outcome' : mutation ? 'only-if-domain-contract-explicitly-permits; native-alias-has-no-unified-receipt' : 'read-again-with-current-authorization-and-cursor', unifiedCommandReceipt: kind === 'command' },
      invokesModel: entry.invokesModel, notes: entry.notes ?? 'All current authorization, Project/Task bindings and domain fences are rechecked server-side.', implementation: { path: entry.source, sha256: hash(read(entry.source)) }, ...(entry.aliasOf ? { aliasOf: `development.${entry.aliasOf}` } : {}) })
    return ref(requestKey)
  }
  for (const [name, entry] of queries) v1Branches.push(register(entry, 'project-development', 'query', name))
  for (const [name, entry] of commands) v1Branches.push(register(entry, 'project-development', 'command', name))
  for (const [endpoint, entry] of catalog) {
    if (endpoint === 'personal-space' || endpoint === 'project-workflow') {
      const branches = []
      for (const [name, subentry] of endpoint === 'personal-space' ? personal : workflows) branches.push(register(subentry, endpoint, undefined, undefined, name))
      nativeBranches.push(...branches)
    } else nativeBranches.push(register(entry, endpoint))
  }
  components.BotRequest = { oneOf: [...nativeBranches, ...v1Branches] }
  components.BotResponse = { oneOf: [obj({ ok: lit(true), value: ref('JsonValue') }, ['ok', 'value']), ref('DomainError')] }
  const response = (description, schema) => ({ description, content: { 'application/json': { schema } } })
  const gatewayError = response('Gateway transport rejection; no domain command success is implied.', ref('GatewayError'))
  const files = ['core/src/shared/project-policy.js', 'plugins/workflow/src/service.js', ...readdirSync(resolve(root, 'core/src/host')).filter(name => name.endsWith('.js')).map(name => `core/src/host/${name}`)]
  return {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'FlyBot public Bot integration API', version: 'project-development/v1+native', description: 'Source-matched restricted backend gateway. Native endpoint dispatch and versioned application commands share POST /api/bot. Inspect x-flybot-operations for correlated response, current rights, prerequisites, state effects and recovery. This artifact documents existing behavior; it does not deploy a service or grant access.' },
    servers: [{ url: '{origin}', variables: { origin: { default: 'http://127.0.0.1:3080', description: 'Actual operator-provided backend origin; prefer HTTPS for remote use. No URL token.' } } }],
    webhooks: { agentNotification: { post: { operationId: 'receiveAgentInboxNotification', description: 'Callback on the explicitly verified receiver endpoint, not a new FlyBot inbound route. Verify HMAC-SHA256(key, timestamp + "." + exactRawBody), timestamp tolerance and persistent eventId deduplication. Then authenticate to FlyBot and claim the message; notification grants no permission.', security: [{ agentWebhookSignature: [] }], parameters: [{ in: 'header', name: 'X-Flybot-Event-ID', required: true, schema: id }, { in: 'header', name: 'X-Flybot-Timestamp', required: true, schema: { type: 'string', pattern: '^[0-9]{13}$' } }, { in: 'header', name: 'X-Flybot-Signature', required: true, schema: { type: 'string', pattern: '^sha256=[a-f0-9]{64}$' } }], requestBody: { required: true, content: { 'application/json': { schema: ref('AgentNotification') } } }, responses: { 200: response('Metadata accepted only; connection.verify must echo the exact challenge and prove HMAC-SHA256(key, "challenge." + challenge). Not a processing/business acknowledgement.', obj({ received: { type: 'boolean' }, challenge: id, signature: { type: 'string', pattern: '^sha256=[a-f0-9]{64}$' } }, [], { anyOf: [{ required: ['received'] }, { required: ['challenge', 'signature'] }] })) }, 'x-signed': true, 'x-defaultSignatureToleranceMs': 300000, 'x-delivery': 'at-least-once; use authenticated inbox as authority' } } },
    paths: {
      '/health': { get: { operationId: 'health', summary: 'Gateway process liveness', security: [], responses: { 200: response('Liveness only; not proof of provider readiness.', result({ status: lit('ok') })), 403: gatewayError } } },
      '/ready': { get: { operationId: 'readiness', summary: 'Current backend transport and state-write readiness, not model/provider or full storage integrity verification', security: [], responses: { 200: response('Ready for backend state writes.', result({ status: lit('ready'), writable: lit(true) })), 503: response('Backend is read-only or unavailable; no private diagnostics are exposed.', result({ status: { enum: ['degraded', 'unavailable'] }, writable: lit(false) })), 403: gatewayError } } },
      '/api/bot': { post: { operationId: 'dispatchBotOperation', summary: 'Dispatch a native endpoint or a project-development/v1 query/command', description: 'Select a request branch by endpoint and, for v1, kind/name. x-flybot-operations correlates that request with its exact success/result schema. HTTP 200 includes domain failures; inspect ok before value. Security differs by dispatch; anonymous access is only for explicit discovery/login/redeem.', security: [{}, { memberSession: [] }, { personalAgentToken: [] }], requestBody: { required: true, content: { 'application/json': { schema: ref('BotRequest') } } }, responses: { 200: response('Domain result envelope. ok=false is failure even with HTTP 200.', ref('BotResponse')), ...Object.fromEntries([400, 403, 404, 413, 415, 502].map(status => [status, gatewayError])) }, 'x-maxRequestBytes': 1048576, 'x-maxUpstreamResponseCodeUnits': 8388608, 'x-upstreamTimeoutMs': 180000 } },
      '/api/project-events': { get: { operationId: 'streamProjectEvents', summary: 'Read committed Project facts as SSE; never acquire Task initiative', security: [{ memberSession: [] }, { personalAgentToken: [] }], parameters: [{ in: 'query', name: 'projectId', required: true, schema: requestId }, { in: 'query', name: 'after', schema: { type: 'string', maxLength: 600, pattern: '^[A-Za-z0-9_-]+$' } }, { in: 'header', name: 'Last-Event-ID', schema: str(600), description: 'Same opaque cursor as after. If both are present they must match. Duplicate/unknown query keys are refused.' }], responses: { 200: { description: 'UTF-8 SSE. snapshot when no cursor, fact for committed events; comment keep-alive; reset-required/access-revoked then close. Reauthenticate and take a fresh snapshot as instructed, never replay commands.', content: { 'text/event-stream': { schema: str() } }, 'x-sse-events': { snapshot: ref('Snapshot'), fact: ref('Event'), 'reset-required': ref('SseControl'), 'access-revoked': ref('SseControl') } }, ...Object.fromEntries([400, 401, 403, 409, 429, 503].map(status => [status, response('SSE admission refusal before headers; origin/host checks may use a gateway error.', { oneOf: [ref('SseError'), ref('GatewayError')] })])) }, 'x-preconditions': ['valid-current-principal', 'current-project-membership', 'active-agent-participation-and-token-scope-for-FBA', 'valid-same-project-cursor', 'available-stream-capacity'], 'x-stateChanges': [], 'x-authorizationRechecked': 'every-poll; revocation-closes-stream' } },
    },
    components: { securitySchemes: { agentWebhookSignature: { type: 'apiKey', in: 'header', name: 'X-Flybot-Signature', description: 'Computed HMAC-SHA256 over timestamp + dot + exact raw body using the explicitly provisioned private notification key; verify timestamp and eventId replay protection. Never an FBA credential.' }, memberSession: { type: 'apiKey', in: 'header', name: 'X-Flybot-Member-Session', description: 'Secret human session returned by platform-login/auth-redeem or private local bootstrap. No public self-signup or refresh endpoint.' }, personalAgentToken: { type: 'apiKey', in: 'header', name: 'X-Flybot-Member-Session', description: 'Independent fba_ token, issued once by the human for explicit Project scopes. The same header as memberSession; do not send both. Safe by default. Watch can only be granted/revoked by its human.' } }, schemas: { ...components, SseControl: result({ code: str(), details: result({ nextAction: str() }) }), SseError: result({ ok: lit(false), error: ref('Error') }) } },
    'x-flybot-operations': operations,
    'x-flybot-inventory': { ...inv, nativeEndpointCount: inv.endpoints.length, versionedQueryCount: queries.size, versionedCommandCount: commands.size, dispatchVariantCount: operations.length, sources: Object.fromEntries(files.sort().map(path => [path, hash(read(path))])) },
    'x-flybot-client-profile': { requestUnknownFields: 'refused-by-this-canonical-client-schema; legacy-server-may-ignore-or-coerce-fields', responseUnknownFields: 'preserved-and-ignored-unless-understood', schemaIsAuthorization: false, time: 'epoch-milliseconds-unless-described-as-ISO8601', textOffsets: 'UTF-16-code-units-for-SourcePage; UTF-8-bytes-for-attempt.log', confidentiality: 'never-share-private-history-sessions-raw-credentials-or-owner-cookie', errors: { domain: 'HTTP200 ok=false error.code/message; details may be present', gateway: 'non-2xx {error:string}', sse: 'before-stream domain error envelope; after-stream terminal SSE control event' } },
    'x-flybot-workflows': workflowsForBots(),
    'x-flybot-examples': integrationExamples,
    'x-flybot-error-policy': {
      'bot/unauthorized': { retryAutomatically: false, nextAction: 'reauthenticate-with-human-issued-credential' },
      'bot/forbidden': { retryAutomatically: false, nextAction: 'check-current-membership-scope-participation-and-human-delegation' },
      'bot/conflict': { retryAutomatically: false, nextAction: 'read-current-entity-and-source-versions; do-not-discard-fences' },
      'bot/cursor-expired': { retryAutomatically: false, nextAction: 'project.snapshot' },
      'bot/outcome-unknown': { retryAutomatically: false, nextAction: 'command.receipt-and-domain-reconciliation-or-Chief' },
      'bot/read-only': { retryAutomatically: false, nextAction: 'operator-reconciles-store-format-or-write-failure' },
      'bot/quota': { retryAutomatically: false, nextAction: 'observe-existing-queue-and-capacity; do-not-create-duplicate-work' },
      'bot/busy': { retryAutomatically: false, nextAction: 'bounded-read-retry-after-capacity-or-current-turn-finishes' },
      default: { retryAutomatically: false, nextAction: 'inspect-domain-message-and-current-state; unknown-errors-never-authorize-replay' },
    },
    'x-excluded-surfaces': [
      { surface: 'DSH owner API, raw /api/bot endpoints absent from the gateway allowlist, platform administration', reason: 'private operator surface; no public registration/role escalation/credential upload/process control' },
      { surface: 'roleCommand/roleResult: claim, handoff.offer, handoff.accept, return, transfer, complete, arbitrate, split, role.memory.record', reason: 'trusted host executor ports bound to a real current claim/session; a personal-agent token is not an executor role credential' },
      { surface: '/, /workbench.js, /workbench.css, /workbench-native.js, /workbench-native.css, /workbench-fonts/*, /favicon.ico', reason: 'original UI/static assets, not Bot business APIs' },
      { surface: 'automatic cross-repository child repository selection and parent integration', reason: 'explicitly deferred; repository association API is implemented independently' },
      { surface: 'vendor-specific grok-bot/dots callback, OAuth/refresh and public user signup', reason: 'not implemented; external descriptor is unverified metadata, not an outbound adapter' },
    ],
  }
}

function workflowsForBots() {
  return [
    { id: 'human-provisions-independent-agent', actor: 'human', steps: ['auth-mode', 'platform-login OR auth-redeem OR private-local-operator-bootstrap', 'project-join OR project-create OR existing-project-membership', 'personal-agent-create', 'personal-agent-join', 'personal-agent-token-create', 'optional:personal-agent-delegation-set(mode=watch)'], tokenDelivery: 'private-out-of-band; raw token returned once; no secrets in URL/logs' },
    { id: 'safe-bot-consults-and-proposes', actor: 'personal-agent-safe', steps: ['auth-whoami', 'projects', 'development.query.roles', 'development.command.consultation.ask', 'development.query.consultation.get', 'personal-agent-propose-task'], approvalBoundary: 'human publishes proposal via development.command.proposal.publish; ordinary consultation never creates a Task' },
    { id: 'watch-bot-publishes-project-work', actor: 'personal-agent-watch', steps: ['auth-whoami', 'development.command.task.propose', 'development.query.command.receipt', 'development.query.task', 'development.command.task.run', 'development.query.events OR streamProjectEvents', 'development.query.task.detail'], completion: 'observe actual Chief adjudication and current evidence; enqueue/receipt/SDK completion never equals Task closure' },
    { id: 'chief-notifies-native-or-external-agent', actor: 'personal-agent', steps: ['receiveAgentInboxNotification OR existing-native-wake OR periodic-inbox-pull', 'development.query.inbox.list', 'development.command.inbox.claim', 'development.query.inbox.get', 'optional:development.command.inbox.renew', 'development.command.inbox.complete OR development.command.inbox.fail'], authority: 'notification-and-message-lease-grant-no-Task-initiative; safe-publication-awaits-human-approval', compensation: 'poll-same-private-mailbox; original-effects-retry-and-configured-Chief-inspection' },
    { id: 'recover-lost-command-response', actor: 'original-command-principal', steps: ['development.query.command.receipt', 'development.query.command.result', 'retry-original-command-with-identical-requestId-and-payload-only-if-contract-permits'], forbidden: ['new-requestId-for-same-unknown-external-write', 'replace-role-claim-from-event-notification'] },
  ]
}

export const artifactPath = resolve(root, 'docs/openapi/flybot.openapi.json')
export function renderSpec() { return JSON.stringify(buildSpec(), null, 2) + '\n' }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderSpec()
  if (process.argv.includes('--check')) {
    if (readFileSync(artifactPath, 'utf8') !== rendered) throw new Error('OpenAPI artifact is stale; run node scripts/openapi.mjs')
    console.log('OpenAPI source inventory and generated artifact match')
  } else { mkdirSync(dirname(artifactPath), { recursive: true }); writeFileSync(artifactPath, rendered); console.log(`Generated ${relative(root, artifactPath)}`) }
}
