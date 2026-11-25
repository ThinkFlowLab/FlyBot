const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export function publicWorkIntentFromHash(hash) {
  const params = [...new URLSearchParams(String(hash || '').replace(/^#/, ''))];
  if (params.length !== 1) return null;
  const [[key, slug]] = params;
  if (!SLUG.test(slug) || !['work-comments', 'work-detail'].includes(key)) return null;
  const panel = key === 'work-comments' ? 'comments' : 'share';
  return {slug, continuation: '#' + new URLSearchParams({[key]: slug}),
    target: '/discover?' + new URLSearchParams({work: slug, [panel]: '1'}), panel};
}
