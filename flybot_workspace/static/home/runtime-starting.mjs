import {csrfCookie, pendingSignupSession, personalChatPath, personalDraftScope, readChatDrafts, rememberColdDraftHandoff, runtimeHoldNotice, signupDraftScope, waitForRuntime, workspaceLoginHash, workspacePageTarget, writeChatDrafts} from './runtime-readiness.mjs';

const startingTitle = '正在启动专属智能体';

export function mountRuntimeStarting(document, {
  view = document.defaultView ?? globalThis, fetcher = globalThis.fetch.bind(globalThis),
} = {}) {
  const title = document.getElementById('runtime-title');
  const status = document.getElementById('runtime-status');
  const progress = document.getElementById('runtime-progress');
  const retry = document.getElementById('runtime-retry');
  const draftPanel = document.getElementById('runtime-draft');
  const draft = document.getElementById('runtime-first-message');
  const continueButton = document.getElementById('runtime-continue');
  let checking = false;
  let draftScope, draftOwner, draftLocation, draftDestination;
  let composing = false;
  let runtimeReady = false;
  let leaving = false;
  let canStart = false;
  let checkedPersonalChat = false;
  const startupPath = view.location.pathname === '/runtime-starting';
  const returnHome = startupPath && view.location.hash === '#home=1';
  const chatTarget = !returnHome && ['/chat', '/chat/', '/messenger', '/messenger/', '/runtime-starting'].includes(view.location.pathname);
  const bareChatTarget = () => (startupPath || ['/chat', '/chat/'].includes(view.location.pathname)) &&
    !view.location.search && !view.location.hash;
  const locationPath = () => view.location.pathname + (view.location.search || '') + (view.location.hash || '');
  if (returnHome) document.getElementById('runtime-home')?.setAttribute('hidden', '');

  function saveDraft() {
    if (!draftScope || locationPath() !== draftLocation) return true;
    const drafts = readChatDrafts(view, draftOwner);
    const text = draft.value || '';
    if ((drafts.get(draftScope) ?? '') === text) return true;
    if (text) drafts.set(draftScope, text);
    else drafts.delete(draftScope);
    return writeChatDrafts(view, draftOwner, drafts);
  }

  function openDestination() {
    if (leaving) return;
    leaving = true;
    if (draftDestination && draft.value.trim() && locationPath() === draftLocation) {
      if (startupPath) view.location.replace(draftDestination);
      else {
        // A fragment-only replace would leave the startup document mounted.
        view.history.replaceState(view.history.state, '', draftDestination);
        view.location.reload();
      }
      return;
    }
    if (startupPath) view.location.replace(returnHome ? '/' : '/chat' + (view.location.hash || ''));
    else view.location.reload();
  }

  function finish() {
    if (!runtimeReady || leaving) return;
    if (composing) {
      status.textContent = '聊天已就绪，完成当前输入后会自动打开。';
      return;
    }
    const handoff = draftScope && draft.value && locationPath() === draftLocation;
    if (!saveDraft() || (handoff && !rememberColdDraftHandoff(view, draftScope))) {
      status.textContent = '聊天已就绪。浏览器暂时无法保留草稿，请复制文本后继续。';
      continueButton.hidden = false;
      return;
    }
    openDestination();
  }

  draft?.addEventListener('compositionstart', () => { composing = true; });
  draft?.addEventListener('compositionend', () => {
    composing = false;
    queueMicrotask(finish);
  });
  draft?.addEventListener('input', () => {
    if (!composing) saveDraft();
    if (runtimeReady) finish();
  });
  continueButton?.addEventListener('click', openDestination);

  async function read(path, options = {}) {
    const response = await fetcher(path, {
      credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(8000),
      ...options, headers: {Accept: 'application/json', ...options.headers},
    });
    const body = await response.json().catch(() => null);
    return {status: response.status, body};
  }

  async function start(wake = false) {
    if (checking) return;
    checking = true;
    retry.hidden = true;
    if (progress) progress.hidden = false;
    title.textContent = wake ? startingTitle : '正在检查智能体状态';
    status.textContent = chatTarget ? '就绪后会自动打开聊天。' : '就绪后会自动返回当前页面。';
    const expectedUser = pendingSignupSession(view);
    const csrf = csrfCookie(document.cookie);
    const check = () => waitForRuntime(async () => {
      const include = chatTarget && !expectedUser && !checkedPersonalChat && !view.location.search &&
        (view.location.hash || bareChatTarget())
        ? '?include=personal-chat' : '';
      const reply = await read('/v1/auth/runtime-readiness' + include);
      const owner = reply.body?.user_id;
      if (reply.status !== 200 || (expectedUser && owner !== expectedUser)) return reply;
      if (draftOwner && owner !== draftOwner) return {status: 401};
      if (include && ['starting', 'stopped', 'ready'].includes(reply.body?.state)) checkedPersonalChat = true;
      if (reply.body?.state === 'starting' && title.textContent !== startingTitle) {
        title.textContent = startingTitle;
      }
      if (!draftScope && chatTarget && draftPanel && draft) {
        const personal = reply.body?.personal_chat;
        const allowBare = bareChatTarget();
        const scope = expectedUser ? signupDraftScope(view, owner) : personalDraftScope(view, owner, personal, {allowBare});
        if (scope) {
          draftScope = scope;
          draftOwner = owner;
          draftLocation = locationPath();
          draftDestination = allowBare ? personalChatPath(personal) : '';
          draft.value = readChatDrafts(view, draftOwner).get(scope) ?? '';
          draftPanel.hidden = false;
        }
      }
      return reply;
    }, {expectedUser});
    let state;
    if (wake) {
      const result = await read('/v1/auth/runtime-start', {
        method: 'POST', headers: {'X-CSRF-Token': csrf, 'Content-Type': 'application/json'}, body: '{}',
      }).catch(() => null);
      state = result?.status === 401 ? 'signed-out' : await check();
    } else {
      state = await check();
    }
    if (state === 'setup') {
      const result = await read('/v1/personal-agent', {method: 'POST', headers: {'X-CSRF-Token': csrf}})
        .catch(() => null);
      if (result?.status === 401) state = 'signed-out';
      else if (result?.status === 200 || result?.status === 201) {
        const provisioning = result.body?.personal_agent?.runtime_provisioning;
        state = provisioning?.state === 'capacity' || provisioning?.readiness === 'capacity' ? 'capacity'
          : provisioning?.readiness === 'ready' ? 'ready' : await check();
      } else state = 'unavailable';
    }
    if (state === 'signed-out' || state === 'signup-mismatch') {
      if (draftScope) {
        draft.value = '';
        draftPanel.hidden = true;
      }
      // The login page confirms the same-tab signup and presents its manual login form on a mismatch.
      const continuation = state === 'signed-out' ? workspaceLoginHash(workspacePageTarget(view.location)) : '';
      view.location.replace('/login' + (continuation || view.location.hash || ''));
      return;
    }
    if (state === 'ready') {
      runtimeReady = true;
      if (progress) progress.hidden = true;
      finish();
      return;
    }
    canStart = state === 'stopped';
    const notice = runtimeHoldNotice(state);
    title.textContent = notice?.title || (canStart ? '你的专属智能体已停止' : '专属智能体暂未就绪');
    status.textContent = canStart
      ? (chatTarget ? '启动后会自动打开聊天。' : '启动后会自动返回当前页面。')
      : notice ? notice.detail
        : state === 'timeout' ? '你的专属智能体仍在启动。点击重试即可继续检查。'
        : '暂时无法连接到你的专属智能体。请重试。';
    if (progress) progress.hidden = true;
    retry.textContent = canStart ? '启动我的智能体' : notice ? '重新检查' : '重试';
    retry.hidden = false;
    checking = false;
  }

  retry.addEventListener('click', () => start(canStart));
  return start();
}

if (typeof document !== 'undefined') mountRuntimeStarting(document);
