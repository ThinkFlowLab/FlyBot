// Workspace membership and its three roles (#3117).
//
// `workspace.members` is the only source of membership: `{ accountId, role, addedAt }`. This
// module is the one place that reads a role and the one place that adds a member, so a route
// never re-checks the shape of the array.
export const ROLES = ['owner', 'admin', 'member']

export class WorkspaceRoleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkspaceRoleError'
    this.code = code
  }
}

export function memberOf(workspace, accountId) {
  return (workspace?.members ?? []).find((member) => member.accountId === accountId) ?? null
}

export function roleOf(workspace, accountId) {
  return memberOf(workspace, accountId)?.role ?? null
}

export function canRead(workspace, accountId) {
  return roleOf(workspace, accountId) !== null
}

export function canAddMembers(workspace, accountId) {
  return ['owner', 'admin'].includes(roleOf(workspace, accountId))
}

// A workspace written before members existed gets its owner as the only member, never a
// rejection: refusing it would take down a plane that is already running.
export function seedMembers(workspace) {
  workspace.members ??= [{ accountId: workspace.ownerId, role: 'owner', addedAt: workspace.createdAt }]
  return workspace
}

export function withMember(workspace, { accountId, role } = {}, addedAt) {
  if (!ROLES.includes(role)) throw new WorkspaceRoleError('invalid_role', `unknown role ${role}`)
  if (memberOf(workspace, accountId)) throw new WorkspaceRoleError('member_exists', `${accountId} is already a member`)
  const member = { accountId, role, addedAt }
  workspace.members.push(member)
  return member
}
