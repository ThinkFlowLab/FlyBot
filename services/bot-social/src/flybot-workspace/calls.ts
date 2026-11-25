import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, hashCode, OtContext, params, query, text } from "./core.js";
import { requireMember } from "./teams.js";
import { requireDirectReach } from "./messenger.js";
import { CALL_RECORDING_SCHEMA, callRecording, changeCallRecording, recordingCommand } from "./call-recording.js";

export const CALLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_live_calls (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE REFERENCES ot_conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('audio','video')), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_call_peers (
  id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES ot_live_calls(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, expires INTEGER NOT NULL, UNIQUE(call_id,owner_id)
);
CREATE INDEX IF NOT EXISTS ot_call_peer_expiry ON ot_call_peers(expires);
${CALL_RECORDING_SCHEMA}
CREATE TABLE IF NOT EXISTS ot_call_signals (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES ot_live_calls(id) ON DELETE CASCADE,
  sender TEXT NOT NULL REFERENCES ot_call_peers(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL REFERENCES ot_call_peers(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(sender, client_key)
);
CREATE INDEX IF NOT EXISTS ot_call_signals_recipient ON ot_call_signals(recipient,seq);
CREATE TABLE IF NOT EXISTS ot_call_titles (
  call_id TEXT PRIMARY KEY REFERENCES ot_live_calls(id) ON DELETE CASCADE, title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_call_meetings (
  conversation_id TEXT PRIMARY KEY REFERENCES ot_conversations(id) ON DELETE CASCADE,
  host_owner TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_call_records (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('audio','video')),
  started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS ot_call_attendees (
  call_id TEXT NOT NULL REFERENCES ot_call_records(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, name TEXT NOT NULL, joined_at INTEGER NOT NULL,
  PRIMARY KEY(call_id,owner_id)
);
CREATE TRIGGER IF NOT EXISTS ot_call_record_after_delete
AFTER DELETE ON ot_live_calls
BEGIN
  UPDATE ot_call_records SET ended_at=MAX(started_at,CAST(strftime('%s','now') AS INTEGER)*1000)
    WHERE id=OLD.id AND ended_at IS NULL;
END;
`;

const PEER_TTL = 60_000;
const MAX_PEERS = 6;
const MAX_SIGNALS = 240;
const SIGNAL_KEY = /^[a-zA-Z0-9_-]{16,64}$/;
const MEETING_CODE = /^[a-zA-Z0-9_-]{24}$/;
const MEETING_TTL = 6 * 60 * 60 * 1000;
const CALL_ID = /^otcav_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const RECORD_ATTENDEES = 50;
type Call = { id: string; conversation_id: string; kind: "audio" | "video"; created_at: number };
type Peer = { id: string; owner_id: string };
type Meeting = Call & { title: string; host_owner: string };
type CallRecord = { id: string; title: string; kind: Call["kind"]; started_at: number; ended_at: number | null };

function callContext(ot: OtContext, req: FastifyRequest, teamId: unknown) {
  const me = ot.me(req);
  const conversation = ot.get(
    "SELECT c.* FROM ot_conversations c JOIN ot_conversation_members m ON c.id=m.conversation_id WHERE c.id=? AND m.owner_id=?",
    params(req).id, me.ownerId,
  );
  assert(conversation, 404, "conversation_not_found", "no such conversation");
  assert(!String(conversation.dm_key ?? "").startsWith("agent:"), 409, "public_chat_fixed", "访客聊天支持文字消息。");
  requireDirectReach(ot, conversation, me.ownerId);
  if (teamId !== undefined) {
    assert(typeof teamId === "string" && (!conversation.team_id || teamId === conversation.team_id),
      404, "conversation_not_found", "no such conversation in this team");
  }
  const team = conversation.team_id || teamId;
  if (team) requireMember(ot, team, me.ownerId);
  return { me, conversation, team };
}

function prune(ot: OtContext, conversationId?: string) {
  const now = ot.now();
  ot.run("DELETE FROM ot_call_peers WHERE expires<=?", now);
  if (conversationId && !ot.get("SELECT 1 FROM ot_call_meetings WHERE conversation_id=?", conversationId)) {
    ot.run(`DELETE FROM ot_call_peers WHERE call_id IN (SELECT id FROM ot_live_calls WHERE conversation_id=?)
      AND owner_id NOT IN (SELECT owner_id FROM ot_conversation_members WHERE conversation_id=?)`, conversationId, conversationId);
    ot.run(`DELETE FROM ot_call_peers WHERE call_id IN (SELECT c.id FROM ot_live_calls c JOIN ot_conversations g
      ON c.conversation_id=g.id WHERE g.id=? AND g.team_id IS NOT NULL)
      AND owner_id NOT IN (SELECT m.owner_id FROM ot_team_members m JOIN ot_conversations g ON g.team_id=m.team_id
        WHERE g.id=? AND m.suspended=0)`, conversationId, conversationId);
  }
  ot.run(`UPDATE ot_call_records SET ended_at=MAX(started_at,?) WHERE ended_at IS NULL AND id IN (
    SELECT c.id FROM ot_live_calls c LEFT JOIN ot_call_meetings m ON m.conversation_id=c.conversation_id
    WHERE m.expires<=? OR NOT EXISTS (SELECT 1 FROM ot_call_peers p WHERE p.call_id=c.id))`, now, now);
  ot.run(`DELETE FROM ot_conversations WHERE id IN (SELECT m.conversation_id FROM ot_call_meetings m
    WHERE m.expires<=? OR NOT EXISTS (SELECT 1 FROM ot_live_calls c JOIN ot_call_peers p ON p.call_id=c.id
      WHERE c.conversation_id=m.conversation_id))`, now);
  ot.run("DELETE FROM ot_live_calls WHERE id NOT IN (SELECT call_id FROM ot_call_peers)");
}

function recordAttendance(ot: OtContext, call: Call, ownerId: string, joinedAt: number) {
  if (!ot.get("SELECT 1 FROM ot_call_records WHERE id=?", call.id)) {
    const named = ot.get<{title: string}>("SELECT title FROM ot_call_titles WHERE call_id=?", call.id);
    const conversation = ot.get<{title: string}>("SELECT title FROM ot_conversations WHERE id=?", call.conversation_id);
    const fallback = call.kind === "video" ? "视频通话" : "语音通话";
    const title = (named?.title || conversation?.title || "").trim().slice(0, 80).replace(/[\uD800-\uDBFF]$/, "") || fallback;
    ot.run("INSERT OR IGNORE INTO ot_call_records(id,title,kind,started_at) VALUES(?,?,?,?)", call.id, title, call.kind, call.created_at);
  }
  const profile = ot.profileView(ownerId);
  const name = (profile.display_name || profile.handle || "").trim().slice(0, 80).replace(/[\uD800-\uDBFF]$/, "") || "成员";
  ot.run("INSERT OR IGNORE INTO ot_call_attendees VALUES(?,?,?,?)", call.id, ownerId, name, joinedAt);
}

function attendedCall(ot: OtContext, id: string, ownerId: string) {
  return ot.get<CallRecord>(`SELECT r.* FROM ot_call_records r JOIN ot_call_attendees a ON a.call_id=r.id
    WHERE r.id=? AND a.owner_id=?`, id, ownerId);
}

function describe(ot: OtContext, call: Call, joined = false) {
  const named = ot.get<{title: string}>("SELECT title FROM ot_call_titles WHERE call_id=?", call.id);
  const peers = ot.all<Peer>("SELECT id,owner_id FROM ot_call_peers WHERE call_id=? ORDER BY id", call.id);
  return {
    id: call.id, kind: call.kind, created_at: call.created_at,
    ...(named ? {title: named.title} : {}),
    ...(joined ? {recording: callRecording(ot, call.id)} : {}),
    peers: peers.map(peer => {
      const profile = ot.profileView(peer.owner_id);
      return { id: peer.id, name: profile.display_name || profile.handle || "成员" };
    }),
  };
}

function lease(ot: OtContext, conversationId: string, owner: string, input: any) {
  prune(ot, conversationId);
  assert(typeof input.call_id === "string" && typeof input.peer_id === "string",
    400, "invalid_request", "provide a call and peer");
  const call = ot.get<Call>("SELECT * FROM ot_live_calls WHERE id=? AND conversation_id=?", input.call_id, conversationId);
  const peer = call && ot.get<Peer>("SELECT id,owner_id FROM ot_call_peers WHERE id=? AND call_id=? AND owner_id=?",
    input.peer_id, call.id, owner);
  assert(call && peer, 404, "call_ended", "call has ended or this tab left");
  return { call, peer };
}

function joinPeer(ot: OtContext, call: Call, ownerId: string, peerId: unknown, now: number) {
  const existing = ot.get<Peer>("SELECT id,owner_id FROM ot_call_peers WHERE call_id=? AND owner_id=?", call.id, ownerId);
  assert(typeof peerId === "string" && SIGNAL_KEY.test(peerId), 400, "invalid_request", "provide the tab identifier");
  assert(!existing || existing.id === peerId, 409, "call_already_joined", "this account is already in the call");
  if (!existing) {
    assert(!ot.get("SELECT 1 FROM ot_call_peers WHERE id=?", peerId), 409, "peer_in_use", "peer already in use");
    const count = ot.get<{n: number}>("SELECT COUNT(*) AS n FROM ot_call_peers WHERE call_id=?", call.id);
    assert(count && count.n < MAX_PEERS, 409, "call_full", "call is full");
    ot.run("INSERT INTO ot_call_peers VALUES(?,?,?,?)", peerId, call.id, ownerId, now + PEER_TTL);
  }
  recordAttendance(ot, call, ownerId, now);
  return peerId;
}

function signalPayload(input: any) {
  if (input?.description) {
    const {type, sdp} = input.description;
    assert(type === "offer" || type === "answer", 400, "invalid_signal", "expected an offer or answer");
    return {description: {type, sdp: text(sdp, "sdp", {min: 1, max: 24_000, multiline: true})}};
  }
  const candidate = input?.candidate;
  assert(candidate && (candidate.sdpMid == null || typeof candidate.sdpMid === "string" && candidate.sdpMid.length <= 80)
    && (candidate.sdpMLineIndex == null || Number.isInteger(candidate.sdpMLineIndex)
      && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 64)
    && (candidate.sdpMid != null || candidate.sdpMLineIndex != null),
  400, "invalid_signal", "invalid ICE candidate");
  return {candidate: {
    candidate: text(candidate.candidate, "candidate", {min: 1, max: 2048}),
    sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    ...(typeof candidate.usernameFragment === "string" && candidate.usernameFragment.length <= 128
      ? {usernameFragment: candidate.usernameFragment} : {}),
  }};
}

function iceConfig() {
  const stun = process.env.FLYBOT_WORKSPACE_CALL_STUN_URL?.trim();
  const turn = process.env.FLYBOT_WORKSPACE_CALL_TURN_URL?.trim();
  const file = process.env.FLYBOT_WORKSPACE_CALL_TURN_SECRET_FILE?.trim();
  if (stun && !/^stuns?:(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(stun)) throw new Error("Invalid FLYBOT_WORKSPACE_CALL_STUN_URL");
  if (turn && (!/^turns?:(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(turn) || !file)) {
    throw new Error("Configure a valid TURN URL and its credential secret file");
  }
  const secret = turn && file ? readFileSync(file, "utf8").trim() : undefined;
  if (turn && (!secret || secret.length < 32)) throw new Error("TURN requires a secret of at least 32 characters");
  return (peerId: string, now: number) => {
    const ice: {urls: string; username?: string; credential?: string}[] = stun ? [{urls: stun}] : [];
    if (turn && secret) {
      const username = Math.floor(now / 1000 + 21_600) + ":" + peerId;
      ice.push({urls: turn, username, credential: createHmac("sha1", secret).update(username).digest("base64")});
    }
    return ice;
  };
}

type CallAccess = (req: FastifyRequest, input: any) => {ownerId: string; conversationId: string};

export function registerCalls(app: FastifyInstance, ot: OtContext) {
  const root = "/v1/ot/conversations/:id/call";
  const iceServers = iceConfig();
  // Rooms already active during a service upgrade have only their current peer leases.
  ot.tx(() => {
    const peers = ot.all<Call & {owner_id: string}>(`SELECT c.*,p.owner_id FROM ot_live_calls c
      JOIN ot_call_peers p ON p.call_id=c.id WHERE p.expires>?`, ot.now());
    for (const peer of peers) recordAttendance(ot, peer, peer.owner_id, ot.now());
  });
  app.get("/v1/ot/call-records/:id", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const me = ot.me(req);
    const id = params(req).id;
    const record = CALL_ID.test(id) && attendedCall(ot, id, me.ownerId);
    assert(record, 404, "call_record_not_found", "call record not found");
    if (record.ended_at === null) {
      const live = ot.get<Call>("SELECT * FROM ot_live_calls WHERE id=?", id);
      ot.tx(() => prune(ot, live?.conversation_id));
    }
    const closed = attendedCall(ot, id, me.ownerId);
    assert(closed && closed.ended_at !== null, 409, "meeting_call_active", "the call has not ended");
    const attendees = ot.all<{name: string}>(`SELECT name FROM ot_call_attendees WHERE call_id=?
      ORDER BY joined_at,owner_id LIMIT ?`, id, RECORD_ATTENDEES);
    return {record: {...closed, attendees: attendees.map(row => row.name)}};
  });
  app.get(root, async req => {
    const {conversation} = callContext(ot, req, query(req).team_id);
    prune(ot, conversation.id);
    const call = ot.get<Call>("SELECT * FROM ot_live_calls WHERE conversation_id=?", conversation.id);
    return {call: call ? describe(ot, call) : null};
  });

  app.post(root + "/join", async req => {
    const input = body(req);
    const {me, conversation, team} = callContext(ot, req, input.team_id);
    assert(input.kind === "audio" || input.kind === "video", 400, "invalid_request", "choose audio or video");
    const now = ot.now();
    return ot.tx(() => {
      prune(ot, conversation.id);
      let call = ot.get<Call>("SELECT * FROM ot_live_calls WHERE conversation_id=?", conversation.id);
      const starting = !call;
      if (!call) {
        assert(input.start === true, 404, "call_ended", "call is no longer active");
        call = {id: newId("otcav"), conversation_id: conversation.id, kind: input.kind, created_at: now};
        ot.run("INSERT INTO ot_live_calls VALUES(?,?,?,?)", call.id, conversation.id, call.kind, now);
        if (input.title != null) {
          const title = text(input.title, "title", {min: 1, max: 80});
          ot.run("INSERT INTO ot_call_titles VALUES(?,?)", call.id, title);
        }
      }
      const peerId = joinPeer(ot, call, me.ownerId, input.peer_id, now);
      const view = describe(ot, call, true);
      if (starting) {
        const by = ot.profileView(me.ownerId);
        for (const member of ot.all<{owner_id: string}>(
          "SELECT owner_id FROM ot_conversation_members WHERE conversation_id=? AND owner_id<>?", conversation.id, me.ownerId)) {
          if (team && !ot.get("SELECT 1 FROM ot_team_members WHERE team_id=? AND owner_id=? AND suspended=0", team, member.owner_id)) continue;
          ot.notify(member.owner_id, "messenger.call", {conversation_id: conversation.id, team_id: team || undefined,
            title: view.title || conversation.title, call_kind: call.kind, by});
        }
      }
      return {call: view, peer_id: peerId, ice_servers: iceServers(peerId, now)};
    });
  });

  const roomAccess: CallAccess = (req, input) => {
    const {me, conversation} = callContext(ot, req, input.team_id);
    return {ownerId: me.ownerId, conversationId: conversation.id};
  };
  registerCallActions(app, ot, root, roomAccess);

  const meetings = "/v1/ot/meeting-calls";
  const meetingSelect = `SELECT c.*,g.title,m.host_owner FROM ot_live_calls c
    JOIN ot_call_meetings m ON m.conversation_id=c.conversation_id
    JOIN ot_conversations g ON g.id=c.conversation_id`;
  const findMeeting = (code: unknown) => {
    assert(typeof code === "string" && MEETING_CODE.test(code), 404, "meeting_ended", "meeting not found");
    const meeting = ot.get<Meeting>(meetingSelect + " WHERE m.code_hash=?", hashCode(code));
    assert(meeting, 404, "meeting_ended", "meeting not found");
    return meeting;
  };
  const meetingView = (meeting: Meeting, actor: string) => ({
    title: meeting.title,
    host: actor === meeting.host_owner,
    ...(actor === meeting.host_owner ? {code: ot.platform.meetingInviteCode(meeting.id)} : {}),
  });

  app.post(meetings + "/create", async req => {
    const {ownerId} = ot.me(req);
    const input = body(req);
    const title = text(input.title, "title", {min: 1, max: 80});
    assert(typeof input.peer_id === "string" && SIGNAL_KEY.test(input.peer_id),
      400, "invalid_request", "provide the tab identifier");
    const now = ot.now();
    return ot.tx(() => {
      prune(ot);
      let meeting = ot.get<Meeting>(meetingSelect + ` JOIN ot_call_peers p ON p.call_id=c.id
        WHERE p.id=? AND p.owner_id=? AND m.host_owner=?`, input.peer_id, ownerId, ownerId);
      if (!meeting) {
        const id = newId("otcav");
        const conversationId = newId("otmeet");
        const code = ot.platform.meetingInviteCode(id);
        // The call engine owns this temporary room. It has no chat memberships.
        ot.run(`INSERT INTO ot_conversations(id,kind,title,created_by,created_at,updated_at)
          VALUES(?,'group',?,?,?,?)`, conversationId, title, ownerId, now, now);
        ot.run("INSERT INTO ot_live_calls VALUES(?,?,?,?)", id, conversationId, "video", now);
        ot.run("INSERT INTO ot_call_meetings VALUES(?,?,?,?)", conversationId, ownerId, hashCode(code), now + MEETING_TTL);
        meeting = {id, conversation_id: conversationId, created_at: now, kind: "video", title, host_owner: ownerId};
      }
      const peerId = joinPeer(ot, meeting, ownerId, input.peer_id, now);
      return {meeting: meetingView(meeting, ownerId), call: describe(ot, meeting, true), peer_id: peerId, ice_servers: iceServers(peerId, now)};
    });
  });

  app.post(meetings + "/preview", async req => {
    ot.me(req);
    prune(ot);
    return {title: findMeeting(body(req).code).title};
  });

  app.post(meetings + "/join", async req => {
    const {ownerId} = ot.me(req);
    const input = body(req);
    const now = ot.now();
    return ot.tx(() => {
      prune(ot);
      const meeting = findMeeting(input.code);
      const peerId = joinPeer(ot, meeting, ownerId, input.peer_id, now);
      return {meeting: meetingView(meeting, ownerId), call: describe(ot, meeting, true), peer_id: peerId, ice_servers: iceServers(peerId, now)};
    });
  });

  const meetingAccess: CallAccess = (req, input) => {
    const {ownerId} = ot.me(req);
    assert(typeof input.call_id === "string", 400, "invalid_request", "provide a call");
    const meeting = ot.get<Meeting>(meetingSelect + " WHERE c.id=? AND m.expires>?", input.call_id, ot.now());
    assert(meeting, 404, "call_ended", "meeting has ended");
    return {ownerId, conversationId: meeting.conversation_id};
  };
  registerCallActions(app, ot, meetings, meetingAccess);

  app.post(meetings + "/end", async req => {
    const input = body(req);
    const {ownerId, conversationId} = meetingAccess(req, input);
    return ot.tx(() => {
      const {call} = lease(ot, conversationId, ownerId, input);
      assert(ot.get("SELECT 1 FROM ot_call_meetings WHERE conversation_id=? AND host_owner=?", conversationId, ownerId),
        403, "forbidden", "only the host may end the meeting");
      ot.run("UPDATE ot_call_records SET ended_at=MAX(started_at,?) WHERE id=? AND ended_at IS NULL", ot.now(), call.id);
      ot.run("DELETE FROM ot_conversations WHERE id=?", conversationId);
      return {ended: true, handoff: {id: call.id}};
    });
  });
}

function registerCallActions(app: FastifyInstance, ot: OtContext, root: string, access: CallAccess) {
  app.post(root + "/poll", async req => {
    const input = body(req);
    const {ownerId, conversationId} = access(req, input);
    const {call, peer} = lease(ot, conversationId, ownerId, input);
    const after = input.after ?? 0;
    assert(Number.isSafeInteger(after) && after >= 0, 400, "invalid_request", "invalid signal cursor");
    ot.run("UPDATE ot_call_peers SET expires=? WHERE id=?", ot.now() + PEER_TTL, peer.id);
    const signals = ot.all<{seq: number; sender: string; payload: string}>(
      "SELECT seq,sender,payload FROM ot_call_signals WHERE call_id=? AND recipient=? AND seq>? ORDER BY seq LIMIT 64", call.id, peer.id, after);
    return {call: describe(ot, call, true), signals: signals.map(row => ({seq: row.seq, from: row.sender, ...JSON.parse(row.payload)}))};
  });

  app.post(root + "/recording", {bodyLimit: 1024}, async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const input = body(req);
    const {ownerId, conversationId} = access(req, input);
    const command = recordingCommand(input);
    return ot.tx(() => {
      const {call, peer} = lease(ot, conversationId, ownerId, input);
      return {recording: changeCallRecording(ot, call.id, peer.id, command)};
    });
  });

  app.post(root + "/signal", async req => {
    const input = body(req);
    const {ownerId, conversationId} = access(req, input);
    const {call, peer} = lease(ot, conversationId, ownerId, input);
    const to = input.to;
    assert(typeof to === "string" && to !== peer.id && ot.get("SELECT 1 FROM ot_call_peers WHERE call_id=? AND id=?", call.id, to),
      404, "peer_left", "peer is no longer in the call");
    const key = input.client_key;
    assert(typeof key === "string" && SIGNAL_KEY.test(key), 400, "invalid_request", "provide a signal key");
    if (ot.get("SELECT 1 FROM ot_call_signals WHERE sender=? AND client_key=?", peer.id, key)) return {sent: true};
    const count = ot.get<{n: number}>("SELECT COUNT(*) AS n FROM ot_call_signals WHERE sender=?", peer.id);
    assert(count && count.n < MAX_SIGNALS, 429, "signal_limit", "call signal limit reached");
    ot.run("INSERT INTO ot_call_signals(call_id,sender,recipient,client_key,payload) VALUES(?,?,?,?,?)",
      call.id, peer.id, to, key, JSON.stringify(signalPayload(input)));
    return {sent: true};
  });

  app.post(root + "/leave", async req => {
    const input = body(req);
    const {ownerId, conversationId} = access(req, input);
    return ot.tx(() => {
      if (typeof input.peer_id === "string" && typeof input.call_id === "string") {
        ot.run(`DELETE FROM ot_call_peers WHERE id=? AND owner_id=? AND call_id IN
          (SELECT id FROM ot_live_calls WHERE id=? AND conversation_id=?)`, input.peer_id, ownerId, input.call_id, conversationId);
      }
      prune(ot, conversationId);
      const record = typeof input.call_id === "string" && attendedCall(ot, input.call_id, ownerId);
      return {left: true, ...(record && record.ended_at !== null ? {handoff: {id: record.id}} : {})};
    });
  });
}
