// Trust metadata is not an authorization token or an OS sandbox claim.
import { projectGithubStatus, githubConfigurationStatus } from './project-github-connections.js'
import { ownEntry } from './store.js'
import { repositoryReadiness } from './project-repository-policy.js'
import { executionProfile } from './project-execution-profile.js'
const credential = githubConfigurationStatus
export async function executionBoundary(rt, body, actor) {
  const project = rt.requireProjectAccess(actor, body.projectId)
  const binding = [project.repository, project.ownerUserId]
  if (rt.validateHumanActor && !await rt.validateHumanActor(actor)) throw Object.assign(new Error('Execution boundary principal is unavailable'), { code: 'bot/forbidden' })
  rt.requireProjectAccess(actor, body.projectId)
  const task = body.taskId === undefined ? undefined : ownEntry(rt.state.tasks, body.taskId)
  if (body.taskId !== undefined && (!task || task.projectId !== project.id)) throw Object.assign(new Error('Task belongs to another Project'), { code: 'bot/forbidden' })
  let profile
  try { profile = executionProfile(rt.config) } catch (error) { profile = { id: null, status: 'unsupported', reason: error.message, hostileCodeIsolation: false, perBotOsIdentityRequired: false } }
  const readiness = await repositoryReadiness(rt, project)
  rt.requireProjectAccess(actor, body.projectId)
  if (rt.validateHumanActor && !await rt.validateHumanActor(actor)) throw Object.assign(new Error('Execution boundary principal was revoked'), { code: 'bot/forbidden' })
  const current = rt.requireProjectAccess(actor, body.projectId)
  if (current.repository !== binding[0] || current.ownerUserId !== binding[1] || task && (ownEntry(rt.state.tasks, task.id) !== task || task.projectId !== current.id)) throw Object.assign(new Error('Execution boundary Project or Task binding changed'), { code: 'bot/conflict' })
  const privateAgentId = rt.projectAgents.privateIdentity(project.id, actor.memberId)
  const delegation = rt.projectDelegations.view(privateAgentId)
  delegation.effective = false
  if (delegation.mode === 'watch') {
    try { rt.projectDelegations.validateGrant({ ...actor, watchGrantId: delegation.grant.id, watchGeneration: delegation.grant.generation }); delegation.effective = true }
    catch { delegation.reason = 'Recorded watch grant no longer matches the current human principal' }
  }
  const settings = projectGithubStatus(rt, project)
  const personal = ownEntry(ownEntry(rt.config.personalGithub ?? {}, actor.memberId) ?? {}, project.id)
  return { version: 'project-execution-boundary/v1', projectId: project.id, memberId: actor.memberId, profile,
    host: { uid: process.getuid?.() ?? null, identityScope: 'host runtime only; resource transport may select a different explicit UID', dedicatedAccount: 'operator responsibility, not inferred from numeric UID' },
    permissions: Object.fromEntries(['read', 'create', 'configure', 'manage', 'invite', 'run-control', 'accept', 'task-write'].map(action => [action, rt.projectCan(actor, project.id, action, task)])),
    taskScope: task?.id ?? null, delegation,
    resources: rt.projectResources.list(project.id, actor).map(row => ({ id: row.id, type: row.type, capacity: row.capacity, harnesses: row.harnesses, health: { status: row.health.status, at: row.health.at }, harnessStatus: row.harnessStatus.map(({ harness, status, at }) => ({ harness, status, at: at ?? null })) })),
    credentials: { project: settings, personal: credential(personal?.credential === 'github-app' ? undefined : personal), fallback: 'none', harnessPrincipalId: project.ownerUserId },
    preflight: { ...readiness, tests: 'not-run', sdk: 'not-run', credentials: 'configuration-only', backgroundPrincipal: !rt.state.members[actor.memberId]?.platform ? 'local-member' : rt.config.controlPlane?.principalCheckCommand ? 'configured-checker; validated per background operation' : 'live-session-only; unattended execution needs operator principal checker' },
    memory: { public: 'explicit shared Project/public Bot memory', private: 'original current-human private-agent APIs only', contentsRead: false, inheritedIntoPublicContext: false },
    invariants: ['current Project/delegation/resource authorization', 'exclusive registered workspace ownership', 'lease and generation fencing', 'confirmed previous worker exit', 'exact candidate host tests and independent role Review', 'Chief adjudication'],
    evidence: 'read-only metadata; does not grant execution, credential access, approval or candidate acceptance' }
}
export function install(rt) { rt.projectExecutionBoundary = (body, actor) => executionBoundary(rt, body, actor) }
