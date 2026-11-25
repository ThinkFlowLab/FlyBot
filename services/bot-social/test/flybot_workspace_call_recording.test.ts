import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

type Home = Awaited<ReturnType<typeof home>>;
type Recording = {id: string; initiator_peer_id: string; state: string; participants: {peer_id: string; allowed: boolean}[]};
let service: Awaited<ReturnType<typeof startServer>>;
let now = Date.now();
before(async () => { service = await startServer({...bulkAuth, now: () => now}); });
after(async () => { await service.stop(); });

const conversation = (id: string) => "/v1/ot/conversations/" + id + "/call";
const consentBody = (call_id: string, peer_id: string, action: string, recording_id?: string) => ({
  call_id, peer_id, action, ...(recording_id ? {recording_id} : {}),
});
const peerId = () => randomUUID();
const marker = (state: Recording, peer: string) => state.participants.find(person => person.peer_id === peer)?.allowed;

async function invite(owner: Home, attendee: Home, team: {id: string}) {
  const {code} = await owner.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await attendee.ok("POST", "/v1/ot/invites/accept", {code});
}

test("group recording requires the exact joined roster and permits a participant to withdraw consent", async () => {
  const [owner, peer, late, outsider] = await Promise.all([
    home(service.base, "audio-lead"), home(service.base, "audio-guest"),
    home(service.base, "audio-late"), home(service.base, "audio-outsider"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/teams", {name: "Group audio"});
  await invite(owner, peer, team);
  await invite(owner, late, team);
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", team_id: team.id, title: "Group audio", members: [peer.handle, late.handle],
  });
  const root = conversation(group.id);
  const first = peerId(), second = peerId(), third = peerId();
  const opened = await owner.ok("POST", root + "/join", {kind: "audio", start: true, peer_id: first});
  const call = opened.call.id;
  assert.equal(opened.call.recording, null);
  assert.equal((await peer.ok("POST", root + "/join", {kind: "audio", peer_id: second})).call.recording, null);
  const change = (actor: Home, peerId: string, action: string, id?: string) =>
    actor.call("POST", root + "/recording", consentBody(call, peerId, action, id));

  const request = await change(owner, first, "request");
  assert.equal(request.status, 200);
  const pending: Recording = request.data.recording;
  assert.equal(pending.initiator_peer_id, first);
  assert.equal(pending.state, "pending");
  assert.deepEqual(new Set(pending.participants.map(person => person.peer_id)), new Set([first, second]));
  assert.equal(marker(pending, first), true);
  assert.equal(marker(pending, second), false);
  assert.deepEqual((await change(owner, first, "request")).data.recording, pending);
  assert.equal((await change(peer, second, "request")).data.error.code, "call_recording_busy");
  assert.equal((await change(peer, first, "allow", pending.id)).data.error.code, "call_ended");
  assert.equal((await change(late, third, "request")).data.error.code, "call_ended");
  assert.equal((await change(outsider, first, "request")).data.error.code, "conversation_not_found");
  assert.equal((await change(owner, first, "stop", pending.id)).data.error.code, "call_recording_changed");
  assert.equal(Object.hasOwn((await late.ok("GET", root)).call, "recording"), false);
  const extra = await owner.call("POST", root + "/recording", {...consentBody(call, first, "request"), audio: "must not be stored"});
  assert.equal(extra.status, 400);

  const approved: Recording = (await change(peer, second, "allow", pending.id)).data.recording;
  assert.equal(approved.state, "recording");
  assert.equal(approved.participants.every(person => person.allowed), true);
  assert.equal((await change(peer, second, "stop", pending.id)).status, 403);
  const revoked: Recording = (await change(peer, second, "decline", pending.id)).data.recording;
  assert.equal(revoked.state, "cancelled");
  assert.equal(marker(revoked, second), false);
  assert.equal((await change(owner, first, "stop", pending.id)).status, 409);
  assert.deepEqual((await owner.ok("POST", root + "/poll", {call_id: call, peer_id: first})).call.recording, revoked);

  const again: Recording = (await change(owner, first, "request")).data.recording;
  assert.notEqual(again.id, pending.id);
  assert.equal((await change(peer, second, "allow", pending.id)).status, 409);
  assert.equal((await change(peer, second, "allow", again.id)).data.recording.state, "recording");
  const joined = await late.ok("POST", root + "/join", {kind: "audio", peer_id: third});
  assert.equal(joined.call.recording.state, "cancelled");
  assert.deepEqual(joined.call.recording.participants.map((person: Recording["participants"][number]) => person.peer_id),
    again.participants.map(person => person.peer_id));
  assert.equal((await change(owner, first, "stop", again.id)).status, 409);

  const fresh: Recording = (await change(owner, first, "request")).data.recording;
  assert.equal(fresh.participants.length, 3);
  assert.equal((await change(peer, second, "allow", fresh.id)).data.recording.state, "pending");
  assert.equal((await change(late, third, "allow", fresh.id)).data.recording.state, "recording");
  const stopped: Recording = (await change(owner, first, "stop", fresh.id)).data.recording;
  assert.equal(stopped.state, "stopped");
  assert.deepEqual((await change(owner, first, "stop", fresh.id)).data.recording, stopped);
  assert.equal((await change(late, third, "decline", fresh.id)).status, 409);
});

test("direct recording cancels when a leased peer expires or is replaced and is removed when the call expires", async () => {
  const [owner, peer] = await Promise.all([home(service.base, "audio-direct-a"), home(service.base, "audio-direct-b")]);
  const request = await owner.ok("POST", "/v1/ot/contacts", {handle: peer.handle});
  await peer.ok("POST", "/v1/ot/contacts/" + request.id, {action: "accept"});
  const room = await owner.ok("POST", "/v1/ot/conversations", {kind: "dm", peer: peer.handle});
  const root = conversation(room.id);
  const first = peerId(), second = peerId(), replacement = peerId();
  const {call} = await owner.ok("POST", root + "/join", {kind: "video", start: true, peer_id: first});
  await peer.ok("POST", root + "/join", {kind: "video", peer_id: second});
  const {recording} = await owner.ok("POST", root + "/recording", consentBody(call.id, first, "request"));
  assert.equal((await peer.ok("POST", root + "/recording", consentBody(call.id, second, "allow", recording.id))).recording.state, "recording");
  now += 59_000;
  await owner.ok("POST", root + "/poll", {call_id: call.id, peer_id: first});
  now += 2_000;
  assert.equal((await owner.call("POST", root + "/recording", consentBody(call.id, first, "stop", recording.id))).status, 409);
  const live = (await owner.ok("POST", root + "/poll", {call_id: call.id, peer_id: first})).call;
  assert.equal(live.recording.state, "cancelled");
  assert.equal((await peer.call("POST", root + "/recording", consentBody(call.id, second, "allow", recording.id))).status, 404);
  const joined = await peer.ok("POST", root + "/join", {kind: "video", peer_id: replacement});
  assert.equal(joined.call.recording.state, "cancelled");
  const next = (await owner.ok("POST", root + "/recording", consentBody(call.id, first, "request"))).recording;
  assert.equal(marker(next, second), undefined);
  assert.equal(marker(next, replacement), false);

  now += 60_001;
  assert.equal((await owner.ok("GET", root)).call, null);
  assert.equal(service.platform.db.prepare("SELECT id FROM ot_call_recordings WHERE call_id=?").get(call.id), undefined);
});

test("standalone meeting calls share the protocol and ending does not keep an unfinalized recording", async () => {
  const [host, guest, outsider] = await Promise.all([
    home(service.base, "audio-meeting-host"), home(service.base, "audio-meeting-guest"), home(service.base, "audio-meeting-other"),
  ]);
  const root = "/v1/ot/meeting-calls";
  const first = peerId(), second = peerId();
  const result = await host.ok("POST", root + "/create", {title: "Meeting audio", peer_id: first});
  const call = result.call.id;
  assert.equal(result.call.recording, null);
  await guest.ok("POST", root + "/join", {code: result.meeting.code, peer_id: second});
  const {recording} = await guest.ok("POST", root + "/recording", consentBody(call, second, "request"));
  assert.equal(recording.state, "pending");
  assert.equal(recording.initiator_peer_id, second);
  assert.equal((await outsider.call("POST", root + "/recording", consentBody(call, second, "allow", recording.id))).status, 404);
  assert.equal((await host.ok("POST", root + "/recording", consentBody(call, first, "allow", recording.id))).recording.state, "recording");
  assert.equal((await host.call("POST", root + "/recording", consentBody(call, first, "stop", recording.id))).status, 403);
  assert.equal((await host.ok("POST", root + "/end", {call_id: call, peer_id: first})).ended, true);
  assert.equal((await guest.call("POST", root + "/recording", consentBody(call, second, "stop", recording.id))).status, 404);
  assert.equal(service.platform.db.prepare("SELECT id FROM ot_call_recordings WHERE call_id=?").get(call), undefined);
});
