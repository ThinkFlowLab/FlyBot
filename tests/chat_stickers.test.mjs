import assert from 'node:assert/strict';
import test from 'node:test';
import { saveChatSticker } from '../flybot_workspace/static/chat/stickers.mjs';

const workspace = '1'.repeat(32);
const chatImage = `/v1/workspaces/${workspace}/social/conversations/chat-1/messages/image-1/file`;
const mime = 'image/gif';

test('saving a message image rejects unscoped paths before making a request', async () => {
  for (const path of [
    `https://example.test${chatImage}`,
    `//example.test${chatImage}`,
    `${chatImage}?download=1`,
    `/v1/workspaces/${workspace}/social/conversations/../messages/image-1/file`,
    '/v1/stickers/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/file',
  ]) {
    const result = await saveChatSticker({
      attachment: {path, mime},
      fetcher: () => assert.fail('read an unscoped path'),
      request: () => assert.fail('uploaded an unscoped image'),
    });
    assert.equal(result.status, 400, path);
  }
});

test('saving a message image verifies response MIME and bounds streamed bytes without a Content-Length', async () => {
  const save = response => saveChatSticker({
    attachment: {path: chatImage, mime},
    fetcher: async () => response,
    request: () => assert.fail('invalid image was uploaded'),
  });
  assert.equal((await save(new Response('not an image', {headers: {'Content-Type': 'text/plain'}}))).status, 400);
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.enqueue(Uint8Array.of(1));
      controller.close();
    },
  });
  assert.equal((await save(new Response(oversized, {headers: {'Content-Type': mime}}))).status, 413);
});

test('saving a canonical GIF uses the original binary data, a same-origin read and the private library', async () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const response = {status: 201, body: {sticker: {id: 'a'.repeat(32)}}};
  const original = globalThis.FileReader;
  globalThis.FileReader = class {
    async readAsDataURL(file) {
      this.result = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;
      this.onload();
    }
  };
  try {
    const result = await saveChatSticker({
      attachment: {path: chatImage, title: '验收.gif', mime, bytes: gif.length},
      fetcher: async (path, options) => {
        assert.equal(path, chatImage);
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.redirect, 'error');
        return new Response(gif, {headers: {'Content-Type': mime}});
      },
      request: async (method, path, body, headers) => {
        assert.equal(method, 'POST');
        assert.equal(path, '/v1/stickers');
        assert.deepEqual(body, {title: '验收.gif', mime, data: gif.toString('base64')});
        assert.match(headers['Idempotency-Key'], /^sticker[a-f0-9]{32}$/);
        return response;
      },
    });
    assert.deepEqual(result, response);
  } finally {
    if (original === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = original;
  }
});
