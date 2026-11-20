// Public surface of @flybot/plane.
//
//   const plane = createPlane({ dataDir, backend })
//   const instance = await plane.createInstance({ workspaceId, name, ownerId })
//
// The plane owns metadata, ownership and credentials; a LifecycleBackend owns where the
// instance actually runs. This package starts no HTTP server and no container by itself —
// `server.mjs` is a pure router plus an opt-in node:http adapter, and the compose backend
// only writes files.
import { randomBytes } from 'node:crypto'
import { openStore, InstanceNotFoundError } from './src/store.mjs'
import { mintControlToken, hashToken } from './src/credentials.mjs'
import { MemoryBackend } from './src/lifecycle.mjs'
import { WorkspaceRoleError, canAddMembers, canRead, withMember } from './src/workspace-roles.mjs'

export { DuplicateInstanceError, InstanceNotFoundError, openStore } from './src/store.mjs'
export { ROLES, WorkspaceRoleError, canAddMembers, canRead, memberOf, roleOf } from './src/workspace-roles.mjs'
export { LifecycleBackend, MemoryBackend, ComposeBackend, NotImplementedError, hostPortFor } from './src/lifecycle.mjs'
export {
  mintOperatorToken,
  mintControlToken,
  verifyOperator,
  verifyControl,
  hashToken,
  redact,
} from './src/credentials.mjs'
export { handle, serve } from './src/server.mjs'

function assertNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`)
}

// The record the plane hands out: the control-token hash never leaves the store.
function publicRecord(record) {
  if (!record) return null
  const { controlTokenHash, ...rest } = record
  return rest
}

export function createPlane({ dataDir, store, backend = new MemoryBackend(), clock = () => Date.now() } = {}) {
  const theStore = store ?? (dataDir ? openStore(dataDir) : null)
  if (!theStore) throw new TypeError('createPlane needs a dataDir or a store')
  const now = () => new Date(clock()).toISOString()

  function applyOutcome(id, outcome) {
    const patch = { updatedAt: now() }
    if (outcome?.state) patch.state = outcome.state
    if (outcome?.health) patch.health = outcome.health
    if (outcome?.hostPort !== undefined) patch.hostPort = outcome.hostPort
    if (outcome?.composePath !== undefined) patch.composePath = outcome.composePath
    return publicRecord(theStore.updateInstance(id, patch))
  }

  // A workspace id is owner-scoped, so two owners both have a "ws-1": pick the candidate the
  // caller has the role for. No candidate is a missing workspace; candidates it cannot enter are
  // forbidden, so a member of somebody else's workspace learns nothing about it.
  function workspaceFor(workspaceId, actorId, allowed) {
    const candidates = theStore.workspacesWithId(workspaceId)
    if (candidates.length === 0) throw new WorkspaceRoleError('workspace_not_found', `no workspace ${workspaceId}`)
    const workspace = candidates.find((candidate) => allowed(candidate, actorId))
    if (!workspace) throw new WorkspaceRoleError('forbidden', `not a member of workspace ${workspaceId}`)
    return workspace
  }

  // The actor always comes from the verified account, never from the request body.
  function listWorkspaceMembers(workspaceId, actorId) {
    const workspace = workspaceFor(workspaceId, actorId, canRead)
    return workspace.members.map((member) => ({ ...member }))
  }

  function addWorkspaceMember(workspaceId, actorId, { accountId, role } = {}) {
    const workspace = workspaceFor(workspaceId, actorId, canAddMembers)
    if (!theStore.getAccount(accountId)) throw new WorkspaceRoleError('account_not_found', `no account ${accountId}`)
    const member = withMember(workspace, { accountId, role }, now())
    theStore.updateWorkspaceMembers(workspace, workspace.members)
    return { ...member }
  }

  async function createInstance({ workspaceId, name, ownerId } = {}) {
    assertNonEmpty(workspaceId, 'workspaceId')
    assertNonEmpty(name, 'name')
    assertNonEmpty(ownerId, 'ownerId')

    const createdAt = now()
    theStore.ensureWorkspace({ id: workspaceId, ownerId, createdAt })

    const controlToken = mintControlToken()
    const record = {
      id: `inst_${randomBytes(8).toString('hex')}`,
      ownerId,
      workspaceId,
      name,
      state: 'stopped',
      health: 'unknown',
      createdAt,
      updatedAt: createdAt,
      controlTokenHash: hashToken(controlToken),
    }
    theStore.insertInstance(record)

    const outcome = await backend.create(publicRecord(record), { controlToken })
    const instance = applyOutcome(record.id, outcome)
    // The plaintext control token is returned exactly once, to the caller that created it.
    return { ...instance, controlToken }
  }

  async function startInstance(id) {
    const record = theStore.getInstance(id)
    if (!record) throw new InstanceNotFoundError(id)
    const outcome = await backend.start(publicRecord(record))
    return applyOutcome(id, outcome)
  }

  async function stopInstance(id) {
    const record = theStore.getInstance(id)
    if (!record) throw new InstanceNotFoundError(id)
    const outcome = await backend.stop(publicRecord(record))
    return applyOutcome(id, outcome)
  }

  function getInstance(id) {
    return publicRecord(theStore.getInstance(id))
  }

  function listInstances(ownerId) {
    return theStore.listInstances(ownerId).map(publicRecord)
  }

  return {
    createInstance, startInstance, stopInstance, getInstance, listInstances,
    listWorkspaceMembers, addWorkspaceMember,
  }
}
