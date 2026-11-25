const CODE = /^[A-Za-z0-9_-]{24}$/;
const CALL_ID = /^otcav_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const WORKSPACE_ID = /^[a-f0-9]{32}$/;

export function isMeetingCallId(value) {
  return typeof value === 'string' && CALL_ID.test(value);
}

export function meetingDraftFromCallHref(callId, workspace) {
  if (!isMeetingCallId(callId)) return '';
  const params = new URLSearchParams();
  if (WORKSPACE_ID.test(workspace)) params.set('workspace', workspace);
  params.set('from-call', callId);
  return '/meetings#' + params;
}

export function meetingCodeFromHash(hash) {
  const code = new URLSearchParams(hash?.slice(1)).get('meeting');
  return typeof code === 'string' && CODE.test(code) ? code : '';
}

export function meetingHref(code) {
  return typeof code === 'string' && CODE.test(code) ? '/chat#meeting=' + code : '';
}

export function parseMeetingCode(value, origin) {
  const input = value.trim();
  if (CODE.test(input)) return input;
  try {
    const url = new URL(input, origin);
    return url.origin === origin && /^\/chat\/?$/.test(url.pathname) ? meetingCodeFromHash(url.hash) : '';
  } catch { return ''; }
}

const ARCHIVE = 'flybot-workspace.meeting-archive';
const MEETING_FOCUS = /^(?:meeting|shared):[a-f0-9]{32}$/;

export function meetingArchiveLocation(hash) {
  const params = new URLSearchParams(hash?.slice(1));
  const scope = params.get('meetingScope') === 'all' ? 'all' : 'joined';
  const focus = params.get('meetingFocus') || '';
  return {scope, focus: MEETING_FOCUS.test(focus) ? focus : ''};
}

export function meetingArchiveHref(workspace, {scope = 'joined', focus = ''} = {}) {
  if (!WORKSPACE_ID.test(workspace)) return '/space?view=meetings';
  const params = new URLSearchParams({workspace});
  if (scope === 'all') params.set('meetingScope', 'all');
  if (MEETING_FOCUS.test(focus)) params.set('meetingFocus', focus);
  return '/space?view=meetings#' + params;
}

export function saveMeetingArchive(view, {owner, workspace, scope, focus, depth}) {
  try {
    view?.sessionStorage.setItem(ARCHIVE, JSON.stringify({owner, workspace, scope, focus, depth}));
  } catch {}
}

export function meetingArchiveDepth(view, {owner, workspace, scope, focus}) {
  if (!WORKSPACE_ID.test(owner) || !WORKSPACE_ID.test(workspace) || !MEETING_FOCUS.test(focus)) return 0;
  try {
    const saved = JSON.parse(view?.sessionStorage.getItem(ARCHIVE));
    if (saved?.owner === owner && saved.workspace === workspace && saved.scope === scope && saved.focus === focus &&
        Number.isSafeInteger(saved.depth) && saved.depth > 0) return Math.min(480, saved.depth);
  } catch {}
  return 0;
}

const CHAT_DRAFT = 'flybot-workspace.meeting-draft-from-chat';

export function stageMeetingFromChat(storage, draft) {
  storage.setItem(CHAT_DRAFT, JSON.stringify(draft));
  return '/meetings#' + new URLSearchParams({workspace: draft.workspace, new: '1', from: 'chat'});
}

export function takeMeetingFromChat(storage, owner, workspace) {
  try {
    const raw = storage.getItem(CHAT_DRAFT);
    storage.removeItem(CHAT_DRAFT);
    const draft = JSON.parse(raw);
    if (draft?.owner === owner && draft.workspace === workspace
      && typeof draft.title === 'string' && draft.title.length <= 120
      && typeof draft.transcript === 'string' && draft.transcript.trim() && draft.transcript.length <= 40000) {
      return draft;
    }
  } catch {}
  return null;
}
