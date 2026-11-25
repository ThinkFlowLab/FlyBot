import assert from 'node:assert/strict';
import test from 'node:test';
import { LOOK_FIELDS, LOOK_OPTIONS, createLookAvatar, validLook } from '../flybot_workspace/static/look/app.mjs';
import { applyChatIdentity } from '../flybot_workspace/static/chat/app.mjs';

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}

const document = {createElement: (tag) => new Element(tag)};
const LOOK = {color: '天空蓝', expression: '微笑', headwear: '耳机', glasses: '圆框眼镜', hand: '笔记本'};

test('validLook accepts only one value per look field', () => {
  assert.equal(validLook(LOOK), true);
  assert.equal(validLook(null), false);
  assert.equal(validLook({...LOOK, color: '金色'}), false);
  assert.equal(validLook({...LOOK, extra: '无'}), true);
  assert.equal(validLook({...LOOK, hand: undefined}), false);
  assert.deepEqual(LOOK_FIELDS, ['color', 'expression', 'headwear', 'glasses', 'hand']);
  assert.equal(LOOK_OPTIONS.headwear.includes('耳机'), true);
});

test('createLookAvatar renders data attributes and decorative parts', () => {
  const avatar = createLookAvatar(LOOK, document);
  assert.equal(avatar.className, 'look-avatar');
  assert.equal(avatar.attributes['aria-hidden'], 'true');
  assert.deepEqual({...avatar.dataset}, LOOK);
  assert.deepEqual(avatar.children.map((node) => node.className), [
    'look-portrait', 'look-glasses', 'look-hand',
  ]);
  assert.equal(avatar.textContent, '');
  assert.equal(createLookAvatar(null, document), null);
  assert.equal(createLookAvatar({...LOOK, color: '<script>'}, document), null);
});


test('applyChatIdentity swaps the header avatar for the saved look', () => {
  const nodes = {};
  const doc = {
    getElementById(id) { nodes[id] ||= new Element('span'); return nodes[id]; },
    createElement(tag) { return new Element(tag); },
  };
  applyChatIdentity(doc, "alice's Personal Agent", null, LOOK);
  assert.equal(nodes['chat-title'].textContent, "alice's Personal Agent");
  assert.equal(nodes['chat-avatar'].hidden, false);
  assert.equal(nodes['chat-avatar'].children.length, 1);
  assert.equal(nodes['chat-avatar'].children[0].className, 'look-avatar');
  applyChatIdentity(doc, "alice's Personal Agent", null, null);
  assert.equal(nodes['chat-avatar'].children.length, 0);
  assert.equal(nodes['chat-avatar'].textContent, 'A');
});
