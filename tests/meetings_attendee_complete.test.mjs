import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ATTENDEE_EMPTY, ATTENDEE_UNAVAILABLE, MEMBER_ROLE_LABELS, attendeeQuery, attendeeInsert, matchMembers,
} from '../flybot_workspace/static/meetings/app.mjs';

const members = [
  {user_id: 'u1', username: 'alice', role: 'owner', suspended: false},
  {user_id: 'u2', username: 'bob', role: 'member', suspended: false},
  {user_id: 'u3', username: 'bobby', role: 'member', suspended: false},
  {user_id: 'u4', username: 'carol', role: 'admin', suspended: true},
];

test('the attendee field offers a completion list element', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/meetings/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="attendee-matches"/);
});

test('the query is the segment after the last comma', () => {
  assert.equal(attendeeQuery('alice, bo'), 'bo');
  assert.equal(attendeeQuery('alice,bo'), 'bo');
  assert.equal(attendeeQuery('alice'), 'alice');
  assert.equal(attendeeQuery('   '), '');
  assert.equal(attendeeQuery('alice, '), '');
});

test('two characters list matching members with their role and one never does', () => {
  const matched = matchMembers(members, 'bo', '');
  assert.deepEqual(matched.map(item => item.username), ['bob', 'bobby']);
  assert.equal(matchMembers(members, 'b', '').length, 0);
  assert.deepEqual(matchMembers(members, 'BO', '').map(item => item.username), ['bob', 'bobby']);
  assert.equal(MEMBER_ROLE_LABELS.owner, '所有者');
});

test('members already in the field are not offered again', () => {
  assert.deepEqual(matchMembers(members, 'bo', 'bob').map(item => item.username), ['bobby']);
  assert.deepEqual(matchMembers(members, 'al', 'alice').map(item => item.username), []);
});

test('inserting a match replaces the current segment and keeps the comma form', () => {
  assert.equal(attendeeInsert('alice, bo', 'bob'), 'alice, bob, ');
  assert.equal(attendeeInsert('bo', 'bob'), 'bob, ');
  assert.equal(attendeeInsert('', 'bob'), 'bob, ');
  assert.equal(attendeeInsert('alice, bob', 'bobby'), 'alice, bobby, ');
});

test('the two honest empty states have their own text', () => {
  assert.equal(ATTENDEE_EMPTY, '无匹配成员');
  assert.equal(ATTENDEE_UNAVAILABLE, '读不到成员列表');
});
