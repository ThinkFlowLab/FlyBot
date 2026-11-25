import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AVATAR_LIMIT, avatarNotice, paintAvatarImage} from '../flybot_workspace/static/profile/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'flybot_workspace/static/profile/index.html'), 'utf8');
const source = readFileSync(path.join(root, 'flybot_workspace/static/profile/app.mjs'), 'utf8');

function fakeImage() {
  return {
    hidden: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

test('the 更换头像 control opens a real PNG/JPG picker instead of the disabled placeholder', () => {
  const button = /<button[^>]*id="profile-change-avatar"[^>]*>/.exec(html);
  assert.ok(button, 'the 更换头像 button is missing from the edit page');
  assert.doesNotMatch(button[0], /\bdisabled\b/, 'the 更换头像 button is still disabled');
  assert.doesNotMatch(html, /未接通：还没有头像上传接口/, 'the placeholder tooltip is still there');
  assert.match(
    html,
    /<input[^>]*type="file"[^>]*id="profile-avatar-input"[^>]*accept="image\/png,image\/jpeg"/,
    'the edit page has no hidden file input limited to PNG/JPG',
  );
  assert.match(html, /id="profile-avatar-image"/, 'the profile header has no element that can show an avatar image');
  assert.match(html, /id="profile-edit-avatar-image"/, 'the edit form has no element that can show an avatar image');
});

test('the page turns each avatar upload failure into a Chinese reason', () => {
  assert.equal(AVATAR_LIMIT, 2 * 1024 * 1024);
  assert.equal(avatarNotice(413), '头像不能超过 2 MB。');
  assert.equal(avatarNotice(415), '头像只支持 PNG 或 JPG。');
  assert.equal(avatarNotice(401), '登录状态已失效，请重新登录。');
  assert.equal(avatarNotice(403), '页面已过期，请刷新后重试。');
  assert.equal(
    avatarNotice(500, {message: 'Storage is temporarily unavailable'}),
    'Storage is temporarily unavailable',
  );
  assert.equal(avatarNotice(500, {}), '头像上传失败，请稍后重试。');
  assert.match(source, /fetch\('\/v1\/profile\/avatar'/, 'the page never posts to the avatar route');
  assert.match(source, /form\.append\('file', file/, 'the page does not upload the chosen file as a multipart field');
});

test('an uploaded avatar replaces the monogram and a missing one falls back to it', () => {
  const node = fakeImage();
  assert.equal(paintAvatarImage(node, {url: '/v1/profile/avatar?v=abcdef123456'}), true);
  assert.equal(node.hidden, false);
  assert.equal(node.attributes.src, '/v1/profile/avatar?v=abcdef123456');
  assert.equal(paintAvatarImage(node, null), false);
  assert.equal(node.hidden, true);
  assert.equal(node.attributes.src, '');
});
