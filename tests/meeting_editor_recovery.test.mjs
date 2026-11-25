import assert from 'node:assert/strict';
import test from 'node:test';
import {readMeetingEditor, writeMeetingEditor} from '../flybot_workspace/static/meetings/editor-recovery.mjs';

const fields = ['title', '2026-11-23T10:00', 'member', 'summary', 'transcript', [['follow up', 'member', false, '2026-11-24']]];
const memory = () => {
  const items = new Map();
  return {getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key)};
};

test('meeting editor recovery reads only its scoped draft and preserves the original create receipt key', () => {
  const storage = memory();
  const saved = {fields, baseline:fields, revision:0, pending:{key:'meeting-' + 'a'.repeat(32), startedAt:123456, fields}};
  assert.equal(writeMeetingEditor(storage,'owner.workspace.new',saved),true);
  assert.deepEqual(readMeetingEditor(storage,'owner.workspace.new'),saved);
  assert.equal(readMeetingEditor(storage,'different.workspace.new'),null);
  assert.equal(readMeetingEditor(storage,'owner.different.new'),null);
  assert.equal(writeMeetingEditor(storage,'owner.workspace.new',null),true);
  assert.equal(readMeetingEditor(storage,'owner.workspace.new'),null);
});

test('corrupted and oversized drafts never become editable or retryable, and denied storage degrades safely', () => {
  const storage = memory();
  storage.setItem('draft','invalid json');
  assert.equal(readMeetingEditor(storage,'draft'),null);
  writeMeetingEditor(storage,'draft',{revision:5, baseline:fields, fields:[...fields.slice(0,5),[['task','member','false','']]]});
  assert.equal(readMeetingEditor(storage,'draft'),null);
  writeMeetingEditor(storage,'draft',{revision:0, baseline:fields, fields, pending:{key:'invalid',startedAt:123,fields}});
  assert.equal(readMeetingEditor(storage,'draft'),null);
  writeMeetingEditor(storage,'draft',{revision:0, baseline:fields, fields:[...fields.slice(0,4),'x'.repeat(40001),fields[5]]});
  assert.equal(readMeetingEditor(storage,'draft'),null);
  assert.equal(writeMeetingEditor(undefined,'draft',{fields}),false);
});
