const MAX_FILE_BYTES = 512 * 1024;
const IMPORT_TYPES = new Set(['txt', 'md', 'markdown', 'vtt', 'srt']);
const TIMING = /^(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}(?:[ \t].*)?$/;
const ENTITIES = {amp:'&', lt:'<', gt:'>', nbsp:'\u00a0', lrm:'\u200e', rlm:'\u200f'};
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function captionsToText(source, type) {
  if (type === 'vtt' && !/^WEBVTT(?:[ \t]|\n|$)/.test(source)) {
    throw new Error('无法读取 WebVTT 字幕。');
  }
  const paragraphs = [];
  for (const block of source.split(/\n[ \t]*\n+/)) {
    const lines = block.trim().split('\n');
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[0])) continue;
    const timing = TIMING.test(lines[0]) ? 0 : TIMING.test(lines[1] || '') ? 1 : -1;
    if (timing < 0) continue;
    const cue = lines.slice(timing + 1).join('\n')
      .replace(/<v(?:\.[^ >]+)*[ \t]+([^>\n]+)>/gi, (_tag, speaker) => speaker.trim() + '：')
      .replace(/<\/?(?:v|c|b|i|u|ruby|rt|lang|font)(?:[. \t][^>\n]*)?>/gi, '')
      .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_entity, name) => ENTITIES[name])
      .trim();
    if (cue) paragraphs.push(cue);
  }
  if (!paragraphs.length) throw new Error('没有读到字幕正文。');
  return paragraphs.join('\n');
}

export async function readTranscriptFile(file, limit = 40000) {
  const type = file.name.split('.').pop().toLowerCase();
  if (!IMPORT_TYPES.has(type)) throw new Error('请选择 TXT、Markdown、VTT 或 SRT 文件。');
  if (file.size > MAX_FILE_BYTES) throw new Error('文字文件超过 512 KB，请先裁剪。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text;
  try {
    text = new TextDecoder(encoding, {fatal:true}).decode(bytes).replace(/\r\n?/g, '\n');
  } catch {
    throw new Error('请使用 UTF-8 或带 BOM 的 UTF-16 文本。');
  }
  if (CONTROL.test(text)) throw new Error('文件包含无法导入的控制字符。');
  if (type === 'vtt' || type === 'srt') text = captionsToText(text, type);
  if (!text.trim()) throw new Error('文件没有可导入的文字。');
  if (text.length > limit) throw new Error(`转写超过 ${limit} 字，请先裁剪。`);
  return text;
}

export function mountTranscriptImport(document, {transcript, scope}) {
  const node = suffix => document.getElementById('meeting-transcript-import' + suffix);
  const wrapper = node('');
  const picker = node('-file');
  const open = node('-open');
  const status = node('-status');
  const undo = node('-undo');
  const dialog = node('-dialog');
  const filename = node('-filename');
  const preview = node('-preview');
  const feedback = node('-feedback');
  const append = node('-append');
  const replace = node('-replace');
  const limit = transcript.maxLength > 0 ? transcript.maxLength : 40000;
  let reading;
  let selected;
  let lastImport;
  let returnFocus;

  function clearPreview() {
    selected = undefined;
    filename.textContent = preview.value = feedback.textContent = '';
  }

  function syncUndo() {
    if (lastImport && (lastImport.scope !== scope() || lastImport.after !== transcript.value)) lastImport = undefined;
    undo.hidden = !lastImport;
  }

  function sync() {
    wrapper.hidden = !scope();
    syncUndo();
  }

  function reset() {
    reading = lastImport = returnFocus = undefined;
    if (dialog.open) dialog.close();
    clearPreview();
    picker.value = status.textContent = '';
    open.disabled = false;
    wrapper.hidden = undo.hidden = true;
  }

  function setTranscript(value) {
    transcript.value = value;
    transcript.dispatchEvent(new document.defaultView.Event('input', {bubbles:true}));
  }

  open.addEventListener('click', () => {
    if (scope() && !reading) picker.click();
  });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    const target = scope();
    if (!file || !target) return;
    const pending = reading = {scope:target};
    open.disabled = true;
    status.textContent = '正在读取文字转写…';
    try {
      const text = await readTranscriptFile(file, limit);
      if (reading !== pending || scope() !== pending.scope) return;
      selected = {scope:target, text};
      filename.textContent = file.name;
      preview.value = text;
      const hasTranscript = Boolean(transcript.value.trim());
      append.textContent = hasTranscript ? '追加到正文' : '导入正文';
      replace.hidden = !hasTranscript;
      returnFocus = open;
      status.textContent = '';
      dialog.showModal();
    } catch (error) {
      if (reading === pending && scope() === pending.scope) {
        status.textContent = error.message || '无法读取这份转写。';
      }
    } finally {
      if (reading === pending) {
        reading = undefined;
        open.disabled = false;
      }
    }
  });

  function apply(useReplacement) {
    if (!selected || selected.scope !== scope()) return;
    const before = transcript.value;
    const separator = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const after = useReplacement || !before.trim() ? selected.text : before + separator + selected.text;
    if (after.length > limit) {
      feedback.textContent = `加入后会超过 ${limit} 字，可替换正文或先缩短现有内容。`;
      return;
    }
    lastImport = {scope:selected.scope, before, after};
    setTranscript(after);
    returnFocus = transcript;
    status.textContent = '已导入文字转写。';
    dialog.close();
  }

  append.addEventListener('click', () => apply(false));
  replace.addEventListener('click', () => apply(true));
  node('-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    clearPreview();
    if (scope()) returnFocus?.focus({preventScroll:true});
    returnFocus = undefined;
  });
  undo.addEventListener('click', () => {
    syncUndo();
    if (!lastImport) return;
    setTranscript(lastImport.before);
    status.textContent = '已撤销导入。';
    transcript.focus({preventScroll:true});
  });
  transcript.addEventListener('input', syncUndo);
  return {reset, sync};
}
