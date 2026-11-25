import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {appConnectionState} from '../flybot_workspace/static/onboarding/app.mjs';

// Step 2 used to print ' · 未连接' for every app no matter what the workspace
// actually had. These tests pin the mapping from the real reads to the words a
// user sees, including the case where the list could not be read at all.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a real connection shows as 已连接 and a failing one as 未连接', () => {
  const connections = [{toolkit: 'github', state: 'connected'}, {toolkit: 'gmail', state: 'failed'}];
  assert.equal(appConnectionState({key: 'github', name: 'GitHub'}, {connections}).label, '已连接');
  assert.equal(appConnectionState({key: 'gmail', name: 'Gmail'}, {connections}).label, '连接失败');
  assert.equal(appConnectionState({key: 'google-calendar', name: 'Google Calendar'}, {connections}).label, '未连接');
});

test('the Composio toolkit slugs of the step-2 catalog are mapped explicitly', () => {
  const connections = [
    {toolkit: 'googlecalendar', state: 'connected'},
    {toolkit: 'googledrive', state: 'connecting'},
    {toolkit: 'googlesheets', state: 'inactive'},
  ];
  assert.equal(appConnectionState({key: 'google-calendar'}, {connections}).label, '已连接');
  assert.equal(appConnectionState({key: 'google-drive'}, {connections}).label, '连接中');
  assert.equal(appConnectionState({key: 'google-sheets'}, {connections}).label, '已停用');
  assert.equal(appConnectionState({key: 'google-docs'}, {connections}).label, '未连接');
});

test('an unreadable connection list says 未接入 instead of 未连接', () => {
  const state = appConnectionState({key: 'gmail', name: 'Gmail'}, {connections: [], readable: false});
  assert.equal(state.label, '未接入');
  assert.equal(state.connected, false);
  assert.match(state.title, /Composio/);
});

test('a failed Composio sync says 状态未知 instead of inventing 未连接', () => {
  const state = appConnectionState({key: 'gmail'}, {connections: [], readable: true, sync: 'failed'});
  assert.equal(state.label, '状态未知');
  assert.match(state.title, /同步失败/);
});

test('the recorded step-2 copy no longer claims app connections are unimplemented', () => {
  const source = readFileSync(path.join(root, 'flybot_workspace/static/onboarding/index.html'), 'utf8');
  assert.doesNotMatch(source, /尚未实现/);
  assert.match(source, /已连接/);
  assert.match(source, /未接入/);
});

// Changing the wording on the page without changing the wording the repository's
// own screenshot script asserts is a silent CI red: the script keeps looking for
// the retired string. Pin both files to the same contract here.
test('the screenshot script pins the same step-2 wording as the page', () => {
  const script = readFileSync(path.join(root, 'scripts/ci_ui_screenshots.mjs'), 'utf8');
  assert.doesNotMatch(script, /Gmail · 未连接/,
    'ci_ui_screenshots.mjs still asserts the retired "Gmail · 未连接" wording');
  assert.match(script, /appStates\.length === 8/,
    'the step-2 record must require all 8 connector rows, not one sample row');
  assert.match(script, /'· 未接入'/, 'the step-2 record must pin the unreadable case as 未接入');
  assert.match(script, /!appsText\.includes\('已连接'\)/, 'the step-2 record must also reject a fake 已连接');
  assert.match(script, /onboarding_connectors_honest/, 'the honesty check needs its own named record');
  assert.match(script, /appStates\.length\}\/8/, 'the honesty record must carry the text it read');
});
