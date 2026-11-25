const LANGUAGE_LABELS = new Map([
  ['js', 'JavaScript'], ['javascript', 'JavaScript'],
  ['ts', 'TypeScript'], ['typescript', 'TypeScript'],
  ['py', 'Python'], ['python', 'Python'],
  ['sh', 'Shell'], ['bash', 'Bash'], ['zsh', 'Zsh'],
  ['json', 'JSON'], ['yaml', 'YAML'], ['yml', 'YAML'],
  ['html', 'HTML'], ['css', 'CSS'], ['sql', 'SQL'],
  ['md', 'Markdown'], ['markdown', 'Markdown'], ['mermaid', 'Mermaid'],
]);

export function renderChatCodeBlock(document, {text, language} = {}) {
  const english = document.documentElement?.lang === 'en';
  const label = (zh, en) => english ? en : zh;
  const source = typeof text === 'string' ? text : '';
  const name = typeof language === 'string' && /^[a-z0-9][a-z0-9+#._-]{0,31}$/i.test(language)
    ? language.toLowerCase() : '';

  const block = document.createElement('div');
  block.className = 'chat-code-block';
  const toolbar = document.createElement('div');
  toolbar.className = 'chat-code-toolbar';
  const languageLabel = document.createElement('span');
  languageLabel.className = 'chat-code-language';
  languageLabel.textContent = LANGUAGE_LABELS.get(name) || name || label('代码', 'Code');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'chat-code-copy';
  copy.textContent = label('复制代码', 'Copy code');
  toolbar.append(languageLabel, copy);

  const pre = document.createElement('pre');
  pre.tabIndex = 0;
  const code = document.createElement('code');
  code.textContent = source;
  pre.append(code);
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');

  copy.addEventListener('click', async () => {
    const view = document.defaultView;
    status.textContent = '';
    try {
      await view.navigator.clipboard.writeText(source);
      copy.textContent = label('已复制', 'Copied');
      status.textContent = label('代码已复制。', 'Code copied.');
    } catch {
      const selection = view?.getSelection?.();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      copy.textContent = label('请手动复制', 'Copy manually');
      status.textContent = label('无法访问剪贴板，请手动复制代码。', 'Clipboard unavailable. Copy the code manually.');
    }
  });

  block.append(toolbar, pre, status);
  return block;
}
