import '../shell/dsbot-api.mjs';
import { meetingCodeFromHash, meetingHref } from '../shell/meeting-link.mjs';
import { spaceHref } from '../shell/thumb.mjs';
import { canManage } from '../shell/chat-utils.mjs';
import { confirmSignupSession, csrfCookie, runtimeHoldNotice, signupSessionError, waitForRuntime, workspaceLoginHash, workspaceLoginTarget, workspacePageTarget } from './runtime-readiness.mjs';

export const KIND_LABELS = {
  document: '文档', website: '网站', slides: '幻灯片', dashboard: '看板',
  whiteboard: '白板', media: '媒体', image: '图片', audio: '音频', video: '视频',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || '作品';
}

export function conversationTitle(item, userId) {
  if (!item) return '对话';
  if (item.source === 'agent') return item.title || item.agent_name || 'AI 对话';
  if (item.kind === 'dm') {
    const other = (item.members || []).find((member) => member.user_id !== userId);
    return (other && other.username) || item.title || '单聊';
  }
  return item.title || '群聊';
}

export function formatWhen(value, now = Date.now() / 1000) {
  const timestamp = Number(value);
  if (!value || !Number.isFinite(timestamp)) return '';
  const seconds = now - timestamp;
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  const date = new Date(timestamp * 1000);
  const current = new Date(now * 1000);
  const sameDay = date.toDateString() === current.toDateString();
  if (sameDay) return new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(date);
  const yesterday = new Date(now * 1000 - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'numeric', day: 'numeric'}).format(date);
}

export function meetingMeta(item) {
  const actions = Number(item && item.action_count) || 0;
  const done = Number(item && item.done_count) || 0;
  return actions ? `${actions} 个行动项 · ${done} 已完成` : '没有行动项';
}

function hashWorkspace(hash = '') {
  return new URLSearchParams(hash.replace(/^#/, '')).get('workspace') || '';
}

function workspaceLink(path, workspace, extras = {}) {
  return path + '#' + new URLSearchParams({workspace, ...extras});
}

async function readLoginLinks(hash) {
  const [agents, works, discover, teams, groups, chat] = await Promise.all([
    import('../shell/public-agent-link.mjs'), import('../shell/public-work-link.mjs'),
    import('../shell/discover-link.mjs'), import('../shell/team-invite-link.mjs'),
    import('../shell/group-invite-link.mjs'), import('../shell/chat-utils.mjs'),
  ]);
  const agent = agents.publicAgentIntentFromHash(hash);
  const work = works.publicWorkIntentFromHash(hash);
  const discovery = discover.discoverIntentFromHash(hash);
  const invite = teams.teamInviteHash(teams.teamInviteFromHash(hash)) || groups.groupInviteHash(groups.groupInviteFromHash(hash));
  const agentHash = agent && agents.publicAgentContinuation(agent);
  const access = chat.directAgentAccessFromHash(hash);
  return {agent, agentHash, work, discovery, invite,
    continuation:invite || agentHash || work?.continuation || discovery?.continuation,
    message:chat.socialMessageFromHash(hash), agentPath:access && chat.directAgentAccessHref(access)};
}

function show(document, kind, text) {
  const signedIn = document.getElementById('main-panel')?.hidden === false;
  const status = document.getElementById(signedIn ? 'home-status' : 'status');
  const other = document.getElementById(signedIn ? 'status' : 'home-status');
  if (other) other.textContent = '';
  if (!status) return;
  status.dataset.kind = kind || '';
  status.textContent = text || '';
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis), now = Date.now() / 1000} = {}) {
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('login-form');
  const feedback = document.getElementById('login-feedback');
  const workspaceSelect = document.getElementById('home-workspace');
  const greeting = document.getElementById('home-greeting');
  const whoami = document.getElementById('whoami');
  const create = document.getElementById('home-create');
  const createDialog = document.getElementById('home-create-dialog');
  if (!loginPanel || !mainPanel || !form || !workspaceSelect) return null;

  const view = document.defaultView ?? globalThis;
  const pendingKey = 'ot-pending-meeting';
  const meetingFromLink = meetingCodeFromHash(view.location?.hash);
  if (meetingFromLink) {
    try { view.sessionStorage.setItem(pendingKey, meetingFromLink); } catch {}
  }
  let currentUser = null;
  let workspaces = [];
  let personal = null;
  let profile = null;
  let selectedId = '';
  let loading = false;
  let signingIn = false;
  let overviewRequest = null;
  let lookAssets;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function request(method, path, body, signal) {
    const headers = {Accept: 'application/json'};
    const options = {method, headers, credentials: 'same-origin'};
    if (signal) options.signal = signal;
    if (method !== 'GET') headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetcher(path, options);
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    return {status: response.status, body: payload};
  }

  function setHash(workspaceId) {
    if (!globalThis.location || !globalThis.history) return;
    globalThis.history.replaceState(null, '', '#workspace=' + encodeURIComponent(workspaceId));
  }

  function loadLook() {
    if (!lookAssets) {
      const style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = new URL('../look/app.css', import.meta.url).href;
      const styled = new Promise((resolve, reject) => {
        style.addEventListener('load', resolve, {once:true});
        style.addEventListener('error', reject, {once:true});
        document.head.append(style);
      });
      lookAssets = Promise.all([import('../look/app.mjs'), styled]).then(([renderer]) => renderer).catch(() => {
        style.remove();
        lookAssets = null;
        return null;
      });
    }
    return lookAssets;
  }

  function renderPersonal() {
    const agent = personal && personal.agent;
    const section = document.querySelector('.home-personal');
    if (!section) return;
    if (!agent) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    document.getElementById('home-personal-title').textContent = agent.name;
    document.getElementById('home-personal-summary').textContent = agent.summary || '你的跨场景个人智能体。';
    const avatar = document.getElementById('home-personal-avatar');
    const binding = personal;
    avatar.textContent = (agent.name || 'P').trim().slice(0, 1).toUpperCase();
    if (binding.look) void loadLook().then(renderer => {
      if (!renderer || !currentUser || binding !== personal) return;
      const lookAvatar = renderer.createLookAvatar(binding.look, document);
      if (lookAvatar) avatar.replaceChildren(lookAvatar);
    });
    renderPersonalContext();
    const workspaceId = personal.workspace && personal.workspace.id;
    const chat = document.getElementById('home-personal-chat');
    const agents = document.getElementById('home-personal-agents');
    if (chat && workspaceId) chat.href = '/chat#workspace=' + encodeURIComponent(workspaceId) + '&agent=' + encodeURIComponent(agent.id);
    if (agents && workspaceId) agents.href = workspaceLink('/agents', workspaceId, {agent:agent.id});
  }

  function renderPersonalContext() {
    const context = document.getElementById('home-context');
    if (!context) return;
    const bits = [profile?.industry, profile?.role].filter(Boolean);
    context.hidden = !bits.length;
    context.textContent = bits.length ? '工作背景：' + bits.join(' · ') : '';
  }

  function renderWorkspaceSelect() {
    workspaceSelect.replaceChildren(...workspaces.map((space) => {
      const option = element('option');
      option.value = space.id;
      option.textContent = space.name;
      return option;
    }));
    workspaceSelect.value = selectedId;
    workspaceSelect.disabled = !workspaces.length;
  }

  function conversationLink(item) {
    if (item.source === 'agent') {
      return '/chat#workspace=' + encodeURIComponent(selectedId) + '&agent=' + encodeURIComponent(item.agent_id)
        + '&conversation=' + encodeURIComponent(item.id);
    }
    return '/chat#workspace=' + encodeURIComponent(selectedId) + '&social=' + encodeURIComponent(item.id);
  }

  function renderConversations(items) {
    const list = document.getElementById('home-conversations');
    const empty = document.getElementById('home-conversations-empty');
    list.replaceChildren(...(items || []).map((item) => {
      const li = element('li');
      const link = element('a', 'home-row');
      link.href = conversationLink(item);
      const title = element('strong', '', conversationTitle(item, currentUser && currentUser.id));
      const agentNote = item.source === 'agent' && item.agent_name ? item.agent_name + ' · ' : '';
      const preview = element('span', 'home-row-note',
        agentNote + (item.preview || (item.source === 'agent' ? 'AI 对话' : '群聊')));
      const when = element('time', 'home-row-time', formatWhen(item.updated, now));
      link.append(title, preview, when);
      if (item.unread_count > 0) {
        const badge = element('span', 'home-unread', String(item.unread_count));
        badge.setAttribute('aria-label', item.unread_count + ' 条未读');
        link.append(badge);
      }
      li.append(link);
      return li;
    }));
    if (empty) empty.hidden = (items || []).length > 0;
  }

  function renderArtifacts(items) {
    const list = document.getElementById('home-artifacts');
    const empty = document.getElementById('home-artifacts-empty');
    list.replaceChildren(...(items || []).map((item) => {
      const li = element('li');
      const link = element('a', 'home-row');
      link.href = spaceHref(selectedId, item && item.id);
      const title = element('strong', '', item.title);
      const meta = element('span', 'home-row-note', kindLabel(item.kind));
      const when = element('time', 'home-row-time', formatWhen(item.updated, now));
      link.append(title, meta, when);
      li.append(link);
      return li;
    }));
    if (empty) empty.hidden = (items || []).length > 0;
  }

  function renderMeetings(items) {
    const list = document.getElementById('home-meetings');
    const empty = document.getElementById('home-meetings-empty');
    list.replaceChildren(...(items || []).map((item) => {
      const li = element('li');
      const link = element('a', 'home-row');
      link.href = workspaceLink('/meetings', selectedId, {meeting:item.id});
      const title = element('strong', '', item.title);
      const meta = element('span', 'home-row-note', meetingMeta(item));
      const when = element('time', 'home-row-time', formatWhen(item.started_at, now));
      link.append(title, meta, when);
      li.append(link);
      return li;
    }));
    if (empty) empty.hidden = (items || []).length > 0;
  }

  function renderStats(counts) {
    const holder = document.getElementById('home-stats');
    if (!holder) return;
    const entries = [
      ['智能体', counts && counts.agents, '/agents'],
      ['作品', counts && counts.artifacts, '/space'],
      ['会议', counts && counts.meetings, '/meetings'],
      ['自动化', counts && counts.automations, '/automations'],
    ];
    holder.replaceChildren(...entries.map(([label, value, href]) => {
      const link = element('a', 'home-stat');
      link.href = workspaceLink(href, selectedId);
      link.append(element('strong', '', String(Number(value) || 0)), element('span', '', label));
      return link;
    }));
    holder.hidden = !counts;
  }

  function renderWorkspaceLinks() {
    for (const link of document.querySelectorAll('[data-home-workspace-path]')) {
      if (selectedId) {
        link.href = workspaceLink(link.dataset.homeWorkspacePath, selectedId);
        link.removeAttribute('aria-disabled');
      } else {
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
      }
    }
    if (create) create.disabled = !currentUser || !/^[0-9a-f]{32}$/.test(selectedId) ||
      !workspaces.some(workspace => workspace.id === selectedId);
  }

  create?.addEventListener('click', () => {
    const workspace = workspaces.find(item => item.id === selectedId);
    if (!currentUser || !workspace || create.disabled || !createDialog || createDialog.open) return;
    document.getElementById('home-create-workspace').textContent = workspace.name || workspaceSelect.selectedOptions[0]?.textContent || '当前工作区';
    const manage = personal?.workspace?.id === selectedId ||
      (workspace.role ? canManage(workspace.role) : workspace.owner_id === currentUser.id);
    document.getElementById('home-create-agents').hidden = !manage;
    for (const link of createDialog.querySelectorAll('[data-home-create-path]')) {
      link.href = workspaceLink(link.dataset.homeCreatePath, selectedId);
    }
    createDialog.showModal();
  });

  function clearOverview() {
    renderConversations([]);
    renderArtifacts([]);
    renderMeetings([]);
    renderStats(null);
    for (const id of ['home-conversations-empty', 'home-artifacts-empty', 'home-meetings-empty', 'home-notifications']) {
      const element = document.getElementById(id);
      if (element) element.hidden = true;
    }
  }

  async function loadOverview() {
    overviewRequest?.abort();
    renderWorkspaceLinks();
    clearOverview();
    if (!selectedId) return;
    const controller = overviewRequest = new AbortController();
    show(document, 'loading', '正在读取工作区概览…');
    const result = await request('GET', `/v1/workspaces/${selectedId}/overview?limit=5`, undefined, controller.signal)
      .catch(() => ({status: 0, body: {}}));
    if (overviewRequest !== controller || controller.signal.aborted) return;
    overviewRequest = null;
    if (result.status !== 200) {
      show(document, 'error', (result.body.error && result.body.error.message) || '无法加载首页摘要。');
      return;
    }
    renderConversations(result.body.recent_conversations || []);
    renderArtifacts(result.body.recent_artifacts || []);
    renderMeetings(result.body.recent_meetings || []);
    renderStats(result.body.counts || null);
    const notifications = document.getElementById('home-notifications');
    const unread = Number(result.body.unread_notifications) || 0;
    if (notifications) {
      notifications.hidden = unread === 0;
      notifications.textContent = `有 ${unread} 条未读通知，打开聊天查看`;
    }
    show(document, '', '');
  }

  async function continuePublicActivity({target, backPath, loadingText, errorText, retryId}) {
    const hash = view.location.hash;
    const stillCurrent = () => view.location.pathname === '/login' && view.location.hash === hash;
    loginPanel.hidden = true;
    mainPanel.hidden = true;
    show(document, 'loading', loadingText);
    try {
      const personal = await initializePersonalAgent(target);
      if (!stillCurrent() || !personal) return;
      const ready = await request('GET', '/v1/workspaces?scope=personal');
      if (!stillCurrent()) return;
      if (ready.status === 200 && ready.body?.items?.length) {
        view.location.replace(target);
        return;
      }
    } catch {}
    if (!stillCurrent()) return;
    show(document, 'error', errorText);
    const status = document.getElementById('status');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.id = retryId;
    retry.className = 'public-agent-action';
    retry.textContent = '重试';
    retry.addEventListener('click', () => void load());
    const back = document.createElement('a');
    back.href = backPath;
    back.className = 'public-agent-action';
    back.textContent = '返回公开页面';
    status.append(retry, back);
  }

  function showPersonalRuntimeRetry(state) {
    loginPanel.hidden = true;
    mainPanel.hidden = true;
    const notice = runtimeHoldNotice(state);
    const message = notice ? notice.title + '。' + notice.detail
      : state === 'timeout' ? '你的专属智能体仍在启动，请稍后再试。'
        : '暂时无法打开你的工作区，请重试。';
    show(document, notice ? '' : 'error', message);
    const retry = element('button', 'public-agent-action', notice ? '重新检查' : '重试');
    retry.type = 'button';
    retry.id = 'runtime-startup-retry';
    retry.addEventListener('click', () => void load());
    document.getElementById('status')?.append(retry);
  }

  async function initializePersonalAgent(resumePath = '/runtime-starting#home=1') {
    const result = await request('POST', '/v1/personal-agent').catch(() => null);
    const agent = result?.body?.personal_agent;
    const provisioning = agent?.runtime_provisioning;
    if (agent && (!provisioning || ['ready', 'unmanaged'].includes(provisioning.readiness))) return agent;

    loginPanel.hidden = true;
    mainPanel.hidden = true;
    let state;
    if (provisioning?.readiness === 'starting') {
      show(document, 'loading', '正在启动你的专属智能体。就绪后会自动继续。');
      state = await waitForRuntime(() => request('GET', '/v1/auth/runtime-readiness'));
      if (state === 'ready' || state === 'unmanaged') return agent;
      if (state === 'signed-out') {
        view.location.replace('/login' + view.location.hash);
        return null;
      }
    }
    if (provisioning?.readiness === 'stopped' || state === 'stopped') {
      view.location.replace(resumePath);
      return null;
    }
    showPersonalRuntimeRetry(state || provisioning?.readiness || provisioning?.state);
    return null;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const isLogin = view.location?.pathname === '/login';
      const originalPage = workspacePageTarget(view.location);
      const hash = isLogin ? view.location.hash : '';
      const returnTo = originalPage || workspaceLoginTarget(hash);
      const loginLinks = hash && !returnTo ? readLoginLinks(hash).catch(() => null) : null;
      const sessionPath = isLogin || originalPage ? '/v1/auth/session' : '/v1/auth/session?include=home';
      const session = await request('GET', sessionPath).catch(() => ({status: 0, body: {}}));
      const unconfirmedSignup = [200, 401].includes(session.status) && !confirmSignupSession(view, session);
      if (session.status === 401 || unconfirmedSignup) {
        currentUser = null;
        if (whoami) whoami.textContent = '';
        document.body?.classList.remove('home-signed-in', 'app-primary');
        loginPanel.hidden = false;
        mainPanel.hidden = true;
        const links = await loginLinks;
        const continuation = workspaceLoginHash(returnTo) || links?.continuation;
        const register = loginPanel.querySelector?.('.login-register-button');
        if (register) register.href = '/register' + (continuation || '');
        const back = document.getElementById('login-return-discover');
        if (back) {
          back.hidden = !links?.discovery;
          if (links?.discovery) back.href = links.discovery.target;
        }
        show(document, unconfirmedSignup ? 'error' : '', unconfirmedSignup ? signupSessionError :
          returnTo ? '登录后会返回你刚打开的页面。' : '');
        return;
      }
      if (session.status !== 200 || !session.body.user) {
        show(document, 'error', (session.body.error && session.body.error.message) || '无法读取会话。');
        return;
      }
      if (returnTo) {
        if (originalPage) view.location.reload();
        else view.location.replace(returnTo);
        return;
      }
      let meeting = meetingFromLink;
      try {
        meeting ||= view.sessionStorage.getItem(pendingKey);
      } catch {}
      const target = meetingHref(meeting);
      if (target) {
        if (!await initializePersonalAgent(target)) return;
        try { view.sessionStorage.removeItem(pendingKey); } catch {}
        view.location.replace(target);
        return;
      }
      try { view.sessionStorage.removeItem(pendingKey); } catch {}
      if (isLogin) {
        const links = await loginLinks;
        if (hash && !links) {
          show(document, 'error', '暂时无法打开登录前的页面。请刷新重试。');
          return;
        }
        const {invite, agent, agentHash, work, discovery, message, agentPath} = links || {};
        if (invite) {
          const destination = '/members' + invite;
          if (await initializePersonalAgent(destination) && view.location.hash === hash) {
            view.location.replace(destination);
          }
        } else if (message) {
          view.location.replace(message);
        } else if (agentPath) {
          view.location.replace(agentPath);
        } else if (agent) {
          await continuePublicActivity({
            target: '/chat' + agentHash, backPath: '/a/' + agent.slug,
            loadingText: '正在打开公开智能体…', errorText: '聊天尚未准备好。', retryId: 'public-agent-login-retry',
          });
        } else if (work) {
          await continuePublicActivity({
            target: work.target, backPath: '/w/' + work.slug,
            loadingText: work.panel === 'comments' ? '正在打开作品评论…' : '正在打开作品…',
            errorText: '暂时无法打开作品。', retryId: 'public-work-login-retry',
          });
        } else if (discovery) {
          await continuePublicActivity({
            target: discovery.target, backPath: discovery.target,
            loadingText: '正在返回发现…', errorText: '暂时无法打开你的发现页。', retryId: 'discover-login-retry',
          });
        } else {
          view.location.replace('/');
        }
        return;
      }
      currentUser = session.body.user;
      if (whoami) whoami.textContent = currentUser.username;
      document.body?.classList.add('home-signed-in', 'app-primary');
      loginPanel.hidden = true;
      const startup = session.body.home;
      if (runtimeHoldNotice(startup?.runtime_state)) {
        showPersonalRuntimeRetry(startup.runtime_state);
        return;
      }
      const ready = ['ready', 'unmanaged'].includes(startup?.runtime_state);
      personal = (ready && startup.personal_agent) || await initializePersonalAgent();
      if (!personal) return;
      greeting.textContent = `欢迎回来，${currentUser.username}`;
      workspaceSelect.disabled = true;
      const banner = document.getElementById('home-onboarding');
      if (banner) banner.hidden = true;
      profile = null;
      // The authenticated personal binding is already usable. Optional dashboard
      // and onboarding reads no longer hold back opening the first chat.
      renderPersonal();
      const personalWorkspace = personal.workspace;
      const requested = hashWorkspace(view.location?.hash);
      const earlyId = !requested || requested === personalWorkspace?.id ? personalWorkspace?.id || '' : '';
      selectedId = earlyId;
      if (earlyId) {
        workspaces = [{...personalWorkspace, name:personalWorkspace.name || '个人空间'}];
        renderWorkspaceSelect();
        workspaceSelect.disabled = true;
      }
      renderWorkspaceLinks();
      mainPanel.hidden = false;
      show(document, '', '');
      const earlyOverview = earlyId ? loadOverview() : null;
      const activeUser = currentUser;
      void request('GET', '/v1/onboarding').then(onboarding => {
        if (currentUser !== activeUser || onboarding.status !== 200) return;
        profile = onboarding.body.onboarding;
        if (banner) banner.hidden = Boolean(onboarding.body.progress?.completed ?? profile?.completed);
        if (onboarding.body.steps?.look && personal) {
          personal = {...personal, look: onboarding.body.steps.look};
          renderPersonal();
        } else renderPersonalContext();
      }).catch(() => {});
      const listed = await request('GET', '/v1/workspaces?limit=100').catch(() => ({status: 0, body: {}}));
      if (currentUser !== activeUser) return;
      if (listed.status !== 200) {
        await earlyOverview;
        show(document, 'error', '暂时无法加载工作区列表。');
        return;
      }
      workspaces = listed.body.items || [];
      if (!workspaces.length) {
        if (earlyOverview) await earlyOverview;
        else show(document, '', '还没有工作区。先创建一个团队或工作区。');
        return;
      }
      const wanted = hashWorkspace(view.location?.hash);
      if (wanted && !workspaces.some(space => space.id === wanted)) {
        overviewRequest?.abort();
        selectedId = '';
        renderWorkspaceSelect();
        renderWorkspaceLinks();
        clearOverview();
        show(document, 'error', '无法访问链接中的工作区。请选择其他工作区。');
        return;
      }
      selectedId = workspaces.some((space) => space.id === wanted)
        ? wanted
        : (personal && personal.workspace ? personal.workspace.id : workspaces[0].id);
      if (!workspaces.some((space) => space.id === selectedId)) selectedId = workspaces[0].id;
      renderWorkspaceSelect();
      setHash(selectedId);
      await (selectedId === earlyId && earlyOverview ? earlyOverview : loadOverview());
    } finally {
      loading = false;
    }
  }

  workspaceSelect.addEventListener('change', async () => {
    selectedId = workspaceSelect.value;
    setHash(selectedId);
    await loadOverview();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (signingIn) return;
    signingIn = true;
    const submit = form.querySelector?.('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = '正在登录…';
    }
    show(document, '', '');
    if (feedback) feedback.textContent = '';
    try {
      const result = await request('POST', '/v1/auth/login', {
        username: form.elements.username.value,
        password: form.elements.password.value,
      });
      if (result.status !== 200) {
        if (feedback) {
          feedback.dataset.kind = 'error';
          feedback.textContent = result.status === 401 ? '用户名或密码不正确。'
            : result.status === 429 ? '登录尝试过多，请稍后再试。' : '暂时无法登录，请重试。';
        }
        return;
      }
      form.reset();
      await load();
    } catch {
      if (feedback) {
        feedback.dataset.kind = 'error';
        feedback.textContent = '无法连接，请检查网络后重试。';
      }
    } finally {
      signingIn = false;
      if (submit) {
        submit.disabled = false;
        submit.textContent = '登录';
      }
    }
  });

  const logout = document.getElementById('logout-form');
  if (logout) logout.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) return;
    currentUser = null;
    overviewRequest?.abort();
    // A slow dashboard read may still be in flight after the page is usable.
    view.location.replace('/');
  });

  load();
  return {load, loadOverview};
}

if (typeof document !== 'undefined') {
  const start = () => mount(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
