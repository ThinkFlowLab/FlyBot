import {servedByDsBot} from '../shell/dsbot-api.mjs';
import {readChatDrafts, rememberColdDraftHandoff, writeChatDrafts} from '../home/runtime-readiness.mjs';

function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const options = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

// Creation is deliberately isolated from every save/skip/navigation handler.
// The server deduplicates retries; the busy guard also prevents rapid clicks.
export function mountAutomationCreation(doc, send = request) {
  const button = doc.getElementById('create-onboarding-automations');
  const list = doc.getElementById('onboarding-automation-templates');
  const status = doc.getElementById('onboarding-automation-status');
  const links = doc.getElementById('onboarding-automation-links');
  let busy = false;
  let choices = [];
  let personalWorkspace = '';
  const savedId = /^[0-9a-f]{32}$/;
  if (!button || !list || !status) return {render() {}};
  button.addEventListener('click', async () => {
    if (busy) return;
    const selected = choices.filter(box => box.checked).map(box => box.value);
    if (!selected.length || selected.length > 6) {
      status.textContent = '请明确选择 1–6 个模板；保存偏好不会创建自动化。';
      return;
    }
    busy = true;
    button.disabled = true;
    status.textContent = '正在创建自动化…';
    try {
      let workspaceId = personalWorkspace;
      if (!savedId.test(workspaceId)) {
        const personal = await send('POST', '/v1/personal-agent', {});
        workspaceId = personal.body?.personal_agent?.workspace?.id;
        if (![200, 201].includes(personal.status) || !savedId.test(workspaceId || '')) {
          status.textContent = '无法加载个人工作区，请重试。';
          return;
        }
      }
      const result = await send('POST', '/v1/onboarding/automations', {workspace_id: workspaceId, template_ids: selected});
      if (result.status !== 200 && result.status !== 201) {
        status.textContent = messageFor(result.body.error, '创建失败，请重试。');
        return;
      }
      const {created = [], skipped = []} = result.body;
      status.textContent = created.length ? `已创建 ${created.length} 条暂停的自动化。` : '';
      if (skipped.length) status.textContent += `已有 ${skipped.length} 条相同模板或重名的自动化。`;
      if (links) {
        links.textContent = '';
        for (const item of [...created, ...skipped]) {
          if (!savedId.test(item.id || '')) continue;
          const row = doc.createElement('li');
          const link = doc.createElement('a');
          link.href = `/automations?workspace=${workspaceId}&automation=${item.id}`;
          link.textContent = '打开「' + item.title + '」';
          row.append(link);
          links.append(row);
        }
        links.hidden = links.children.length === 0;
      }
    } catch {
      status.textContent = '连接中断，结果尚不确定。可重试，已创建的模板不会重复创建。';
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
  return {setPersonalWorkspace(workspaceId) {
    personalWorkspace = savedId.test(workspaceId || '') ? workspaceId : '';
  }, render(items = []) {
    list.textContent = '';
    choices = [];
    for (const item of items) {
      const label = doc.createElement('label');
      label.className = 'pick-card';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.name = 'automation_template';
      box.value = item.template_id;
      box.checked = false;
      const copy = doc.createElement('span');
      copy.className = 'pick-copy';
      const title = doc.createElement('strong');
      title.textContent = item.title;
      const prompt = doc.createElement('span');
      prompt.className = 'pick-summary';
      prompt.textContent = item.prompt;
      copy.append(title, prompt);
      label.append(box, copy);
      list.append(label);
      choices.push(box);
    }
    button.disabled = !choices.length || busy;
  }};
}

const LOOK_LABELS = {color: '颜色', expression: '表情', headwear: '头饰', glasses: '眼镜', hand: '手持'};

// Composio toolkit slugs for the step-2 catalog in flybot_workspace/onboarding.py.
// The catalog uses dashed ids; Composio does not, so the mapping is explicit
// instead of guessed from the display name.
const TOOLKITS = {
  gmail: 'gmail', outlook: 'outlook', 'google-calendar': 'googlecalendar', github: 'github',
  'google-drive': 'googledrive', notion: 'notion', 'google-sheets': 'googlesheets', 'google-docs': 'googledocs',
};

// The words for one app row come from the real read, never from a constant.
// `readable: false` means the connection list could not be read (no Composio
// key of the user's own, or another refusal): that row says 未接入, because
// claiming 未连接 would assert something about an app nobody asked.
export function appConnectionState(app, {connections = [], readable = true, sync = 'ok'} = {}) {
  if (!readable) {
    return {state: 'unknown', label: '未接入', connected: false,
            title: '暂时无法读取你的 Composio 连接状态'};
  }
  if (sync === 'failed') {
    return {state: 'unknown', label: '状态未知', connected: false,
            title: 'Composio 同步失败，这次读到的连接状态不可信'};
  }
  const slug = TOOLKITS[app.key] || String(app.key || '');
  const rows = (connections || []).filter(row => row && String(row.toolkit || '').toLowerCase() === slug);
  if (rows.some(row => row.state === 'connected')) {
    return {state: 'connected', label: '已连接', connected: true, title: '这个应用已经有真实的连接'};
  }
  if (rows.some(row => row.state === 'connecting')) {
    return {state: 'connecting', label: '连接中', connected: false, title: '授权流程还没有完成'};
  }
  if (rows.some(row => row.state === 'inactive')) {
    return {state: 'inactive', label: '已停用', connected: false, title: '连接存在但已停用，需要重新授权'};
  }
  if (rows.some(row => row.state === 'failed')) {
    return {state: 'failed', label: '连接失败', connected: false, title: '上次授权失败，需要重新连接'};
  }
  return {state: 'unconnected', label: '未连接', connected: false, title: '还没有这个应用的连接'};
}

const TILE_TONES = 6;

export function tileTone(text) {
  let hash = 0;
  for (const ch of String(text || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % TILE_TONES) + 1);
}

export function stepLabel(step) {
  return `第 ${step} 步，共 4 步`;
}

export function lookSummary(look) {
  if (!look) return '还没有选择形象。';
  return Object.keys(LOOK_LABELS).map(name => `${LOOK_LABELS[name]}：${look[name]}`).join(' · ');
}

const NATIVE_ID = /^[a-f0-9]{32}$/;

export function personalChatPath(personal) {
  const workspace = personal?.workspace?.id;
  const agent = personal?.agent?.id;
  return NATIVE_ID.test(workspace || '') && NATIVE_ID.test(agent || '')
    ? '/chat#workspace=' + workspace + '&agent=' + agent : '';
}

function savedProgress(data) {
  const progress = data?.progress;
  if (Number.isInteger(progress?.step) && progress.step >= 1 && progress.step <= 4) {
    return {step: progress.step, completed: progress.completed === true};
  }
  const profile = data?.onboarding;
  if (data?.steps?.look || (profile?.completed && !profile.industry && !profile.role)) {
    return {step: 4, completed: true};
  }
  return {step: profile ? 2 : 1, completed: false};
}

export function mountOnboarding(document, {
  send = request,
  navigate = path => document.defaultView.location.assign(path),
} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('onboarding-form');
  const select = document.getElementById('industry');
  const roleChoices = document.getElementById('role-choices');
  const roleLocked = document.getElementById('role-locked');
  const customIndustryLabel = document.getElementById('custom-industry-label');
  const customIndustry = document.getElementById('custom-industry');
  const customRoleLabel = document.getElementById('custom-role-label');
  const customRole = document.getElementById('custom-role');
  if (!status || !loginPanel || !mainPanel || !form) return;
  const profileSave = document.getElementById('onboarding-save');
  const firstTask = document.getElementById('onboarding-first-task');
  const taskPreview = document.getElementById('onboarding-first-task-preview');
  const taskPreviewLabel = document.getElementById('onboarding-first-task-preview-label');
  const taskStatus = document.getElementById('onboarding-first-task-status');
  const enter = document.getElementById('onboarding-enter');
  const automationCreation = mountAutomationCreation(document, send);
  let industries = [];
  let current = null;
  let data = null;
  let user = null;
  let generation = 0;
  let writing = null;
  let step = 1;
  let progress = {step: 1, completed: false};
  let connections = null;
  let loadingConnections = null;
  let taskOptions = new Map();

  const read = path => send('GET', path).catch(() => null);

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function populateIndustries() {
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择你的行业';
    select.append(placeholder);
    for (const row of industries) {
      const option = document.createElement('option');
      option.value = row.name;
      option.textContent = row.name;
      select.append(option);
    }
    renderIndustryCards();
  }

  function renderIndustryCards() {
    const holder = document.getElementById('industry-cards');
    if (!holder) return;
    holder.replaceChildren();
    for (const row of industries) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'choice-card';
      card.setAttribute('role', 'radio');
      card.dataset.value = row.name;
      card.setAttribute('aria-checked', String(select.value === row.name));
      const tile = document.createElement('span');
      tile.className = 'choice-tile';
      tile.dataset.tone = tileTone(row.name);
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = Array.from(row.name)[0] || '?';
      const name = document.createElement('span');
      name.className = 'choice-name';
      name.textContent = row.name;
      card.append(tile, name);
      card.addEventListener('click', () => {
        select.value = row.name;
        select.dispatchEvent(new Event('change'));
      });
      holder.append(card);
    }
  }

  function syncIndustryCards() {
    for (const card of document.querySelectorAll('#industry-cards .choice-card')) {
      card.setAttribute('aria-checked', String(card.dataset.value === select.value));
    }
  }

  function goStep(next, {focus = false} = {}) {
    step = next;
    form.hidden = next !== 1;
    const section = document.getElementById('onboarding-steps');
    if (section) section.hidden = next === 1;
    for (const part of document.querySelectorAll('#onboarding-steps .onboarding-step')) {
      part.hidden = Number(part.dataset.step) !== next;
    }
    const label = document.getElementById('onboarding-step-label');
    if (label) label.textContent = stepLabel(next);
    for (const bar of document.querySelectorAll('.onboarding-progress li')) {
      bar.dataset.done = String(Number(bar.dataset.bar) <= next);
    }
    if (focus) {
      document.getElementById('main')?.scrollTo?.(0, 0);
      document.querySelector('[data-step="' + next + '"] h2')?.focus();
    }
    if (next === 2) {
      renderConnections();
      void loadConnections();
    }
    if (next === 4) paintLook();
  }

  function renderRoles() {
    const name = select.value;
    const row = industries.find(item => item.name === name);
    roleChoices.replaceChildren();
    syncIndustryCards();
    customIndustryLabel.hidden = name !== '其他';
    customRoleLabel.hidden = true;
    roleLocked.hidden = Boolean(name);
    if (!name) return;
    const roles = row ? row.roles : [];
    const values = new Set(roles);
    for (const role of roles) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'role';
      radio.value = role;
      radio.addEventListener('change', () => {
        customRoleLabel.hidden = radio.value !== '其他';
        syncProfileReady();
        if (radio.value === '其他') customRole.focus();
      });
      const tile = document.createElement('span');
      tile.className = 'choice-tile';
      tile.dataset.tone = tileTone(role);
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = Array.from(role)[0] || '?';
      const name = document.createElement('span');
      name.className = 'choice-name';
      name.textContent = role;
      label.className = 'choice-card';
      label.append(radio, tile, name);
      roleChoices.append(label);
    }
    if (!roles.length) {
      customRoleLabel.hidden = false;
      return;
    }
    if (current && current.industry === name && current.role) {
      if (values.has(current.role)) {
        const radio = roleChoices.querySelector('input[name="role"][value="' + CSS.escape(current.role) + '"]');
        if (radio) radio.checked = true;
        customRoleLabel.hidden = current.role !== '其他';
      } else {
        customRoleLabel.hidden = false;
        customRole.value = current.role;
      }
    }
  }

  function chosenRole() {
    const checked = roleChoices.querySelector('input[name="role"]:checked');
    if (checked) return checked.value === '其他' ? customRole.value.trim() : checked.value;
    return customRole.value.trim();
  }

  function profileValues() {
    return {industry: select.value === '其他' ? customIndustry.value.trim() : select.value, role: chosenRole()};
  }

  function syncProfileReady() {
    const {industry, role} = profileValues();
    profileSave.disabled = Boolean(writing) || !industry || !role;
  }

  function fill(state) {
    current = state;
    select.value = state && state.industry && industries.some(item => item.name === state.industry)
      ? state.industry : (state && state.industry ? '其他' : '');
    customIndustry.value = select.value === '其他' && state?.industry && state.industry !== '其他' ? state.industry : '';
    customRole.value = state && state.role || '';
    renderRoles();
    syncProfileReady();
    const meta = document.getElementById('onboarding-meta');
    if (state && state.completed) {
      meta.textContent = '已完成' + (state.industry ? ' · ' + state.industry + (state.role ? ' · ' + state.role : '') : '') + '，可随时修改。';
    } else {
      meta.textContent = '';
    }
  }

  function renderConnections() {
    const apps = document.getElementById('onboarding-apps');
    apps.replaceChildren();
    for (const app of data?.steps?.apps || []) {
      const li = document.createElement('li');
      const tile = document.createElement('span');
      tile.className = 'choice-tile';
      tile.dataset.tone = tileTone(app.name);
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = Array.from(app.name)[0] || '?';
      const copy = document.createElement('span');
      copy.className = 'app-copy';
      const name = document.createElement('strong');
      name.textContent = app.name;
      const state = document.createElement('span');
      state.className = 'app-state';
      const info = connections ? appConnectionState(app, connections)
        : {state: 'loading', label: '读取中', title: '正在读取连接状态'};
      state.dataset.state = info.state;
      state.textContent = ' · ' + info.label;
      state.title = info.title;
      copy.append(name, state);
      li.append(tile, copy);
      if (!info.connected) {
        const connect = document.createElement('a');
        connect.href = '/settings/connectors';
        connect.className = 'app-connect';
        connect.textContent = '前往设置';
        connect.setAttribute('aria-label', '在设置中管理 ' + app.name);
        li.append(connect);
      }
      apps.appendChild(li);
    }
  }

  async function loadConnections({refresh = false} = {}) {
    if (!data || loadingConnections || (connections && !refresh)) return;
    const own = Symbol();
    loadingConnections = own;
    const result = await read('/v1/composio/connections');
    if (loadingConnections !== own) return;
    loadingConnections = null;
    connections = {
      readable: result?.status === 200,
      connections: result?.body?.items || [],
      sync: result?.body?.sync,
    };
    if (step === 2) renderConnections();
  }

  function renderSteps(steps) {
    if (!steps) return;
    if (step === 2) renderConnections();
    const picks = document.getElementById('onboarding-picks');
    picks.textContent = '';
    const groups = {task: ['一次性任务'], routine: ['例行任务']};
    const lists = {};
    for (const [kind, [title]] of Object.entries(groups)) {
      const group = document.createElement('div');
      group.className = 'pick-group';
      const head = document.createElement('h3');
      head.className = 'onboarding-group';
      head.textContent = title;
      const list = document.createElement('div');
      list.className = 'pick-list';
      group.append(head, list);
      picks.append(group);
      lists[kind] = list;
    }
    for (const item of steps.recommendations || []) {
      const label = document.createElement('label');
      label.className = 'pick-card';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'pick';
      box.value = item.key;
      box.checked = (steps.picks || []).includes(item.key);
      const copy = document.createElement('span');
      copy.className = 'pick-copy';
      const title = document.createElement('strong');
      title.textContent = ` ${item.title}（${item.kind === 'routine' ? '例行' : '一次性'}）`;
      const summary = document.createElement('span');
      summary.className = 'pick-summary';
      summary.textContent = item.summary;
      copy.append(title, summary);
      label.append(box, copy);
      label.title = item.summary;
      (lists[item.kind] || lists.task).appendChild(label);
    }
    const look = document.getElementById('onboarding-look');
    look.textContent = '';
    for (const [name, options] of Object.entries(steps.look_options || {})) {
      const label = document.createElement('label');
      const choice = document.createElement('select');
      choice.name = name;
      for (const value of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        choice.appendChild(option);
      }
      if (steps.look && steps.look[name]) choice.value = steps.look[name];
      choice.addEventListener('change', paintLook);
      label.className = 'look-option';
      const caption = document.createElement('span');
      caption.textContent = `${LOOK_LABELS[name] || name} `;
      label.append(caption, choice);
      look.appendChild(label);
    }
    paintLook();
    document.getElementById('onboarding-steps-meta').textContent =
      '已选 ' + (steps.picks || []).length + ' 项';
    renderFirstTasks(steps);
  }

  function renderFirstTasks(steps) {
    const previous = firstTask.value;
    const selected = new Set(steps.picks || []);
    taskOptions = new Map((steps.recommendations || [])
      .filter(item => item.kind === 'task' && selected.has(item.key))
      .map(item => [item.key, item]));
    const direct = document.createElement('option');
    direct.value = '';
    direct.textContent = '直接打开聊天';
    firstTask.replaceChildren(direct);
    for (const [key, task] of taskOptions) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = task.title;
      firstTask.append(option);
    }
    firstTask.value = taskOptions.has(previous) ? previous : '';
    document.getElementById('onboarding-first-task-panel').hidden = !taskOptions.size;
  }

  function syncFirstTask() {
    const task = taskOptions.get(firstTask.value);
    taskPreviewLabel.hidden = !task;
    taskPreview.value = task
      ? `请帮我完成这项任务：${task.title}。\n${task.summary}\n如果缺少必要信息，请先问我。` : '';
    enter.textContent = task
      ? (progress.completed ? '保存并带着任务开始聊天' : '完成并带着任务开始聊天')
      : (progress.completed ? '保存并打开聊天' : '完成并开始聊天');
  }

  function chosenLook() {
    return Object.fromEntries([...document.querySelectorAll('#onboarding-look select')]
      .map(choice => [choice.name, choice.value]));
  }

  let lookRenderer;
  function paintLook() {
    const look = chosenLook();
    document.getElementById('onboarding-look-preview').textContent =
      Object.keys(look).length ? lookSummary(look) : '';
    if (step !== 4) return;
    if (!lookRenderer) {
      const style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = '/look/app.css';
      document.head?.appendChild(style);
      lookRenderer = import('../look/app.mjs');
    }
    const own = generation;
    void lookRenderer.then(({createLookAvatar}) => {
      if (generation !== own || step !== 4) return;
      const graphic = createLookAvatar(chosenLook(), document);
      if (graphic) document.getElementById('look-avatar').replaceChildren(graphic);
    }).catch(() => {});
  }

  function applyState(next, {full = false} = {}) {
    data = {...data, ...next};
    if (full) {
      industries = data.industries || [];
      populateIndustries();
      fill(data.onboarding);
      automationCreation.render(data.automation_templates || []);
    }
    if (full || next.steps) renderSteps(data.steps);
    progress = savedProgress(data);
    syncFirstTask();
  }

  async function load() {
    const own = ++generation;
    if (writing) finishWriting(writing);
    user = null;
    data = null;
    firstTask.value = '';
    taskStatus.textContent = '';
    connections = null;
    loadingConnections = null;
    mainPanel.hidden = true;
    show('loading', '正在读取引导进度…');
    const sessionRequest = read('/v1/auth/session');
    const early = servedByDsBot(document) ? read('/v1/onboarding') : null;
    const session = await sessionRequest;
    if (generation !== own) return;
    if (session?.status === 401) {
      loginPanel.hidden = false;
      show('', '');
      return;
    }
    if (session?.status !== 200 || !session.body?.user?.username) {
      show('error', '暂时无法读取账号信息，请刷新重试。');
      return;
    }
    loginPanel.hidden = true;
    user = session.body.user;
    let result = await early;
    if (result?.status !== 200 || result.body?.viewer_username !== user.username) {
      result = await read('/v1/onboarding');
    }
    if (generation !== own) return;
    if (result?.status !== 200 || !result.body || (result.body.viewer_username && result.body.viewer_username !== user.username)) {
      show('error', messageFor(result?.body?.error, '暂时无法读取引导进度，请刷新重试。'));
      return;
    }
    const identity = document.getElementById('whoami');
    identity.textContent = user.username;
    identity.dataset.username = user.username;
    document.getElementById('onboarding-ready-name').textContent = user.username + '，';
    applyState(result.body, {full: true});
    show('', '');
    goStep(progress.step);
    mainPanel.hidden = false;
  }

  async function perform(message, action) {
    if (writing || !user || !data) return;
    const own = generation;
    const live = () => generation === own;
    const controls = [...document.querySelectorAll(
      '#onboarding-save,#onboarding-skip,#onboarding-steps [data-go],#onboarding-picks-form button[type="submit"],#onboarding-look-form button[type="submit"],#onboarding-first-task,#onboarding-enter',
    )];
    const before = controls.map(button => button.disabled);
    const task = {controls, before};
    writing = task;
    for (const button of controls) button.disabled = true;
    show('loading', message);
    try { await action(live); }
    catch { if (live()) show('error', '连接中断，请重试。'); }
    finally { finishWriting(task); }
  }

  function finishWriting(task) {
    if (writing !== task) return;
    writing = null;
    task.controls.forEach((button, index) => { button.disabled = task.before[index]; });
    syncProfileReady();
  }

  async function save(path, body, live, finishing = false) {
    const result = await send('POST', path, body).catch(error => {
      if (!finishing) throw error;
      return null;
    });
    if (!live()) return null;
    if (result?.status === 200 || result?.status === 201) return result.body;
    if (finishing && (!result || result.status === 408 || result.status >= 500)) {
      show('loading', '正在确认引导是否已保存…');
      const checked = await read('/v1/onboarding');
      if (!live()) return null;
      const saved = checked?.body;
      if (checked?.status === 200 && saved?.viewer_username === user.username &&
          saved.progress?.completed === true && Object.entries(body.look ?? {}).every(([name, value]) =>
            saved.steps?.look?.[name] === value)) return saved;
      show('error', '暂时无法确认引导是否已保存。请重试。');
      return null;
    }
    show('error', messageFor(result?.body?.error, '保存失败，请重试。'));
    return null;
  }

  function showFirstTaskError(text) {
    show('', '');
    taskStatus.textContent = text;
  }

  async function openPersonal(live, binding, firstMessage = '') {
    show('loading', '正在打开你的私人聊天…');
    let personal = (await binding)?.body?.personal_agent;
    let href = personalChatPath(personal);
    if (!live()) return;
    const foreign = () => personal?.workspace?.owner_id && personal.workspace.owner_id !== user.id;
    if (!foreign() && (!href || personal.runtime_provisioning?.readiness === 'setup')) {
      const result = await send('POST', '/v1/personal-agent', {});
      if (!live()) return;
      personal = [200, 201].includes(result.status) ? result.body?.personal_agent : null;
      href = personalChatPath(personal);
    }
    if (foreign()) {
      const message = '暂时无法确认个人工作区，请重新打开引导后重试。';
      if (firstMessage) showFirstTaskError(message);
      else show('error', message);
      return;
    }
    if (!href) {
      show('error', '引导已保存，暂时无法打开私人聊天。请重试。');
      return;
    }
    if (firstMessage) {
      const owner = user.id;
      if (!NATIVE_ID.test(owner || '')) {
        showFirstTaskError('暂时无法确认个人工作区，请重新打开引导后重试。');
        return;
      }
      const view = document.defaultView;
      const drafts = readChatDrafts(view, owner);
      const scope = JSON.stringify([owner, personal.workspace.id, 'agent', personal.agent.id, null]);
      const existing = drafts.get(scope);
      if (existing && existing !== firstMessage) {
        showFirstTaskError('私人聊天已有未发送草稿。请选择「直接打开聊天」处理原草稿。');
        firstTask.focus();
        return;
      }
      drafts.set(scope, firstMessage);
      // Chat resolves the latest owned conversation before applying the staged draft.
      if (!writeChatDrafts(view, owner, drafts) || !rememberColdDraftHandoff(view, scope)) {
        showFirstTaskError('浏览器无法暂存任务。请复制草稿后，选择「直接打开聊天」。');
        taskPreview.focus();
        taskPreview.select();
        return;
      }
    }
    navigate(href);
  }

  for (const button of document.querySelectorAll('#onboarding-steps [data-go]')) {
    button.addEventListener('click', () => {
      if (writing) return;
      const next = Number(button.dataset.go);
      if (step === 2 && next === 3) {
        void perform('正在保存进度…', async live => {
          const result = await save('/v1/onboarding/progress', {step: 3}, live);
          if (!result) return;
          applyState(result);
          show('', '');
          goStep(next, {focus: true});
        });
      } else {
        show('', '');
        goStep(next, {focus: true});
      }
    });
  }

  document.getElementById('onboarding-picks-form').addEventListener('submit', event => {
    event.preventDefault();
    const picks = [...document.querySelectorAll('#onboarding-picks input[name="pick"]:checked')].map(box => box.value);
    if (picks.length > 6) {
      show('error', '最多选择 6 项。');
      return;
    }
    void perform('正在保存选择…', async live => {
      const result = await save('/v1/onboarding/picks', {picks}, live);
      if (!result) return;
      applyState(result);
      show('', '');
      goStep(4, {focus: true});
    });
  });

  function saveLook(finish) {
    const firstMessage = finish ? taskPreview.value : '';
    void perform('正在保存形象…', async live => {
      taskStatus.textContent = '';
      const look = chosenLook();
      const saving = save('/v1/onboarding/look', finish ? {look, finish: true} : {look}, live, finish);
      const binding = finish ? read('/v1/personal-agent') : null;
      const result = await saving;
      if (!result) return;
      applyState(result);
      if (finish) await openPersonal(live, binding, firstMessage);
      else show('ok', '已保存个人智能体形象。');
    });
  }

  document.getElementById('onboarding-look-form').addEventListener('submit', event => {
    event.preventDefault();
    saveLook(false);
  });
  enter.addEventListener('click', () => saveLook(true));
  firstTask.addEventListener('change', () => {
    syncFirstTask();
    taskStatus.textContent = '';
  });

  select.addEventListener('change', () => {
    current = null;
    customRole.value = '';
    renderRoles();
    syncProfileReady();
  });
  customIndustry.addEventListener('input', syncProfileReady);
  customRole.addEventListener('input', syncProfileReady);

  form.addEventListener('submit', event => {
    event.preventDefault();
    const {industry, role} = profileValues();
    if (!industry) {
      show('error', '请选择或填写行业。');
      (select.value === '其他' ? customIndustry : select).focus();
      return;
    }
    if (!role) {
      show('error', '请选择或填写角色。');
      if (!customRoleLabel.hidden) customRole.focus();
      else roleChoices.querySelector('input[name="role"]')?.focus();
      return;
    }
    void perform('正在保存工作背景…', async live => {
      const result = await save('/v1/onboarding', {industry, role, completed: progress.completed}, live);
      if (!result) return;
      applyState(result, {full: true});
      show('', '');
      goStep(2, {focus: true});
    });
  });

  document.getElementById('onboarding-skip').addEventListener('click', () => {
    void perform('正在保存进度…', async live => {
      const saving = save('/v1/onboarding/progress', {completed: true}, live, true);
      const binding = read('/v1/personal-agent');
      const result = await saving;
      if (!result) return;
      applyState(result);
      await openPersonal(live, binding);
    });
  });

  const login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', async event => {
      event.preventDefault();
      const result = await send('POST', '/v1/auth/login', {
        username: login.elements.username.value,
        password: login.elements.password.value,
      });
      if (result.status !== 200) {
        show('error', messageFor(result.body && result.body.error, '无法登录。'));
        return;
      }
      login.reset();
      await load();
    });
  }

  const logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', async event => {
      event.preventDefault();
      await send('POST', '/v1/auth/logout', {});
      await load();
    });
  }

  document.defaultView?.addEventListener('pageshow', event => {
    if (event.persisted && step === 2) void loadConnections({refresh: true});
  });
  return {ready: load()};
}

if (typeof document !== 'undefined') {
  const mount = () => mountOnboarding(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
