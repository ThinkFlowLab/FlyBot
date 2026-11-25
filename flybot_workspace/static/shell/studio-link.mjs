const idPattern = /^[0-9a-f]{32}$/;

export function studioDocumentHref(workspace, id, revision) {
  if (!idPattern.test(workspace || '') || !idPattern.test(id || '')) return '';
  const params = new URLSearchParams({workspace, studio:id});
  if (revision !== undefined) {
    if (!Number.isSafeInteger(revision) || revision < 1) return '';
    params.set('studio_revision', revision);
  }
  return '/space?' + params;
}

export function studioDocumentFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const workspace = params.get('workspace'), id = params.get('studio');
  const rawRevision = params.get('studio_revision');
  if (rawRevision === null) return params.size === 2 && studioDocumentHref(workspace, id) ? {workspace,id} : null;
  const revision = Number(rawRevision);
  return params.size === 3 && /^[1-9][0-9]{0,15}$/.test(rawRevision) && studioDocumentHref(workspace, id, revision)
    ? {workspace,id,revision} : null;
}

export function studioDocumentHrefInMessage(text, origin) {
  if (!origin || typeof text !== 'string' || !text.includes('studio=')) return '';
  for (const match of text.matchAll(/(?:^|\s)(https?:\/\/[^\s<>"']+|\/(?:space|artifacts)\?[^\s<>"']+)/gu)) {
    let url;
    try { url = new URL(match[1].replace(/[.,;!?)。，；！）]+$/u, ''), origin); } catch { continue; }
    if (url.origin !== origin || url.username || url.password || url.hash ||
        !['/space','/artifacts'].includes(url.pathname)) continue;
    const reference = studioDocumentFromSearch(url.search);
    if (reference) return studioDocumentHref(reference.workspace, reference.id, reference.revision);
  }
  return '';
}
