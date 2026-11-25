import {PUBLIC_AGENT_MESSAGE_LIMIT, publicAgentIntentFromHash, stagePublicAgentOpening} from './public-agent-link.mjs';

export function mountPublicAgentComposer(document) {
  const form = document.getElementById('public-agent-composer');
  const input = form?.querySelector('textarea[name="message"]');
  const submit = form?.querySelector('button[type="submit"]');
  const status = document.getElementById('public-agent-composer-status');
  const view = document.defaultView;
  if (!input || !submit || !status || !view) return;
  let selected = null;

  function update() {
    if (selected && input.value !== selected.text) {
      selected.button.setAttribute('aria-pressed', 'false');
      selected = null;
    }
    submit.disabled = !input.value.trim() || input.value.length > PUBLIC_AGENT_MESSAGE_LIMIT;
    status.hidden = true;
    status.textContent = '';
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (submit.disabled) return;
    const continuation = selected?.text === input.value ? selected.hash : stagePublicAgentOpening(view, {
      slug: form.dataset.slug, listingId: form.dataset.listingId, text: input.value,
    });
    if (!continuation) {
      status.textContent = '此浏览器暂时无法保留草稿。可先复制消息，再打开对话。';
      status.hidden = false;
      return;
    }
    submit.disabled = true;
    view.location.assign('/login' + continuation);
  });
  for (const link of document.querySelectorAll('a[data-public-agent-starter]')) {
    const hash = link.hash;
    const intent = publicAgentIntentFromHash(hash);
    if (intent?.slug !== form.dataset.slug || intent.quickStart === undefined) continue;
    const text = link.firstElementChild?.textContent;
    if (!text) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = link.className;
    button.textContent = text;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      selected?.button.setAttribute('aria-pressed', 'false');
      selected = {button, hash, text};
      button.setAttribute('aria-pressed', 'true');
      input.value = text;
      update();
      input.focus();
      input.setSelectionRange(text.length, text.length);
    });
    link.replaceWith(button);
  }
  input.addEventListener('input', update);
  view.addEventListener('pageshow', event => { if (event.persisted) update(); });
  input.disabled = false;
  update();
}

if (typeof document !== 'undefined') mountPublicAgentComposer(document);
