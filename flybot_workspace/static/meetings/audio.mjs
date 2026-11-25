import {validCallAudio} from '../shell/call-audio-handoff.mjs';

const SAMPLE_RATE = 16000;
const SEGMENT_SAMPLES = 15 * SAMPLE_RATE;
const MAX_SECONDS = 600;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const PREPARING = new Set(['checking', 'downloading', 'loading', 'cancelling']);

export function waveBase64(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const wave = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  }
  wave.setUint32(4, bytes.length - 8, true);
  wave.setUint32(16, 16, true);
  wave.setUint16(20, 1, true);
  wave.setUint16(22, 1, true);
  wave.setUint32(24, SAMPLE_RATE, true);
  wave.setUint32(28, SAMPLE_RATE * 2, true);
  wave.setUint16(32, 2, true);
  wave.setUint16(34, 16, true);
  wave.setUint32(40, bytes.length - 44, true);
  samples.forEach((value, index) => {
    const sample = Math.max(-1, Math.min(1, value));
    wave.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  });
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

async function decodeAudio(blob) {
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Audio || !Offline) throw new Error('当前浏览器无法解码音频。');
  const audio = new Audio();
  try {
    const input = await audio.decodeAudioData(await blob.arrayBuffer()).catch(() => null);
    if (!input || !input.duration) throw new Error('无法读取这份音频，请更换文件。');
    if (input.duration > MAX_SECONDS) throw new Error('请选择时长不超过 10 分钟的音频。');
    const output = new Offline(1, Math.max(1, Math.ceil(input.duration * SAMPLE_RATE)), SAMPLE_RATE);
    const source = output.createBufferSource();
    source.buffer = input;
    source.connect(output.destination);
    source.start();
    return (await output.startRendering()).getChannelData(0);
  } finally {
    await audio.close().catch(() => {});
  }
}

export function mountMeetingAudio(document, {request, base, transcript, onPendingChange = () => {}}) {
  const el = id => document.getElementById(id);
  const panel = el('meeting-audio'), preview = el('meeting-audio-preview'), file = el('meeting-audio-file');
  const status = el('meeting-audio-status'), prepare = el('meeting-audio-prepare');
  const record = el('meeting-audio-record'), stop = el('meeting-audio-stop');
  const start = el('meeting-audio-start'), discard = el('meeting-audio-discard');
  const addPartial = el('meeting-audio-add-partial');
  if (!panel) return {reset() {}, hasPendingWork: () => false, acceptCallRecording: () => false};
  let input = null, used = false, url = '', phase = '', ready = false, checking = false, asking = false;
  let progress = null, capture = null, captureTimer, pollTimer, operation = null, scope = 0;
  let discardCallRecording = null, discarding = false;

  function hasPendingWork() {
    return Boolean(capture || asking || operation || discarding ||
      (input && !used && (!discardCallRecording || progress?.next)));
  }

  function refreshButtons() {
    prepare.hidden = !['unprepared', 'failed', 'cancelled'].includes(phase);
    prepare.disabled = checking;
    const busy = Boolean(capture || operation || asking || discarding);
    record.disabled = busy || Boolean(discardCallRecording) || !globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder;
    stop.hidden = !capture;
    file.disabled = busy || Boolean(discardCallRecording);
    const finished = Boolean(progress?.total && progress.next === progress.total);
    start.disabled = !input || used || (!ready && !finished) || busy;
    start.textContent = used ? '开始转写' : finished ? '加入正文' : progress?.next ? '继续转写' : '开始转写';
    addPartial.hidden = !progress || used || finished || progress.added === progress.notes.length;
    addPartial.disabled = busy;
    discard.disabled = discarding || (!input && !operation);
    discard.textContent = operation ? '取消转写' : '移除音频';
  }

  function syncAudio() {
    refreshButtons();
    onPendingChange();
  }

  function audioInput(blob, discardRecording = null) {
    if (url) URL.revokeObjectURL(url);
    input = blob;
    discardCallRecording = discardRecording;
    used = false;
    progress = blob ? {samples: null, total: 0, next: 0, notes: [], added: 0} : null;
    url = blob ? URL.createObjectURL(blob) : '';
    preview.hidden = !url;
    if (url) preview.src = url;
    else preview.removeAttribute('src');
    file.value = '';
    syncAudio();
  }

  function acceptCallRecording({blob, discard:remove} = {}) {
    if (input || capture || operation || asking || !validCallAudio(blob) || typeof remove !== 'function') return false;
    audioInput(blob, remove);
    panel.open = true;
    status.textContent = '已带入通话录音。试听后可开始转写。';
    return true;
  }

  async function checkSpeech(method = 'GET') {
    if (checking) return;
    const epoch = scope;
    clearTimeout(pollTimer);
    checking = true;
    refreshButtons();
    try {
      const result = await request(method, base() + '/speech', method === 'POST' ? {} : undefined);
      if (epoch !== scope) return;
      if (result.status !== 200) throw new Error(result.body.error?.message || '无法读取语音识别状态。');
      ({phase, ready} = result.body);
      if (PREPARING.has(phase) && panel.open) pollTimer = setTimeout(checkSpeech, 1800);
      if (operation || capture) return;
      const progress = result.body.progress;
      if (ready) {
        if (!progress?.next && !used) status.textContent = discardCallRecording ? '录音暂存在本机，试听后可以开始转写。'
          : input ? '音频已选好，试听后可以开始转写。' : '';
      }
      else if (phase === 'unavailable') status.textContent = '当前 DS-Bot 尚未启用本地语音识别。';
      else if (phase === 'failed') status.textContent = '语音识别准备失败，请重试。';
      else if (PREPARING.has(phase)) {
        status.textContent = Number.isFinite(progress) ? `正在准备语音识别，下载 ${progress}%` : '正在准备语音识别…';
      } else status.textContent = '首次使用需要准备本地语音识别。';
    } catch (error) {
      if (epoch === scope) status.textContent = error.message || '无法读取语音识别状态。';
    } finally {
      if (epoch === scope) {
        checking = false;
        refreshButtons();
      }
    }
  }

  function stopCapture() {
    clearTimeout(captureTimer);
    if (!capture) return;
    if (capture.recorder.state !== 'inactive') capture.recorder.stop();
    for (const track of capture.stream.getTracks()) track.stop();
  }

  function reset() {
    scope += 1;
    clearTimeout(pollTimer);
    stopCapture();
    capture = null;
    operation?.abort();
    operation = null;
    phase = '';
    ready = checking = asking = false;
    discarding = false;
    audioInput(null);
    status.textContent = '';
    panel.open = false;
  }

  panel.addEventListener('toggle', () => {
    if (panel.open) void checkSpeech();
    else clearTimeout(pollTimer);
  });
  prepare.addEventListener('click', () => checkSpeech('POST'));
  file.addEventListener('change', () => {
    const blob = file.files?.[0];
    if (!blob) return;
    if (!blob.size || blob.size > MAX_FILE_BYTES) {
      file.value = '';
      status.textContent = '请选择大小不超过 32 MB 的音频。';
      return;
    }
    audioInput(blob);
    status.textContent = '音频已选好，试听后可以开始转写。';
  });
  record.addEventListener('click', async () => {
    const epoch = scope;
    let stream;
    asking = true;
    syncAudio();
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
      if (scope !== epoch) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const recorder = new MediaRecorder(stream);
      const clips = [];
      capture = {recorder, stream};
      recorder.ondataavailable = event => { if (event.data.size) clips.push(event.data); };
      recorder.onstop = () => {
        if (scope !== epoch) return;
        stopCapture();
        capture = null;
        const blob = new Blob(clips, {type: recorder.mimeType});
        if (blob.size) {
          audioInput(blob);
          status.textContent = '录音已完成，试听后可以开始转写。';
        } else status.textContent = '没有录到音频，请重试。';
        refreshButtons();
      };
      recorder.start();
      captureTimer = setTimeout(stopCapture, MAX_SECONDS * 1000);
      status.textContent = '正在录音…';
    } catch (error) {
      for (const track of stream?.getTracks() || []) track.stop();
      if (scope === epoch) {
        capture = null;
        status.textContent = error.name === 'NotAllowedError' ? '请允许麦克风权限，或上传音频。' : '无法录音，请检查麦克风。';
      }
    } finally {
      if (scope === epoch) { asking = false; syncAudio(); }
    }
  });
  stop.addEventListener('click', stopCapture);
  discard.addEventListener('click', async () => {
    if (operation) {
      operation.abort();
      status.textContent = progress?.next ? `已取消转写。已保留 ${progress.next} / ${progress.total} 段，可以继续。` : '已取消转写。';
      return;
    }
    const epoch = scope;
    if (discardCallRecording) {
      discarding = true;
      syncAudio();
      try {
        await discardCallRecording();
      } catch {
        if (epoch === scope) status.textContent = '暂时无法删除本机录音，请重试。';
        return;
      } finally {
        if (epoch === scope) {
          discarding = false;
          syncAudio();
        }
      }
    }
    if (epoch !== scope) return;
    audioInput(null);
    status.textContent = '';
  });

  function addRecognized(state) {
    const lines = state.notes.slice(state.added).join('\n');
    if (!lines) return;
    const combined = [transcript.value, lines].filter(Boolean).join('\n\n');
    if (combined.length > transcript.maxLength) throw new Error('正文已达上限，请精简后再加入转写。');
    transcript.value = combined;
    state.added = state.notes.length;
    transcript.dispatchEvent(new Event('input', {bubbles: true}));
  }

  addPartial.addEventListener('click', () => {
    if (addPartial.disabled || addPartial.hidden) return;
    try {
      addRecognized(progress);
      status.textContent = '已将识别到的片段加入正文，可继续转写剩余音频。';
      syncAudio();
    } catch (error) {
      status.textContent = error.message;
    }
  });

  start.addEventListener('click', async () => {
    if (start.disabled) return;
    const work = new AbortController();
    const target = base();
    const state = progress;
    operation = work;
    syncAudio();
    try {
      if (!state.total) {
        status.textContent = '正在读取音频…';
        const samples = await decodeAudio(input);
        work.signal.throwIfAborted();
        state.samples = samples;
        state.total = Math.ceil(samples.length / SEGMENT_SAMPLES);
      }
      while (state.next < state.total) {
        const i = state.next;
        status.textContent = `正在转写第 ${i + 1} / ${state.total} 段…`;
        const audio_base64 = waveBase64(state.samples.subarray(i * SEGMENT_SAMPLES, (i + 1) * SEGMENT_SAMPLES));
        const result = await request('POST', target + '/transcribe', {audio_base64}, undefined, work.signal);
        work.signal.throwIfAborted();
        if (result.status !== 200) {
          if (result.body.error?.code === 'speech_not_ready') void checkSpeech();
          throw new Error(result.body.error?.message || '转写失败，请重试。');
        }
        if (result.body.text) state.notes.push(result.body.text);
        state.next += 1;
      }
      state.samples = null;
      if (!state.notes.length) {
        status.textContent = '没有识别到语音。';
        state.total = state.next = 0;
        return;
      }
      addRecognized(state);
      used = true;
      status.textContent = '已将转写加入正文，可核对并保存。';
    } catch (error) {
      if (!work.signal.aborted && operation === work) {
        const message = error.message || '转写失败，请重试。';
        status.textContent = state.next ? message + ` 已保留 ${state.next} / ${state.total} 段。` : message;
      }
    } finally {
      if (operation === work) {
        operation = null;
        syncAudio();
      }
    }
  });
  globalThis.addEventListener?.('pagehide', () => {
    panel.open = false;
    reset();
  });
  refreshButtons();
  return {reset, hasPendingWork, acceptCallRecording};
}
