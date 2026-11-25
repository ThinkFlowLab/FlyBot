const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const VOICE_TYPES = new Set(MIME_TYPES.map(type => type.split(';')[0]));
const MAX_BYTES = 128 * 1024;
const MAX_SECONDS = 30;

async function encodeVoice(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return {mime: blob.type, data: btoa(binary)};
}

export function decodeVoice({mime, data} = {}) {
  if (!VOICE_TYPES.has(mime) || typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4) {
    throw new Error('Unsupported voice message');
  }
  return new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], {type: mime});
}

export function mountVoiceRecorder(doc, {context, send, createKey}) {
  const record = doc.getElementById('voice-record');
  const panel = doc.getElementById('voice-draft-panel');
  if (!record || !panel) return {refresh() {}, clear() {}};
  const status = doc.getElementById('voice-draft-status');
  const stop = doc.getElementById('voice-stop');
  const cancel = doc.getElementById('voice-discard');
  const publish = doc.getElementById('voice-send');
  const preview = doc.getElementById('voice-preview');
  const Recorder = globalThis.MediaRecorder;
  const devices = globalThis.navigator?.mediaDevices;
  const format = Recorder?.isTypeSupported && MIME_TYPES.find(type => Recorder.isTypeSupported(type));

  let scope = context()?.scope;
  let job = null;
  let draft = null;
  let note = '';

  function render() {
    record.hidden = !scope;
    record.disabled = Boolean(!format || !devices?.getUserMedia || job || draft);
    record.title = format && devices?.getUserMedia ? '录制语音' : '当前浏览器不支持录音';
    panel.hidden = !scope || !(job || draft || note);
    stop.hidden = !job?.recorder || job.recorder.state !== 'recording';
    cancel.hidden = !(job || draft || note);
    cancel.disabled = Boolean(draft?.sending);
    publish.hidden = !draft;
    publish.disabled = Boolean(draft?.sending);
    preview.hidden = !draft;
    status.textContent = note;
  }

  function release(active) {
    clearTimeout(active.timer);
    for (const track of active.stream?.getTracks() ?? []) track.stop();
  }

  function clear() {
    const active = job;
    job = null;
    if (active) {
      if (active.recorder?.state === 'recording') active.recorder.stop();
      release(active);
    }
    if (draft) {
      URL.revokeObjectURL(draft.url);
      preview.removeAttribute('src');
      draft = null;
    }
    note = '';
    render();
  }

  function refresh() {
    const next = context()?.scope;
    if (scope !== next) {
      scope = next;
      clear();
      return;
    }
    render();
  }

  record.addEventListener('click', async () => {
    refresh();
    const destination = context();
    if (!destination || !format || job || draft) return;
    const active = {destination, chunks: []};
    job = active;
    note = '等待麦克风授权…';
    render();
    try {
      active.stream = await devices.getUserMedia({audio: true});
      if (job !== active) { release(active); return; }
      const recorder = new Recorder(active.stream, {mimeType: format, audioBitsPerSecond: 24000});
      active.recorder = recorder;
      let size = 0;
      recorder.addEventListener('dataavailable', event => {
        if (job !== active || !event.data.size) return;
        size += event.data.size;
        if (size <= MAX_BYTES) active.chunks.push(event.data);
        if (size > MAX_BYTES && recorder.state === 'recording') recorder.stop();
      });
      recorder.addEventListener('stop', () => {
        release(active);
        if (job !== active) return;
        job = null;
        const mime = (recorder.mimeType || format).split(';')[0].toLowerCase();
        const blob = new Blob(active.chunks, {type: mime});
        if (!blob.size || size > MAX_BYTES || !VOICE_TYPES.has(mime)) {
          note = size > MAX_BYTES ? '录音过大，请录短一点。' : '没有录到声音，请重试。';
        } else {
          draft = {blob, url: URL.createObjectURL(blob), destination, key: createKey()};
          preview.src = draft.url;
          note = '试听后发送。';
        }
        render();
      });
      recorder.addEventListener('error', () => {
        if (job !== active) return;
        clear();
        note = '录音中断，请重试。';
        render();
      });
      recorder.start(500);
      active.timer = setTimeout(() => {
        if (job === active && recorder.state === 'recording') recorder.stop();
      }, MAX_SECONDS * 1000);
      note = '录音中 · 最长 30 秒';
      render();
    } catch (error) {
      if (job !== active) return;
      clear();
      note = error?.name === 'NotAllowedError' ? '麦克风未授权。' : '无法启动录音，请检查麦克风。';
      render();
    }
  });

  stop.addEventListener('click', () => {
    if (job?.recorder?.state === 'recording') job.recorder.stop();
    render();
  });
  cancel.addEventListener('click', clear);
  publish.addEventListener('click', async () => {
    refresh();
    const current = draft;
    if (!current || current.sending) return;
    current.sending = true;
    note = '正在发送语音…';
    render();
    try {
      const encoded = await encodeVoice(current.blob);
      if (draft !== current) return;
      await send(current.destination, encoded, current.key);
      if (draft === current) clear();
    } catch (error) {
      if (draft === current) {
        current.sending = false;
        note = error?.message || '语音发送失败，请重试。';
      }
    } finally { render(); }
  });
  globalThis.addEventListener?.('pagehide', clear);
  render();
  return {refresh, clear};
}
