const endpoint = '/b/api/flybot-workspace/computer';
const asset = endpoint + '?op=asset&name=core%2Frfb.js';
const id = /^[a-f0-9]{32}$/;

function connectChannel(url, onClose) {
  const stop = new AbortController();
  const queued = [];
  let writing = false;
  let size = 0;
  async function flush() {
    if (writing || stop.signal.aborted) return;
    writing = true;
    try {
      while (queued.length && !stop.signal.aborted) {
        let bytes = 0;
        const parts = [];
        while (queued.length && bytes + queued[0].byteLength <= 64 * 1024) {
          const chunk = queued.shift();
          bytes += chunk.byteLength;
          parts.push(chunk);
        }
        size -= bytes;
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const part of parts) {
          body.set(part,offset);
          offset += part.byteLength;
        }
        const response = await fetch(url,{method:'POST',body,signal:stop.signal});
        if (!response.ok) throw new Error('Desktop input was interrupted');
      }
    } catch { channel.close(); }
    finally { writing = false; }
  }
  const channel = {
    binaryType: 'arraybuffer',
    protocol: '',
    readyState: 'open',
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send(bytes) {
      if (stop.signal.aborted || !bytes.byteLength) return;
      if (bytes.byteLength > 64 * 1024 || size + bytes.byteLength > 256 * 1024) {
        channel.close();
        return;
      }
      const chunk = bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) : bytes.slice();
      queued.push(chunk);
      size += chunk.byteLength;
      void flush();
    },
    close() {
      if (stop.signal.aborted) return;
      this.readyState = 'closed';
      stop.abort();
      void fetch(url, {method:'DELETE', keepalive:true}).catch(() => {});
      this.onclose?.({code:1000, reason:'Desktop control ended'});
      onClose();
    },
  };
  async function receive() {
    while (!stop.signal.aborted) {
      const response = await fetch(url, {signal:stop.signal});
      if (!response.ok) throw new Error('Desktop connection expired');
      const data = await response.arrayBuffer();
      if (data.byteLength) channel.onmessage?.({data});
    }
  }
  queueMicrotask(() => { void receive().catch(() => channel.close()); });
  return channel;
}

export function mountBotComputer(document, button, {fetcher = fetch, dock = null} = {}) {
  const noOp = {setTarget() {}, close() {}};
  if (!button) return noOp;
  const en = () => document.documentElement.lang?.startsWith('en');
  const copy = (zh, english) => en() ? english : zh;
  let target = null;
  let view = null;
  let panel, modal, heading, state, image, screen, take, handBack, close, retry, full, placeholder;
  const path = (owner, op, extra = {}) => endpoint + '?' + new URLSearchParams({
    workspace: owner.workspace, agent: owner.id, op, ...extra,
  });

  async function request(owner, op, options = {}) {
    const response = await fetcher(path(owner, op), options);
    if (!response.ok || response.redirected) throw Object.assign(new Error('Desktop request failed'), {status:response.status});
    return response;
  }

  function say(zh, english) { state.textContent = copy(zh, english); }

  function setMode(mode) {
    take.hidden = mode !== 'watch';
    handBack.hidden = mode !== 'control';
    retry.hidden = mode !== 'error';
    image.hidden = mode === 'control' || !view?.image;
    screen.hidden = mode !== 'control';
    placeholder.hidden = !image.hidden || !screen.hidden;
    panel.dataset.mode = mode;
  }

  function stopView() {
    if (!view) return;
    const previous = view;
    view = null;
    previous.abort.abort();
    clearTimeout(previous.timer);
    previous.channel?.close();
    if (previous.image) URL.revokeObjectURL(previous.image);
    screen.replaceChildren();
    image.removeAttribute('src');
  }

  function fail() {
    setMode('error');
    placeholder.textContent = copy('未能加载桌面画面', 'The desktop preview could not be loaded');
    say('电脑暂时无法连接', 'Computer unavailable');
  }

  async function frame(open) {
    if (view !== open || open.channel || open.taking) return;
    let nextFrame;
    try {
      const response = await request(open.target, 'preview', {signal:open.abort.signal});
      if (!response.headers.get('content-type')?.startsWith('image/png')) throw new Error('Invalid desktop image');
      const blob = await response.blob();
      if (view !== open || open.channel || open.taking) return;
      nextFrame = URL.createObjectURL(blob);
      const preview = document.createElement('img');
      preview.src = nextFrame;
      await preview.decode();
      if (view !== open || open.channel || open.taking) return;
      if (open.image) URL.revokeObjectURL(open.image);
      open.image = image.src = nextFrame;
      nextFrame = null;
      open.failures = 0;
      if (panel.dataset.mode !== 'watch') {
        setMode('watch');
        say('正在观看', 'Watching');
      }
      open.timer = setTimeout(() => void frame(open), 650);
    } catch (error) {
      if (view !== open || open.channel || open.taking) return;
      if (error.status === 410 && !open.restarted) {
        void start({restarted:true});
        return;
      }
      if (++open.failures <= 3) {
        setMode('loading');
        placeholder.textContent = copy('正在重新加载画面…', 'Reloading the preview…');
        say('正在重新连接', 'Reconnecting');
        open.timer = setTimeout(() => void frame(open), open.failures * 900);
      } else fail();
    } finally {
      if (nextFrame) URL.revokeObjectURL(nextFrame);
    }
  }

  async function start({restarted = false} = {}) {
    stopView();
    const open = {target,abort:new AbortController(),taking:false,failures:0,restarted};
    view = open;
    heading.textContent = copy(`${open.target.name} 的电脑`, `${open.target.name}’s computer`);
    placeholder.textContent = copy('正在启动 Linux 桌面…', 'Starting Linux desktop…');
    setMode('loading');
    say('连接中', 'Connecting');
    try {
      await request(open.target, 'start', {method:'POST',signal:open.abort.signal});
      if (view === open) await frame(open);
    } catch {
      if (view === open && !restarted) {
        open.timer = setTimeout(() => { if (view === open) void start({restarted:true}); }, 1000);
      } else if (view === open) fail();
    }
  }

  async function takeControl() {
    const open = view;
    if (!open || open.taking || open.channel) return;
    open.taking = true;
    clearTimeout(open.timer);
    take.disabled = true;
    say('正在接管…', 'Taking control…');
    let control;
    try {
      const {default:RFB} = await import(asset);
      if (view !== open) return;
      const response = await request(open.target,'take',{method:'POST'});
      const {lease} = await response.json();
      control = path(open.target,'control',{lease});
      if (view !== open) {
        void fetch(control,{method:'DELETE',keepalive:true}).catch(() => {});
        return;
      }
      open.channel = connectChannel(control, () => {
        if (view !== open || !open.channel) return;
        open.channel = null;
        open.rfb = null;
        screen.replaceChildren();
        setMode('watch');
        say('正在观看', 'Watching');
        void frame(open);
      });
      setMode('control');
      open.rfb = new RFB(screen,open.channel,{shared:false});
      open.rfb.scaleViewport = true;
      open.rfb.addEventListener('connect', () => {
        if (view !== open || !open.channel) return;
        say('你正在控制电脑，Bot 输入已暂停', 'You control the computer. Bot input is paused.');
        open.rfb.focus();
      });
      open.rfb.addEventListener('disconnect', () => open.channel?.close(), {once:true});
    } catch {
      if (control && !open.channel) void fetch(control,{method:'DELETE',keepalive:true}).catch(() => {});
      if (view !== open) return;
      open.channel?.close();
      setMode('watch');
      say('暂时无法接管。Bot 或另一个页面可能正在操作。', 'Control is unavailable while the Bot or another tab is using this computer.');
    } finally {
      open.taking = false;
      take.disabled = false;
      if (view === open && !open.channel) void frame(open);
    }
  }

  function dismiss({focus = false} = {}) {
    stopView();
    if (modal?.open) modal.close();
    if (dock) {
      dock.hidden = true;
      button.setAttribute('aria-expanded','false');
    }
    if (focus && !button.hidden) button.focus();
  }

  function makeModal() {
    if (modal) return;
    modal = document.createElement('dialog');
    modal.className = 'bot-computer-modal';
    modal.setAttribute('aria-label', copy('Bot 电脑', 'Bot computer'));
    modal.addEventListener('close', () => {
      if (dock) {
        dock.append(panel);
        full.setAttribute('aria-pressed','false');
        full.textContent = copy('放大', 'Expand');
      } else stopView();
    });
    document.body.append(modal);
  }

  function makePanel() {
    panel = document.createElement('section');
    panel.className = 'bot-computer';
    panel.innerHTML = '<header><div><h2></h2><p role="status"></p></div><div class="bot-computer-tools"><button type="button" data-take></button><button type="button" data-back hidden></button><button type="button" data-retry hidden></button><button type="button" data-full></button><button type="button" data-close></button></div></header><div class="bot-computer-viewport"><p class="bot-computer-placeholder"></p><img hidden><div class="bot-computer-screen" hidden></div></div>';
    heading = panel.querySelector('h2');
    state = panel.querySelector('[role=status]');
    placeholder = panel.querySelector('.bot-computer-placeholder');
    image = panel.querySelector('img');
    image.alt = copy('Linux 桌面画面', 'Linux desktop preview');
    screen = panel.querySelector('.bot-computer-screen');
    take = panel.querySelector('[data-take]');
    take.textContent = copy('接管', 'Take control');
    handBack = panel.querySelector('[data-back]');
    handBack.textContent = copy('交还给 Bot', 'Hand back to Bot');
    retry = panel.querySelector('[data-retry]');
    retry.textContent = copy('重试', 'Retry');
    full = panel.querySelector('[data-full]');
    full.textContent = copy('放大', 'Expand');
    full.setAttribute('aria-pressed','false');
    close = panel.querySelector('[data-close]');
    close.textContent = copy('关闭', 'Close');
    take.addEventListener('click', () => void takeControl());
    handBack.addEventListener('click', () => view?.channel?.close());
    retry.addEventListener('click', () => void start());
    close.addEventListener('click', () => dismiss({focus:true}));
    full.addEventListener('click', () => {
      if (dock) {
        if (modal?.open) {
          modal.close();
          return;
        }
        makeModal();
        modal.append(panel);
        modal.showModal();
      }
      const expanded = dock || modal.classList.toggle('bot-computer-expanded');
      full.setAttribute('aria-pressed',String(Boolean(expanded)));
      full.textContent = expanded ? copy('还原','Restore') : copy('放大','Expand');
    });
  }

  button.addEventListener('click', () => {
    if (!target) return;
    if (dock ? !dock.hidden : modal?.open) {
      dismiss({focus:true});
      return;
    }
    if (!panel) makePanel();
    if (dock) {
      dock.append(panel);
      dock.hidden = false;
      button.setAttribute('aria-expanded','true');
    } else {
      makeModal();
      modal.append(panel);
      modal.showModal();
    }
    void start();
  });
  document.defaultView?.addEventListener?.('pagehide', stopView);
  return {
    setTarget(agent) {
      const next = agent && !agent.archived && !agent.native_deleted && id.test(agent.id) && id.test(agent.workspace_id)
        ? {id:agent.id,workspace:agent.workspace_id,name:agent.name} : null;
      if (next && next.id === target?.id && next.workspace === target.workspace) return;
      dismiss();
      target = next;
      button.hidden = true;
      if (next) void request(next,'status').then(() => {
        if (next === target) button.hidden = false;
      }, () => {});
    },
    close: dismiss,
  };
}
