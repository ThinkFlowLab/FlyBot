// Read from the browser only: the download page never asks the server to guess
// the visitor's platform, and an unrecognised agent is reported as unknown
// rather than as a plausible-looking default.
export function platformLabel(navigatorLike) {
  const ua = (navigatorLike && navigatorLike.userAgent) || '';
  const platform = (navigatorLike && navigatorLike.platform) || '';
  const source = ua + ' ' + platform;
  let os = '';
  if (/iPhone|iPad|iPod/i.test(source)) os = 'iOS';
  else if (/Android/i.test(source)) os = 'Android';
  else if (/Macintosh|Mac OS X|MacIntel/i.test(source)) os = 'macOS';
  else if (/Windows/i.test(source)) os = 'Windows';
  else if (/Linux|X11/i.test(source)) os = 'Linux';
  let browser = '';
  if (/Edg\//i.test(source)) browser = 'Edge';
  else if (/OPR\//i.test(source)) browser = 'Opera';
  else if (/Chrome\//i.test(source)) browser = 'Chrome';
  else if (/Firefox\//i.test(source)) browser = 'Firefox';
  else if (/Safari\//i.test(source)) browser = 'Safari';
  if (!os && !browser) return '未知平台';
  return [os, browser].filter(Boolean).join(' · ');
}

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
  const payload = await response.json();
  return { status: response.status, body: payload };
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const whoami = document.getElementById('whoami');
  const form = document.getElementById('login-form');
  if (!status || !loginPanel || !mainPanel || !form) return;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    if (session.status !== 200 || !session.body.user) {
      show('error', messageFor(session.body && session.body.error, '无法读取会话。'));
      return;
    }
    const username = session.body.user.username;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    whoami.dataset.username = username;
    whoami.textContent = username;
    const platform = document.getElementById('download-platform-value');
    if (platform) platform.textContent = platformLabel(globalThis.navigator || {});
    const command = document.getElementById('daemon-command');
    if (command) command.textContent = command.textContent.replaceAll('__ORIGIN__', location.origin);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: form.elements.username.value,
      password: form.elements.password.value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body && result.body.error, '无法登录。'));
      return;
    }
    form.reset();
    await load();
  });

  const logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', async event => {
      event.preventDefault();
      const result = await request('POST', '/v1/auth/logout', {});
      if (result.status !== 200 && result.status !== 204) {
        show('error', messageFor(result.body && result.body.error, '无法退出登录。'));
        return;
      }
      show('ok', '已退出登录。');
      await load();
    });
  }

  load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
