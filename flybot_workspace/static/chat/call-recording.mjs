const MAX_BYTES = 32 * 1024 * 1024;
const MAX_MS = 590000;
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const STATES = new Set(['pending', 'recording', 'stopped', 'cancelled']);
const inProgress = item => item?.state === 'pending' || item?.state === 'recording';
const identical = (left, right) => left.size === right.size && [...left].every(id => right.has(id));

function parseRecording(input) {
  if (!input?.id || !input.initiator_peer_id || !STATES.has(input.state) || !Array.isArray(input.participants)) return null;
  const participants = new Map(input.participants.map(row => [row.peer_id, row.allowed]));
  if (participants.size !== input.participants.length || !participants.has(input.initiator_peer_id) ||
      (inProgress(input) && !participants.get(input.initiator_peer_id)) ||
      [...participants].some(([id, allowed]) => !id || typeof allowed !== 'boolean')) return null;
  return {...input, participants};
}

function closeAudio(audio) {
  if (audio && audio.state !== 'closed') void audio.close().catch(() => {});
}

function beginCapture(view, audio, tracks, mime, onFailure) {
  const destination = audio.createMediaStreamDestination();
  const sources = [];
  let recorder;
  let timer;
  let finalTimer;
  let retained = false;
  let discarding = false;
  let settled = false;
  let consumed = 0;
  let chunks = [];
  let finish;
  const output = new Promise(resolve => { finish = resolve; });
  const now = () => (view.performance || globalThis.performance).now();
  const deadline = now() + MAX_MS;
  const cleanup = value => {
    if (settled) return;
    settled = true;
    view.clearTimeout(timer);
    view.clearTimeout(finalTimer);
    for (const source of sources) source.disconnect();
    destination.stream.getTracks().forEach(track => track.stop());
    closeAudio(audio);
    chunks = [];
    finish(value);
  };
  const stop = () => { if (recorder?.state !== 'inactive') recorder?.stop(); };
  const discard = () => {
    discarding = true;
    retained = false;
    try { stop(); } catch {} finally { cleanup(null); }
  };
  const fail = text => {
    discard();
    onFailure(text);
  };

  try {
    for (const track of tracks) {
      const source = audio.createMediaStreamSource(new view.MediaStream([track]));
      sources.push(source);
      source.connect(destination);
    }
    recorder = new view.MediaRecorder(destination.stream, {mimeType:mime, audioBitsPerSecond:64000});
    recorder.ondataavailable = ({data}) => {
      if (settled || discarding || !data.size) return;
      consumed += data.size;
      if (consumed > MAX_BYTES) fail('录音已超过 32 MB，未保留。');
      else chunks.push(data);
    };
    recorder.onerror = () => fail('无法继续录音，未保留。');
    recorder.onstop = () => {
      if (settled) return;
      const blob = retained && consumed ? new view.Blob(chunks, {type:recorder.mimeType || mime}) : null;
      cleanup(blob);
      if (!retained && !discarding) onFailure('录音已中断，未保留。');
    };
    recorder.start(1000);
    timer = view.setTimeout(() => fail('录音已到时间上限，未保留。下次请提前停止并保留。'), MAX_MS);
  } catch (error) {
    discard();
    throw error;
  }

  return {
    discard,
    finish() {
      if (settled || now() >= deadline) { discard(); return output; }
      retained = true;
      view.clearTimeout(timer);
      finalTimer = view.setTimeout(() => cleanup(null), 4000);
      try { stop(); } catch { cleanup(null); }
      return output;
    },
  };
}

export function mountCallRecording(document, {view, send}) {
  const panel = document.getElementById('chat-call-recording');
  const request = document.getElementById('chat-call-record-request');
  const allow = document.getElementById('chat-call-record-allow');
  const decline = document.getElementById('chat-call-record-decline');
  const stop = document.getElementById('chat-call-record-stop');
  const status = document.getElementById('chat-call-record-status');
  const Audio = view.AudioContext || view.webkitAudioContext;
  const MIME = TYPES.find(type => view.MediaRecorder?.isTypeSupported?.(type));
  let live;

  const current = state => live === state;
  const rosterOf = call => new Set((call?.peers || []).map(peer => peer.id));

  function render() {
    if (!panel) return;
    const item = live?.recording;
    const own = live?.own;
    const joined = item?.participants.has(own?.id);
    const agreed = item?.participants.get(own?.id);
    const initiating = item?.initiator_peer_id === own?.id;
    const valid = joined && !live?.blocked.has(item.id);
    const pending = valid && item.state === 'pending';
    const active = valid && item.state === 'recording';
    panel.hidden = !live?.available;
    request.hidden = inProgress(item) || Boolean(live?.blob);
    request.disabled = !Audio || !MIME || Boolean(live?.busy);
    allow.hidden = !pending || agreed;
    decline.hidden = !(pending || active);
    decline.textContent = agreed ? (initiating ? '放弃录音' : '撤回同意') : '不同意';
    stop.hidden = !active || !initiating || !live?.capture;
    for (const button of [allow, decline, stop]) button.disabled = Boolean(live?.busy);
    const consentCount = item && [...item.participants.values()].filter(Boolean).length;
    const message = live?.notice || (live?.busy === 'stop' ? '正在停止并确认录音…'
      : live?.busy ? '正在发送录音选择…'
        : pending ? `等待全员同意（${consentCount}/${item.participants.size}）`
          : active ? (initiating ? '通话正在录音。请在 9 分 50 秒内停止并保留。' : '通话正在录音，仅录制音频。')
            : live?.blob ? '录音已在此设备保留。结束通话后可在会议纪要中使用。'
              : item?.state === 'cancelled' ? '本次录音已取消。'
                : item?.state === 'stopped' ? '本次录音已停止。' : !Audio || !MIME ? '当前浏览器无法发起录音。' : '');
    if (status.textContent !== message) status.textContent = message;
  }

  function discardCapture(state) {
    state.capture?.discard();
    state.capture = null;
    closeAudio(state.audio);
    state.audio = null;
  }

  function invalidate(state, message, tellServer = false) {
    const item = state.recording;
    state.fence += 1;
    state.busy = '';
    if (item) state.blocked.add(item.id);
    discardCapture(state);
    state.notice = message;
    if (tellServer && inProgress(item) && item.participants.has(state.own.id)) {
      void send(state.own, 'decline', item.id).catch(() => {});
    }
    render();
  }

  function start(state, item) {
    if (state.capture || state.requestId !== item.id || !state.audio || state.busy) return;
    if (!identical(state.roster, new Set(item.participants.keys())) || ![...item.participants.values()].every(Boolean)) return;
    if (state.audio.state !== 'running') {
      state.notice = '等待浏览器准备录音…';
      return;
    }
    const own = state.own;
    const sources = [...item.participants.keys()].map(id => {
      const stream = id === own.id ? own.stream : own.peers.get(id)?.remote;
      const tracks = (stream?.getAudioTracks() || []).filter(track => track.kind === 'audio' && track.readyState === 'live');
      return {id, tracks};
    });
    const audioTracks = [...new Set(sources.flatMap(source => source.tracks))];
    if (!audioTracks.length || sources.some(source => source.id !== own.id && !source.tracks.length)) {
      state.notice = '等待通话音频连接…';
      return;
    }
    try {
      state.capture = beginCapture(view, state.audio, audioTracks, MIME, message => {
        if (current(state) && state.recording?.id === item.id) invalidate(state, message, true);
      });
      state.audio = null;
      state.notice = '';
    } catch {
      invalidate(state, '无法启动浏览器录音，未保留。', true);
    }
  }

  function apply(state, item, {authoritativeRoster = false} = {}) {
    const existing = state.recording;
    if (item?.id === existing?.id && existing &&
        ((!inProgress(existing) && inProgress(item)) || (existing.state === 'recording' && item.state === 'pending'))) return;
    if (inProgress(existing) && (existing.id !== item?.id || !inProgress(item))) {
      discardCapture(state);
      if (state.requestId === existing.id && !state.blob && !state.notice) state.notice = '录音已中断，未保留。';
    }
    if (inProgress(item) && item.id !== existing?.id) state.notice = '';
    state.recording = item;
    if (inProgress(item) && !state.blocked.has(item.id)) {
      if (authoritativeRoster && !identical(state.roster, new Set(item.participants.keys()))) {
        invalidate(state, '参会人员已变化，本次录音已取消。', true);
        return;
      }
      if (item.initiator_peer_id === state.own.id && state.requestId !== item.id) {
        invalidate(state, '本机无法确认录音请求，本次录音已取消。', true);
        return;
      }
      if (item.initiator_peer_id === state.own.id && state.audioFailed) {
        invalidate(state, '浏览器无法准备录音，本次录音已取消。', true);
        return;
      }
      if (item.state === 'recording') start(state, item);
    }
    render();
  }

  async function command(action) {
    const state = live;
    const item = state?.recording;
    if (!state?.available || state.busy) return;
    if (action === 'request') {
      if (request.hidden || request.disabled) return;
      try {
        const audio = state.audio = new Audio();
        state.audioFailed = false;
        void audio.resume().catch(() => {
          if (!current(state) || state.audio !== audio) return;
          state.audioFailed = true;
          if (inProgress(state.recording)) invalidate(state, '浏览器无法准备录音，本次录音已取消。', true);
        });
      } catch {
        discardCapture(state);
        state.notice = '无法启动浏览器录音。';
        render();
        return;
      }
    } else if (!inProgress(item) || !item.participants.has(state.own.id) || state.blocked.has(item.id)) return;
    if (action === 'stop' && (!state.capture || item.initiator_peer_id !== state.own.id)) return;

    const fence = ++state.fence;
    state.busy = action;
    state.notice = '';
    const clip = action === 'stop' ? state.capture.finish() : null;
    if (action === 'decline') discardCapture(state);
    render();
    const result = await send(state.own, action, action === 'request' ? undefined : item.id).catch(() => null);
    if (!current(state) || state.fence !== fence) return;
    const updated = parseRecording(result?.body?.recording);
    const accepted = result?.status === 200 && updated &&
      (action === 'request' ? updated.initiator_peer_id === state.own.id : updated.id === item.id) &&
      (action !== 'stop' || updated.state === 'stopped') && (action !== 'decline' || !inProgress(updated));
    if (action === 'stop') {
      const blob = await clip;
      if (!current(state) || state.fence !== fence) return;
      state.capture = null;
      state.blob = accepted && updated.initiator_peer_id === state.own.id &&
        identical(new Set(item.participants.keys()), new Set(updated.participants.keys())) &&
        [...updated.participants.values()].every(Boolean) ? blob : null;
      if (!state.blob) state.notice = '无法确认录音已保存，本次音频未保留。';
    }
    state.busy = '';
    state.fence += 1;
    if (!accepted) {
      if (['stop', 'decline'].includes(action)) invalidate(state,
        state.notice || '无法确认录音状态，本次音频未保留。', true);
      else {
        if (action === 'request') discardCapture(state);
        state.notice = '无法确认录音操作，请重试。';
        render();
      }
      return;
    }
    if (action === 'request') state.requestId = updated.id;
    apply(state, updated);
  }

  request?.addEventListener('click', () => command('request'));
  allow?.addEventListener('click', () => command('allow'));
  decline?.addEventListener('click', () => command('decline'));
  stop?.addEventListener('click', () => command('stop'));
  render();

  return {
    fence(own) { return live?.own === own ? live.fence : 0; },
    sync(own, call, readFence) {
      if (live?.own !== own) live = {own, fence:0, blocked:new Set(), roster:new Set(), busy:''};
      if (readFence !== undefined && (live.fence !== readFence || live.busy)) return;
      live.available = Object.hasOwn(call || {}, 'recording');
      live.roster = rosterOf(call);
      apply(live, parseRecording(call?.recording), {authoritativeRoster:true});
    },
    interrupt(own) {
      if (live?.own === own && (live.busy || inProgress(live.recording)) && !live.blocked.has(live.recording?.id)) {
        invalidate(live, '连接中断，本次录音未保留。', true);
      }
    },
    abandon(own) {
      if (live?.own !== own) return;
      live.blob = null;
      if (live.busy || inProgress(live.recording)) invalidate(live, '页面已切换，本次录音未保留。', true);
      render();
    },
    release(own) {
      if (live?.own !== own) return null;
      const blob = live.blob || null;
      discardCapture(live);
      live = null;
      render();
      return blob;
    },
  };
}
