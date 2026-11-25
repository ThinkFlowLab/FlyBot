import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'flybot_workspace', 'static');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const ACCOUNT_LINKS = [
  {href: '/help', label: '帮助中心'},
  {href: '/terms', label: '服务条款'},
  {href: '/privacy', label: '隐私政策'},
];
const DISABLED = [
  '未实现：还没有 FlyBot 帮助中心页',
  '未实现：还没有 FlyBot 服务条款页',
  '未实现：还没有 FlyBot 隐私政策页',
];

function hasAccountMenuLink(html, href, label) {
  // Account-menu anchors may carry data-ui-text (or other) attributes, and
  // attribute order varies across pages after the locale catalog landed.
  const anchors = html.matchAll(/<a\b([^>]*?)>([^<]*)<\/a>/g);
  for (const match of anchors) {
    const attrs = match[1];
    if (match[2] !== label) continue;
    if (!new RegExp(`\\bhref="${href}"`).test(attrs)) continue;
    if (!/\brole="menuitem"/.test(attrs)) continue;
    return true;
  }
  return false;
}

const ACCOUNT_PAGES = fs.readdirSync(ROOT)
  .filter(name => fs.existsSync(path.join(ROOT, name, 'index.html')))
  .filter(name => read(path.join(name, 'index.html')).includes('id="help-menu"'))
  .sort();

test('every account menu links to the help centre, terms and privacy pages', () => {
  assert.ok(ACCOUNT_PAGES.length >= 17,
    `expected the account menu on at least 17 pages, found ${ACCOUNT_PAGES.join(', ')}`);
  for (const page of ACCOUNT_PAGES) {
    const html = read(path.join(page, 'index.html'));
    for (const {href, label} of ACCOUNT_LINKS) {
      assert.ok(hasAccountMenuLink(html, href, label),
        `${page}/index.html still has no real ${label} link in the account menu`);
    }
    for (const text of DISABLED) {
      assert.ok(!html.includes(text), `${page}/index.html still carries the disabled placeholder: ${text}`);
    }
  }
});

test('the help centre lists each feature with what works and where it stops', () => {
  const html = read('help/index.html');
  assert.ok(html.includes('<h1>帮助中心</h1>'));
  for (const anchor of ['chat', 'channels', 'agents', 'artifacts', 'automations', 'meetings', 'memory', 'team', 'runtimes']) {
    assert.ok(html.includes(`id="${anchor}"`), `the help centre has no section for ${anchor}`);
  }
  assert.ok(html.includes('现在能做什么'));
  assert.ok(html.includes('已知边界'));
  assert.ok(!html.includes('即将支持'));
  assert.ok(!/teamily\.(ai|com)/i.test(html), 'the help centre must not quote the Teamily site');
});

test('terms and privacy state where a self-hosted instance keeps its data', () => {
  const terms = read('terms/index.html');
  assert.ok(terms.includes('<h1>服务条款</h1>'));
  assert.ok(terms.includes('自托管实例'));
  assert.ok(terms.includes('--data-dir'));

  const privacy = read('privacy/index.html');
  assert.ok(privacy.includes('<h1>隐私政策</h1>'));
  assert.ok(privacy.includes('management.sqlite3'), 'privacy must name the real database file');
  assert.ok(privacy.includes('artifact_media'), 'privacy must name where media blobs live');
  assert.ok(privacy.includes('/artifacts/&lt;id&gt;/export'), 'privacy must cite the real export route');
  assert.ok(privacy.includes('删除账户'), 'privacy must say account deletion is not self-service');
});
