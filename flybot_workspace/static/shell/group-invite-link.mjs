const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function groupInviteFromHash(hash) {
  return /^#group-invite=([A-Za-z0-9_-]{32})$/.exec(hash || '')?.[1] || '';
}

export function groupInviteHash(token) {
  return typeof token === 'string' && TOKEN.test(token) ? '#group-invite=' + token : '';
}

export function groupInviteUrl(token, origin) {
  const hash = groupInviteHash(token);
  return hash ? new URL('/login' + hash, origin).href : '';
}
