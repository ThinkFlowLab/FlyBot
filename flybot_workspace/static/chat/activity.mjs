// The owner runtime returns a compact Bot Social snapshot. Fetch content only
// after the caller compares this snapshot with the data already on screen.
export function mountChatActivity(document, {request, update, interval = 2000}) {
  const notice = document.getElementById('chat-connection-notice');
  const status = document.getElementById('workspace-events-status');
  const retry = document.getElementById('workspace-events-retry');
  let state = null;

  function show(text) {
    if (status) status.textContent = text;
    if (notice) notice.hidden = !text;
  }

  function later(current, delay = interval) {
    clearTimeout(current.timer);
    if (document.visibilityState === 'hidden' || state !== current) return;
    current.timer = setTimeout(() => { void sync(current); }, delay);
    current.timer?.unref?.();
  }

  async function sync(current) {
    if (!current || current !== state || current.busy || document.visibilityState === 'hidden') return;
    current.busy = true;
    try {
      const query = new URLSearchParams({view: 'activity'});
      if (current.version) query.set('since', current.version);
      const result = await request('GET', `/v1/workspaces/${current.workspace}/social/conversations?${query}`);
      if (current !== state || document.visibilityState === 'hidden') return;
      if (result.status !== 200 || typeof result.body?.version !== 'string') throw new Error('Activity unavailable');
      if (Array.isArray(result.body.items)) current.items = result.body.items;
      current.version = result.body.version;
      current.failures = 0;
      show('');
      await update(current.workspace, current.items);
    } catch {
      if (current !== state || document.visibilityState === 'hidden') return;
      if (++current.failures >= 2) show('实时更新暂不可用');
    } finally {
      current.busy = false;
      later(current, current.failures >= 2 ? 8000 : interval);
    }
  }

  retry?.addEventListener('click', () => { void sync(state); });
  document.addEventListener('visibilitychange', () => {
    if (state && document.visibilityState === 'hidden') clearTimeout(state.timer);
    else void sync(state);
  });
  return {
    start(workspace) {
      if (state?.workspace === workspace) return;
      if (state) clearTimeout(state.timer);
      state = workspace ? {workspace, version: '', items: [], failures: 0, busy: false} : null;
      show('');
      if (state) later(state);
    },
  };
}
