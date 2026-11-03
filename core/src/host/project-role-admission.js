// Initial routing is a durable choice, separate from an active role Session.
const fail = message => Object.assign(new Error(message), { code: 'bot/handoff' })
export function initialRoleTarget(rt, task, body = {}) {
  if (rt.config.projectDispatch === 'workflow' || !rt.projectAgents?.deliveryDefinitions) return undefined
  const catalog = rt.projectAgents.deliveryDefinitions(task.projectId)
  const revision = task.projectTask?.requirements.revision ?? null
  const pinned = body.initialTarget
  if (pinned && (pinned.definitionRevision !== catalog.revision || pinned.requirementsRevision !== revision)) throw fail('Initial role catalog or Task requirements changed; explicitly select a target again')
  const requested = body.targetRole ?? pinned?.role
  if (requested !== undefined && (typeof requested !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(requested))) throw fail('Invalid initial targetRole')
  const candidates = catalog.roles.filter(row => (row.policyRole ?? row.role) === 'developer')
  const target = requested ? catalog.roles.find(row => row.role === requested) : candidates.find(row => row.role === 'developer') ?? (candidates.length === 1 ? candidates[0] : null)
  if (!target || target.role === 'chief') throw fail('An active initial role is required; provide an explicit targetRole when developer capabilities are ambiguous')
  const result = { role: target.role, botId: target.id, policyRole: target.policyRole ?? target.role, definitionRevision: catalog.revision, requirementsRevision: revision }
  if (pinned && Object.keys(result).some(key => result[key] !== pinned[key])) throw fail('Initial role selection changed; explicitly select a target again')
  return result
}
