import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  notificationSummary, notificationTarget, reminderKey, reminderNotice, reminderPayload, reminderSchedule,
} from '../flybot_workspace/static/chat/app.mjs';

const html = readFileSync(new URL('../flybot_workspace/static/chat/index.html', import.meta.url), 'utf8');
const NOW = new Date('2027-01-15T00:30:00Z');
const MESSAGE = {id: 'a'.repeat(32), body: '周五前把方案发给客户，记得带报价单'};

test('the message actions menu offers one-click reminders', () => {
  assert.match(html, /data-menu="remind-1h"[^>]*>[^<]*1 小时后/);
  assert.match(html, /data-menu="remind-tomorrow"[^>]*>[^<]*明天 9 点/);
});

test('reminder times are real once schedules in the reader time zone', () => {
  assert.deepEqual(reminderSchedule('later', NOW, 'Asia/Shanghai'),
    {kind: 'once', date: '2027-01-15', time: '09:30', time_zone: 'Asia/Shanghai'});
  assert.deepEqual(reminderSchedule('tomorrow', NOW, 'Asia/Shanghai'),
    {kind: 'once', date: '2027-01-16', time: '09:00', time_zone: 'Asia/Shanghai'});
  // Crossing local midnight must move the calendar day, not print hour 24.
  assert.deepEqual(reminderSchedule('later', new Date('2027-01-15T23:30:00Z'), 'UTC'),
    {kind: 'once', date: '2027-01-16', time: '00:30', time_zone: 'UTC'});
  assert.deepEqual(reminderSchedule('tomorrow', new Date('2027-01-15T23:30:00Z'), 'UTC'),
    {kind: 'once', date: '2027-01-16', time: '09:00', time_zone: 'UTC'});
});

test('a reminder becomes a real one-shot automation for the current user', () => {
  const payload = reminderPayload(MESSAGE, 'later', NOW, 'Asia/Shanghai', 'alice');
  assert.equal(payload.template_id, 'reminder');
  assert.deepEqual(payload.schedule, {kind: 'once', date: '2027-01-15', time: '09:30', time_zone: 'Asia/Shanghai'});
  assert.deepEqual(payload.participants, ['alice']);
  assert.equal(payload.scope, 'once');
  assert.equal(payload.intent, '');
  assert.deepEqual(payload.agents, []);
  assert.match(payload.title, /^提醒/);
  assert.ok(payload.title.length <= 80);
  assert.match(payload.prompt, /周五前把方案发给客户/);
  const other = reminderPayload({id: 'b'.repeat(32), body: '   '}, 'tomorrow', NOW, 'Asia/Shanghai', 'alice');
  assert.equal(other.title, '提醒：回看一条消息');
});

test('the idempotency key is derived from the message so a repeat cannot create a second reminder', () => {
  assert.equal(reminderKey(MESSAGE.id), 'remind-' + MESSAGE.id);
  assert.match(reminderKey(MESSAGE.id), /^[A-Za-z0-9_-]{16,64}$/);
  assert.notEqual(reminderKey(MESSAGE.id), reminderKey('b'.repeat(32)));
});

test('reminder responses tell the user what happened instead of failing silently', () => {
  assert.match(reminderNotice(201, {automation: {schedule: {kind: 'once', date: '2027-01-16', time: '09:00'}}}),
    /已设提醒：2027-01-16 09:00/);
  assert.match(reminderNotice(200, {automation: {schedule: {date: '2027-01-15', time: '09:30'}}}),
    /已经设过提醒：2027-01-15 09:30/);
  assert.match(reminderNotice(403, {}), /所有者或管理员/);
  assert.match(reminderNotice(429, {}), /上限/);
  assert.match(reminderNotice(409, {}), /同名/);
  assert.match(reminderNotice(500, {}), /没能设成提醒/);
});

test('a due reminder is listed as a notification and opens the automation list', () => {
  const item = {kind: 'automation_reminder', title: '提醒：周五前把方案发给客户'};
  assert.match(notificationSummary(item), /提醒到点/);
  assert.match(notificationSummary(item), /周五前把方案发给客户/);
  assert.equal(notificationTarget(item), '/automations');
  assert.equal(notificationTarget({kind: 'mention', conversation_id: 'c-1'}), null);
});
