// A workspace-only link opens its catalog; a saved-result link also opens the record.
export function artifactTargetFromSearch(search) {
  const params = new URLSearchParams(search || '');
  if (!params.has('workspace') && !params.has('artifact') && !params.has('revision')) return null;
  const id = /^[0-9a-f]{32}$/;
  const workspace = params.get('workspace');
  const artifact = params.get('artifact');
  const revision = params.get('revision');
  if ([...params.keys()].some(key => !['workspace', 'artifact', 'revision'].includes(key))
    || params.getAll('workspace').length !== 1 || !id.test(workspace || '')
    || (artifact !== null && (params.getAll('artifact').length !== 1 || !id.test(artifact)))
    || (revision !== null && (!artifact || params.getAll('revision').length !== 1 || !/^[1-9][0-9]{0,7}$/.test(revision)))) return {invalid: true};
  if (revision !== null) return {workspace, artifact, revision:Number(revision)};
  return artifact ? {workspace, artifact} : {workspace};
}

const unavailable = {status: 0, body: {}};
const workspaces = result =>
  result.status === 200 && Array.isArray(result.body?.items) ? result.body.items : [];

export function startSavedArtifactReads(read, workspace) {
  const get = path => read(path).catch(() => unavailable);
  const sessionRequest = get('/v1/auth/session');
  const shared = get('/v1/workspaces?limit=100');
  const personal = get('/v1/workspaces?scope=personal');
  const combined = Promise.all([personal, shared]).then(([local, teams]) => {
    const mine = workspaces(local);
    if (teams.status !== 200) return mine.length ? local : teams;
    const listed = workspaces(teams);
    const missing = mine.filter(item => !listed.some(other => other.id === item.id));
    return {...teams, body: {...teams.body, items: [...missing, ...listed]}};
  });
  // Either signed directory can confirm the exact workspace. An unrelated or
  // failed result must wait for the other directory before denying the link.
  const linkedDirectory = Promise.race([personal, shared]).then(async initial => {
    if (workspaces(initial).some(item => item.id === workspace)) {
      return {initial, supplemental: combined};
    }
    return {initial: await combined, supplemental: null};
  });
  return {sessionRequest, linkedDirectory};
}

let early;
const view = typeof window === 'undefined' ? null : window;
if (view?.document.querySelector('meta[name="flybot-workspace-instance"]')) {
  const {href, search} = view.location;
  const target = artifactTargetFromSearch(search);
  // These GETs already use the native gateway. The editor still waits for
  // both the signed session and confirmation of the selected workspace.
  const read = async path => {
    const response = await view.fetch(path, {credentials: 'same-origin', headers: {Accept: 'application/json'}});
    return {status: response.status, body: await response.json().catch(() => ({}))};
  };
  const reads = target?.artifact ? startSavedArtifactReads(read, target.workspace)
    : {sessionRequest: read('/v1/auth/session').catch(() => unavailable)};
  early = {document: view.document, href, ...reads};
}

export function takeSpaceStartup(document) {
  const requests = early;
  early = null;
  return requests && requests.document === document && requests.href === document.defaultView?.location.href ? requests : null;
}
