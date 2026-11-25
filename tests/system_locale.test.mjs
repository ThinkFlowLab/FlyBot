import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {applySystemLocale, renderSystemLocale, systemLocale, uiText} from '../flybot_workspace/static/shell/system-locale.mjs';
import {CHAT_MESSAGES} from '../flybot_workspace/static/shell/system-locale-chat.mjs';
import {createPageHandler} from '../runtime/flybot-workspace-web/src/pages.js';
import {readForm} from '../flybot_workspace/static/settings/app.mjs';

const pagesDir = fileURLToPath(new URL('../flybot_workspace/static/', import.meta.url));

test('annotated English templates render before scripts with complete keys and escaped slots', () => {
  for (const page of ['settings', 'chat']) {
    const source = readFileSync(new URL('../flybot_workspace/static/' + page + '/index.html', import.meta.url), 'utf8');
    const messages = page === 'chat' ? CHAT_MESSAGES : undefined;
    for (const [, key] of source.matchAll(/data-ui-(?:text|title|label|placeholder|alt|option-group)="([^"]+)"/g)) {
      assert.ok(uiText('zh-CN', key, undefined, messages), key);
      assert.ok(uiText('en', key, undefined, messages), key);
    }
    const english = renderSystemLocale(source, 'en', messages);
    assert.match(english, /<html lang="en">/);
    if (page === 'settings') {
      assert.match(english, />AI &amp; agent settings</);
      assert.match(english, />System language</);
      assert.match(english, /label="Interface translation unavailable"/);
    } else {
      assert.match(english, /id="chat-send"[^>]*aria-label="Send"/);
    }
    assert.equal(renderSystemLocale(source, 'ja'), source);
  }
  assert.equal(systemLocale('<injected>'), 'zh-CN');
  assert.equal(uiText('en', '__proto__'), undefined);
  const example = '<p href="/same" data-ui-href="shell.chat" title="聊天" data-ui-title="shell.chat"><b>用户数据</b></p>';
  assert.match(renderSystemLocale(example, 'en'), /href="\/same".*title="Chats".*<b>用户数据<\/b>/);
});

test('live locale changes keep input values, runtime labels, and nested controls intact', () => {
  function node(textContent, attrs) {
    return {textContent, getAttribute:name => attrs[name], setAttribute:(name, value) => { attrs[name] = value; }};
  }
  const label = node('设置', {'data-ui-text':'shell.settings'});
  const runtime = node('账', {'data-ui-text':'shell.account','data-ui-label':'shell.account','aria-label':'当前有三条消息'});
  const input = node('', {'data-ui-placeholder':'shell.chat','placeholder':'聊天'});
  input.value = '我的草稿';
  const nested = node('帮助', {'data-ui-text':'shell.help'});
  nested.childElementCount = 1;
  const document = {documentElement:{lang:'zh-CN'},querySelectorAll(selector) {
    return ({'[data-ui-text]':[label,runtime,nested], '[data-ui-label]':[runtime], '[data-ui-placeholder]':[input]})[selector] || [];
  }};
  applySystemLocale(document, 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(label.textContent, 'Settings');
  assert.equal(runtime.textContent, '账');
  assert.equal(runtime.getAttribute('aria-label'), '当前有三条消息');
  assert.equal(nested.textContent, '帮助');
  assert.equal(input.getAttribute('placeholder'), 'Chats');
  assert.equal(input.value, '我的草稿');
  applySystemLocale(document, 'ja');
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(label.textContent, '设置');
  assert.equal(input.getAttribute('placeholder'), '聊天');
});

test('native page language is private to its own runtime and public or unlocalized assets do not query it', async () => {
  let readsA = 0;
  let readsB = 0;
  const english = createPageHandler({pagesDir, identity:{instanceId:'english-owner'}, getSystemLanguage: () => { readsA += 1; return 'en'; }});
  const other = createPageHandler({pagesDir, identity:{instanceId:'other-owner'}, getSystemLanguage: () => { readsB += 1; return 'fr'; }});
  const fetchPage = (handler, path) => handler(new Request('http://local.test/api/flybot-workspace/page?path=' + encodeURIComponent(path)));
  const [a, b, shell, publicPage] = await Promise.all([
    fetchPage(english, '/settings/language'), fetchPage(other, '/chat'),
    fetchPage(english, '/shell/system-locale.mjs'), fetchPage(other, '/a/example-agent'),
  ]);
  assert.equal(a.headers.get('content-language'), 'en');
  assert.match(a.headers.get('cache-control'), /no-store/);
  assert.match(await a.text(), /<html lang="en">[\s\S]*>System language</);
  assert.equal(b.headers.get('content-language'), 'zh-CN');
  assert.match(await b.text(), /<html lang="zh-CN">[\s\S]*聊天 · FlyBot/);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('content-language'), null);
  assert.equal(publicPage.status, 404);
  assert.equal(readsA, 1);
  assert.equal(readsB, 1);
});

test('an unsupported stored language is not lost when its select option is disabled', t => {
  t.mock.method(globalThis, 'FormData', function () { return {get:()=>null,has:()=>false}; });
  const form = {elements:{language:{value:'ja'}}};
  assert.equal(readForm(form).language, 'ja');
});
