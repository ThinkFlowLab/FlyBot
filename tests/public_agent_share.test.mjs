import assert from 'node:assert/strict';
import test from 'node:test';
import {mountPublicAgentShare} from '../flybot_workspace/static/shell/public-agent-share.mjs';

function shareFixture(clipboard, profilePath = '/a/assistant-demo') {
  const elements = new Map();
  const document = {
    activeElement: null,
    defaultView: {
      location: new URL('https://example.test:8080/social/a/another-slug?auth=private#draft=local-only'),
      navigator: {clipboard},
    },
    getElementById: () => ({
      dataset: {profilePath},
      querySelector: selector => elements.get(selector),
    }),
  };
  for (const selector of ['copy-profile', 'copy-profile-status', 'copy-profile-fallback', 'copy-profile-url']) {
    elements.set('[data-' + selector + ']', {
      addEventListener(type, listener) { this[type] = listener; },
      focus() { document.activeElement = this; },
      select() { this.selected = this.value; },
    });
  }
  const node = key => elements.get('[data-copy-profile' + key + ']');
  const button = node('');
  button.disabled = true;
  button.hidden = true;
  const status = node('-status');
  status.hidden = true;
  const fallback = node('-fallback');
  fallback.open = false;
  return {document, button, status, fallback, input:node('-url')};
}

test('public agent sharing uses the canonical listing path and ignores duplicate in-flight taps', async () => {
  const copies = [];
  let finish;
  const {document, button, status, fallback, input} = shareFixture({
    writeText(url) {
      copies.push(url);
      return new Promise(resolve => { finish = resolve; });
    },
  });
  mountPublicAgentShare(document);
  const expected = 'https://example.test:8080/a/assistant-demo';
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(input.value, expected);
  const copied = button.click();
  await button.click();
  assert.deepEqual(copies, [expected]);
  assert.match(status.textContent, /正在复制/);
  finish();
  await copied;
  assert.match(status.textContent, /主页链接已复制/);
  assert.equal(status.hidden, false);
  assert.equal(fallback.open, false);
});

test('missing and denied clipboard both open a selectable manual fallback', async () => {
  for (const clipboard of [undefined, {writeText: async () => { throw new Error('NotAllowedError'); }}]) {
    const {document, button, status, fallback, input} = shareFixture(clipboard);
    mountPublicAgentShare(document);
    button.focus();
    await button.click();
    assert.equal(fallback.open, true);
    assert.match(status.textContent, /手动复制/);
    assert.equal(document.activeElement, input);
    assert.equal(input.selected, 'https://example.test:8080/a/assistant-demo');
    input.selected = '';
    input.click();
    assert.equal(input.selected, input.value);
  }
});

test('a delayed clipboard failure never takes focus from another control', async () => {
  let deny;
  const {document, button, fallback, input} = shareFixture({
    writeText: () => new Promise((_resolve, reject) => { deny = reject; }),
  });
  mountPublicAgentShare(document);
  button.focus();
  const copying = button.click();
  const composer = {};
  document.activeElement = composer;
  deny(new Error('NotAllowedError'));
  await copying;
  assert.equal(fallback.open, true);
  assert.equal(document.activeElement, composer);
  assert.equal(input.selected, undefined);
});

test('noncanonical and off-origin share paths cannot enable the copy action', () => {
  for (const path of [
    '/a/ab', '/a/Agent', '/a/valid\n', '/a/valid?key=value', '/a/valid#draft=tok',
    '/a/%76alid', '/social/a/valid', '//other.test/a/valid', 'https://other.test/a/valid',
  ]) {
    const {document, button, input} = shareFixture(undefined, path);
    mountPublicAgentShare(document);
    assert.equal(button.hidden, true, path);
    assert.equal(button.disabled, true, path);
    assert.equal(input.value, undefined, path);
  }
});
