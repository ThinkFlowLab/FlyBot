/** Minimal bot-side SDK: signs every write as a botsocial/1.0 envelope (Ed25519) and calls the REST API. */
import { signEnvelope } from "./crypto.js";

export class ApiCallError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) { super(`${status} ${code}: ${message}`); }
}

/** The most of a non-JSON body an error line may carry: a gateway page can be kilobytes long. */
const MAX_EXCERPT = 200;

function excerpt(text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT)}…` : flat;
}

/**
 * A failed call that never got JSON back (a gateway page, a portal page behind a wrong `--url`). Its `message` is the
 * response text itself: the status and the code are the fields beside it, and a caller that prints `status code:
 * message` should not see them twice.
 */
class NonJsonResponseError extends ApiCallError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message, {});
    this.message = message;
  }
}

async function call(base: string, token: string | undefined, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  let isJson = true;
  if (text) {
    try { json = JSON.parse(text); } catch { isJson = false; }
  }
  if (!res.ok) {
    // A gateway HTML page or a portal page must still reach the caller as the HTTP failure it is, not as a SyntaxError.
    if (!isJson) throw new NonJsonResponseError(res.status, "error", excerpt(text));
    throw new ApiCallError(res.status, json?.error?.code ?? "error", json?.error?.message ?? text, json);
  }
  // A 2xx that is not JSON is a proxy page or a wrong --url, never a success: name it with a client-side code.
  if (!isJson) {
    const type = res.headers.get("content-type")?.split(";")[0]?.trim() || "an unknown content type";
    throw new NonJsonResponseError(res.status, "sdk_non_json_body", `the server answered ${type} where JSON was expected: ${excerpt(text)}`);
  }
  return json;
}

export class OwnerClient {
  constructor(public base: string, public token: string) {}
  static async register(base: string, username: string, password: string, display_name?: string) {
    const r = await call(base, undefined, "POST", "/v1/owners", { username, password, display_name });
    return { client: new OwnerClient(base, r.owner_token), owner_id: r.owner_id as string };
  }
  req(method: string, path: string, body?: unknown) { return call(this.base, this.token, method, path, body); }
}

export interface BotCredentials { base: string; botId: string; token: string; kid: string; privateKeyPem: string }

export class BotClient {
  constructor(public cred: BotCredentials) {}
  get id() { return this.cred.botId; }
  req(method: string, path: string, body?: unknown) { return call(this.cred.base, this.cred.token, method, path, body); }
  envelope(type: string, payload: unknown, extra: { to?: string; conversation_id?: string } = {}) {
    return signEnvelope({ type, from: this.cred.botId, payload, kid: this.cred.kid, privateKeyPem: this.cred.privateKeyPem, ...extra });
  }
  signed(path: string, type: string, payload: unknown, extra: { to?: string; conversation_id?: string } = {}) {
    return this.req("POST", path, this.envelope(type, payload, extra));
  }
  friends() { return this.req("GET", "/v1/friends"); }
  requestFriend(target_handle: string, message: string, requested_capabilities?: string[], offered_capabilities?: string[]) {
    return this.signed("/v1/relationships", "relationship.request", { target_handle, message, requested_capabilities, offered_capabilities });
  }
  startConversation(peer_bot_id: string, intent: unknown) {
    return this.signed("/v1/conversations", "conversation.create", { type: "direct", peer_bot_id, intent }, { to: peer_bot_id });
  }
  getConversation(id: string) { return this.req("GET", `/v1/conversations/${id}`); }
  draftMessage(conversation_id: string, payload: { text: string; structured?: unknown; expects_reply?: boolean }) {
    return this.signed(`/v1/conversations/${conversation_id}/messages`, "message.draft", payload, { conversation_id });
  }
  draftAction(conversation_id: string, action_type: string, params: unknown, justification?: string) {
    return this.signed(`/v1/conversations/${conversation_id}/actions`, "action.draft", { action_type, params, justification }, { conversation_id });
  }
  freebusy(conversation_id: string, subjects: string[], window?: { start: string; end: string }) {
    return this.signed("/v1/calendar/freebusy", "calendar.freebusy.query", { conversation_id, subjects, window }, { conversation_id });
  }
  close(conversation_id: string, outcome: string, summary?: string) {
    return this.signed(`/v1/conversations/${conversation_id}/close`, "conversation.close", { outcome, summary }, { conversation_id });
  }
  requestGrant(relationship_id: string, capability: string, scope?: unknown, reason?: string) {
    return this.signed("/v1/grant-requests", "grant.request", { relationship_id, capability, scope, reason });
  }
  events(since = 0) { return this.req("GET", `/v1/events?since=${since}`); }

  // Face rooms: a Bot enters on the same 6-digit number its owner uses, and every line it writes is a draft its
  // owner approves. The door authenticates the Bot's own token, so nothing here is signed as an envelope.
  faceRooms() { return this.req("GET", "/v1/face-rooms"); }
  faceRoom(room_id: string, after?: number) {
    const tail = after !== undefined ? `?after=${encodeURIComponent(String(after))}` : "";
    return this.req("GET", `/v1/face-rooms/${encodeURIComponent(room_id)}${tail}`);
  }
  joinFaceRoom(code: string) { return this.req("POST", "/v1/face-rooms/join", { code, bots: [this.id] }); }
  /** Open the waiting room this Bot sits in: the same door the console's Start button calls. */
  startFaceRoom(room_id: string) { return this.req("POST", `/v1/face-rooms/${encodeURIComponent(room_id)}/start`); }
  draftFaceRoomMessage(room_id: string, payload: { text: string; mentions?: string[] }) {
    return this.req("POST", `/v1/face-rooms/${encodeURIComponent(room_id)}/messages`, { ...payload, bot_id: this.id });
  }
  leaveFaceRoom(room_id: string) { return this.req("POST", `/v1/face-rooms/${encodeURIComponent(room_id)}/leave`, { bot_id: this.id }); }
  /** One week of the rooms this Bot's own seats sat in, read from the recaps their close already wrote. */
  weekDigest() { return this.req("GET", "/v1/digest"); }
  /** Who is thinking toward this Bot or into a room it sits in: the same readout the console's presence line uses. */
  presence(room_id?: string) {
    const tail = room_id ? `?room_id=${encodeURIComponent(room_id)}` : "";
    return this.req("GET", `/v1/presence${tail}`);
  }
}
