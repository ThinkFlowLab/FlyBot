export function sourceHref(workspace, source) {
  if (source?.kind === 'meeting') {
    if (![workspace, source.meeting_id].every(id => /^[0-9a-f]{32}$/.test(id || ''))) return '';
    return '/meetings#' + new URLSearchParams({workspace, meeting:source.meeting_id});
  }
  if (source?.kind === 'group') {
    const valid = /^[0-9a-f]{32}$/.test(workspace) &&
      [source.conversation_id,source.message_id].every(id => /^[A-Za-z0-9._-]{1,80}$/.test(id || ''));
    return valid ? '/chat#' + new URLSearchParams({workspace,social:source.conversation_id,message:source.message_id}) : '';
  }
  if (![workspace,source?.agent_id,source?.conversation_id,source?.message_id].every(id => /^[0-9a-f]{32}$/.test(id || ''))) return '';
  return '/chat#' + new URLSearchParams({workspace, agent:source.agent_id, conversation:source.conversation_id, message:source.message_id});
}

export function mountCandidates(document, {request, workspaceId}) {
  const panel = document.getElementById('memory-candidates');
  if (!panel) return {show() {}};
  const get = id => document.getElementById(id);
  const toggle = get('memory-capture-toggle');
  const list = get('memory-candidates-list');
  const status = get('memory-candidates-status');
  const review = get('memory-candidate-review');
  const error = get('memory-review-error');
  let workspace = '';
  let generation = 0;
  let selected = null;
  let enabled = false;
  let groupCapture = false;
  let watchSources = false;
  let loading = false;
  let writing = false;
  let timer;
  const base = () => `/v1/workspaces/${workspace}/memory/candidates`;
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };

  function open(item) {
    selected = item;
    get('memory-review-name').value = item.title;
    get('memory-review-body').value = item.body;
    const link = get('memory-review-source');
    link.href = sourceHref(workspace, item.source);
    link.textContent = '查看原消息 · ' + (item.source.title || (item.source.kind === 'group' ? '群聊' : '智能体私聊'));
    link.hidden = false;
    get('memory-review-excerpt').hidden = false;
    get('memory-review-excerpt').textContent = item.source.excerpt || '';
    get('memory-review-save').disabled = false;
    error.textContent = '';
    review.showModal();
    if (item.source.kind === 'group') void load();
  }

  function refresh() {
    clearTimeout(timer);
    if (workspace && (enabled || groupCapture || watchSources || status.dataset.pending === 'true')) {
      timer = setTimeout(() => void load(), 7000);
    }
  }

  async function load() {
    if (!workspace || loading || writing) return;
    const token = generation;
    loading = true;
    try {
      const result = await request('GET', base());
      if (generation !== token || writing) return;
      if (result.status !== 200) throw new Error();
      enabled = result.body.enabled === true;
      groupCapture = result.body.group_capture === true;
      toggle.disabled = false;
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.textContent = enabled ? '私聊提炼已开启' : '开启私聊提炼';
      const items = result.body.items || [];
      const invalidated = result.body.invalidated || [];
      const sourcePending = result.body.source_check_pending === true;
      const queue = result.body.queued || 0;
      watchSources = sourcePending || items.some(item => item.source?.kind === 'group');
      let reviewClosed = false;
      if (selected?.source.kind === 'group') {
        const stillAvailable = items.some(item => item.id === selected.id);
        if (invalidated.includes(selected.id) || (!stillAvailable && !sourcePending)) {
          close();
          reviewClosed = true;
        } else {
          const pending = !stillAvailable;
          get('memory-review-source').hidden = pending;
          get('memory-review-excerpt').hidden = pending;
          get('memory-review-save').disabled = pending;
          if (pending || error.dataset.sourcePending === 'true') error.textContent = pending ? '暂时无法核对群聊来源，正在重试。' : '';
          error.dataset.sourcePending = String(pending);
        }
      }
      status.dataset.pending = String(queue > 0);
      status.textContent = sourcePending ? '部分群聊来源暂时无法核对，正在重试。'
        : queue > 0 ? `正在提炼 · ${queue} 条消息`
        : invalidated.length ? `${invalidated.length} 条群聊建议已失效。`
        : reviewClosed && !invalidated.length ? '这条建议已处理。'
        : items.length ? ''
        : groupCapture || enabled ? '暂无待核对的建议。' : '可在此开启私聊提炼，或前往群记忆开启群聊提炼。';
      list.replaceChildren(...items.map(item => {
        const row = node('li');
        const button = node('button', '核对建议');
        button.type = 'button';
        button.setAttribute('aria-label', '核对建议 · ' + item.title);
        button.addEventListener('click', () => open(item));
        row.append(node('strong', item.title));
        if (item.source?.kind === 'group') {
          const provenance = node('small', (item.source.automatic ? '群聊自动提炼 · ' : '群聊提炼 · ') + (item.source.title || '群聊'));
          provenance.className = 'note';
          row.append(provenance);
        }
        row.append(node('p', item.body), button);
        return row;
      }), ...invalidated.map(id => {
        const row = node('li');
        const remove = node('button', '移除失效建议');
        remove.type = 'button';
        remove.addEventListener('click', () => void decide('ignore', {id}, remove));
        row.append(node('strong', '群聊来源已变更或无法访问'), node('p', '可前往群聊重新选择消息提炼。'), remove);
        return row;
      }));
      if (reviewClosed) list.querySelector('button')?.focus();
    } catch {
      if (generation === token) status.textContent = '无法读取记忆建议。';
    } finally {
      if (generation === token) { loading = false; refresh(); }
    }
  }

  toggle.addEventListener('click', async () => {
    if (writing || !workspace) return;
    const token = ++generation;
    loading = false;
    let saved = false;
    writing = true;
    toggle.disabled = true;
    try {
      const result = await request('POST', base(), {enabled:!enabled});
      if (generation !== token) return;
      if (result.status !== 200) throw new Error();
      enabled = result.body.enabled;
      saved = true;
    } catch {
      if (generation === token) status.textContent = '开关未保存，请重试。';
    } finally {
      if (generation === token) {
        writing = false;
        toggle.disabled = false;
        if (saved) void load();
      }
    }
  });

  const close = () => {
    selected = null;
    if (review.open) review.close();
    get('memory-review-name').value = '';
    get('memory-review-body').value = '';
    get('memory-review-source').removeAttribute('href');
    get('memory-review-source').textContent = '';
    get('memory-review-excerpt').textContent = '';
    error.textContent = '';
    error.dataset.sourcePending = 'false';
  };
  get('memory-review-close').addEventListener('click', close);
  review.addEventListener('cancel', event => { event.preventDefault(); if (!writing) close(); });
  async function decide(action, item = selected, remove = null) {
    if (!item || writing || !workspace || (action === 'save' && get('memory-review-save').disabled)) return;
    const scope = workspace;
    const token = ++generation;
    loading = false;
    const path = base() + '/' + item.id;
    const body = action === 'save' ? {action, title:get('memory-review-name').value.trim(), body:get('memory-review-body').value} : {action};
    writing = true;
    const feedback = remove ? status : error;
    feedback.textContent = action === 'save' ? '正在保存…' : remove ? '正在移除…' : '正在忽略…';
    const buttons = remove ? [remove] : ['close','save','ignore'].map(id => get('memory-review-' + id));
    buttons.forEach(button => {button.disabled = true;});
    let saved = false;
    try {
      const result = await request('POST',path,body);
      if (generation !== token) return;
      if (![200,201].includes(result.status)) {
        if (result.body.error?.code === 'source_changed') {
          close();
          list.replaceChildren();
          status.textContent = '群聊来源已变更或无法访问，请重新选择消息提炼。';
        } else feedback.textContent = result.body.error?.message || '无法处理这条建议，请重试。';
        return;
      }
      close();
      saved = result.body.page?.id || false;
    } catch {
      if (generation === token) feedback.textContent = '无法处理这条建议，请重试。';
    } finally {
      if (generation === token) {
        buttons.forEach(button => {button.disabled = false;});
        writing = false;
        if (saved) document.defaultView.location.assign('/memory?' + new URLSearchParams({workspace:scope,page:saved}));
        else void load();
      }
    }
  }
  get('memory-candidate-form').addEventListener('submit', event => {event.preventDefault(); void decide('save');});
  get('memory-review-ignore').addEventListener('click', () => void decide('ignore'));
  document.defaultView?.addEventListener?.('focus', () => { if (watchSources) void load(); });

  return {show(active) {
    const scope = active ? workspaceId() : '';
    panel.hidden = !active;
    if (scope === workspace) return;
    workspace = scope;
    generation += 1;
    clearTimeout(timer);
    close();
    loading = false;
    writing = false;
    enabled = false;
    groupCapture = false;
    watchSources = false;
    toggle.disabled = true;
    toggle.setAttribute('aria-pressed','false');
    toggle.textContent = '开启私聊提炼';
    status.dataset.pending = 'false';
    status.textContent = scope ? '正在加载记忆建议…' : '';
    list.replaceChildren();
    ['close','save','ignore'].forEach(id => {get('memory-review-' + id).disabled = false;});
    if (scope) void load();
  }};
}
