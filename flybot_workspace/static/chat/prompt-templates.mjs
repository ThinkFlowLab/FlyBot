import {API_ROUTE} from '../shell/dsbot-api.mjs';

export function mountPromptTemplates(document, {request, composer, scope, uiLabel}) {
  const el = id => document.getElementById('chat-prompt-' + id);
  const dialog = el('dialog');
  const select = el('select');
  const fields = el('values');
  const title = el('title');
  const status = el('status');
  let opening;
  let templates = [];
  let busy = false;
  const same = view => opening === view && dialog.open && scope() === view.scope;
  const selected = () => templates.find(template => template.id === select.value);
  const tell = (zh, en) => { status.textContent = uiLabel(zh, en); };
  function sync() {
    select.disabled = busy || templates.length === 0;
    title.disabled = busy;
    el('insert').disabled = busy || !selected();
    el('save').disabled = busy || !composer.value.trim();
  }
  async function call(operation, payload) {
    const result = await request('POST', API_ROUTE, {endpoint: 'prompts/' + operation, payload}, undefined,
      AbortSignal.timeout(8000));
    if (result.status !== 200 || !result.body?.ok || !result.body.value) throw Error('prompt templates unavailable');
    return result.body.value;
  }
  function showFields() {
    fields.replaceChildren();
    for (const name of selected()?.variables || []) {
      const label = document.createElement('label');
      label.textContent = name;
      const field = document.createElement('input');
      field.name = name;
      field.required = true;
      field.maxLength = 4000;
      label.append(field);
      fields.append(label);
    }
    sync();
  }
  function showTemplates(items, preferred) {
    templates = items;
    select.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('option');
      empty.textContent = uiLabel('还没有模板', 'No saved templates');
      empty.value = '';
      select.append(empty);
    }
    for (const template of items) {
      const option = document.createElement('option');
      option.value = template.id;
      option.textContent = template.title;
      select.append(option);
    }
    if (preferred) select.value = preferred;
    showFields();
  }
  async function perform(view, task, onFailure) {
    if (!view || !same(view) || busy) return;
    busy = true;
    sync();
    try { await task(); }
    catch { if (same(view)) onFailure(); }
    finally {
      if (opening === view) {
        busy = false;
        sync();
      }
    }
  }
  async function readTemplates(view) {
    const items = [];
    let cursor = null;
    do {
      const result = await call('list', {scope: 'private', limit: 100, ...(cursor && {cursor})});
      items.push(...result.items);
      cursor = result.cursor;
    } while (cursor && items.length < 1000 && same(view));
    return items;
  }

  el('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    opening = null;
    busy = false;
  });
  select.addEventListener('change', showFields);
  el('save-form').addEventListener('submit', event => {
    event.preventDefault();
    const view = opening;
    const body = composer.value;
    if (!body.trim() || !title.value.trim()) return;
    void perform(view, async () => {
      tell('正在保存模板…', 'Saving template…');
      const {prompt} = await call('create', {title: title.value, body, scope: 'private'});
      if (!same(view)) return;
      showTemplates([prompt, ...templates], prompt.id);
      title.value = '';
      tell('模板已保存。', 'Template saved.');
    }, () => tell('无法保存模板。请检查名称和 {{变量名}} 格式后重试。',
      'Could not save the template. Check the title and {{variable}} syntax and retry.'));
  });
  el('insert-form').addEventListener('submit', event => {
    event.preventDefault();
    const view = opening;
    const template = selected();
    if (!template) return;
    const values = Object.fromEntries([...fields.querySelectorAll('input')].map(field => [field.name, field.value]));
    void perform(view, async () => {
      tell('正在读取模板…', 'Reading template…');
      const result = await call('render', {id: template.id, version: template.current_version, values});
      if (!same(view) || composer.disabled) return;
      if (result.missing.length) {
        tell('请填写模板变量。', 'Fill in the template variables.');
        return;
      }
      const draft = composer.value;
      const fragment = (draft && !/\s$/.test(draft) ? '\n\n' : '') + result.text;
      if ((draft + fragment).length > composer.maxLength) {
        tell('模板和现有草稿合计超过消息上限。请先缩短草稿。', 'The template and draft exceed the message limit. Shorten the draft first.');
        return;
      }
      composer.value = draft + fragment;
      composer.dispatchEvent(new Event('input', {bubbles: true}));
      dialog.close();
      composer.focus();
    }, () => tell('无法读取模板。请重试。', 'Could not read the template. Try again.'));
  });

  return {open() {
    const current = scope();
    if (!current || dialog.open) return;
    const view = {scope: current};
    opening = view;
    busy = false;
    for (const [id, zh, en] of [
      ['heading', '提示词模板', 'Prompt templates'],
      ['select-label', '已保存的模板', 'Saved templates'],
      ['title-label', '新模板名称', 'New template name'],
      ['syntax', '将可替换内容写成 {{topic}}。', 'Write a variable as {{topic}}.'],
      ['insert', '插入草稿', 'Insert into draft'],
      ['save', '保存当前草稿为模板', 'Save current draft as template'],
    ]) el(id).textContent = uiLabel(zh, en);
    el('close').setAttribute('aria-label', uiLabel('关闭', 'Close'));
    title.value = '';
    showTemplates([]);
    tell('正在读取模板…', 'Loading templates…');
    dialog.showModal();
    void perform(view, async () => {
      const items = await readTemplates(view);
      if (!same(view)) return;
      showTemplates(items);
      tell('', '');
    }, () => tell('无法加载模板。关闭后重新打开可重试。', 'Could not load templates. Close and reopen to retry.'));
  }};
}
