import { listPager } from '../profile/social.mjs';

const HANDLE = /^[a-z0-9][a-z0-9._-]{1,79}$/i;

export function mountFollowedCreators(document, {read, initial}) {
  const ui = Object.fromEntries(['dialog','form','query','list','status','more','retry','close','all']
    .map(name => [name, document.getElementById('followed-creators-' + name)]));
  let state;
  let timer;
  let loadedQuery;

  const live = candidate => candidate && candidate === state && ui.dialog.open && candidate.current();
  const close = () => {
    clearTimeout(timer);
    state = null;
    directory.reset();
    if (ui.dialog.open) ui.dialog.close();
  };

  function choose(handle) {
    const candidate = state;
    if (!live(candidate)) return;
    close();
    return candidate.select(handle);
  }

  const directory = listPager({document, list:ui.list, status:ui.status, more:ui.more, retry:ui.retry,
    async request(method, path, _body, {signal}) {
      const candidate = state;
      if (!live(candidate)) return {status:0};
      const result = await read(method, path, signal);
      return live(candidate) && candidate.matchesViewer(result.body?.viewer_username) ? result : {status:0};
    },
    render(row) {
      if (row?.following !== true || typeof row.handle !== 'string' || !HANDLE.test(row.handle)) return null;
      const handle = row.handle.toLowerCase();
      const name = typeof row.display_name === 'string' && row.display_name.trim() || '@' + handle;
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'followed-creator-choice';
      button.setAttribute('aria-pressed', String(state?.creator === handle));
      const avatar = document.createElement('span');
      avatar.className = 'followed-creator-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = initial(name);
      const identity = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = name;
      identity.append(title);
      if (name !== '@' + handle) {
        const username = document.createElement('span');
        username.className = 'followed-creator-handle';
        username.textContent = '@' + handle;
        identity.append(username);
      }
      button.append(avatar, identity);
      button.addEventListener('click', () => choose(handle));
      item.append(button);
      return item;
    },
    empty: (_view, query) => query ? '没有匹配的已关注作者。' : '你还没有关注任何作者。',
  });

  function search() {
    clearTimeout(timer);
    if (!live(state)) return;
    const query = ui.query.value.trim().slice(0, 80);
    if (query === loadedQuery) return;
    loadedQuery = query;
    return directory.select('following', query);
  }
  const scheduleSearch = () => {
    clearTimeout(timer);
    timer = setTimeout(search, 220);
  };

  ui.form.addEventListener('submit', event => { event.preventDefault(); return search(); });
  ui.query.addEventListener('input', event => { if (!event.isComposing) scheduleSearch(); });
  ui.query.addEventListener('compositionstart', () => clearTimeout(timer));
  ui.query.addEventListener('compositionend', scheduleSearch);
  ui.all.addEventListener('click', () => choose(''));
  ui.close.addEventListener('click', close);
  ui.dialog.addEventListener('close', () => { if (!ui.dialog.open) close(); });

  return {
    close,
    open(candidate) {
      if (!candidate.current()) return;
      state = candidate;
      ui.query.value = '';
      loadedQuery = undefined;
      ui.all.setAttribute('aria-pressed', String(!candidate.creator));
      if (!ui.dialog.open) ui.dialog.showModal();
      ui.query.focus({preventScroll:true});
      return search();
    },
  };
}
