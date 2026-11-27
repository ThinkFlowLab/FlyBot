export function mountActionCards(document, {dockId, request, label, pathForAnswer, onAnswer}) {
  const dock = document.getElementById(dockId);
  let scope;

  function clear() {
    if (!scope) return;
    scope = undefined;
    dock.replaceChildren();
    dock.hidden = true;
  }

  function createCard(active, card, signature) {
    const form = document.createElement('form');
    form.className = 'chat-group-action-card';
    form.dataset.cardId = card.id;
    form.dataset.cardType = card.type;
    const entry = {form, signature, busy:false};
    const title = document.createElement('strong');
    title.className = 'group-action-card-bot';
    title.textContent = card.bot_name || label('智能体', 'Agent');
    const prompt = document.createElement('p');
    prompt.className = 'group-action-card-prompt';
    prompt.textContent = card.type === 'choice' ? card.question : card.tool
      ? label(`请求执行 ${card.tool}`, `Requests approval for ${card.tool}`)
      : label('请求批准操作', 'Requests approval');
    form.append(title, prompt);
    const details = card.type === 'choice' ? [card.detail] : [card.reason, card.detail];
    for (const detail of new Set(details.filter(Boolean))) {
      const context = document.createElement('p');
      context.className = 'group-action-card-detail';
      context.textContent = detail;
      form.append(context);
    }
    if (card.type === 'approval' && card.code) {
      const code = document.createElement('pre');
      code.textContent = card.code;
      form.append(code);
    }
    const actions = document.createElement('div');
    actions.className = 'group-action-card-actions';
    const status = document.createElement('p');
    status.dataset.cardStatus = '';
    status.setAttribute('role', 'status');
    const controls = [];
    let updateSubmit;

    function button(action, text, type = 'button') {
      const node = document.createElement('button');
      node.type = type;
      node.dataset.cardAction = action;
      node.textContent = text;
      controls.push(node);
      actions.append(node);
      return node;
    }

    async function answer(payload) {
      if (scope !== active || active.entries.get(card.id) !== entry || entry.busy) return;
      entry.busy = true;
      for (const control of controls) control.disabled = true;
      status.textContent = label('正在提交…', 'Submitting…');
      try {
        const result = await request('POST', pathForAnswer(active.path, encodeURIComponent(card.id)),
          payload, undefined, AbortSignal.timeout(8000));
        if (scope !== active) return;
        if (result.status !== 200 || result.body?.ok !== true) {
          status.textContent = result.status === 409
            ? label('这张卡片已处理或不再可用。', 'This card was already handled or is no longer available.')
            : label('未能确认提交，请重试。', 'Could not confirm submission. Try again.');
          return;
        }
        active.answered.add(card.id);
        active.entries.delete(card.id);
        const restoreFocus = form === document.activeElement || form.contains?.(document.activeElement);
        form.remove();
        dock.hidden = active.entries.size === 0;
        if (restoreFocus) document.getElementById('chat-body')?.focus({preventScroll:true});
        onAnswer?.(card);
      } catch {
        if (scope === active) status.textContent = label('未能确认提交，请重试。', 'Could not confirm submission. Try again.');
      } finally {
        entry.busy = false;
        for (const control of controls) control.disabled = false;
        updateSubmit?.();
      }
    }

    if (card.type === 'choice') {
      const options = document.createElement('fieldset');
      options.setAttribute('aria-label', card.question);
      const inputs = card.options.map((option, index) => {
        const row = document.createElement('label');
        const input = document.createElement('input');
        input.type = card.multiple ? 'checkbox' : 'radio';
        input.name = 'choice';
        input.value = String(index);
        const copy = document.createElement('span');
        copy.textContent = option.label;
        if (option.description) {
          const description = document.createElement('small');
          description.textContent = option.description;
          copy.append(description);
        }
        row.append(input, copy);
        options.append(row);
        controls.push(input);
        return input;
      });
      let custom;
      if (card.allow_custom === true) {
        const row = document.createElement('label');
        row.className = 'group-action-card-custom';
        const caption = document.createElement('span');
        caption.textContent = label('自定义回答', 'Custom answer');
        custom = document.createElement('input');
        custom.type = 'text';
        custom.maxLength = 1000;
        row.append(caption, custom);
        options.append(row);
        controls.push(custom);
      }
      const submit = button('submit', label('提交选择', 'Submit choice'), 'submit');
      updateSubmit = () => {
        submit.disabled = entry.busy || !(inputs.some(option => option.checked) || custom?.value.trim());
      };
      updateSubmit();
      for (const input of inputs) input.addEventListener('change', () => {
        if (input.checked && custom) custom.value = '';
        updateSubmit();
      });
      custom?.addEventListener('input', () => {
        if (custom.value.trim()) for (const input of inputs) input.checked = false;
        updateSubmit();
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const response = custom?.value.trim();
        if (response) {
          void answer({custom:response});
          return;
        }
        const selected = inputs.flatMap((input, index) => input.checked ? [index] : []);
        if (selected.length) void answer({selected});
      });
      form.append(options);
    } else {
      button('reject', label('拒绝', 'Decline')).addEventListener('click', () => void answer({choice:'reject'}));
      button('allow', label('允许一次', 'Allow once')).addEventListener('click', () => void answer({choice:'allow'}));
    }
    form.append(actions, status);
    return entry;
  }

  return {
    clear,
    update(path, cards) {
      if (!dock) return;
      if (scope?.path !== path) {
        clear();
        scope = {path, entries:new Map(), answered:new Set()};
        dock.setAttribute('aria-label', label('待处理卡片', 'Pending action cards'));
      }
      const visible = new Set();
      for (const card of Array.isArray(cards) ? cards : []) {
        if (typeof card?.id !== 'string' || !card.id || visible.has(card.id) || scope.answered.has(card.id)) continue;
        if (card.type !== 'approval' && (card.type !== 'choice' || typeof card.question !== 'string' ||
            !Array.isArray(card.options) || !card.options.length || !card.options.every(option => typeof option?.label === 'string'))) continue;
        visible.add(card.id);
        const signature = JSON.stringify(card);
        const previous = scope.entries.get(card.id);
        if (previous?.signature === signature || previous?.busy) continue;
        const entry = createCard(scope, card, signature);
        previous?.form.remove();
        scope.entries.set(card.id, entry);
        dock.append(entry.form);
      }
      for (const [id, entry] of scope.entries) {
        if (visible.has(id)) continue;
        entry.form.remove();
        scope.entries.delete(id);
      }
      dock.hidden = scope.entries.size === 0;
    },
  };
}
