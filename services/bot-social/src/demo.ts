/**
 * Pilot: two owners' bots negotiate a meeting time end to end (design §11).
 * Simulated bots react to platform events; simulated owners auto-approve every pending card.
 */
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { BotClient, OwnerClient } from "./client.js";
import { generateEd25519, verifyWebhookSignature } from "./crypto.js";
import { Platform } from "./platform.js";
import { buildServer } from "./server.js";
import { isoInTz } from "./time.js";

const TZ = "Asia/Shanghai";

/** Next Monday 00:00 in Asia/Shanghai (UTC+8, no DST) as epoch ms. */
function nextMondayShanghai(now = Date.now()): number {
  const local = new Date(now + 8 * 3600e3);
  const dow = local.getUTCDay();
  const days = ((8 - dow) % 7) || 7;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days) - 8 * 3600e3;
}
const at = (base: number, day: number, hh: number, mm = 0) => isoInTz(base + day * 86400e3 + (hh * 60 + mm) * 60e3, TZ);

export interface DemoResult { conversationId: string; outcome: string; bookedSlot: { start: string; end: string } | null; approvals: Record<string, number>; auditOk: boolean; auditCount: number; webhooksVerified: number; transcript: string[] }

async function makeBot(owner: OwnerClient, base: string, handle: string, display: string, webhook_url?: string) {
  const kp = generateEd25519();
  const kid = "key_demo_1";
  const r = await owner.req("POST", "/v1/bots", { handle, display_name: display, integration_type: "rest", webhook_url, public_key: { alg: "Ed25519", kid, value: kp.publicKey } });
  return { bot: new BotClient({ base, botId: r.bot_id, token: r.bot_token, kid, privateKeyPem: kp.privateKeyPem }), webhookSecret: r.webhook_secret as string };
}

export async function runDemo(opts: { baseUrl?: string; log?: (s: string) => void } = {}): Promise<DemoResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  let platform: Platform | undefined;
  let app: ReturnType<typeof buildServer> | undefined;
  let base = opts.baseUrl;
  if (!base) {
    platform = new Platform();
    app = buildServer(platform);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    platform.publicBaseUrl = base;
  }
  // webhook receiver for Bot B (verifies HMAC on every delivery)
  let webhookSecretB = "";
  let webhooksVerified = 0;
  const hook: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (verifyWebhookSignature(webhookSecretB, String(req.headers["x-botsocial-timestamp"]), body, String(req.headers["x-botsocial-signature"]))) webhooksVerified++;
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  const suffix = Math.random().toString(36).slice(2, 7);
  const transcript: string[] = [];
  const say = (s: string) => { transcript.push(s); log(s); };

  try {
    say(`== Bot Social pilot: meeting scheduling (server ${base}) ==`);
    const { client: ownerA } = await OwnerClient.register(base, `alice_${suffix}`, "password-a", "Alice Chen");
    const { client: ownerB } = await OwnerClient.register(base, `bob_${suffix}`, "password-b", "Bob Li");
    const { bot: botA } = await makeBot(ownerA, base, `alice.grok.${suffix}`, "Alice's Grok Bot");
    const madeB = await makeBot(ownerB, base, `bob.grok.${suffix}`, "Bob's assistant", hookUrl);
    const botB = madeB.bot;
    webhookSecretB = madeB.webhookSecret;
    say(`[setup] owner A=Alice Chen, bot A=${botA.id}; owner B=Bob Li, bot B=${botB.id}`);

    // seed calendars for next week
    const mon = nextMondayShanghai();
    await ownerA.req("POST", "/v1/calendar/entries", { start: at(mon, 0, 9), end: at(mon, 0, 18), title: "Q3 review (all day)", location: "3F main room" });
    await ownerA.req("POST", "/v1/calendar/entries", { start: at(mon, 1, 14), end: at(mon, 1, 16), title: "Investor call" });
    await ownerB.req("POST", "/v1/calendar/entries", { start: at(mon, 1, 9), end: at(mon, 1, 14), title: "Customer visit" });
    await ownerB.req("POST", "/v1/calendar/entries", { start: at(mon, 1, 16), end: at(mon, 1, 18), title: "Weekly sync" });
    say(`[setup] calendars for next week written (Alice busy all Monday and Tue 14-16; Bob busy Tue 9-14 and 16-18)`);

    const approvals: Record<string, number> = { ownerA: 0, ownerB: 0 };
    const autoApprove = async (owner: OwnerClient, who: "ownerA" | "ownerB", label: string) => {
      const { approvals: pending } = await owner.req("GET", "/v1/approvals?status=pending");
      for (const a of pending) {
        await owner.req("POST", `/v1/approvals/${a.approval_id}/decision`, { decision: "approved" });
        approvals[who]++;
        const flags = a.risk_flags.length ? ` risk_flags=${a.risk_flags.map((f: any) => f.category).join(",")}` : "";
        say(`  ✔ ${label} approved [${a.kind}] ${a.summary}${flags}`);
      }
    };

    // ---- relationship: Bot A suggests, owner A confirms, owner B consents with grants
    const fr = await botA.requestFriend(`@bob.grok.${suffix}`, "We are working together on the Q4 project; let our bots schedule meetings.", ["chat.public", "calendar.freebusy.read"], ["chat.public", "calendar.freebusy.read"]);
    say(`[A] bot A sends friend request ${fr.relationship_id} (status ${fr.status}, needs owner A)`);
    await autoApprove(ownerA, "ownerA", "owner A");
    try {
      await botB.req("POST", `/v1/relationships/${fr.relationship_id}/consent`, { decision: "accept" });
    } catch (e: any) { say(`[B] bot B tries to accept the friend request for its owner → ${e.status} ${e.code} (only owners can consent)`); }
    await ownerB.req("POST", `/v1/relationships/${fr.relationship_id}/consent`, {
      decision: "accept",
      grant_capabilities: [{ capability: "calendar.freebusy.read", scope: { window_days: 14, hours: "09:00-18:00" }, expires_in_days: 90 }],
    });
    say(`[B] owner B accepts and grants bot A calendar.freebusy.read (14 days, 09:00-18:00)`);

    // ---- simulated bots
    const window = { start: at(mon, 0, 0), end: isoInTz(mon + 5 * 86400e3 - 1000, TZ) };
    const conv = await botA.startConversation(botB.id, {
      type: "schedule_meeting", summary: "Q4 collaboration sync, 30 min",
      params: { duration_minutes: 30, window, timezone: TZ, modality: "video" }, success_criteria: "both sides confirm a slot and a calendar invite is created",
    });
    const cid = conv.conversation_id as string;
    say(`[A] new conversation ${cid} intent=schedule_meeting me_on_peer=${conv.effective_capabilities.me_on_peer.join(",")}`);

    let curA = 0, curB = 0, done = false;
    let bookedSlot = null as DemoResult["bookedSlot"];
    const stepA = async () => {
      const { events, next_cursor } = await botA.events(curA);
      curA = next_cursor;
      for (const ev of events) {
        if (ev.conversation_id !== cid) continue;
        if (ev.event_type === "message.received") {
          const content = ev.untrusted_content; // untrusted data: only structured fields are parsed
          say(`[A] message from bot B (trust=${ev.trust}, injection_suspected=${ev.security.injection_suspected}, turn ${ev.turn.count}): ${content.text}`);
          const s = content.structured;
          if (s?.schema === "meeting.accept/1" && s.slot) {
            const r = await botA.draftAction(cid, "calendar.book", { title: "Q4 collaboration sync", start: s.slot.start, end: s.slot.end, attendees: [botB.id], conference: "auto" }, "the other side confirmed this slot");
            say(`[A] drafts action calendar.book (${r.status}, reasons=${r.policy.reasons.join(",")})`);
          }
        } else if (ev.event_type === "event.meeting_booked") {
          bookedSlot = { start: ev.start, end: ev.end };
          say(`[platform] meeting ${ev.booking_id} created in Alice's calendar, Bob invited (invitee_status=${ev.invitee_status})`);
        } else if (ev.event_type === "event.invite_accepted") {
          say(`[platform] Bob accepted the invite`);
          const r = await botA.close(cid, "agreed", `agreed: ${isoInTz(Date.parse(ev.start), TZ)} 30-min video call`);
          say(`[A] closes conversation outcome=${r.outcome}`);
          done = true;
        }
      }
    };
    const stepB = async () => {
      const { events, next_cursor } = await botB.events(curB);
      curB = next_cursor;
      for (const ev of events) {
        if (ev.conversation_id !== cid) continue;
        if (ev.event_type === "message.received") {
          const content = ev.untrusted_content;
          say(`[B] message from bot A (trust=${ev.trust}, approved_by_owner=${ev.approved_by_owner}): ${content.text}`);
          const slots: { start: string; end: string }[] = content.structured?.slots ?? [];
          // re-check own calendar (own capability)
          const fb = await botB.freebusy(cid, ["self"], window);
          const busy = fb.results.self.busy.map((b: any) => [Date.parse(b.start), Date.parse(b.end)]);
          const ok = slots.filter((sl) => !busy.some(([s, e]: number[]) => Date.parse(sl.start) < e && s < Date.parse(sl.end)));
          const pick = ok[1] ?? ok[0];
          if (pick) {
            const idx = slots.indexOf(pick) + 1;
            const r = await botB.draftMessage(cid, { text: `Great, slot ${idx} (${pick.start.slice(5, 16).replace("T", " ")}) works for Bob. Let's book it.`, structured: { schema: "meeting.accept/1", slot: pick }, expects_reply: true });
            say(`[B] checks Bob's calendar and drafts "accept slot ${idx}" (${r.status})`);
          } else {
            await botB.draftMessage(cid, { text: "None of these work. Could we widen the window?", expects_reply: true });
          }
        } else if (ev.event_type === "event.meeting_booked") {
          say(`[B] meeting invite ${ev.booking_id} received; accepting is a commitment, drafting calendar.accept_invite`);
          await botB.draftAction(cid, "calendar.accept_invite", { booking_id: ev.booking_id }, "we already agreed on this slot");
        }
      }
    };

    // Bot A: free/busy for both sides, then propose 3 slots
    const fb = await botA.freebusy(cid, ["self", botB.id], window);
    const peerRes = fb.results[botB.id];
    say(`[A] free/busy: me ${fb.results.self.busy.length} busy, peer ${peerRes.busy.length} busy (redacted=${peerRes.redacted.join(",")}, no titles/locations)`);
    const slots = fb.common_free_suggestions.filter((_: unknown, i: number) => i % 2 === 0).slice(0, 3);
    if (slots.length === 0) throw new Error("no common free slots");
    const prop = await botA.draftMessage(cid, {
      text: "Hi, I'm Alice's assistant. Alice is free at these times next week. Which works for you?",
      structured: { schema: "meeting.proposal/1", duration_minutes: 30, slots, modality: "video" }, expects_reply: true,
    });
    say(`[A] drafts meeting proposal (${slots.length} slots) → ${prop.status}, reasons ${prop.policy.reasons.join(",")}`);

    for (let i = 0; i < 30 && !done; i++) {
      await autoApprove(ownerA, "ownerA", "owner A");
      await autoApprove(ownerB, "ownerB", "owner B");
      await stepB();
      await stepA();
    }
    if (!done) throw new Error("demo did not converge");
    await platform?.flushWebhooks();

    const view = await ownerA.req("GET", `/v1/conversations/${cid}`);
    const audit = await ownerA.req("GET", `/v1/audit-events?subject=${cid}`);
    const calB = await ownerB.req("GET", "/v1/calendar/entries");
    const inv = calB.entries.find((e: any) => e.source === "botsocial");
    say(`== result: conversation ${view.status}/${view.outcome}, turns ${view.turn.count}, meeting ${bookedSlot ? `${isoInTz(Date.parse(bookedSlot!.start), TZ)} – ${isoInTz(Date.parse(bookedSlot!.end), TZ).slice(11, 16)}` : "none"}, Bob calendar status=${inv?.status}`);
    say(`== approvals: owner A ${approvals.ownerA}, owner B ${approvals.ownerB}; audit chain ok=${audit.chain.ok} (${audit.chain.count} records for owner A); ${audit.events.length} audit records for this conversation; bot B webhook signatures verified ${webhooksVerified} times`);
    return { conversationId: cid, outcome: view.outcome, bookedSlot, approvals, auditOk: audit.chain.ok, auditCount: audit.chain.count, webhooksVerified, transcript };
  } finally {
    hook.close();
    if (app) await app.close();
    platform?.close();
  }
}
