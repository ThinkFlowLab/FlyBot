export function mountAutomationDraftAssist(document, {form, request, scope, onApply}) {
  const node = name => document.getElementById('automation-draft-' + name);
  const description = node('description');
  const generate = node('generate');
  const preview = node('preview');
  const title = node('preview-title');
  const prompt = node('preview-prompt');
  const adopt = node('adopt');
  const status = document.getElementById('automation-task-draft-status');
  const fields = ['title', 'prompt'];
  let generation;
  let candidate;

  function clearPreview() {
    candidate = undefined;
    preview.hidden = true;
    title.textContent = '';
    prompt.value = '';
  }

  function reset() {
    generation?.abort();
    generation = undefined;
    generate.disabled = false;
    generate.removeAttribute('aria-busy');
    description.value = '';
    status.textContent = '';
    clearPreview();
  }

  const matches = target => target.key === scope()?.key && target.description === description.value.trim();
  const readFields = () => Object.fromEntries(fields.map(name => [name, form.elements[name].value]));

  generate.disabled = false;
  description.addEventListener('input', () => {
    if (candidate) {
      clearPreview();
      status.textContent = '描述已修改，请生成新的草稿。';
    }
  });
  generate.addEventListener('click', async () => {
    const context = scope();
    if (!context || generation) return;
    const text = description.value.trim();
    if (!text) {
      status.textContent = '请描述想完成的任务和期望的结果。';
      description.focus();
      return;
    }
    clearPreview();
    const task = {...context, description:text, before:readFields()};
    const controller = generation = new AbortController();
    generate.disabled = true;
    generate.setAttribute('aria-busy', 'true');
    status.textContent = '正在生成自动化草稿…';
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
    const result = await request('POST', `/v1/workspaces/${task.workspace}/automations/draft`,
      {description:text}, undefined, signal).catch(() => ({}));
    if (generation !== controller || scope()?.key !== task.key) return;
    generation = undefined;
    generate.disabled = false;
    generate.removeAttribute('aria-busy');
    if (!matches(task)) {
      status.textContent = '描述已修改，请生成新的草稿。';
      return;
    }
    const {draft, workspace_id, viewer_username} = result.body || {};
    if (result.status !== 200 || workspace_id !== task.workspace || viewer_username !== task.username ||
        typeof draft?.title !== 'string' || !draft.title.trim() || draft.title.length > 80 ||
        typeof draft?.prompt !== 'string' || !draft.prompt.trim() || draft.prompt.length > 4000) {
      status.textContent = result.body?.error?.message || '暂时无法生成草稿，可以重试或手动填写。';
      return;
    }
    candidate = {...task, draft};
    title.textContent = draft.title;
    prompt.value = draft.prompt;
    preview.hidden = false;
    status.textContent = '草稿已生成，请核对后采用。';
  });
  adopt.addEventListener('click', () => {
    if (!candidate || !matches(candidate)) return;
    const edits = readFields();
    const available = fields.filter(name => edits[name] === candidate.before[name]);
    for (const name of available) form.elements[name].value = candidate.draft[name];
    clearPreview();
    if (available.length) onApply();
    status.textContent = available.length === fields.length ? '草稿已填入任务设置。'
      : available.length ? '已填入草稿，并保留你修改的字段。' : '已保留你修改的字段。';
    form.elements[available[0] || 'title'].focus();
  });
  node('reject').addEventListener('click', () => {
    clearPreview();
    status.textContent = '';
    description.focus();
  });
  return {reset};
}
