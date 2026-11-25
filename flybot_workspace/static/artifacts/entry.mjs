const ID = /^[0-9a-f]{32}$/;
const ROLES = new Set(['owner', 'admin', 'member']);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function isStudioTeam(team) {
  return team?.kind === 'team' && ID.test(team.id || '') && ROLES.has(team.role);
}

export function studioScope(team, account) {
  return account && isStudioTeam(team) ? {id:team.id, name:team.name, account} : null;
}

export function studioCopyCandidate({selection, item, workspaces}) {
  if (!selection || item?.kind !== 'document' || selection.workspace !== item.workspace_id ||
      !ID.test(item.id || '') ||
      !Number.isSafeInteger(item.revision) || item.revision < 1 ||
      typeof item.title !== 'string' || typeof item.body !== 'string') return null;
  const teams = (workspaces || []).filter(team => isStudioTeam(team) && typeof team.name === 'string' && team.name.trim());
  if (!teams.length) return null;
  const draft = {revision:item.revision, title:item.title.replace(/\s+/g, ' ').trim(), body:item.body};
  return {selection, item, teams, draft};
}

export function requestStudio(request, method, path, body, signal) {
  const timeout = AbortSignal.timeout(12000);
  return request(method, path, body, {signal:signal ? AbortSignal.any([signal, timeout]) : timeout})
    .catch(() => ({status:0, body:{}}));
}

export function preloadStudio(request, workspace, id, account) {
  if (!account || !ID.test(workspace || '') || (id !== undefined && !ID.test(id))) return null;
  const controller = new AbortController();
  const path = '/v1/workspaces/' + workspace + '/studio/documents' + (id ? '/' + id : '');
  const response = requestStudio(request, 'GET', path, undefined, controller.signal);
  return {workspace, id, account, controller, response};
}

export function sharedWorkCopyToken(hash) {
  const fragment = new URLSearchParams(String(hash || '').slice(1));
  const token = fragment.get('shared-work');
  return fragment.size === 1 && TOKEN.test(token || '') ? token : '';
}
