export function chatStartFromHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  return Object.fromEntries(['workspace', 'agent', 'conversation', 'message', 'social']
    .map(key => [key, params.get(key) || '']));
}

export function startChatReads(read, start, allowLocal) {
  const sessionRequest = read('/v1/auth/session');
  const params = new URLSearchParams({scope: 'personal', include: 'chat'});
  if (start.workspace) params.set('workspace', start.workspace);
  const id = /^[a-f0-9]{32}$/;
  if (start.social && id.test(start.workspace)) params.set('directory', '0');
  if (!start.social && id.test(start.workspace) && id.test(start.agent) && (!start.conversation || id.test(start.conversation))) {
    // A message link opens its own history window after the workspace is verified.
    if (!start.conversation || !id.test(start.message)) {
      params.set('entry_agent', start.agent);
      if (start.conversation) params.set('entry_conversation', start.conversation);
    }
    if (start.conversation) params.set('directory', '0');
  }
  const localRequest = allowLocal ? read('/v1/workspaces?' + params, AbortSignal.timeout(2200)) : null;
  return {sessionRequest, localRequest};
}

export function ownedChatStartup(result, user) {
  const body = result?.body;
  const space = body?.items?.length === 1 ? body.items[0] : null;
  if (result?.status !== 200 || !user?.id || space?.kind !== 'personal'
    || !/^[0-9a-f]{32}$/.test(space.id) || !/^[0-9a-f]{32}$/.test(body.personal_agent_id)) return null;
  const viewer = body.viewer_username;
  if ((!space.owner_id && !viewer) || (space.owner_id && space.owner_id !== user.id)
    || (viewer && viewer !== user.username)) return null;
  const directory = body.chat;
  return {space, agentId: body.personal_agent_id, entry: body.entry,
    directory: Array.isArray(directory?.items) && Array.isArray(directory?.conversations) ? directory : null};
}

export const startupTranscriptAge = 1800;
export const historyPageSize = '50';

async function prepareDesktopTranscript(read, {sessionRequest, localRequest}) {
  const [session, personal] = await Promise.all([sessionRequest, localRequest]);
  if (session.status !== 200) return null;
  const user = session.body?.user;
  const local = ownedChatStartup(personal, user);
  if (!local?.directory) return null;
  const id = /^[0-9a-f]{32}$/;
  const workspace = local.space.id;
  const active = new Set(local.directory.items.filter(agent => id.test(agent?.id || '') &&
    agent.workspace_id === workspace && !agent.archived && !agent.native_deleted).map(agent => agent.id));
  let first;
  for (const row of local.directory.conversations) {
    if (!id.test(row?.id || '') || !active.has(row.agent_id) || row.archived === true) continue;
    if (!first || (row.updated || 0) > (first.updated || 0)) first = row;
  }
  if (!first) return null;
  const path = `/v1/workspaces/${workspace}/agents/${first.agent_id}/conversations/${first.id}?limit=${historyPageSize}&snapshot=1`;
  const expires = performance.now() + startupTranscriptAge;
  return {owner: user.id, workspace, agent: first.agent_id, conversation: first.id, expires,
    result: read(path, AbortSignal.timeout(startupTranscriptAge))};
}

function fitChatToKeyboard(view) {
  const {document, visualViewport: viewport} = view;
  if (!viewport || !view.matchMedia?.('(any-pointer: coarse)').matches) return;
  const root = document.documentElement;
  let frame = 0;
  let fitted = false;
  function update() {
    frame = 0;
    const editing = document.activeElement?.matches('textarea, input, [contenteditable]:not([contenteditable="false"])');
    // Some touch browsers pan the visible viewport above the keyboard while
    // the layout viewport and its viewport units keep their original height.
    const keyboard = viewport.height > 0 && root.clientHeight - viewport.height > 80 &&
      Math.abs(viewport.scale - 1) < .01 && (editing || fitted);
    if (keyboard) {
      root.style.setProperty('--chat-viewport-height', Math.floor(viewport.height) + 'px');
      root.style.setProperty('--chat-viewport-top', Math.max(0, Math.floor(viewport.offsetTop)) + 'px');
      if (!fitted) root.setAttribute('data-chat-keyboard', '');
    } else if (fitted) {
      root.removeAttribute('data-chat-keyboard');
      root.style.removeProperty('--chat-viewport-height');
      root.style.removeProperty('--chat-viewport-top');
    }
    fitted = keyboard;
  }
  const schedule = () => { if (!frame) frame = view.requestAnimationFrame(update); };
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  document.addEventListener('focusin', schedule);
  schedule();
}

const startupKey = Symbol.for('flybot-workspace.chat.initial-reads');
const view = typeof window === 'undefined' ? null : window;
const previous = view?.document[startupKey];
if (view && !previous) fitChatToKeyboard(view);
if (view?.document.querySelector('meta[name="flybot-workspace-instance"]') && previous?.href !== view.location.href) {
  const {href, hash, search} = view.location;
  // The gateway can start account and private history reads while Chat loads.
  const read = async (path, signal) => {
    try {
      const response = await view.fetch(path, {credentials: 'same-origin', headers: {Accept: 'application/json'}, signal});
      return {status: response.status, body: await response.json().catch(() => ({}))};
    } catch {
      return {status: 0, body: {}};
    }
  };
  const openingPublicAgent = new URLSearchParams(hash.replace(/^#/, '')).has('public-agent');
  const target = chatStartFromHash(hash);
  const reads = startChatReads(read, target, !openingPublicAgent);
  // The current runtime authenticates this directory independently of the UI.
  // Opening a saved workspace conversation still waits for both results.
  const sharedRequest = !openingPublicAgent && /^[0-9a-f]{32}$/.test(target.workspace)
    && (target.social || (target.agent && target.conversation))
    ? read('/v1/workspaces?limit=100', AbortSignal.timeout(4000)) : null;
  // Desktop can read its private candidate before the main module finishes.
  // The app later chooses between that thread and the shared conversation list.
  const desktopTranscript = !hash && !search && view.matchMedia?.('(min-width: 901px)').matches
    ? prepareDesktopTranscript(read, reads) : null;
  // The inline entry and the imported module share the same native requests.
  view.document[startupKey] = {href, requests: {...reads, sharedRequest, desktopTranscript}};
}

export function takeChatReads(document) {
  const entry = document[startupKey];
  if (!entry || entry.href !== document.defaultView?.location.href) return null;
  const {requests} = entry;
  entry.requests = null;
  return requests;
}
