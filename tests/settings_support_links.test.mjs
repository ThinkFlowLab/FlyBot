import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

// The three rows under 支持与法律. Each must send the reader to the page that
// already exists, instead of a disabled button that claims the page is missing.
const LEGAL_ROWS = [
  {label: '帮助中心', href: '/help'},
  {label: '服务条款', href: '/terms'},
  {label: '隐私政策', href: '/privacy'},
];

function rowLink(html, href, label) {
  const rows = html.match(/<a class="settings-row" href="[^"]*">[\s\S]*?<\/a>/g) || [];
  // Labels may carry data-ui-text (or other) attributes after the locale catalog landed.
  const labelRe = new RegExp(
    `<span\\b[^>]*\\bclass="settings-row-label"[^>]*>${label}</span>`,
  );
  return rows.find((row) => row.includes(`href="${href}"`) && labelRe.test(row));
}

test('the settings page links the help, terms and privacy pages it already serves', () => {
  const html = read('flybot_workspace/static/settings/index.html');
  for (const {label, href} of LEGAL_ROWS) {
    assert.ok(rowLink(html, href, label),
      `the 支持与法律 row for ${label} must be a link to ${href}, not a disabled placeholder`);
  }
});

test('no settings row still claims a legal page does not exist', () => {
  const html = read('flybot_workspace/static/settings/index.html');
  for (const {label} of LEGAL_ROWS) {
    assert.ok(!html.includes(`未接通：还没有 FlyBot ${label}页`),
      `settings still claims it has no ${label} page, but /help, /terms and /privacy are served`);
  }
  assert.ok(!/<button[^>]*class="settings-row"[^>]*disabled/.test(html),
    'a settings row that opens a real page must not stay a disabled button');
});

test('every linked legal page is a route the server really serves', () => {
  const server = read('flybot_workspace/settings_page.py');
  for (const {label, href} of LEGAL_ROWS) {
    assert.ok(server.includes(`'${href}': (`),
      `settings links ${href} for ${label} but the server has no such route`);
  }
});
