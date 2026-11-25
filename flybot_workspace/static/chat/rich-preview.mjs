export function richPreviewButton(document, kind, content, name) {
  const english = document.documentElement?.lang === 'en';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-rich-preview-button';
  button.textContent = english ? `Expand ${name.toLowerCase()}` : `展开${name}`;
  button.addEventListener('click', () => {
    const original = content();
    if (original) openPreview(document, button, kind, original, name, english);
  });
  return button;
}

function openPreview(document, trigger, kind, original, name, english) {
  const dialog = document.createElement('dialog');
  dialog.className = 'chat-rich-preview';
  dialog.setAttribute('aria-label', name);
  const header = document.createElement('header');
  const heading = document.createElement('h2');
  heading.textContent = name;
  const scale = document.createElement('button');
  scale.type = 'button';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = english ? 'Close' : '关闭';
  close.autofocus = true;
  header.append(heading, scale, close);

  const viewport = document.createElement('div');
  viewport.className = 'chat-rich-preview-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', name);
  const content = original.cloneNode(true);
  viewport.append(content);
  dialog.append(header, viewport);
  document.body.append(dialog);
  dialog.showModal();

  let fit = true;
  const isDiagram = kind === 'diagram';
  function resize() {
    viewport.dataset.fit = String(fit);
    if (isDiagram) {
      const naturalWidth = Number.parseFloat(content.style.width);
      const zoom = fit && naturalWidth > 0 ? Math.min(1, viewport.clientWidth / naturalWidth) : 1;
      content.style.zoom = String(zoom);
    }
    scale.textContent = fit ? (english ? 'Actual size' : '原始尺寸') : (english ? 'Fit to window' : '适应窗口');
  }
  scale.addEventListener('click', () => {
    fit = !fit;
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
    resize();
  });
  close.addEventListener('click', () => dialog.close());
  const Observer = document.defaultView?.ResizeObserver;
  const observer = isDiagram && Observer ? new Observer(resize) : null;
  observer?.observe(viewport);
  dialog.addEventListener('close', () => {
    observer?.disconnect();
    dialog.remove();
    if (trigger.isConnected) trigger.focus({preventScroll:true});
  }, {once:true});
  resize();
}
