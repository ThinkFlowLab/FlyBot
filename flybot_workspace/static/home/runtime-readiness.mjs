export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

const signupSessionKey = 'ot-expected-signup-session';
const signupLifetimeMs = 5 * 60 * 1000;
const platformUserId = /^[0-9a-f]{32}$/;
const accountDraftPrefix = 'flybot-workspace.chat-drafts:';
const coldDraftHandoffKey = 'flybot-workspace.cold-chat-draft';
const signupChatPath = /^\/chat#workspace=([a-f0-9]{32})&agent=([a-f0-9]{32})$/;
const messageLimit = 4000;
export const signupSessionError = '账户已创建，但登录会话尚未确认。请使用本实例 HTTPS 地址，允许同源 Cookie，然后尝试登录；不要重复注册。';
export function runtimeHoldNotice(state) {
  if (state === 'capacity') {
    return {
      title: '专属智能体名额已满',
      detail: '你的账户已登录。请联系管理员处理容量，容量恢复后点击重新检查即可继续。',
    };
  }
  if (state === 'parked') {
    return {
      title: '专属智能体已暂停',
      detail: '你的数据仍保留。请联系管理员恢复，恢复后点击重新检查即可继续。',
    };
  }
}
const validSignupUser = id => typeof id === 'string' && platformUserId.test(id);

const workspacePage = /^\/(?:agents|artifacts|automations|chat|contacts|meetings|members|memory|messenger|onboarding|profile|settings|skills|team|team-runs)\/?$/;
const workspaceSubpage = /^\/(?:profile\/edit|settings\/[a-z0-9][a-z0-9-]{0,40})\/?$/;

export function workspacePageTarget({pathname, search = '', hash = ''} = {}) {
  if (pathname !== '/space' && !workspacePage.test(pathname) && !workspaceSubpage.test(pathname)) return '';
  const target = pathname + search + hash;
  return target.length <= 8192 ? target : '';
}

export function workspaceLoginHash(target) {
  return target ? '#resume=' + encodeURIComponent(target) : '';
}

export function workspaceLoginTarget(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const value = params.get('resume');
  if (!value || value.length > 8192 || params.size !== 1) return '';
  try {
    const url = new URL(value, 'https://workspace.invalid');
    return workspacePageTarget(url) === value ? value : '';
  } catch {
    return '';
  }
}

export function rememberSignupSession(view, id, now = Date.now(), chat = '') {
  if (!validSignupUser(id)) return false;
  try {
    if (!view?.sessionStorage) return false;
    view.sessionStorage.setItem(signupSessionKey, JSON.stringify({
      id, expires: now + signupLifetimeMs, ...(signupChatPath.test(chat) ? {chat} : {}),
    }));
    return true;
  } catch {
    return false;
  }
}

function signupSession(view, now, consume = false) {
  try {
    const stored = view?.sessionStorage?.getItem(signupSessionKey);
    if (!stored) return null;
    if (consume) view.sessionStorage.removeItem(signupSessionKey);
    const value = JSON.parse(stored);
    const {id, expires} = value;
    return validSignupUser(id)
      && Number.isFinite(expires) && expires > now && expires <= now + signupLifetimeMs ? value : null;
  } catch {
    return null;
  }
}

export function pendingSignupSession(view, now = Date.now(), {consume = false} = {}) {
  return signupSession(view, now, consume)?.id ?? null;
}

export function signupDraftScope(view, owner, now = Date.now()) {
  const session = signupSession(view, now);
  if (!owner || session?.id !== owner || session.chat !== '/chat' + view.location.hash) return null;
  const target = signupChatPath.exec(session.chat);
  return target ? JSON.stringify([owner, target[1], 'agent', target[2], null]) : null;
}

export function personalChatPath(personal) {
  const workspace = personal?.workspace_id, agent = personal?.agent_id;
  return validSignupUser(workspace) && validSignupUser(agent) ? '/chat#workspace=' + workspace + '&agent=' + agent : '';
}

export function personalDraftScope(view, owner, personal, {allowBare = false} = {}) {
  if (!validSignupUser(owner) || view.location.search) return null;
  const path = personalChatPath(personal);
  if (!path || ('/chat' + view.location.hash !== path && !(allowBare && !view.location.hash))) return null;
  return JSON.stringify([owner, personal.workspace_id, 'agent', personal.agent_id, null]);
}

export function rememberColdDraftHandoff(view, scope) {
  try {
    const storage = view?.sessionStorage;
    if (!storage) return false;
    storage.setItem(coldDraftHandoffKey, scope);
    return true;
  } catch { return false; }
}

export function takeColdDraftHandoff(view, scope) {
  try {
    const storage = view?.sessionStorage;
    if (!scope || storage?.getItem(coldDraftHandoffKey) !== scope) return null;
    storage.removeItem(coldDraftHandoffKey);
    return scope;
  } catch { return null; }
}

export function chatDraftOwner(scope) {
  try {
    const [owner, workspace, kind, agent, conversation] = JSON.parse(scope);
    if (typeof owner !== 'string' || !owner || typeof workspace !== 'string' || !workspace) return null;
    if (kind === 'agent' && typeof agent === 'string' && agent) return owner;
    if (kind === 'social' && typeof conversation === 'string' && conversation) return owner;
  } catch {}
  return null;
}

function storedChatDrafts(view, owner) {
  try {
    const stored = JSON.parse(view?.sessionStorage?.getItem(accountDraftPrefix + owner) || '{}');
    return new Map(Object.entries(stored || {}).filter(([scope]) => chatDraftOwner(scope) === owner));
  } catch {}
  return new Map();
}

function saveChatDrafts(view, owner, drafts) {
  try {
    const storage = view?.sessionStorage;
    if (!storage) return false;
    const name = accountDraftPrefix + owner;
    if (drafts.size) storage.setItem(name, JSON.stringify(Object.fromEntries(drafts)));
    else storage.removeItem(name);
    return true;
  } catch { return false; }
}

function chatDraftBody(value) {
  const body = typeof value === 'string' ? value : value?.body;
  return typeof body === 'string' && body.length <= messageLimit ? body : '';
}

function chatDraftMentions(value) {
  return Array.isArray(value?.agentMentions) ? value.agentMentions.slice(0, 20).filter(target =>
    typeof target?.owner_id === 'string' && target.owner_id.length > 0 && target.owner_id.length <= 128 &&
    typeof target?.agent_id === 'string' && target.agent_id.length > 0 && target.agent_id.length <= 128)
    .map(({owner_id, agent_id}) => ({owner_id, agent_id})) : [];
}

const pendingTextKey = /^[A-Za-z0-9_-]{16,64}$/;
const pendingSocialId = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/;
const validPendingTextKey = (key,source) => typeof key === 'string' && pendingTextKey.test(key) &&
  (source !== 'first-agent' || key.startsWith('chat-'));

function pendingTextScope(scope) {
  try {
    const target = JSON.parse(scope);
    if (!Array.isArray(target) || target.length !== 5) return null;
    const [owner, workspace, source, agent, conversation] = target;
    if (!validSignupUser(owner) || !validSignupUser(workspace)) return null;
    if (source === 'agent' && validSignupUser(agent) && conversation === null) return {owner,source:'first-agent'};
    if (source === 'agent' && validSignupUser(agent) && validSignupUser(conversation)) return {owner,source};
    if (source === 'social' && agent === null && typeof conversation === 'string' && pendingSocialId.test(conversation)) {
      return {owner,source};
    }
    return null;
  } catch { return null; }
}

function pendingTextMessage(value, source) {
  const body = chatDraftBody(value);
  if (!body.trim() || typeof value !== 'object' || value.sticker_id) return null;
  const payload = {body};
  if (value.reply_to !== undefined) {
    if (source !== 'social' || typeof value.reply_to !== 'string' || !pendingSocialId.test(value.reply_to)) return null;
    payload.reply_to = value.reply_to;
  }
  if (typeof value.chat_language === 'string' && value.chat_language.length <= 64) {
    payload.chat_language = value.chat_language;
  }
  if (source === 'first-agent' && ['off','workspace','workspaces'].includes(value.memory_scope)) {
    payload.memory_scope = value.memory_scope;
  }
  if (value.agent_mentions !== undefined) {
    const targets = chatDraftMentions({agentMentions:value.agent_mentions});
    if (!Array.isArray(value.agent_mentions) || targets.length !== value.agent_mentions.length) return null;
    payload.agent_mentions = targets;
  }
  if (value.direct_agent_request === true && payload.agent_mentions?.length) payload.direct_agent_request = true;
  return payload;
}

function chatDraftPendingText(value, source) {
  const rows = value?.pendingText ?? value?.pendingPrivateText;
  if (!source || !Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    const message = pendingTextMessage(row?.message, source);
    return message && validPendingTextKey(row.key,source) ? [{key:row.key,message}] : [];
  });
}

function chatDraftRecord(body, agentMentions, pendingText) {
  if (!agentMentions.length && !pendingText.length) return body;
  return {body, ...(agentMentions.length ? {agentMentions} : {}), ...(pendingText.length ? {pendingText} : {})};
}

export function readChatDrafts(view, owner) {
  const drafts = new Map();
  for (const [scope, value] of storedChatDrafts(view, owner)) {
    const body = chatDraftBody(value);
    if (body) drafts.set(scope, body);
  }
  return drafts;
}

export function writeChatDrafts(view, owner, drafts) {
  const records = new Map(drafts);
  for (const [scope, value] of storedChatDrafts(view, owner)) {
    const agentMentions = chatDraftMentions(value);
    const pendingText = chatDraftPendingText(value, pendingTextScope(scope)?.source);
    if (agentMentions.length || pendingText.length) {
      records.set(scope, chatDraftRecord(records.get(scope) || '', agentMentions, pendingText));
    }
  }
  return saveChatDrafts(view, owner, records);
}

export function readChatDraftMentions(view, scope) {
  return chatDraftMentions(storedChatDrafts(view, chatDraftOwner(scope)).get(scope));
}

export function writeChatDraftMentions(view, scope, agentMentions) {
  const owner = chatDraftOwner(scope);
  if (!owner) return;
  const drafts = storedChatDrafts(view, owner);
  const previous = drafts.get(scope);
  const updated = chatDraftRecord(chatDraftBody(previous), agentMentions,
    chatDraftPendingText(previous, pendingTextScope(scope)?.source));
  if (updated) drafts.set(scope, updated);
  else drafts.delete(scope);
  saveChatDrafts(view, owner, drafts);
}

export function readPendingChatText(view, scope) {
  const target = pendingTextScope(scope);
  return target ? chatDraftPendingText(storedChatDrafts(view, target.owner).get(scope), target.source) : [];
}

export function savePendingChatText(view, scope, key, message) {
  const target = pendingTextScope(scope);
  if (!target || !validPendingTextKey(key,target.source)) return false;
  const {owner,source} = target;
  const payload = message && pendingTextMessage(message, source);
  if (message && !payload) return false;
  const drafts = storedChatDrafts(view, owner);
  const previous = drafts.get(scope);
  const rows = new Map(chatDraftPendingText(previous, source).map(row => [row.key, row]));
  if (payload) rows.set(key, {key,message:payload});
  else if (!rows.delete(key)) return true;
  const updated = chatDraftRecord(chatDraftBody(previous), chatDraftMentions(previous), [...rows.values()]);
  if (updated) drafts.set(scope, updated);
  else drafts.delete(scope);
  return saveChatDrafts(view, owner, drafts);
}

export function takeSignupSession(view, now = Date.now()) {
  return pendingSignupSession(view, now, {consume: true});
}

export function confirmSignupSession(view, response) {
  const expected = pendingSignupSession(view);
  if (!expected) return true;
  const actual = response.body?.user?.id;
  const definitive = response.status === 200 && validSignupUser(actual);
  if (definitive || response.status === 401) takeSignupSession(view);
  return definitive && actual === expected;
}

export async function waitForRuntime(read, {
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 73, expectedUser,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await delay(attempt <= 10 ? 300 : attempt <= 37 ? 1000 : 3000);
    const reply = await read().catch(() => null);
    if (reply?.status === 401) return 'signed-out';
    if (reply?.status !== 200) continue;
    const {state, user_id: user} = reply.body || {};
    if (expectedUser) {
      if (!validSignupUser(user)) continue;
      if (user !== expectedUser) return 'signup-mismatch';
    }
    if (['ready', 'unmanaged', 'unavailable', 'setup', 'stopped', 'capacity', 'parked'].includes(state)) return state;
  }
  return 'timeout';
}
