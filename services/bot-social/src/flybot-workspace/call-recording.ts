import { assert } from "../errors.js";
import { newId } from "../ids.js";
import type { OtContext } from "./core.js";

export const CALL_RECORDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_call_recordings (
  call_id TEXT PRIMARY KEY REFERENCES ot_live_calls(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE, initiator_peer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','recording','stopped','cancelled')),
  participants TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ot_call_recording_peer_added
AFTER INSERT ON ot_call_peers BEGIN
  UPDATE ot_call_recordings SET state='cancelled'
    WHERE call_id=NEW.call_id AND state IN ('pending','recording');
END;
CREATE TRIGGER IF NOT EXISTS ot_call_recording_peer_removed
AFTER DELETE ON ot_call_peers BEGIN
  UPDATE ot_call_recordings SET state='cancelled'
    WHERE call_id=OLD.call_id AND state IN ('pending','recording');
END;
`;

const RECORDING_ID = /^otrec_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
type Action = "request" | "allow" | "decline" | "stop";
type Participant = {peer_id: string; allowed: boolean};
type RecordingRow = {id: string; initiator_peer_id: string; state: "pending" | "recording" | "stopped" | "cancelled"; participants: string};
type Recording = Omit<RecordingRow, "participants"> & {participants: Participant[]};

export function callRecording(ot: OtContext, callId: string): Recording | null {
  const row = ot.get<RecordingRow>("SELECT id,initiator_peer_id,state,participants FROM ot_call_recordings WHERE call_id=?", callId);
  return row ? {...row, participants: JSON.parse(row.participants)} : null;
}

export function recordingCommand(input: Record<string, unknown>): {action: Action; id: string | null} {
  const {action, recording_id} = input;
  assert(action === "request" || action === "allow" || action === "decline" || action === "stop",
    400, "invalid_request", "Choose a recording consent action");
  const fields = new Set(["action", "call_id", "peer_id", "team_id", ...(action === "request" ? [] : ["recording_id"])]);
  assert(Object.keys(input).every(key => fields.has(key)) && (action === "request" ||
    (typeof recording_id === "string" && RECORDING_ID.test(recording_id))),
  400, "invalid_request", "Invalid recording consent request");
  return {action, id: action === "request" ? null : recording_id as string};
}

export function changeCallRecording(ot: OtContext, callId: string, peerId: string, command: ReturnType<typeof recordingCommand>) {
  const current = callRecording(ot, callId);
  const roster = () => ot.all<{id: string}>("SELECT id FROM ot_call_peers WHERE call_id=? ORDER BY id", callId);
  if (command.action === "request") {
    if (current?.state === "pending" || current?.state === "recording") {
      assert(current.initiator_peer_id === peerId, 409, "call_recording_busy", "A participant already requested recording");
      return current;
    }
    const peers = roster().map(({id}) => ({peer_id: id, allowed: id === peerId}));
    const recording: Recording = {
      id: newId("otrec"), initiator_peer_id: peerId, state: peers.length === 1 ? "recording" : "pending", participants: peers,
    };
    ot.run(`INSERT INTO ot_call_recordings VALUES(?,?,?,?,?) ON CONFLICT(call_id) DO UPDATE SET
      id=excluded.id,initiator_peer_id=excluded.initiator_peer_id,state=excluded.state,participants=excluded.participants`,
    callId, recording.id, peerId, recording.state, JSON.stringify(peers));
    return recording;
  }

  assert(current && current.id === command.id, 409, "call_recording_changed", "Recording consent has changed");
  const participant = current.participants.find(peer => peer.peer_id === peerId);
  assert(participant, 409, "call_recording_changed", "The recording participant snapshot has changed");
  if (command.action === "stop") {
    assert(current.initiator_peer_id === peerId, 403, "forbidden", "Only the recording initiator can stop");
    if (current.state === "stopped") return current;
    const peers = roster();
    assert(current.state === "recording" && peers.length === current.participants.length &&
      peers.every(({id}, i) => current.participants[i].peer_id === id && current.participants[i].allowed),
    409, "call_recording_changed", "Recording no longer has all participants' consent");
    current.state = "stopped";
  } else if (command.action === "decline") {
    if (current.state === "cancelled") return current;
    assert(current.state !== "stopped", 409, "call_recording_changed", "The recording has already stopped");
    participant.allowed = false;
    current.state = "cancelled";
  } else {
    assert(current.state === "pending" || current.state === "recording", 409, "call_recording_changed", "Recording consent is closed");
    participant.allowed = true;
    if (current.participants.every(peer => peer.allowed)) current.state = "recording";
  }
  ot.run("UPDATE ot_call_recordings SET state=?,participants=? WHERE call_id=?", current.state, JSON.stringify(current.participants), callId);
  return current;
}
