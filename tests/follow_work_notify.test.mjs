import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FOLLOW_WORK_EMPTY, followWorkNotice, followWorkSwitchLabel} from '../flybot_workspace/static/profile/app.mjs';
import {notificationSummary} from '../flybot_workspace/static/chat/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'flybot_workspace/static/profile/index.html'), 'utf8');

test('the 通知 bell opens a real 作品通知 panel instead of the disabled placeholder', () => {
  const button = /<button[^>]*id="profile-notify-open"[^>]*>/.exec(html);
  assert.ok(button, 'the 通知 bell is missing from the profile page');
  assert.doesNotMatch(button[0], /\bdisabled\b/, 'the 通知 bell is still disabled');
  assert.doesNotMatch(html, /未接通：还没有通知订阅接口/, 'the placeholder tooltip is still there');
  assert.match(html, /id="follow-work-dialog"/, 'there is no 作品通知 dialog');
  assert.match(html, /id="follow-work-list"/, 'the 作品通知 dialog has no list of followed creators');
  assert.match(html, /id="follow-work-empty"/, 'the 作品通知 dialog has no empty note');
});

test('each 作品通知 switch has its own Chinese label and result line', () => {
  assert.equal(FOLLOW_WORK_EMPTY, '还没有关注任何人。先在发现页关注作者，再回来打开作品通知。');
  assert.equal(followWorkSwitchLabel('Alice'), 'Alice 的作品通知');
  assert.equal(followWorkSwitchLabel(''), '这个账号的作品通知');
  assert.equal(followWorkNotice(true), '已打开作品通知。');
  assert.equal(followWorkNotice(false), '已关闭作品通知。');
});

test('a follow_work notification names the author and the new work', () => {
  assert.equal(
    notificationSummary({kind: 'follow_work', actor_username: 'alice', title: '设计稿'}),
    'alice 发布了新作品「设计稿」',
  );
  assert.equal(
    notificationSummary({kind: 'follow_work', actor_username: '', title: ''}),
    '你关注的作者 发布了新作品',
  );
});
