import assert from 'node:assert/strict';
import test from 'node:test';
import {mountCallRecording} from '../flybot_workspace/static/chat/call-recording.mjs';

const localId = 'local';
const remoteId = 'remote';
const recordingId = 'recording-1';
const mime = 'audio/webm;codecs=opus';

function recording(state = 'pending', {initiator = localId, allowed = state !== 'pending'} = {}) {
  return {id:recordingId, initiator_peer_id:initiator, state,
    participants:[localId, remoteId].map(peer_id => ({peer_id, allowed:peer_id === initiator || allowed}))};
}

function fixture() {
  const controls = new Map();
  const timers = new Map();
  const mixed = [];
  const sends = [];
  const answers = new Map();
  let elapsed = 0;
  let nextTimer = 0;
  let starts = 0;
  function element(id) {
    if (!controls.has(id)) controls.set(id, {
      hidden:false, disabled:false, handlers:{},
      addEventListener(name, action) { this.handlers[name] = action; },
      click() { return this.handlers.click(); },
    });
    return controls.get(id);
  }
  const track = (id, kind = 'audio') => ({id, kind, readyState:'live', stop() { this.readyState = 'ended'; }});
  const local = track('local mic');
  const remote = track('remote mic');
  const video = track('camera', 'video');
  const rogue = track('unapproved audio');
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getTracks() { return this.tracks; }
  }
  const view = {
    Blob, MediaStream:Stream,
    performance:{now:() => elapsed},
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    AudioContext:class {
      state = 'suspended';
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
      createMediaStreamDestination() { return {stream:new Stream([track('mixed')])}; }
      createMediaStreamSource(stream) {
        return {connect() { mixed.push(...stream.getTracks().map(track => track.id)); }, disconnect() {}};
      }
    },
    MediaRecorder:class {
      static isTypeSupported(value) { return value === mime; }
      mimeType = mime;
      state = 'inactive';
      start() { this.state = 'recording'; starts += 1; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable({data:new Blob(['consented call audio'], {type:mime})});
          this.onstop();
        });
      }
    },
  };
  const own = {id:localId, stream:new Stream([local, video]), peers:new Map([
    [remoteId, {remote:new Stream([remote, video])}], ['rogue', {remote:new Stream([rogue])}],
  ])};
  const controller = mountCallRecording({getElementById:element}, {view, async send(owned, action, id) {
    assert.equal(owned, own);
    sends.push({action, id});
    return answers.get(action);
  }});
  const response = (item, status = 200) => ({status, body:{recording:item}});
  const sync = (item, ids = [localId, remoteId], fence) => controller.sync(own, {recording:item, peers:ids.map(id=>({id}))}, fence);
  return {controller, own, sync, response, sends, answers, mixed, local, remote, video, rogue,
    starts:() => starts, control:name => element('chat-call-record-' + name),
    expire() { elapsed = 590000; [...timers.values()].find(timer => timer.delay === 590000)?.callback(); },
  };
}

test('capture waits for the same fully consenting roster and retains only an explicit acknowledged stop', async () => {
  const f = fixture();
  f.sync(null);
  f.answers.set('request', f.response(recording()));
  const stale = f.controller.fence(f.own);
  await f.control('request').click();
  assert.equal(f.starts(), 0);
  f.sync(null, undefined, stale);
  assert.match(f.control('status').textContent, /1\/2/);
  f.sync(recording('recording', {allowed:false}));
  assert.equal(f.starts(), 0);
  f.sync(recording('recording'));
  assert.equal(f.starts(), 1);
  assert.deepEqual(f.mixed, ['local mic', 'remote mic']);
  f.answers.set('stop', f.response(recording('stopped')));
  await f.control('stop').click();
  assert.match(f.control('status').textContent, /在此设备保留/);
  assert.deepEqual(f.sends, [{action:'request',id:undefined}, {action:'stop',id:recordingId}]);
  const audio = f.controller.release(f.own);
  assert.equal(audio.type, mime);
  assert.equal(await audio.text(), 'consented call audio');
  for (const track of [f.local, f.remote, f.video, f.rogue]) assert.equal(track.readyState, 'live');
  assert.equal(f.controller.release(f.own), null);
});

test('a joining peer and an expired capture discard the generation and never mix the newcomer', async () => {
  for (const invalidate of [f => f.sync(recording('recording'), [localId, remoteId, 'rogue']), f => f.expire()]) {
    const f = fixture();
    f.sync(null);
    f.answers.set('request', f.response(recording()));
    await f.control('request').click();
    f.sync(recording('recording'));
    invalidate(f);
    f.sync(recording('recording'));
    assert.equal(f.starts(), 1);
    assert.deepEqual(f.mixed, ['local mic', 'remote mic']);
    assert.equal(f.controller.release(f.own), null);
    assert.deepEqual(f.sends.at(-1), {action:'decline', id:recordingId});
  }
});

test('another participant can consent and revoke without starting any recorder', async () => {
  const f = fixture();
  f.sync(recording('pending', {initiator:remoteId}));
  assert.equal(f.control('allow').hidden, false);
  f.answers.set('allow', f.response(recording('recording', {initiator:remoteId})));
  await f.control('allow').click();
  assert.equal(f.control('stop').hidden, true);
  assert.match(f.control('decline').textContent, /撤回/);
  f.answers.set('decline', f.response(recording('cancelled', {initiator:remoteId})));
  await f.control('decline').click();
  assert.equal(f.starts(), 0);
  assert.equal(f.controller.release(f.own), null);
  assert.deepEqual(f.sends, [{action:'allow',id:recordingId}, {action:'decline',id:recordingId}]);
});

test('a disconnect or a wrong stopping receipt cannot return an audio clip', async () => {
  for (const disconnected of [true, false]) {
    const f = fixture();
    f.sync(null);
    f.answers.set('request', f.response(recording()));
    await f.control('request').click();
    f.sync(recording('recording'));
    const answer = Promise.withResolvers();
    f.answers.set('stop', answer.promise);
    const stopping = f.control('stop').click();
    if (disconnected) f.controller.interrupt(f.own);
    answer.resolve(f.response({...recording('stopped'), id:disconnected ? recordingId : 'old'}));
    await stopping;
    assert.equal(f.controller.release(f.own), null);
  }
});
