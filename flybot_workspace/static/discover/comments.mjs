const COMMENT_LIMIT = 2000;
const PAGE_SIZE = 12;
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
});

export function commentsLabel(count) {
  return Number.isSafeInteger(count) && count > 0 ? '评论 · ' + count : '评论';
}

function newPage() {
  return {items: [], cursor: '', ready: false, loading: false, error: '', retryAppend: false};
}

function mergeComments(current, incoming) {
  const seen = new Set(current.map(comment => comment.id));
  return current.concat(incoming.filter(comment => {
    if (!comment?.id || seen.has(comment.id)) return false;
    seen.add(comment.id);
    return true;
  }));
}

function chronologicalReplies(items) {
  return items.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : Number(a.id > b.id)));
}

function failure(status, fallback) {
  if (status === 401 || status === 403) return '当前账号无法完成此操作。';
  if (status === 429) return '操作过于频繁，请稍后重试。';
  return fallback;
}

export function mountWorkComments(document, {request, onCount, loginHref}) {
  const get = suffix => document.getElementById('feed-comments-' + suffix);
  const dialog = get('dialog');
  const title = get('title');
  const workLink = get('work');
  const closeButton = get('close');
  const list = get('list');
  const status = get('status');
  const readStatus = get('read-status');
  const empty = get('empty');
  const more = get('more');
  const form = get('form');
  const input = get('input');
  const submit = get('submit');
  const login = get('login');
  const replyTarget = get('reply-target');
  const replyName = get('reply-name');
  const cancelReply = get('cancel-reply');
  const retryPost = get('retry-post');
  const states = new Map();
  let actor = '';
  let accountId = '';
  let active;
  let opener;
  let focusButtons = new Map();

  const pathFor = state => state.actor
    ? '/v1/discover/works/' + state.slug + '/comments'
    : '/w/' + state.slug + '/comments';
  const writePath = (state, id, action) => pathFor(state) + '/' + encodeURIComponent(id) + '/' + action;

  function pageFor(state, parentId) {
    if (!state.pages.has(parentId)) state.pages.set(parentId, newPage());
    return state.pages.get(parentId);
  }

  function findComment(state, id) {
    for (const page of state.pages.values()) {
      const comment = page.items.find(row => row.id === id);
      if (comment) return comment;
    }
  }

  function setCount(state, count) {
    if (!Number.isSafeInteger(count) || count < 0 || states.get(state.slug) !== state) return;
    state.count = count;
    onCount(state.slug, count);
  }

  function openButton(label, className, action, focusId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    if (focusId) {
      button.dataset.commentFocus = focusId;
      focusButtons.set(focusId, button);
    }
    button.addEventListener('click', action);
    return button;
  }

  function renderComment(state, comment) {
    const row = document.createElement('li');
    row.className = 'feed-comment';
    row.dataset.commentId = comment.id;
    const head = document.createElement('p');
    head.className = 'feed-comment-author';
    const name = document.createElement('strong');
    name.textContent = comment.removed ? '已删除' : (comment.author?.name || comment.author?.handle || '用户');
    head.append(name);
    if (comment.created_at) {
      const time = document.createElement('time');
      const date = new Date(comment.created_at);
      if (Number.isFinite(date.getTime())) {
        time.dateTime = date.toISOString();
        time.textContent = timeFormat.format(date);
        head.append(time);
      }
    }
    const copy = document.createElement('p');
    copy.className = 'feed-comment-body';
    copy.textContent = comment.removed ? '这条评论已删除。' : comment.body;
    row.append(head, copy);

    const {id} = comment;
    const actions = document.createElement('div');
    actions.className = 'feed-comment-actions';
    if (state.actor && !comment.removed) {
      const like = openButton((comment.liked ? '取消点赞' : '点赞') + (comment.likes ? ' · ' + comment.likes : ''),
        'feed-comment-like', () => mutate(state, comment, 'like'), 'like:' + id);
      like.setAttribute('aria-pressed', String(Boolean(comment.liked)));
      like.disabled = Boolean(state.busy);
      actions.append(like);
      if (!comment.parent_id) {
        const reply = openButton('回复', 'feed-comment-reply', () => {
          state.replyTo = {id, name: name.textContent};
          state.error = '';
          state.notice = '';
          saveComposer(state);
          drawComposer(state);
          input.focus?.();
        }, 'reply:' + id);
        reply.disabled = state.busy === 'send';
        actions.append(reply);
      }
      if (comment.can_remove) {
        if (state.confirm === id) {
          const confirm = openButton('确认删除', 'feed-comment-confirm',
            () => mutate(state, comment, 'remove'), 'remove:' + id);
          confirm.disabled = Boolean(state.busy);
          actions.append(confirm, openButton('取消', 'feed-comment-cancel', () => {
            state.confirm = '';
            render(state);
          }));
        } else {
          const remove = openButton('删除', 'feed-comment-remove', () => {
            state.confirm = id;
            render(state);
          }, 'remove:' + id);
          remove.disabled = Boolean(state.busy);
          actions.append(remove);
        }
      }
    }
    const showReplies = state.replies.has(id);
    if (!comment.parent_id && (comment.reply_count || showReplies)) {
      const replies = openButton(showReplies ? '收起回复' : '查看 ' + comment.reply_count + ' 条回复',
        'feed-comment-replies-toggle', () => {
          if (state.replies.delete(id)) {
            render(state);
          } else {
            state.replies.add(id);
            void readPage(state, id);
          }
        }, 'replies:' + id);
      replies.setAttribute('aria-expanded', String(showReplies));
      replies.setAttribute('aria-controls', 'feed-comment-replies-' + id);
      actions.append(replies);
    }
    if (actions.childElementCount) row.append(actions);

    if (showReplies) {
      const box = document.createElement('div');
      box.id = 'feed-comment-replies-' + id;
      box.className = 'feed-comment-replies';
      const page = pageFor(state, id);
      const thread = document.createElement('ul');
      thread.className = 'feed-comments-thread';
      drawRows(state, thread, page, id);
      box.append(thread);
      if (page.loading || page.error) {
        const feedback = document.createElement('p');
        feedback.className = 'feed-comment-load-status';
        feedback.setAttribute('role', 'status');
        feedback.textContent = page.loading ? '正在加载回复…' : page.error;
        box.append(feedback);
      }
      if (!page.loading && (page.cursor || page.error)) {
        box.append(openButton(page.error ? '重试' : '加载更多回复', 'feed-comment-more-replies',
          () => readPage(state, id, Boolean(page.error ? page.retryAppend : page.cursor)), 'more:' + id));
      }
      row.append(box);
    }
    return row;
  }

  function drawRows(state, container, page, parentId) {
    const nodes = page.items.map(comment => renderComment(state, comment));
    if (state.pending?.parentId === parentId) {
      const pending = document.createElement('li');
      pending.className = 'feed-comment is-pending';
      const body = document.createElement('p');
      body.className = 'feed-comment-body';
      body.textContent = state.pending.body;
      const indicator = document.createElement('p');
      indicator.className = 'feed-comment-load-status';
      indicator.textContent = '发送中…';
      pending.append(body, indicator);
      if (parentId) nodes.push(pending);
      else nodes.unshift(pending);
    }
    container.replaceChildren(...nodes);
  }

  function drawComposer(state) {
    if (active !== state) return;
    form.hidden = !state.actor || state.unavailable;
    login.hidden = Boolean(state.actor) || state.unavailable;
    replyTarget.hidden = !state.replyTo;
    replyName.textContent = state.replyTo ? '回复 ' + state.replyTo.name : '';
    cancelReply.disabled = state.busy === 'send';
    if (input.value !== state.draft) input.value = state.draft;
    submit.disabled = Boolean(state.busy) || !state.draft.trim() || state.unavailable;
    const retryInComposer = retryForDraft(state);
    submit.textContent = retryInComposer ? '重试发送' : '发送';
    retryPost.hidden = state.retries.every(attempt => attempt === retryInComposer);
    retryPost.disabled = Boolean(state.busy) || state.unavailable;
  }

  function render(state) {
    if (active !== state) return;
    const focusId = document.activeElement?.dataset?.commentFocus;
    focusButtons = new Map();
    const root = pageFor(state, null);
    drawRows(state, list, root, null);
    list.setAttribute('aria-busy', String(root.loading));
    title.textContent = commentsLabel(state.count);
    status.textContent = state.error || (state.pending ? '正在发送评论…' : state.notice);
    status.dataset.kind = state.error ? 'error' : '';
    readStatus.textContent = root.error || (root.loading ? '正在加载评论…' : '');
    empty.hidden = state.unavailable || !root.ready || root.loading || Boolean(root.error) ||
      root.items.length > 0 || state.pending?.parentId === null;
    more.hidden = state.unavailable || (!root.cursor && !root.error);
    more.disabled = root.loading;
    more.textContent = root.error ? '重试' : '加载更多评论';
    drawComposer(state);
    if (focusId) focusButtons.get(focusId)?.focus?.({preventScroll: true});
  }

  function unavailable(state) {
    state.unavailable = true;
    state.revision += 1;
    state.pages.clear();
    state.replies.clear();
    state.error = '这件作品已下架或不可访问。';
  }

  async function readPage(state, parentId = null, append = false) {
    const page = pageFor(state, parentId);
    if (page.loading || state.unavailable) return;
    const version = state.revision;
    const params = new URLSearchParams({limit: String(PAGE_SIZE)});
    if (parentId) params.set('parent_id', parentId);
    if (append && page.cursor) params.set('cursor', page.cursor);
    page.loading = true;
    page.error = '';
    render(state);

    const result = await request('GET', pathFor(state) + '?' + params).catch(() => ({status: 0}));
    page.loading = false;
    if (states.get(state.slug) !== state || state.unavailable || state.pages.get(parentId) !== page) return;
    if (version !== state.revision) return readPage(state, parentId, append);
    if (result.status === 200 && Array.isArray(result.body?.items)) {
      page.items = mergeComments(append ? page.items : [], result.body.items);
      if (parentId) chronologicalReplies(page.items);
      page.cursor = result.body.cursor || '';
      page.ready = true;
      setCount(state, result.body.comment_count);
    } else if (result.status === 404 && parentId === null) {
      unavailable(state);
    } else {
      page.error = failure(result.status, parentId ? '无法读取回复。' : '无法读取评论。');
      page.retryAppend = append;
    }
    render(state);
  }

  async function send(state, retry = null) {
    const previous = retry ?? retryForDraft(state);
    const body = previous?.body ?? state.draft.trim();
    const reply = previous ? previous.reply : state.replyTo;
    const parentId = reply?.id ?? null;
    if (state.busy || !state.actor || state.unavailable || !body || body.length > COMMENT_LIMIT) return;
    const pending = previous ?? {body, parentId, reply, key: newCommentKey()};
    if (!previous) state.retries.unshift(pending);
    const fromComposer = !retry;
    if (fromComposer) state.draft = '';
    state.busy = 'send';
    state.pending = pending;
    state.error = '';
    state.notice = '';
    if (parentId) state.replies.add(parentId);
    render(state);
    // Save the request key before the server can commit a write whose response may be lost.
    saveComposer(state);

    const payload = parentId ? {body, parent_id: parentId} : {body};
    const result = await request('POST', pathFor(state), payload, {'Idempotency-Key': pending.key}, AbortSignal.timeout(12000))
      .catch(() => ({status: 0}));
    state.busy = '';
    state.pending = null;
    if (states.get(state.slug) !== state) return;
    if ((result.status === 200 || result.status === 201) && result.body?.comment) {
      state.retries = state.retries.filter(attempt => attempt !== pending);
      state.revision += 1;
      const page = pageFor(state, parentId);
      const comment = result.body.comment;
      const alreadyLoaded = page.items.some(row => row.id === comment.id);
      page.items = mergeComments([comment], page.items);
      if (parentId) chronologicalReplies(page.items);
      const parent = parentId && findComment(state, parentId);
      if (parent && Number.isSafeInteger(result.body.parent_reply_count)) parent.reply_count = result.body.parent_reply_count;
      else if (parent && !alreadyLoaded && result.status === 201) parent.reply_count = (parent.reply_count || 0) + 1;
      if (fromComposer && !state.draft) state.replyTo = null;
      setCount(state, result.body.comment_count);
      state.notice = parentId ? '回复已发送。' : '评论已发送。';
      if (parentId && !page.ready && !page.loading) void readPage(state, parentId);
    } else {
      if (result.status === 404 && !parentId) unavailable(state);
      if (!state.draft) {
        state.draft = body;
        state.replyTo = reply;
      }
      if (!state.unavailable) state.error = failure(result.status, '发送失败，草稿已保留。请重试。');
    }
    saveComposer(state);
    render(state);
    if (active === state && document.activeElement === submit) input.focus?.();
  }

  async function mutate(state, comment, action) {
    if (state.busy || state.unavailable || !state.actor) return;
    const focusId = document.activeElement?.dataset?.commentFocus;
    state.busy = action;
    state.error = '';
    state.notice = '';
    render(state);
    const payload = action === 'like' ? {enabled: !comment.liked} : {};
    const result = await request('POST', writePath(state, comment.id, action), payload).catch(() => ({status: 0}));
    state.busy = '';
    if (states.get(state.slug) !== state) return;
    if (result.status === 200) {
      state.revision += 1;
      if (result.body?.comment) Object.assign(comment, result.body.comment);
      if (action === 'remove') {
        state.confirm = '';
        setCount(state, result.body?.comment_count);
        const parentId = comment.parent_id ?? null;
        const page = pageFor(state, parentId);
        if (!parentId && comment.reply_count) Object.assign(comment, {removed: true, can_remove: false, body: '', author: null});
        else page.items = page.items.filter(row => row.id !== comment.id);
        const parent = parentId && findComment(state, parentId);
        if (parent) {
          parent.reply_count = Math.max(0, (parent.reply_count || 0) - 1);
          if (parent.removed && !parent.reply_count) {
            const root = pageFor(state, null);
            root.items = root.items.filter(row => row.id !== parentId);
            state.replies.delete(parentId);
          }
        }
        if (state.replyTo?.id === comment.id) {
          state.replyTo = null;
          saveComposer(state);
        }
        if (!page.loading) void readPage(state, parentId);
      }
    } else {
      state.error = failure(result.status, action === 'like' ? '点赞未保存，请重试。' : '删除未完成，请重试。');
    }
    render(state);
    if (active === state && focusId && document.activeElement === document.body) {
      (focusButtons.get(focusId) || closeButton).focus?.({preventScroll: true});
    }
  }

  function newCommentKey() {
    return 'comment-' + (globalThis.crypto?.randomUUID?.() ||
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
  }

  function retryForDraft(state) {
    const body = state.draft.trim();
    const parentId = state.replyTo?.id ?? null;
    return state.retries.find(attempt => attempt.body === body && attempt.parentId === parentId);
  }

  function storedReply(reply) {
    return typeof reply?.id === 'string' && /^otwc_[0-9A-HJKMNP-TV-Z]{26}$/.test(reply.id) &&
      typeof reply.name === 'string' && reply.name.length <= 256 ? {id: reply.id, name: reply.name} : null;
  }

  function storedAttempt(attempt) {
    const reply = storedReply(attempt?.reply);
    if (typeof attempt?.body === 'string' && attempt.body.trim() && attempt.body.length <= COMMENT_LIMIT &&
        typeof attempt.key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(attempt.key) &&
        attempt.parentId === (reply?.id ?? null)) {
      return [{body: attempt.body, key: attempt.key, parentId: attempt.parentId, reply}];
    }
    return [];
  }

  function restoreComposer(state) {
    if (!state.storageKey) return;
    try {
      const saved = JSON.parse(document.defaultView?.sessionStorage.getItem(state.storageKey));
      if (!saved) return;
      const draft = typeof saved.draft === 'string' && saved.draft.length <= COMMENT_LIMIT ? saved.draft : '';
      state.retries = (Array.isArray(saved.retries) ? saved.retries : [saved.retry]).flatMap(storedAttempt);
      const [latest] = state.retries;
      if (latest) state.error = '上次发送结果未确认，请重试。';
      state.draft = draft || latest?.body || '';
      state.replyTo = !draft && latest ? latest.reply : storedReply(saved.replyTo);
    } catch { /* Keep the composer available when storage is blocked or malformed. */ }
  }

  function saveComposer(state) {
    if (!state.storageKey) return;
    const {draft, replyTo, retries} = state;
    try {
      const storage = document.defaultView?.sessionStorage;
      if (draft || replyTo || retries.length) storage?.setItem(state.storageKey, JSON.stringify({draft, replyTo, retries}));
      else storage?.removeItem(state.storageKey);
    } catch { /* The open page can still offer a retry. */ }
  }

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    active = null;
    const previous = opener;
    opener = null;
    if (previous?.isConnected !== false) previous?.focus?.({preventScroll: true});
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (active) return send(active);
  });
  input.addEventListener('input', () => {
    if (!active) return;
    active.draft = input.value;
    active.notice = '';
    if (!active.pending && !active.error) status.textContent = '';
    drawComposer(active);
    saveComposer(active);
  });
  cancelReply.addEventListener('click', () => {
    if (!active || active.busy === 'send') return;
    active.replyTo = null;
    drawComposer(active);
    saveComposer(active);
    input.focus?.();
  });
  retryPost.addEventListener('click', () => {
    if (!active) return;
    const inComposer = retryForDraft(active);
    const retry = active.retries.find(attempt => attempt !== inComposer);
    if (retry) return send(active, retry);
  });
  more.addEventListener('click', () => {
    if (!active) return;
    const root = pageFor(active, null);
    return readPage(active, null, Boolean(root.error ? root.retryAppend : root.cursor));
  });

  return {
    setActor(key, id = '') {
      if (key === actor && id === accountId) return;
      actor = key;
      accountId = typeof id === 'string' ? id : '';
      if (dialog.open) dialog.close();
      states.clear();
    },
    open(item, trigger) {
      let state = states.get(item.slug);
      if (!state) {
        state = {
          slug: item.slug, actor, count: item.comment_count || 0, revision: 0,
          storageKey: accountId ? 'flybot-workspace.work-comments.' + JSON.stringify([accountId, item.slug]) : '',
          draft: '', replyTo: null, pending: null, retries: [], busy: '',
          pages: new Map(), replies: new Set(), error: '', notice: '', confirm: '', unavailable: false,
        };
        states.set(item.slug, state);
        restoreComposer(state);
      }
      if (state.unavailable) {
        state.unavailable = false;
        state.error = '';
      }
      active = state;
      state.notice = '';
      opener = trigger || null;
      dialog.dataset.slug = item.slug;
      workLink.textContent = item.title || item.slug;
      workLink.href = '/w/' + item.slug;
      login.href = loginHref(item.slug);
      if (!dialog.open) dialog.showModal();
      render(state);
      return readPage(state);
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
