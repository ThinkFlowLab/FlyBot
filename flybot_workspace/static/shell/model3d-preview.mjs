// The renderer and model download are only needed after the viewer is opened.
export function bindModel3dPreview(button, container, status, {onReady} = {}) {
  if (!button || !container || !status) return {toggle() {}, setSource() {}};

  const document = container.ownerDocument;
  let source = '';
  let preview;

  function close() {
    preview?.controller.abort();
    preview?.observer?.disconnect();
    preview?.cleanup?.();
    preview = null;
    container.hidden = true;
    button.textContent = '预览 3D 模型';
    button.setAttribute('aria-expanded', 'false');
    status.textContent = '';
  }

  async function toggle() {
    if (preview) {
      close();
      return;
    }
    if (!source) return;
    const active = {controller: new AbortController()};
    preview = active;
    container.hidden = false;
    button.textContent = '关闭预览';
    button.setAttribute('aria-expanded', 'true');
    status.textContent = '正在加载模型…';

    // Message rows can leave the DOM when the active conversation changes.
    const Observer = document.defaultView?.MutationObserver;
    if (Observer) {
      active.observer = new Observer(() => {
        if (preview === active && !container.isConnected) close();
      });
      active.observer.observe(document.documentElement, {subtree: true, childList: true});
    }

    const url = source;
    try {
      const {openModel3dViewer} = await import('./model3d-viewer.mjs');
      if (preview !== active) return;
      const cleanup = await openModel3dViewer(container, url, {signal: active.controller.signal});
      if (preview !== active) {
        cleanup();
        return;
      }
      active.cleanup = cleanup;
      status.textContent = '';
    } catch {
      if (preview !== active) return;
      close();
      status.textContent = '无法预览，可下载 GLB 文件。';
      return;
    }
    onReady?.();
  }
  button.addEventListener('click', toggle);

  return {
    toggle,
    setSource(url) {
      if (source === url) return;
      close();
      source = url;
      button.disabled = !source;
    },
  };
}
