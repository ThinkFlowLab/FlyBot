const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function teamInviteFromHash(hash) {
  return /^#team-invite=([A-Za-z0-9_-]{16,128})$/.exec(hash || '')?.[1] || '';
}

export function teamInviteHash(token) {
  return typeof token === 'string' && TOKEN.test(token) ? '#team-invite=' + token : '';
}

export function teamInviteUrl(token, origin) {
  const hash = teamInviteHash(token);
  return hash && origin ? new URL('/login' + hash, origin).href : '';
}

export function teamInviteCode(input, origin) {
  if (typeof input !== 'string') return '';
  const value = input.trim();
  if (TOKEN.test(value)) return value;
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname === '/login' && !url.search && !url.username && !url.password
      ? teamInviteFromHash(url.hash) : '';
  } catch {
    return '';
  }
}
