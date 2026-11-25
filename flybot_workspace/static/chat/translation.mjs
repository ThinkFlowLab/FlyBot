const LANGUAGES = [
  ['zh-CN','简体中文'], ['zh-Hant','繁體中文'], ['en','English'], ['ja','日本語'],
  ['ko','한국어'], ['fr','Français'], ['de','Deutsch'], ['es','Español'],
  ['pt','Português'], ['it','Italiano'], ['ru','Русский'], ['id','Indonesia'],
  ['vi','Tiếng Việt'], ['th','ไทย'], ['ar','العربية'], ['fa','فارسی'], ['bn','বাংলা'],
  ['hi','हिन्दी'], ['ms','Bahasa Melayu'],
];

const keyOf = item => JSON.stringify([item.id,item.revision || 1]);
const roomKey = room => room ? JSON.stringify([room.user,room.wid,room.cid]) : '';
const base = room => `/v1/workspaces/${room.wid}/social/conversations/${room.cid}`;

export function mountGroupTranslation(document, {request}) {
  const toggle = document.getElementById('group-translate');
  if (!toggle) return {open() {}, clearRows() {}, add() {}};
  const select = document.getElementById('group-translate-language');
  const languageRow = document.getElementById('group-translate-language-row');
  const note = document.getElementById('group-translate-status');
  const view = document.defaultView;
  const rows = new Map();
  const visible = new Map();
  let current;
  let timer;

  for (const [code,label] of LANGUAGES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    select.append(option);
  }

  const observer = typeof view?.IntersectionObserver === 'function'
    ? new view.IntersectionObserver(entries => {
      for (const entry of entries) {
        const row = rows.get(entry.target);
        if (!row) continue;
        if (entry.isIntersecting) visible.set(row.key,row.item);
        else visible.delete(row.key);
      }
      schedule();
    }, {root:document.getElementById('message-scroller'),rootMargin:'100px 0px'})
    : null;

  function syncControls(message = '') {
    const ready = current?.preferences;
    toggle.disabled = !ready || current.saving;
    toggle.setAttribute('aria-checked', String(ready?.enabled === true));
    languageRow.hidden = !ready?.enabled;
    select.disabled = toggle.disabled;
    if (ready) select.value = ready.language;
    note.textContent = message;
  }

  function paint(row) {
    const value = current?.preferences?.enabled ? current.results.get(row.key) : null;
    const visibleText = value && ['translated','pending','failed'].includes(value.status);
    row.node.hidden = !visibleText;
    const collapsed = current?.collapsed.has(row.key);
    const signature = visibleText ? JSON.stringify([value.status,value.text,collapsed]) : '';
    if (signature === row.signature) return;
    row.signature = signature;
    row.node.replaceChildren();
    if (!visibleText) return;
    if (value.status === 'pending') {
      row.node.textContent = '正在翻译…';
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    if (value.status === 'failed') {
      row.node.append(document.createTextNode('翻译失败'));
      button.textContent = '重试';
      button.addEventListener('click',() => {
        if (!current?.preferences?.enabled) return;
        current.retry.add(row.key);
        current.results.set(row.key,{status:'pending'});
        visible.set(row.key,row.item);
        paint(row);
        schedule();
      });
    } else {
      const text = document.createElement('p');
      text.textContent = value.text;
      text.hidden = collapsed;
      button.textContent = collapsed ? '展开译文' : '收起译文';
      button.setAttribute('aria-expanded', String(!collapsed));
      button.addEventListener('click',() => {
        if (current.collapsed.has(row.key)) current.collapsed.delete(row.key);
        else current.collapsed.add(row.key);
        text.hidden = !text.hidden;
        button.textContent = text.hidden ? '展开译文' : '收起译文';
        button.setAttribute('aria-expanded',String(!text.hidden));
        row.signature = JSON.stringify([value.status,value.text,text.hidden]);
      });
      row.node.append(text);
    }
    row.node.append(button);
  }

  function draw() {
    for (const row of rows.values()) paint(row);
  }

  function clearRows() {
    observer?.disconnect();
    rows.clear();
    visible.clear();
  }

  function add(item, messageNode, body) {
    if (!current || item.retracted || item.voice || item.attachment || !/\p{L}/u.test(item.body || '')) return;
    const key = keyOf(item);
    const node = document.createElement('div');
    node.className = 'chat-message-translation';
    node.hidden = true;
    node.setAttribute('aria-label','译文');
    body.after(node);
    const row = {item,key,node,signature:''};
    rows.set(messageNode,row);
    paint(row);
    if (observer) observer.observe(messageNode);
    else visible.set(key,item);
    schedule();
  }

  async function load(captured) {
    if (captured !== current || captured.loading) return;
    captured.loading = true;
    syncControls('正在读取…');
    try {
      const result = await request('GET',base(captured.room)+'/translation');
      if (captured !== current) return;
      if (result.status !== 200) throw new Error('Preferences unavailable');
      captured.preferences = result.body.preferences;
      syncControls();
      draw();
      schedule();
    } catch {
      if (captured === current) syncControls('自动翻译暂不可用，重新打开群聊可重试。');
    } finally { captured.loading = false; }
  }

  function open(room) {
    const key = roomKey(room);
    if (key === (current?.key || '')) {
      if (current && !current.preferences) void load(current);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    clearRows();
    current = room ? {room,key,preferences:null,results:new Map(),retry:new Set(),collapsed:new Set()} : null;
    syncControls();
    if (current) void load(current);
  }

  async function save(enabled,language) {
    const captured = current;
    if (!captured?.preferences || captured.saving) return;
    captured.saving = true;
    syncControls('正在保存…');
    try {
      const result = await request('POST',base(captured.room)+'/translation',{enabled,language});
      if (captured !== current) return;
      if (result.status !== 200) throw new Error('Save failed');
      captured.preferences = result.body.preferences;
      captured.results.clear();
      captured.retry.clear();
      captured.collapsed.clear();
      syncControls('已保存');
      draw();
    } catch {
      if (captured === current) syncControls('保存失败，请重试。');
    } finally {
      captured.saving = false;
      if (captured === current) {
        toggle.disabled = select.disabled = false;
        schedule();
      }
    }
  }

  function schedule(delay = 180) {
    if (timer || current?.running || current?.saving || !current?.preferences?.enabled
      || document.visibilityState === 'hidden') return;
    const pending = [...visible.values()].some(item => {
      const state = current.results.get(keyOf(item))?.status;
      return !state || state === 'pending';
    });
    if (!pending) return;
    timer = setTimeout(() => {
      timer = undefined;
      void collect(current);
    },delay);
  }

  async function collect(captured) {
    if (!captured?.preferences?.enabled || captured.saving || document.visibilityState === 'hidden') return;
    const language = captured.preferences.language;
    const items = [...visible.values()].filter(item => {
      const found = captured.results.get(keyOf(item));
      return !found || found.status === 'pending';
    }).slice(0,6);
    if (!items.length) return;
    captured.running = true;
    const retry = items.some(item => captured.retry.has(keyOf(item)));
    for (const item of items) captured.retry.delete(keyOf(item));
    for (const item of items) captured.results.set(keyOf(item),{status:'pending'});
    draw();
    try {
      const result = await request('POST',base(captured.room)+'/translations',{
        items:items.map(({id,revision}) => ({id,revision:revision || 1})), retry,
      });
      if (captured !== current || captured.preferences.language !== language || !captured.preferences.enabled) return;
      if (result.status !== 200) throw new Error('Translations unavailable');
      if (!result.body.enabled || result.body.language !== language) {
        captured.preferences = {enabled:result.body.enabled,language:result.body.language};
        captured.results.clear();
        syncControls();
      } else {
        for (const item of result.body.items || []) captured.results.set(keyOf(item),item);
      }
    } catch {
      if (captured !== current || captured.preferences.language !== language || !captured.preferences.enabled) return;
      for (const item of items) captured.results.set(keyOf(item),{status:'failed'});
    } finally {
      captured.running = false;
      if (captured === current) {
        draw();
        schedule(1800);
      }
    }
  }

  toggle.addEventListener('click',() => current?.preferences && save(!current.preferences.enabled,current.preferences.language));
  select.addEventListener('change',() => save(true,select.value));
  document.addEventListener('visibilitychange',() => schedule());
  return {open,clearRows,add};
}
