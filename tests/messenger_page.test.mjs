import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conversationLabel, validMessage, memberChoices,
} from '../flybot_workspace/static/shell/chat-utils.mjs';

const current = 'a'.repeat(32);

test('conversationLabel names a DM by the other members', () => {
  const dm = {kind: 'dm', title: 'bob', members: [
    {user_id: current, username: 'alice'},
    {user_id: 'b'.repeat(32), username: 'bob'},
  ]};
  assert.equal(conversationLabel(dm, current), 'bob');
  assert.equal(conversationLabel({kind: 'group', title: '产品群', members: []}, current), '产品群');
  assert.equal(conversationLabel(null, current), '');
});

test('validMessage enforces a non-empty bounded body', () => {
  assert.equal(validMessage('hello'), true);
  assert.equal(validMessage('   '), false);
  assert.equal(validMessage('x'.repeat(4000)), true);
  assert.equal(validMessage('x'.repeat(4001)), false);
  assert.equal(validMessage(null), false);
});

test('memberChoices excludes the signed-in user', () => {
  const members = [
    {user_id: current, username: 'alice'},
    {user_id: 'b'.repeat(32), username: 'bob'},
  ];
  assert.deepEqual(memberChoices(members, current).map((member) => member.username), ['bob']);
});
