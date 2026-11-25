const publicFilters = ['tab', 'section', 'category', 'feed', 'kind', 'sort', 'q', 'creator', 'topic', 'work', 'comments', 'share'];

function discoverIntent(search) {
  const source = new URLSearchParams(search);
  const filters = new URLSearchParams();
  for (const key of publicFilters) {
    const value = source.get(key);
    if (value && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value)) filters.set(key, value);
  }
  const query = filters.toString();
  return {
    continuation: '#' + new URLSearchParams({discover: query}),
    target: '/discover' + (query ? '?' + query : ''),
  };
}

export function discoverLoginHref(search) {
  return '/login' + discoverIntent(search).continuation;
}

export function discoverIntentFromHash(hash) {
  if (typeof hash !== 'string' || hash.length > 2400) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.size !== 1 || !params.has('discover')) return null;
  return discoverIntent(params.get('discover'));
}
