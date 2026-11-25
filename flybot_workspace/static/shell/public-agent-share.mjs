const PROFILE_PATH = /^\/a\/[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

function publicProfileUrl(origin, path) {
  if (typeof path !== 'string' || PROFILE_PATH.exec(path)?.[0] !== path) return '';
  try {
    const url = new URL(path, origin);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function mountPublicAgentShare(document) {
  const panel = document.getElementById('public-agent-share');
  const button = panel?.querySelector('[data-copy-profile]');
  const status = panel?.querySelector('[data-copy-profile-status]');
  const fallback = panel?.querySelector('[data-copy-profile-fallback]');
  const input = panel?.querySelector('[data-copy-profile-url]');
  const view = document.defaultView;
  const url = publicProfileUrl(view?.location.origin, panel?.dataset.profilePath);
  if (!url || !button || !status || !fallback || !input) return;

  function show(message) {
    status.hidden = false;
    status.textContent = message;
  }

  let copying = false;
  button.addEventListener('click', async () => {
    if (copying) return;
    copying = true;
    const focused = document.activeElement;
    show('正在复制链接…');
    try {
      await view.navigator.clipboard.writeText(url);
      show('公开主页链接已复制。');
    } catch {
      fallback.open = true;
      show('可手动复制下方的主页链接。');
      if (document.activeElement === focused) {
        input.focus();
        input.select();
      }
    } finally {
      copying = false;
    }
  });
  input.addEventListener('click', () => input.select());
  input.value = url;
  button.disabled = false;
  button.hidden = false;
}

if (typeof document !== 'undefined') mountPublicAgentShare(document);
