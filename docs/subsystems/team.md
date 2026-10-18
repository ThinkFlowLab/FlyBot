---
subsystem: team
owned_paths:
  - docs/subsystems/team.md
---

# team (planned authority contract)

Proposed ownership and authority contract for multi-human FlyBot: **human owner ↔ designated Chief ↔ specialists** (tree children).

> **Status: planned, not shipped.** Multi-human ("team mode") does not exist in FlyBot today. This page is a contract for the remaining team work (#48+), written so role and data-boundary decisions are explicit *before* code. The #47 **schema foundation has landed** in the core store — data records only (see [Schema foundation](#schema-foundation-landed-47)). **Team mode stays DISABLED until the [team mode gate](#team-mode-gate) passes.** No API, tool, config key or env var enables it — do not invent one.

Shipped behavior stays what [core/README.md](../../core/README.md) (roles: You / Main Bot / group admin / member) and [plugins/tree/README.md](../../plugins/tree/README.md) (Chief as tree root) already document.

## Owns

- This page and the authority/ownership contract it states (identity, routing matrix, approval rules, team-mode gate).
- `docs/subsystems/team.md` only.

## Does not own

- Tree shape, root adoption, `maxChildren`/depth limits, and shipped `create_child_bot` (#16 Option B) → [tree](tree.md).
- Core runtime, shipped single-human roles and tools → [ds-bot-core](ds-bot-core.md) (`core/README.md`).
- Plugin runtime surface → [plugin-runtime](plugin-runtime.md).
- Per-Bot grants / default deny (#90) → core reach + [tree](tree.md); this page does not invent a publish path.

## Key concepts

| Term | Meaning | Status |
| --- | --- | --- |
| Human owner | The human of a pilot seat. Today: the single person behind a team (`You` — "Everything" in the core role table). In team mode: one of several humans, each with an **owner scope**. | Owner scope is planned; single human is shipped. |
| Owner scope | Everything one owner is authoritative over: their private rooms, their Bots, their files and memory, and their approvals. | Planned. |
| Designated Chief | The owner's Main Bot — the Bot that holds Main rights in that owner's scope. Defaults to name `Chief` / role `Chief of Staff`, and is adopted as the tree root (`treeRole: 'root'`). | Main Bot + tree root shipped; *designated per owner* planned. |
| Specialist | A non-root tree Bot (child of the Chief or of another specialist). Does the work, reports upward. | Shipped as tree members; owner-scoped rights planned. |
| Team administration | Management of **shared** team surfaces (e.g. group chats, team memory) — a distinct, narrower grant than private owner authority. | Distinction planned. |
| Private owner authority | Rights over one owner's **private** scope. Never implied by team administration. | Planned. |
| Approval | A human owner's consent for an action that spends that owner's authority. | Planned. |
| Team mode | Multi-human operation: several owners in one deployment, cross-owner traffic, per-owner scoping. | **Disabled** (see gate). |

## Schema foundation (landed, #47)

Shipped by the core store (`core/src/host/store.js`, owned by [ds-bot-core](ds-bot-core.md)) as **data records only**. It replaces implicit single-user ownership with explicit stable identities while the product stays single-human:

- The saved team (`state.json`) is **version 2**. `members` holds records with an immutable `id`, `createdAt`, and `designatedChiefId`; every Bot carries an `ownerId` binding.
- Loading a legacy **version-1** team runs one migration: it creates the single initial owner (`owner-1`), binds every existing Bot to it, sets the designated Chief from the **first Main Bot** (the shipped Main role — no name matching, no new Main rules), and writes version 2. Bot ids, Session parts and private histories are preserved. The pre-migration file is backed up once as `state.json.v1` before the first version-2 write; if a backup already exists it counts only when it is a readable file holding a parseable version-1 state — a directory, an empty or truncated file, or anything else there fails the load closed instead of migrating.
- Malformed ownership **fails closed**: a Bot owner that names no member, duplicate or mismatched member ids, or a designated Chief that is not a Bot of its member makes the file read-only — it is never repaired by guessing. An older binary already refuses a newer version read-only, so it cannot overwrite the schema.
- This is **not team mode**: the gates below are unchanged and unsatisfied except #16 (resolved Option B on the tree plugin). The schema does not encode child-creation policy and defines no flag/config/env for team mode. The #48 member-auth foundation (invitations, sessions, whoami) is a sign-in surface only — it does not enable team mode or cross-owner routing.

## Member auth foundation (landed, #48)

A thin invitation-and-session layer on top of the #47 identity schema, in `core/src/host/member-auth.js`:

- An invitation is a one-time random token; only its **sha256 hash** is stored. Redeeming a valid, unexpired, unredeemed invite creates a **member session** (also stored as a hash) and returns the session token once. The first redeem (no sessions yet) binds to the existing `owner-1` member; later redeems create the next human owner (`owner-2`, …). A member record stays the identity shape (`id`, `createdAt`, `designatedChiefId`); a display name is returned in the session response and is never written into the member record.
- The channel resolves the actor once per request from the `x-flybot-member-session` header (`rt.authenticate`). `body.actorId` / `payload.actorId` grant nothing and are ignored. Endpoints: `auth-invite`, `auth-redeem`, `auth-revoke`, `auth-whoami`, `auth-remove-member`, `auth-revoke-invite`. `auth-invite` needs a signed-in member, except on a host that has never had a session (bootstrap — the first invite is how the installing human signs in); every other member-auth endpoint needs the actor.
- `removeMember` revokes that member's sessions and drops the record; the **last owner cannot be removed**, and a member that still **owns a Bot** cannot be removed (`has_bots`) — reassign or delete the Bots first. `revokeSession` kills one session; `revokeInvitation` kills an unredeemed invitation (`auth-revoke-invite`, redeemed or already-revoked invitations refused), and redeeming a revoked invitation fails with `revoked`. Auth mutations run one at a time (an in-process lock), so concurrent `removeMember` calls cannot both pass the last-owner check. Only hashes live in `state.json`; plaintext tokens never reach disk.
- This is still **not team mode**: no owner scoping, no cross-owner routing, no flag/config/env for any of them. The gates below remain unsatisfied; this is the sign-in surface those gates will need.

## Owner-scoped access foundation (landed, #49)

Central authorization in `core/src/host/authz.js`, installed after member-auth:

- **Enforced only once a member session exists** (`authzEnforced`). With no sessions the shipped single-human product is unchanged.
- When enforced, every Bot / room / session an endpoint touches must belong to the signed-in actor (`bot/forbidden` otherwise). `body.actorId` still grants nothing. Session targets resolve through the store's owner maps (`botOf` for a Bot id; `selfOf` / `groupOwners` / `pastOwners` for a current chat, group Session or earlier part); unresolvable ids deny. `approval-answer` is judged by the approval's own Bot or room, resolved by approval id — caller-supplied session fields grant nothing.
- Connector tools (`mcp__github__*`, `mcp__composio__*`, #335) are a per-Bot opt-in of the owner, default off, and a Bot that is shared with anyone never gets them: access is a per-Bot grant of that Bot's own abilities, not of the owner's connected third-party accounts (see [core-host](core-host.md)).
- Shared resources that cannot yet be isolated per owner (secrets, connectors, folder picks, browser bridge, update-install, diagnostics, set-prefs, capability library writes, `add-agent` — the DSH Agent is one per deployment with no owner) are **explicitly blocked** with `bot/blocked-shared` while more than one member exists — not hidden only in the UI. `flybot/*` plugin endpoints follow the same split: plugin reads reach any signed-in actor, plugin writes are shared-blocked.
- `create-bot` stamps `ownerId` from the actor; `view()` and `live()` narrow to the actor — per-session entries (`questions`, `exchangeTurns`) keep the actor's own, deployment-wide surfaces (agents, secrets, connectors, memory reviews) stay visible while a single member exists and hide with more than one, the same rule as the shared writes. `create-room` refuses a request with neither a member Bot nor any participant (a room with nothing in it would belong to nobody); view() also keeps the shared rooms the actor belongs to and the Bots in them (#50).
- Watch item: `set-main` lets an owner promote their own Bot to a Main Bot. Main rights inside the Bot team are a shipped product concept; how they compose with multi-human authority is still a team-mode question (not #16 — that issue decided tree child creation). Revisit before team mode turns on.
- **Not done here:** cross-owner task execution and filesystem sandbox redesign (reach is #51, below). Team mode stays disabled.

## Room membership foundation (landed, #50)

Typed participants on a native room, in `core/src/host/room-membership.js`, installed after groups:

- A room may carry `participants`: `{ kind: 'human'|'bot', id, role: 'admin'|'member', displayName, joinedSeq, joinedAt, leftSeq?, leftAt?, invitedBy? }`. A **granted remote Bot** is the same kind with `remote: true`, `handle`, `ownerHome`, `ownerName`, `isChief?`. `room.members` stays the current *local* bot ids so existing single-owner groups keep their shape. Rooms without `participants` stay legacy: the owner is implicit and `who: 'User'` is that owner.
- Across owners, a *local* agent must have a **person-grant** (#90; Invite to this Bot was accepted) or have joined this room by its room code (#83, this room only). An ungranted Bot cannot be added, and cannot be in a room that has another owner or a friend's Bot (enforced on the host, not only hidden in the UI; revoking the grant takes it out at once). A friend's Bot listed by `@flybot/social` `social/remote-bots` (Bots granted to me) may be added; ungranted specialists stay owner-private. **Why the rule stands for a group (not only a 1:1 chat):** a group that holds a friend's Bot is projected to that friend's home. `fanoutRoomLine` sends its lines on, and the replies of every local Bot that may speak there; the friend's Bot's lines come back into the room that the local Bots read. A local Bot that is not shared with that friend would either be silently cut off from the friend (its lines are filtered, `mayShareRoom`) or be exposed to the friend's Bot's text — so the host refuses instead of half-including it, and the Bot Social server would refuse its messages anyway (no grant on its side). The refusal is not a dead end: it names the Bot and the friend (`details.reason: 'ungranted-local'`, `bots`, `remotes`, Bot names from local records, friend names through `cleanPeerName`) and the new-chat card offers **Copy invite link for {Bot}** (the Bot's own invite; the grant exists only after the friend accepts it) or **Leave {Bot} out**. Nothing is granted by the click, and no room-scoped grant is made for a plain group.
- Every posted line carries `authorId` + `authorKind` + a display snapshot (`who`). The signed-in actor wins; `body.authorId` grants nothing. Peer names are sanitized (`cleanPeerName` / `cleanRemote`).
- **History-visibility rule (membership window):** only a *current* participant — or the owner of an invited Bot — may read a room. They see lines with `seq >=` the `joinedSeq` of their open interval (for an invited owner, their Bot's interval). Leaving closes the interval and withdraws all history access. Rejoining opens a new interval at the then-current seq; prior intervals do not come back. Non-members cannot read or inject.
- Endpoints: `room-history`, `room-post`; `create-room` / `update-room` accept `participants` / `addParticipants` / `removeParticipants`. `view()` presents each viewer under the table below. Inbound projections (`origin: 'inbound-share'`, `rt.recordInboundSharedRoom` / `applyInboundRoomShare`) are the remote owner's copy of a friend's room that invited their granted Bot, created from a `FLYBOT-ROOM-SHARE` envelope when the Bot is added (not only after the first chat line).
- Replies that leave through Bot Social still follow that plugin's outbound hold (`pending_approval` / Friends' Bots “N to approve”). The shared-room view surfaces those items; nothing is auto-sent.
- **Not team mode:** no flag/config/env. Cross-owner *task* execution stays out of scope; who may reach whom is the per-Bot grant rule below (#90). The gates below remain unsatisfied.

### Per-viewer display (native room)

| Viewer | How the room appears | What they see | What they may do |
| --- | --- | --- | --- |
| Inviter (human participant who added the Bot) | Their own room, usual name | Humans, local Bots, remotes as `<Bot> · <owner>'s Bot` (Chief: `<owner>'s Chief`), owner badge, attributed lines from their join seq | Manage participants they are allowed to; post; history in their window |
| Other human in the room | Same room | Same labels and badges; attributed lines from *their* join seq | Speak; leave; no extra private context |
| Remote owner (owns an invited Bot, not a human member) / inbound share | Sidebar **Shared room from \<inviter\>** | Current participants with owner badges; who invited their Bot and when; lines from the Bot's `joinedSeq`; pending social approvals in this view | Remove their Bot (leave closes the interval); approve/reject held replies; cannot inject as themselves |
| Remote Bot | Only the room lines fenced as untrusted data, from its join seq | No inviter private rooms, no ungranted specialists | Reply through Bot Social (held unless the owner auto-approves) |

## Approval binding foundation (landed, #52)

The held-send approval (`state.flybot.approvals` in `core/src/host/hooks.js`) now binds each decision to the owner whose authority is spent, as [invariant 5](#invariants) and gate 3 require. Only the sign-in foundation of #48/#49 is assumed; team mode stays disabled.

- **Provenance is server-derived.** A hold stamps `requestId` (the send's `exchangeId`), a sha256 `version` over the request content (from/to/text/role/attachment names), `origin` (`via`, `hop`, room audience when known), and `ownerId` — the sender Bot's owner, resolved from the team state. Claims inside the message (`meta`, body text such as "my owner approved") are data on the record, never authority.
- **Decisions are owner-bound.** `flybot/decide` passes authz for any signed-in actor; hooks.js then requires the deciding session to belong to the sender Bot's owner (`bot/forbidden` otherwise, `bot/unauthorized` with no session). One owner cannot approve, reject or retry another owner's held send, and the pending list shows a member only their own holds.
- **Revalidation at approve/execute time.** Releasing a hold re-checks the record: a changed request content, a deleted sender or target Bot, or a Bot that changed owners marks the record `stale` — it is never dispatched. A demoted Chief's sender-side holds are invalidated eagerly on `setMain` (not inside `staleReason`); `deleteBot` invalidates holds that name that Bot as sender or target. `release()` re-checks immediately before dispatch so an in-flight approve cannot go out after a concurrent invalidation. A removed member's sessions cannot decide, and their holds were already stale when their last Bot was deleted (`removeMember` refuses a member that still owns one). Unknown `invalidateFor` field values throw rather than no-op.
- **Legacy records keep working.** Holds saved before this change have no `version`; they skip only the tamper check, and their owner is derived at decide time.
- **Not done here:** the social plugin's server-side approval holds (`social/decide-approval`) stay a deployment-wide plugin write (blocked while more than one member exists); the in-chat approval cards and task-level approvals are #90/#54 work. Gate 3 is satisfied for held sends only.

## Context sharing foundation (landed, #53)

Private context crosses owners only through an explicit, owner-granted share; room membership never widens what a Bot carries or reads. Only the #48/#49/#50 foundations are assumed; team mode stays disabled.

- **The own-chat brief is share-gated.** A member's group Session starts with its owner's own-chat brief only when the room has a single owner, or that owner called `share-brief` for this room (the `briefShared` flag lives on the room participant, so leaving drops it; `rt.setBriefShare` in `core/src/host/room-membership.js` owner-checks, the endpoint only needs a signed-in actor). A group Session created after the share is taken back carries no brief. A granted remote Bot in the room counts as another owner (its handle stands for its home), so a friend's Bot's presence also suppresses the brief. A brief already delivered is not retroactively unseen — document that to owners.
- **Memory review is owner-aware.** In `core/src/host/memory.js`, "the user" of a group review is the member Bot's owner (`isUserLine`); another owner's human is a named `peer` (not `bot`) and does not get user-line retention. A review that reads a room with more than one owner cannot write the team scope (`teamAllowedFrom`) — entries land in the Bot's own memory. Entries already written are not retroactively unseen.
- **Roster disclosure narrows.** `list_bots` lists the caller's owner's Bots, Bots granted to that owner, and Bots in the current room — never an ungranted Bot of another owner. A granted child triggered by a grantee is scoped to its own `createdBy` subtree and does not dump the owner's roster with `workDir` / instructions. Another owner's folder and instructions stay private when that Bot is listed at all.
- **Chat references stay owner-scoped.** A `dsh-session:` reference chip in actor-authored text that becomes a session user message (`send`, `room-post`, `answer-question`, `schedule-create`) must name a Session the author may read (`sessionOwnedBy`); the snapshot rides to every recipient, so authorship is the gate. `schedule-create` authz keys off `body.target` (the Bot or room the endpoint uses), not a caller-chosen `sessionId`. Bot-authored group posts (`postToRoom`) and Bot-to-Bot / own-chat followups (`rt.deliver` and `bot.send`, including a granted Bot of another owner) drop chips so a member Bot cannot tunnel a private chat. DSH resolves chips on user-shaped followups (`session-reference` / `attachReference`) and attaches the snapshot only to the last user post, not a Bot's post.
- **Not done here:** the secrets surface stays `SHARED_BLOCKED` for >1 member; previously received messages cannot be retroactively unseen (stated, not engineered); no per-owner file-sandbox changes — a room `workDir` remains readable by its member Bots under DSH's own policy. **Follow-up (brief share):** `briefAllowed` still withholds the owner's own-chat brief in any multi-owner room, including face-to-face rooms where someone brings their own Bot; the intended model is a grant-tied share (a flag on `state.grants` or the room-scoped grant) rather than a participant `briefShared` flag lost on leave. `setBriefShare` already requires the Bot to be a current room participant. That redesign is out of this #54 PR.

## Task lifecycle foundation (landed, #54)

`state.tasks` (`core/src/host/tasks.js`): a request becomes a tracked task — `open → claimed → working → blocked ⇄ working → result-ready → accepted`, `cancelled`/`failed` terminal, `accepted` only from `result-ready`. Only the requester's session moves their task (`bot/forbidden` otherwise). Create does not require owning the Bot: a matching per-Bot grant, or both the requester and the Bot as current members of the named room, is enough — a granted child can take a handoff within its authority. Outgoing holds stay the owner's: a held send (#52) blocks **that** task (`meta.taskId` stamped on the send from the working task — origin session/room when the Bot has several, else the latest — or an explicit id) until that owner decides. `result-ready` is protected from prune while it waits for acceptance. Task channel names are an explicit allow-list (`tasks` / `task-create` / `task-accept` / `task-start` / `task-return` / `task-accept-result` / `task-cancel`). Records carry per-status actor entries, pointers to the originating conversation, and a summary — never private transcripts. The in-room task view and audit trail are #57's; clarification (ask the requester) and `workBotId` (the specialist on the exchange) wait on #55's exchange wiring. Team mode stays disabled.

### Requester-controlled input-wait bookkeeping (#207)

The host task API has `task-wait-input` and `task-answer-input`, both checked
against the task's server-derived requester. They persist one bounded selected
question/answer snapshot and a current question ID, not conversation history.
Answering requires the current ID and no pending task approvals. `task-start`
only starts claimed work; it cannot bypass a blocked input or approval wait.
Explicitly task-tagged holds that arrive during an input wait stay separately
tracked, including across restart; approval clears no unanswered question.

This is bookkeeping only: no automatic question delivery, model prompt, external
runtime authentication or cross-owner execution is added. The #55 exchange wiring
and team-mode gates remain unsatisfied. See [core-host](core-host.md#task-input-waits).

## Identity model

| Relation | Rule |
| --- | --- |
| Human owner → designated Chief | Exactly **one designated Chief per pilot member** (owner). Several humans never share one Chief, and one human designates one Chief. The shipped product allows more than one Main Bot per team; the pilot contract pins one per owner. |
| Designated Chief → specialists | The Chief is the root of its owner's tree; specialists are its children (or descendants). Specialists inherit their scope only from their Chief's owner. |
| Specialist → owner | A specialist belongs to exactly one owner's tree. There are no ownerless or shared specialists. |
| Authority follows the human | Ownership is an assignment to a person, not to a Bot name. Renaming, replacing or disabling a Bot never transfers authority by itself. |
| Granted ↔ granted | The only legal cross-owner hop (#90): a Bot another owner (or a friend) can reach is one its owner **granted** to that person. Default deny, Chief included; nothing is routed through the Chief. Each Bot remains accountable to its own owner. |

## Room visibility (membership window landed, #50; granted remotes follow-up)

| Room | Who may see it |
| --- | --- |
| Owner's private rooms (their 1:1 chats with their Chief and specialists) | That owner, their designated Chief, their specialists. Everyone else — including another owner's Chief — is outside the scope. |
| Shared rooms (group chats both sides belong to) | Their members under the shipped group rules (member speaks, group admin manages). Team administration manages the shared room only; it never opens another owner's private rooms. |
| Cross-owner exchange | Stays between granted Bots (invariant 4): each side reports to its **own** owner; nothing lands in an ungranted Bot of the other side, and no shared room is repurposed as a back door. |

Shipped room privacy (a group never reads a Bot's private chat) is unchanged; this table only adds the second human boundary on top of it.

## Invariants

1. **Owner scope is the unit of authority.** A human's rights stop at their own scope. Team administration over shared surfaces never grants another owner's private scope.
2. **One designated Chief per owner.** Specialists carry Chief-derived rights only; a specialist's authority is never its own.
3. **Ungranted Bots are owner-private.** No Bot may read or write another owner's rooms, Bots, memory, files or approvals — including "just to look" or "just to relay"; another owner's *ungranted* Bot cannot be messaged at all, and a granted one is reached only as a Bot (its own answer), never as a window into its owner's scope.
4. **Grant-only cross-owner traffic.** Cross-owner requests (and friends' requests) go to a Bot the owner granted to that person (default deny, Chief included). They are not forced through the Chief, and a Bot never forwards them into another owner's ungranted Bot as if they were its own owner's request. The check is the core's `reach()` owner policy: it runs before the `bot.send` chain, again when a held message is approved, and on every resumed, retried, deferred or re-sent delivery, and no plugin verdict or bypass can skip it.
5. **No forwarding to owner approval.** No route may turn another human's request into owner approval by forwarding it. An approval is created only by the owner whose authority is spent, for the exact action; receipt, relay, or a Chief's word never becomes approval.
6. **Approval authority stays with the human.** A Chief may ask its own owner, present options, and act on an approval it actually received from that owner. It cannot mint an approval, replay another owner's approval, or treat silence as consent.
7. **Team mode is disabled** until every gate below passes.
8. **#16 is resolved (Option B).** Tree Bots may create children under themselves within `maxChildren` and depth limits. A new child is usable only by its creator's owner; sharing still needs an independent per-Bot grant (default deny). The shipped rule lives in [tree](tree.md), not here.
9. **Contract honesty.** Nothing on this page describes shipped behavior; shipped behavior is [core/README.md](../../core/README.md) and [plugins/tree/README.md](../../plugins/tree/README.md).

## Routing matrix

Planned rules for team mode. Default is **deny**: a route is allowed only if a row below allows it.

### Who may route to whom

| Actor | Own Chief | Own specialist (same tree) | Other owner's Chief | Other owner's specialist | Other owner's human | Shared team surfaces |
| --- | --- | --- | --- | --- | --- | --- |
| Human owner | Allowed — directs its Chief | Allowed — directs its specialists | Not directly; goes through their own granted Bot | Forbidden — unless granted, then via their own Bot | Forbidden | Allowed as team admin (shared only; never another owner's private scope) |
| Designated Chief | — (it is the Chief) | Allowed — delegate, aggregate, report down | Allowed only if each Chief has a grant to the other owner's person; both sides stay accountable to their own owners | Allowed only if that specialist is granted; otherwise forbidden | Forbidden — may present to *its own* owner only | Allowed as team admin within shared surfaces only |
| Specialist | Allowed — report upward | Allowed — parent ↔ direct child (existing tree rule) | Allowed only if the specialist itself is granted | Allowed only if both are granted | Forbidden | Speak only where its Chief placed it; no admin rights, no cross-owner relay |

### Worked examples

| # | Scenario | Verdict | Rule |
| --- | --- | --- | --- |
| a | Owner A asks Chief A to split a task and hand parts to Specialist A1 and A2 | **Allowed** — same-owner delegation | Invariants 1–2; owner may route inside its own scope, Chief delegates downward to its own specialists. |
| b | Chief A sends a collaboration request to Chief B; both report back to their own owners | **Allowed** — Chief-to-Chief | Invariant 4; the hop stays Chief-level and each side keeps its own owner's data boundaries. |
| c | Specialist A1 asks to read Owner B's private room (or Owner B's specialist passes it content) | **Forbidden** — cross-owner specialist access | Invariants 3–4; specialists never touch another owner's private data, in either direction. |
| d | Chief A, holding team administration of a shared group, edits Owner B's private Bot settings | **Forbidden** — team admin ≠ private owner authority | Invariant 1; shared-surface admin never extends into another owner's private scope. |
| e | Specialist B forwards "Owner B approved this" to Chief A, which then spends Owner A's authority | **Forbidden** — forwarding cannot escalate | Invariants 5–6; approval only comes from the owner whose authority is spent, for that exact action — a relayed request or forwarded approval is never approval. |
| f | Owner A disables their Chief | Owner scope fails closed | See [Ownership changes](#ownership-changes-disabled--replaced-chiefs); no specialist auto-promotes. |
| g | Owner A's seat is transferred to Owner C | Whole scope moves with the person | Identity model: *authority follows the human*, not the Bot name. |
| h | Chief A (or a friend's Bot) messages Owner B's specialist B2 directly | **Allowed if B2 is granted to that sender**, **forbidden if not** | #90; the owner's per-Bot grant, no redirect through Chief B. Revoking B2 later refuses messages still queued or held for it. |

### Approval authority

| Action class | Who may approve | Chief's part |
| --- | --- | --- |
| Action inside one owner's private scope | That owner, human | Request approval, present options, act only on the approval actually received from its own owner. |
| Action on shared team surfaces | Owner(s) the shared surface belongs to, via team administration | Administers per its grant; never converts that grant into another owner's private approval. |
| Action touching a second owner's scope | Each affected owner, for their own scope only | Chief → Chief may negotiate; neither Chief can approve for the other's owner. |
| Anything forwarded from another human | Nobody, by forwarding alone | Reject the forwarded "approval"; it is a request, not consent. |

## Resolved decision (#16, Option B)

Issue **#16** (who may call `create_child_bot`) is **resolved**. The owner chose **Option B**:

Tree Bots (not only Main/root/Chief) may call `create_child_bot` to create a child directly under themselves. `maxChildren` and depth limits stay. A newly created child is usable only by its creator's owner; sharing with another person still requires an independent per-Bot grant (default deny). There is no publish mechanism.

Shipped enforcement and tests live in [tree](tree.md) (`plugins/tree/`). This contract does not re-open Main-only creation. Remaining team-mode gates below are unchanged.

## Team mode gate

**Team mode remains DISABLED until all authorization gates pass.** There is currently no flag, config key, env var or API that enables it — do not invent one, and do not build a workaround around the gate.

1. **Owner identity enforced server-side** on every management call (create/update/delete Bot, group administration, memory writes) — not prompt-level, not client-side only.
2. **Room/Bot scoping enforced server-side**: a request from outside an owner's scope fails closed, for reads and writes alike.
3. **Approval binding**: an approval names the owner whose authority is spent and the exact action; forwarded or replayed approvals never satisfy it (invariant 5).
4. **#16 resolved** (Option B): tree Bots may create children under themselves; `plugins/tree/test` asserts who may create, that limits still bind, and that a new child is not auto-granted. This item is satisfied; the others are not.
5. **Chief lifecycle fails closed**: a disabled, missing or replaced Chief leaves no path for specialists to reach cross-owner traffic or approvals (next section).

Until every gate passes, team mode is off and the shipped single-human model is the only supported one.

## Ownership changes, disabled / replaced Chiefs

Planned rules (fail closed by default):

- **Ownership change** moves the owner's whole scope — rooms, Bots, memory, open approvals — with the human assignment. Derived authority (the Chief's) moves with it; nothing transfers because of a Bot name.
- **Disabled Chief**: the owner's tree stops at the root. Specialists go inert for cross-owner traffic and approvals; no specialist auto-promotes to Chief, and an ownerless specialist is never a fallback Chief.
- **Replaced Chief**: only the owner designates a replacement. The old Chief's Main rights are removed at handover, the tree re-anchors to the new designated Chief under the tree plugin's existing adoption rules (this contract changes none of them), and approvals issued through the old Chief die with it — the owner must re-grant them.
- **No Chief, no cross-owner**: cross-owner traffic requires a live designated Chief on *both* sides; a gap on either side fails closed rather than degrading to specialist-level routing.

## Common mistakes

- Reading this page as shipped behavior — multi-human is planned; team mode is disabled.
- Reading the version-2 identity schema (`members`, `ownerId`, `designatedChiefId`) as team mode — it is data-record foundation; the gates below are unchanged, and nothing enforces them yet.
- Treating team administration (shared groups, team memory) as private owner authority, or vice versa.
- Letting a specialist "just relay" across owners — relaying is routing, and it is forbidden.
- Treating a forwarded request or forwarded "approval" as owner approval.
- Treating #16 as still open, or restricting `create_child_bot` to Main/root after Option B.
- Adding a team-mode flag, config key or env var before the gates pass.
- Rewriting tree ownership here instead of in [tree](tree.md).

## Tests

**Schema foundation (#47)** has store-level tests in `core/test/identity.test.js`: a fresh team and a representative legacy team load, migration idempotence and restart-safety, the `state.json.v1` backup (created once; a directory or a truncated/unusable file in its place fails closed), and malformed-ownership fail-closed cases (unknown owner, duplicate member ids, bad Chief references, version-1 files carrying ownership fields). They assert data records only — no routing, scoping or approvals, and no multi-human behavior.

**Member auth foundation (#48)** has tests in `core/test/member-auth.test.js`: two members get distinct identities via invite→redeem, forged strings never authenticate (only a live session token does), invitation replay and expiry fail, `removeMember` / `revokeSession` invalidate sessions, the last owner cannot be removed, and tokens are stored only as hashes. These cover the sign-in surface only — no owner scoping or cross-owner behavior.

Owner-scoped access (#49) tests in `core/test/authz.test.js`: cross-owner denials, and the positive paths that keep an owner working — their own Bots' sessions (Bot id, current chat, group Session, schedule), plugin-endpoint reads, approval answering by id, and the `view()`/`live()` narrowing rules for one and for several members.

**Room membership foundation (#50)** has tests in `core/test/room-membership.test.js`: Alice, Bob and both Chiefs keep distinct authorship; concurrent posts keep order and identity; unauthorized history reads fail; join/leave follows the membership-window rule; non-members cannot inject (forged `authorId` is ignored); existing single-owner groups still display and accept posts; a specialist cannot join a cross-owner room.

**Approval binding (#52)** has tests in `core/test/approval-binding.test.js`: the hold stamps server-derived provenance and a request-content hash while forged `meta` claims stay data; only the sender Bot's owner's session may decide (another member gets `bot/forbidden`, no session gets `bot/unauthorized`, a body `actorId` grants nothing); the pending list is per-actor; a request that changed after it was held goes `stale` and never dispatches; same-owner deciding survives a restart; deleting a sender or target Bot or replacing the Chief invalidates pending *sender-side* holds, while a hold *addressed to* the demoted Chief stays pending and decidable; an in-flight approve is invalidated if the Chief is replaced before dispatch; and a record whose sender Bot and owner are both gone stays in state with its attribution but in no member's list.

**Context sharing (#53)** has tests in `core/test/context-sharing.test.js` (brief gate per room ownership, the owner-only `share-brief` round trip, the single-owner guard, `list_bots` narrowing to own / granted / current-room Bots and granted-child subtree scoping, reference-chip authorization on `send`/`room-post`/`answer-question`/`schedule-create`, and chip stripping on Bot group posts and Bot-to-Bot / own-chat followups) and in `core/test/memory.test.js` (owner-as-user classification, the team-write gate out of a cross-owner room).

**Task lifecycle (#54)** has tests in `core/test/tasks.test.js`: the happy path (open → claimed → working → result-ready → accepted, then stale), wrong-member accept/claim/cancel forbidden, accept-before-result and post-terminal moves stale, held-send block → owner approve resumes, owner reject cancels, a named hold blocks only that working task (an untagged hold does not cancel every sibling), `result-ready` survives prune, responsible-Bot deletion fails the task, restart persistence, corrupt `state.tasks` resets, and a grantee may create a task on a granted child but not on an ungranted sibling.

The routing-matrix rows above remain untested because the behavior is not shipped. When enforcement work starts (#48+), each row becomes a test first, per [fail-without-change](../code-standards.md): same-owner delegation allowed (a), Chief-to-Chief allowed (b), cross-owner specialist denied (c), team-admin vs private-owner denied (d), forwarded approval rejected (e). Each must fail on the unbroken tip before implementation lands.
