import {teamInviteUrl} from '../shell/team-invite-link.mjs';

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function validName(value) {
  const name = (value || '').trim();
  return name.length >= 1 && name.length <= 60;
}

export function validSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(value || '');
}

export function step1Ready(values) {
  return validName(values.name) && validSlug(values.slug);
}

export function readWizard(form) {
  const data = new FormData(form);
  const mode = data.get('mode') || 'new';
  return {
    name: (data.get('name') || '').trim(),
    slug: (data.get('slug') || '').trim(),
    mode,
    workspace_id: mode === 'convert' ? (data.get('workspace_id') || '') : undefined,
  };
}

// The invite endpoint (POST /v1/workspaces/<id>/invites) takes a role and an
// expiry in seconds; its defaults are member and seven days.
const INVITE_EXPIRY = [86400, 604800, 2592000];
const INVITE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BATCH_LIMIT = 10;

export function parseInviteLines(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    const email = line.trim();
    const key = email.toLowerCase();
    if (email && !entries.has(key)) entries.set(key, {key, email, valid: email.length <= 254 && INVITE_EMAIL.test(email)});
  }
  return {entries: [...entries.values()].slice(0, BATCH_LIMIT), overflow: Math.max(0, entries.size - BATCH_LIMIT)};
}

export function inviteValues(document, prefix = 'invite') {
  const roleField = document.getElementById(prefix + '-role');
  const expiryField = document.getElementById(prefix + '-expiry');
  const expires = Number(expiryField ? expiryField.value : 0);
  return {
    role: roleField && roleField.value === 'admin' ? 'admin' : 'member',
    expires_in: INVITE_EXPIRY.includes(expires) ? expires : 604800,
  };
}

// The invite object has no email field, and the endpoint rejects unknown ones, so
// an address typed in the wizard only ever becomes a link in the user's own mail
// client. Nothing is sent to the server and no mail is claimed to be sent.
export function inviteMailto(email, teamName, url) {
  const address = (email || '').trim();
  if (!url || !INVITE_EMAIL.test(address) || /[\r\n]/.test(address)) return '';
  const subject = '邀请你加入团队「' + (teamName || 'FlyBot 团队') + '」';
  const body = '打开邀请，登录后确认加入：\n' + url;
  return 'mailto:' + encodeURIComponent(address) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}

// Renders the server's own invite object; it carries no email, so none is shown.
export function inviteSummary(invite) {
  if (!invite) return '';
  const role = invite.role === 'admin' ? '管理员' : '成员';
  const seconds = Number(invite.expires);
  const day = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 10) : '';
  const uses = Number.isFinite(Number(invite.max_uses)) ? Number(invite.max_uses) : 1;
  return [role, day ? '有效期至 ' + day : '', '最多使用 ' + uses + ' 次'].filter(Boolean).join(' · ');
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function idempotencyKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('wizard-form');
  let step = 1;
  let owned = [];
  let choicesLoading = true;
  let choicesFailed = false;
  let created = null;
  let creation = null;
  let busy = false;
  const batch = new Map();
  const batchButton = document.getElementById('batch-invite');
  const batchSummary = document.getElementById('batch-summary');
  const batchList = document.getElementById('batch-results');

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders, signal) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const response = await fetcher(path, {
      method, headers, signal, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function syncContinue() {
    const values = readWizard(form);
    document.getElementById('next').disabled = !step1Ready(values) ||
      (values.mode === 'convert' && !owned.some(item => item.id === values.workspace_id));
  }

  function syncConvertPicker() {
    const values = readWizard(form);
    const converting = values.mode === 'convert';
    const needsPicker = converting && owned.length > 1;
    const note = document.getElementById('convert-workspace-note');
    const field = document.getElementById('convert-workspace-field');
    const option = document.getElementById('convert-mode');
    option.disabled = owned.length === 0;
    note.hidden = !converting && owned.length > 0;
    note.textContent = choicesLoading ? '正在检查可转换的工作区…' :
      choicesFailed ? '暂时无法读取可转换的工作区，请刷新后重试。' :
      !owned.length ? '没有可转换的工作区。个人工作区用于你的专属智能体。' :
      owned.length === 1 ? '将转换「' + owned[0].name + '」。' : '选择要转换为团队的工作区。';
    field.hidden = !needsPicker;
  }

  function renderStep() {
    document.getElementById('step-1').hidden = step !== 1;
    document.getElementById('step-2').hidden = step !== 2;
    document.getElementById('step-3').hidden = step !== 3;
    const back = document.getElementById('back');
    back.hidden = step !== 2 || Boolean(created);
    back.disabled = busy;
    document.getElementById('next').hidden = step !== 1;
    const submit = document.getElementById('submit');
    submit.hidden = step !== 2;
    submit.disabled = busy;
    submit.textContent = created ? '生成邀请链接' : '创建团队并生成邀请';
    const skip = document.getElementById('invite-skip');
    skip.hidden = step !== 2;
    skip.disabled = busy;
    skip.textContent = created ? '完成，稍后邀请' : '跳过，只建团队';
    document.getElementById('step-2').setAttribute('aria-busy', String(busy));
    const label = document.getElementById('wizard-step-label');
    if (label) label.textContent = '第 ' + step + ' / 3 步';
    const progress = document.getElementById('wizard-progress');
    if (progress && progress.querySelectorAll) {
      const dots = progress.querySelectorAll('.wizard-dots span');
      for (let index = 0; index < dots.length; index += 1) {
        if (dots[index].classList) dots[index].classList.toggle('is-current', index === step - 1);
      }
    }
    syncContinue();
    syncConvertPicker();
  }

  function resetWizard() {
    step = 1;
    created = null;
    creation = null;
    busy = false;
    document.getElementById('invite-result').hidden = true;
    document.getElementById('invite-summary').textContent = '';
    document.getElementById('invite-token').value = '';
    document.getElementById('invite-mailto').hidden = true;
    batch.clear();
    batchButton.disabled = false;
    batchList.replaceChildren();
    batchSummary.textContent = '';
    document.getElementById('batch-invites').open = false;
    form.reset();
    form.elements.mode.value = 'new';
    renderStep();
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    loginPanel.hidden = true;
    const whoami = document.getElementById('whoami');
    if (whoami) whoami.textContent = session.body.user.username;
    choicesLoading = true;
    choicesFailed = false;
    owned = [];
    renderStep();
    mainPanel.hidden = false;
    const listed = await request('GET', '/v1/workspaces?scope=convertible&limit=100').catch(() => null);
    choicesLoading = false;
    choicesFailed = listed?.status !== 200;
    const items = Array.isArray(listed?.body?.items) ? listed.body.items : [];
    owned = items.filter(item => item.owner_id === session.body.user.id && item.kind === 'workspace');
    const select = form.elements.workspace_id;
    const previous = select.value;
    select.textContent = '';
    for (const item of owned) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      select.appendChild(option);
    }
    if (previous && owned.some(item => item.id === previous)) select.value = previous;
    renderStep();
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  form.addEventListener('input', () => {
    syncContinue();
    syncConvertPicker();
  });
  form.addEventListener('change', () => {
    syncContinue();
    syncConvertPicker();
  });

  function advance() {
    const values = readWizard(form);
    if (!step1Ready(values)) {
      show('error', '请先填好团队名称和 Team ID。');
      return;
    }
    if (values.mode === 'convert' && !owned.some(item => item.id === values.workspace_id)) {
      show('error', '当前没有可转换的工作区。');
      return;
    }
    show('', '');
    step = 2;
    renderStep();
  }

  async function createAndInvite(withInvite) {
    if (busy || step !== 2) return;
    const values = readWizard(form);
    if (!step1Ready(values)) {
      show('error', '请先填好团队名称和 Team ID。');
      step = 1;
      renderStep();
      return;
    }
    if (values.mode === 'convert' && !owned.some(item => item.id === values.workspace_id)) {
      show('error', '当前没有可转换的工作区。');
      return;
    }
    busy = true;
    renderStep();
    show('loading', created ? '正在生成邀请链接…' : '正在创建团队…');
    try {
      if (!created) {
        const body = {name: values.name, slug: values.slug, mode: values.mode};
        if (values.mode === 'convert') body.workspace_id = values.workspace_id;
        const draft = JSON.stringify(body);
        if (creation?.draft !== draft) creation = {draft, key: idempotencyKey()};
        const result = await request('POST', '/v1/teams', body, {'Idempotency-Key': creation.key});
        if (result.status !== 200 && result.status !== 201) {
          show('error', result.status >= 500 ? '暂时无法确认团队是否创建，请重试。' :
            messageFor(result.body.error, '创建团队失败。'));
          return;
        }
        const workspace = result.body.workspace || {};
        if (!workspace.id) {
          show('error', '创建团队失败：响应里没有工作区。');
          return;
        }
        created = workspace;
        const hash = '#workspace=' + encodeURIComponent(created.id);
        document.getElementById('finish-members').setAttribute('href', '/members' + hash);
        document.getElementById('finish-chat').setAttribute('href', '/chat' + hash);
        document.getElementById('created-team-name').textContent = created.name;
        document.getElementById('created-team-name').hidden = !created.name;
        renderStep();
      }
      if (!withInvite) {
        step = 3;
        show('', '');
        renderStep();
        document.getElementById('finish-members').focus();
        return;
      }
      show('loading', '团队已创建，正在生成邀请链接…');
      const result = await request('POST', '/v1/workspaces/' + created.id + '/invites', inviteValues(document));
      if (result.status !== 201) {
        // The team exists by now; say so instead of implying nothing happened.
        show('error', result.status >= 500 ? '团队已创建。暂时无法确认邀请是否生成，可以稍后在成员页查看。' :
          '团队已创建。' + messageFor(result.body.error, '无法生成邀请链接。'));
        return;
      }
      document.getElementById('invite-summary').textContent = inviteSummary(result.body.invite);
      const url = teamInviteUrl(result.body.token, document.defaultView?.location?.origin);
      document.getElementById('invite-token').value = url;
      document.getElementById('copy-invite').disabled = !url;
      const mail = document.getElementById('invite-mailto');
      if (mail) {
        const address = (document.getElementById('invite-email') || {}).value || '';
        const href = inviteMailto(address, created.name, url);
        mail.hidden = !href;
        if (href) {
          mail.setAttribute('href', href);
          mail.textContent = '写邮件给 ' + address.trim();
        }
      }
      document.getElementById('invite-result').hidden = false;
      step = 3;
      show('', '');
      renderStep();
      document.getElementById('copy-invite').focus();
    } catch {
      show('error', created ? '团队已创建。暂时无法确认邀请是否生成，可以稍后在成员页查看。' :
        '暂时无法确认团队是否创建，请重试。');
    } finally {
      busy = false;
      renderStep();
    }
  }

  document.getElementById('next').addEventListener('click', () => {
    advance();
  });

  document.getElementById('back').addEventListener('click', () => {
    if (busy || created || step !== 2) return;
    step = 1;
    show('', '');
    renderStep();
  });

  document.getElementById('invite-skip').addEventListener('click', () => createAndInvite(false));

  async function copyInvite(field, announce) {
    if (!field.value) return;
    try {
      await globalThis.navigator.clipboard.writeText(field.value);
      announce('ok', '已复制邀请链接。');
    } catch {
      field.select();
      announce('error', '请复制选中的链接。');
    }
  }

  document.getElementById('copy-invite').addEventListener('click', () => copyInvite(document.getElementById('invite-token'), show));

  async function generateInvite(entry, result, workspace, values) {
    if (!entry.valid) {
      result.state = 'failed';
      result.row.dataset.state = 'failed';
      result.status.textContent = '邮箱格式不正确。';
      return;
    }
    result.status.textContent = '正在生成邀请链接…';
    let response;
    try {
      response = await request('POST', '/v1/workspaces/' + workspace.id + '/invites', values, {}, AbortSignal.timeout(15000));
    } catch {
      response = {status: 0};
    }
    if (created !== workspace) return;
    const url = response.status === 201 ? teamInviteUrl(response.body.token, document.defaultView?.location?.origin) : '';
    if (url) {
      result.state = 'ok';
      result.status.textContent = inviteSummary(response.body.invite);
      const field = document.createElement('input');
      field.type = 'url';
      field.readOnly = true;
      field.value = url;
      field.setAttribute('aria-label', entry.email + ' 的邀请链接');
      const label = document.createElement('label');
      label.className = 'wizard-field';
      label.append(field);
      const controls = document.createElement('div');
      controls.className = 'actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制邀请链接';
      copy.addEventListener('click', () => copyInvite(field, (_kind, text) => {batchSummary.textContent = text;}));
      const mail = document.createElement('a');
      mail.href = inviteMailto(entry.email, workspace.name, url);
      mail.textContent = '打开邮件草稿';
      controls.append(copy, mail);
      result.row.append(label, controls);
    } else if (!response.status || response.status === 201 || response.status >= 500 || response.status === 408) {
      result.state = 'unknown';
      result.status.textContent = '暂时无法确认是否生成，请在成员页检查。';
    } else {
      result.state = 'failed';
      result.status.textContent = messageFor(response.body?.error, '无法生成邀请链接。');
    }
    result.row.dataset.state = result.state;
  }

  batchButton.addEventListener('click', async () => {
    if (busy || step !== 3 || !created) return;
    const source = document.getElementById('batch-emails');
    const {entries, overflow} = parseInviteLines(source.value);
    if (!entries.length) {
      batchSummary.textContent = '请填写收件人邮箱。';
      source.focus();
      return;
    }
    const workspace = created;
    const values = {...inviteValues(document, 'batch'), max_uses:1};
    busy = true;
    batchButton.disabled = true;
    batchSummary.textContent = '正在生成邀请链接…';
    try {
      for (const entry of entries) {
        if (created !== workspace) return;
        let result = batch.get(entry.key);
        if (result?.state === 'ok' || result?.state === 'unknown') continue;
        if (!result) {
          const row = document.createElement('li');
          const email = document.createElement('strong');
          email.textContent = entry.email;
          const status = document.createElement('p');
          row.append(email, status);
          result = {row, status};
          batch.set(entry.key, result);
          batchList.append(row);
        }
        await generateInvite(entry, result, workspace, values);
      }
      if (created !== workspace) return;
      const counts = {ok:0, failed:0, unknown:0};
      for (const {key} of entries) counts[batch.get(key).state] += 1;
      batchSummary.textContent = [
        '已生成 ' + counts.ok + ' 条。',
        counts.failed ? counts.failed + ' 行未生成。' : '',
        counts.unknown ? counts.unknown + ' 行待确认。' : '',
        overflow ? '另有 ' + overflow + ' 行超出本批上限。' : '',
      ].filter(Boolean).join(' ');
    } finally {
      if (created === workspace) {
        busy = false;
        batchButton.disabled = false;
      }
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (step === 1) {
      advance();
      return;
    }
    if (step === 2) await createAndInvite(true);
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    resetWizard();
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('wizard-form')) {
  mount(globalThis.document);
}
