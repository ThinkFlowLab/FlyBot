const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const INDEX = /^[0-4]$/;
const VERSION = /^[a-f0-9]{64}$/;
const DRAFT = /^[a-f0-9]{32}$/;
const LISTING = /^otl_[0-9A-HJKMNP-TV-Z]{26}$/;
const ALLOWED = new Set(['public-agent', 'quick-start', 'quick-start-version', 'draft']);
const DRAFT_PREFIX = 'flybot-workspace.public-agent-opening:';
const DRAFT_TTL = 15 * 60_000;
export const PUBLIC_AGENT_MESSAGE_LIMIT = 4000;

export function publicAgentIntentFromHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const slug = params.get('public-agent');
  if (!SLUG.test(slug || '') || [...params.keys()].some(key => !ALLOWED.has(key) || params.getAll(key).length !== 1)) return null;
  const index = params.get('quick-start');
  const version = params.get('quick-start-version');
  const draft = params.get('draft');
  if (draft !== null) return index === null && version === null && DRAFT.test(draft) ? {slug, draft} : null;
  if (index === null && version === null) return {slug};
  if (!INDEX.test(index || '') || !VERSION.test(version || '')) return null;
  return {slug, quickStart: Number(index), version};
}

export function publicAgentContinuation(intent) {
  if (!intent || !SLUG.test(intent.slug || '')) return '';
  const params = new URLSearchParams({'public-agent': intent.slug});
  if (intent.draft !== undefined) {
    if (intent.quickStart !== undefined || intent.version !== undefined || !DRAFT.test(intent.draft)) return '';
    params.set('draft', intent.draft);
  }
  if (intent.quickStart !== undefined) {
    if (!Number.isInteger(intent.quickStart) || !INDEX.test(String(intent.quickStart)) || !VERSION.test(intent.version || '')) return '';
    params.set('quick-start', String(intent.quickStart));
    params.set('quick-start-version', intent.version);
  }
  return '#' + params;
}

function validOpeningText(text) {
  return typeof text === 'string' && text.length <= PUBLIC_AGENT_MESSAGE_LIMIT && Boolean(text.trim());
}

export function stagePublicAgentOpening(view, {slug, listingId, text}) {
  if (typeof slug !== 'string' || !SLUG.test(slug) || typeof listingId !== 'string' || !LISTING.test(listingId)
      || !validOpeningText(text)) return '';
  try {
    const storage = view.sessionStorage;
    const now = Date.now();
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(DRAFT_PREFIX) && !readOpening(storage, key, now)) storage.removeItem(key);
    }
    const bytes = view.crypto.getRandomValues(new Uint8Array(16));
    const draft = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    storage.setItem(DRAFT_PREFIX + draft, JSON.stringify({slug, listingId, text, expiresAt: now + DRAFT_TTL}));
    return publicAgentContinuation({slug, draft});
  } catch {
    return '';
  }
}

function readOpening(storage, key, now) {
  try {
    const row = JSON.parse(storage.getItem(key));
    if (typeof row?.slug === 'string' && SLUG.test(row.slug)
        && typeof row.listingId === 'string' && LISTING.test(row.listingId) && validOpeningText(row.text)
        && Number.isSafeInteger(row.expiresAt) && row.expiresAt > now && row.expiresAt <= now + DRAFT_TTL) return row;
  } catch {}
  return null;
}

export function publicAgentOpening(view, intent) {
  if (!DRAFT.test(intent?.draft || '')) return null;
  try {
    const storage = view.sessionStorage;
    const key = DRAFT_PREFIX + intent.draft;
    const row = readOpening(storage, key, Date.now());
    if (!row) storage.removeItem(key);
    return row?.slug === intent.slug ? row : null;
  } catch {
    return null;
  }
}

export function consumePublicAgentOpening(view, intent) {
  if (!publicAgentOpening(view, intent)) return;
  try { view.sessionStorage.removeItem(DRAFT_PREFIX + intent.draft); } catch {}
}
