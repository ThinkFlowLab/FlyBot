import { refuse } from '../../featurekit/http.js'

const ID = /^[0-9a-f]{32}$/
const pendingMemberships = new WeakMap()

export async function personalMemoryWorkspace(host) {
  try {
    const binding = await host.call('agents/personal-binding', {})
    return ID.test(binding?.workspace_id || '') ? binding.workspace_id : null
  } catch {
    return null
  }
}

export async function sharedMemoryWorkspaces(host) {
  let pending = pendingMemberships.get(host)
  if (!pending) {
    // Concurrent library, editor, and recall reads can share the same check.
    // Once it settles, later reads must consult the current membership again.
    pending = Promise.resolve()
      .then(() => host.call('teams/activeWorkspaces', {}))
      .then(rows => Array.isArray(rows) ? rows.filter(team => ID.test(team?.id || '')) : [])
      .catch(() => [])
      .finally(() => pendingMemberships.delete(host))
    pendingMemberships.set(host, pending)
  }
  return pending
}

export async function requireMemoryWorkspace(host, workspace) {
  if (await personalMemoryWorkspace(host) === workspace) return
  const active = await sharedMemoryWorkspaces(host)
  if (!active.some(team => team.id === workspace)) refuse(404, 'not_found', '无法访问此工作区。')
}
