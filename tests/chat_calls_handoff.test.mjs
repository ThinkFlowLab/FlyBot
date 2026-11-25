import assert from 'node:assert/strict';
import test from 'node:test';
import {mountChatCalls} from '../flybot_workspace/static/chat/calls.mjs';
import {meetingCallHrefInMessage} from '../flybot_workspace/static/chat/app.mjs';

const CALL = 'otcav_' + 'M'.repeat(26);
const INVITE = 'Z'.repeat(24);
const PEER = 'a'.repeat(32);

function callFixture({host = true, recordable = false} = {}) {
  const nodes = new Map();
  const timers = new Map();
  const calls = [];
  let serial = 0, stopped = 0, viewer = 'alice', remoteEnded = false, copied = '', navigated = '';
  let finishLeave;
  const track = {kind:'audio', readyState:'live', stop() { stopped += 1; }};
  const stream = {getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [track]};
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      handlers: {}, open: false, hidden: false, disabled: false, textContent: '', value: '',
      querySelector: () => node('local-video'), focus() {}, select() {}, setAttribute() {}, toggleAttribute() {},
      removeAttribute(name) { delete this[name]; },
      replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener(type, handler) { this.handlers[type] = handler; },
    });
    return nodes.get(id);
  }
  const view = {
    RTCPeerConnection: class {},
    navigator: {mediaDevices: {getUserMedia: async () => stream}, clipboard: {async writeText(value) { copied = value; }}},
    crypto: {randomUUID: () => PEER},
    location: new URL('https://example.test/chat'),
    setTimeout(fn) { timers.set(++serial, fn); return serial; },
    clearTimeout(id) { timers.delete(id); },
  };
  view.location.assign = href => { navigated = href; };
  const document = {getElementById: node, defaultView: view};
  const call = {id: CALL, kind: 'video', peers: [{id: PEER, name: '参会者'}]};
  if (recordable) {
    call.recording = null;
    const mime = 'audio/webm;codecs=opus';
    view.AudioContext = class {
      state = 'running';
      async resume() {}
      async close() { this.state = 'closed'; }
      createMediaStreamDestination() { return {stream:{getTracks:() => [{stop() {}}]}}; }
      createMediaStreamSource() { return {connect() {}, disconnect() {}}; }
    };
    view.MediaStream = class {};
    view.Blob = Blob;
    view.MediaRecorder = class {
      static isTypeSupported(type) { return type === mime; }
      state = 'inactive';
      mimeType = mime;
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable({data:new Blob(['private recording'], {type:mime})});
          this.onstop();
        });
      }
    };
  }
  const request = async (method, path, body) => {
    calls.push({method, path, body});
    const action = path.split('/').at(-1);
    if (action === 'create' || action === 'join') {
      return {status: 200, body: {call, peer_id: PEER, ice_servers: [], meeting: {title: '本次会议', host, ...(host ? {code: INVITE} : {})}}};
    }
    if (action === 'preview') return {status: 200, body: {title: '本次会议'}};
    if (action === 'recording') {
      call.recording = {id:'test-recording', initiator_peer_id:PEER, state:body.action === 'stop' ? 'stopped' : 'recording',
        participants:[{peer_id:PEER,allowed:true}]};
      return {status:200, body:{recording:call.recording}};
    }
    if (action === 'end') return {status: 200, body: {ended: true, handoff: {id: CALL}}};
    if (action === 'poll') return remoteEnded ? {status: 404, body: {error: {code: 'call_ended'}}}
      : {status: 200, body: {call, signals: []}};
    if (action === 'leave') return new Promise(resolve => { finishLeave = resolve; });
    throw new Error(path);
  };
  const controller = mountChatCalls(document, {request, context: () => null, account: () => viewer});
  return {
    node, calls, controller,
    stopped: () => stopped,
    copied: () => copied,
    navigated: () => navigated,
    async start() {
      controller.openMeeting(host ? 'create' : 'join', INVITE);
      node('chat-meeting-form').handlers.submit({preventDefault() {}});
      await new Promise(resolve => setImmediate(resolve));
    },
    finishLeave(ended = true) { finishLeave({status: 200, body: ended ? {handoff: {id: CALL}} : {}}); },
    switchAccount() { viewer = 'bob'; controller.sync(); },
    async remoteEnd() {
      remoteEnded = true;
      const poll = timers.values().next().value;
      assert.equal(typeof poll, 'function');
      await poll();
    },
  };
}

test('explicit leave opens the notes handoff after stopping local media, even before room closure', async () => {
  const fixture = callFixture();
  const {node} = fixture;
  await fixture.start();
  assert.equal(node('chat-call-media').hidden, false);
  const leaving = node('chat-meeting-hangup').handlers.click();
  assert.equal(fixture.stopped(), 1);
  assert.equal(node('chat-call-media').hidden, true);
  assert.equal(node('chat-call-dialog').open, true);
  assert.equal(node('chat-meeting-notes').hidden, false);
  assert.equal(node('chat-meeting-notes').href, '/meetings#from-call=' + CALL);
  assert.match(node('chat-meeting-notes-hint').textContent, /会议结束后/);
  await node('chat-call-close').handlers.click();
  fixture.finishLeave();
  await leaving;
  assert.equal(node('chat-call-dialog').open, false);
  assert.equal(node('chat-meeting-notes').hidden, true);
  assert.equal(node('chat-meeting-notes').href, undefined);
});

test('host end and remote end keep only an attendee-scoped call link and release devices', async () => {
  for (const host of [true, false]) {
    const fixture = callFixture({host});
    const {node} = fixture;
    await fixture.start();
    if (host) {
      await node('chat-meeting-end').handlers.click();
      await node('chat-meeting-end').handlers.click();
    } else await fixture.remoteEnd();
    assert.equal(fixture.stopped(), 1);
    assert.equal(node('chat-call-media').hidden, true);
    assert.equal(node('chat-meeting-notes').href, '/meetings#from-call=' + CALL);
    assert.match(node('chat-meeting-notes-hint').textContent, /补充正文/);
    await node('chat-meeting-notes-copy').handlers.click();
    assert.equal(fixture.copied(), 'https://example.test/meetings#from-call=' + CALL);
    fixture.switchAccount();
    assert.equal(node('chat-call-dialog').open, false);
    assert.equal(node('chat-meeting-notes').hidden, true);
    assert.equal(node('chat-meeting-notes').href, undefined);
  }
});

test('leaving first keeps an acknowledged local clip available for the notes handoff and preserves metadata fallback', async () => {
  const fixture = callFixture({host:false, recordable:true});
  const {node} = fixture;
  await fixture.start();
  await node('chat-call-record-request').handlers.click();
  await node('chat-call-record-stop').handlers.click();
  assert.match(node('chat-call-record-status').textContent, /在此设备保留/);
  const leaving = node('chat-meeting-hangup').handlers.click();
  fixture.finishLeave(false);
  await leaving;
  assert.match(node('chat-meeting-notes-hint').textContent, /通话结束后刷新/);
  const href = node('chat-meeting-notes').href;
  await node('chat-meeting-notes-copy').handlers.click();
  assert.equal(fixture.copied(), 'https://example.test' + href);
  assert.equal(fixture.navigated(), '');
  let intercepted = false;
  await node('chat-meeting-notes').handlers.click({preventDefault() { intercepted = true; }});
  assert.equal(intercepted, true, 'the acknowledged local clip is still available after non-final leave');
  assert.equal(node('chat-meeting-notes-without-audio').hidden, false);
  assert.equal(fixture.navigated(), '');
  node('chat-meeting-notes-without-audio').handlers.click();
  assert.equal(fixture.navigated(), href);
});

test('only an exact same-origin call source URL gives a saved message a notes action', () => {
  const origin = 'https://example.test';
  const workspace = 'a'.repeat(32);
  const path = `/meetings#workspace=${workspace}&from-call=${CALL}`;
  assert.equal(meetingCallHrefInMessage('会议已结束 ' + origin + path + '。', origin), path);
  assert.equal(meetingCallHrefInMessage(path, origin), path);
  for (const rejected of ['https://elsewhere.test' + path, '/meetings#workspace=other&from-call=' + CALL,
    path + '&from-call=' + CALL, '/chat#meeting=' + INVITE, '/meetings?old=1#from-call=' + CALL]) {
    assert.equal(meetingCallHrefInMessage(rejected, origin), '');
  }
});
