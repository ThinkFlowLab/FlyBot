---
subsystem: core-host
owned_paths:
  - core/index.js
  - core/src/host/
  - core/src/shared/
  - core/web-search.js
  - core/test/identity.test.js
  - core/test/room-membership.test.js
  - core/test/remote-room.test.js
  - core/test/reach-policy.test.js
---

# core-host

The server side of the patched `ds-bot` core (`core/`): the part of [ds-bot-core](ds-bot-core.md) that runs in DSH. Split out of that page so a change to the browser client or to the pin and patch tooling does not have to edit this one. Pin, patch format, `core/dev/` and the invariants about `ds-bot/` and `client.js` stay on [ds-bot-core](ds-bot-core.md).

## Owns

- Core server: roster/store, tools, turns/delivery, groups, conversation parts, search index, images, browser bridge, `api/bot` channel.
- `core/index.js` — plugin server entry; `core/src/host/` — host modules (roster/store, tools, turns/delivery, groups, channel, remote chats); `core/src/shared/` — code both sides import.
- `core/web-search.js` — standalone `auto` web-search provider.
- `core/test/identity.test.js` — the state identity schema tests (store `state.json` v2, #47).
- `core/test/room-membership.test.js` — typed room participants, authorship and the membership-window history rule (#50).
- `core/test/remote-room.test.js` — granted remote participants, per-viewer presentation and ungranted-Bot refusal; #90 room rules (a room with friends' Bots takes granted local Bots only, revoke evicts, fanout checks author and recipient, room-code Bots); a friend's chat `pendingCount` from `listChatApprovals`.
- `core/test/reach-policy.test.js` — #90 reach policy: per-Bot grants (default deny, Chief included), the allow/deny matrix per direction, no bypass, hold release and flagged deliveries re-checked, setGrants and `bot.grants`.

## Does not own

- The browser client, `core/client.js` → [core-client](core-client.md).
- Pin, patches, `core/dev/`, `core/types/` → [ds-bot-core](ds-bot-core.md).
- FlyBot plugin API surface (`core/src/host/hooks.js`) → [plugin-runtime](plugin-runtime.md).
- `plugins/tree/`, `plugins/social/` → their own pages.

## Key files

| File | Role |
| --- | --- |
| `core/index.js` | Server entry. |
| `core/src/host/` | Host-side helpers (non-hooks). |
| `core/src/host/room-membership.js` | Typed room participants (human / local bot / granted remote), authorship, membership-window history (#50); rooms with friends' Bots or other owners take granted local Bots only and evict a Bot that stops qualifying (#90). Face-to-face rooms (#83) reuse this model (`origin: 'face-to-face'`, room-only remotes without a person-grant, `upsertFaceRoom` / `syncFaceParticipants` / `applyFaceRoomLine`). |
| `core/src/host/reach.js` | Per-Bot grants and the owner-policy `reach()` check that hooks.js runs outside the plugin chain (#90); `rt.setGrants`, `rt.hasGrant`, `rt.hasAnyGrant`. |
| `core/src/shared/remote-label.js` | Owner-badge labels for a friend's Bot and “Shared room from …” titles. `isListedRemoteChat` / `listedChatBots` keep gone, hidden, and home-level (`@something.home`) remotes out of the sidebar, the **发给** picker, mentions, and `list_bots` friends lines; history stays on disk. |

## Invariants

Add a new invariant under the heading it belongs to (or a new heading), not at the end of the page: parallel PRs then do not edit the same lines.

### Team state and access

- The saved team (`state.json`) is versioned. Version 2 (#47) carries the identity schema — `members` records, a per-Bot `ownerId`, the owner's `designatedChiefId`. A legacy version-1 file is migrated on load with a one-time `state.json.v1` backup; an existing backup counts only when it is a readable file holding a parseable version-1 state, and anything else (or any malformed ownership) fails closed (read-only). An older binary refuses a newer version read-only. This is schema foundation only — team mode stays disabled, see [team](team.md). On top of it, member auth (#48) adds host module `src/host/member-auth.js`, installed after `store` in `MODULES` (`core/index.js`): `invitations` and `authSessions` maps live on state (no `STATE_VERSION` bump), the channel resolves the actor from the `x-flybot-member-session` header, and endpoints are `auth-invite` / `auth-redeem` / `auth-revoke` / `auth-whoami` / `auth-remove-member` / `auth-revoke-invite` with `body.actorId` ignored; `auth-invite` alone also opens for an anonymous caller on a host with no sessions yet (bootstrap first invite), `auth-revoke-invite` kills an unredeemed invitation (redeeming it afterwards fails with `revoked`), `removeMember` refuses a member that still owns a Bot (`has_bots`), and the auth mutations are serialized behind an in-process lock so concurrent `removeMember` calls cannot both pass the last-owner check. Sign-in surface only — still not team mode; details in [team](team.md). On top of it, owner-scoped access (#49) adds host module `src/host/authz.js`, installed after member-auth: when any `authSessions` exist, the channel `authorize()` default-denies cross-owner Bot/room/session access, blocks shared non-isolatable resources (secrets, connectors, folder picks, browser bridge, update-install, diagnostics, set-prefs, `add-agent` — the DSH Agent is one per deployment and carries no owner) with `bot/blocked-shared` when more than one member exists, stamps `create-bot` with `actor.memberId`, and filters `view()`/`live()` to the actor; with no sessions the single-human behavior is unchanged. Session targets resolve through the store's owner maps — a Bot id via `botOf`, current chats and group Sessions and earlier parts via `selfOf`/`groupOwners`/`pastOwners` (a shared room Session also resolves for its current participants, #50) — and unresolvable ids deny. `approval-answer` gates on the approval's own Bot or room (resolved by approval id), never on caller-supplied session fields. `flybot/*` plugin endpoints (src/host/hooks.js) reach any signed-in actor for reads; plugin writes follow the shared rule. `view()`/`live()` narrowing (`rt.ownedView`/`rt.ownedLive` in authz.js) keeps per-session entries (`questions`, `exchangeTurns`) the actor owns, and deployment-wide surfaces (agents, secrets, connectors, memory reviews) only while a single member exists — the same rule as the shared writes; rooms the actor belongs to and the Bots in them (#50) stay visible. `create-room` refuses a request with neither a member Bot nor any participant. On top of it, room membership (#50) adds host module `src/host/room-membership.js`, installed after groups: a room may carry typed `participants` (`human` / local `bot` / granted remote `bot` with `handle` + owner fields, roles `admin` / `member`, `joinedSeq` / `leftSeq`); log lines carry `authorId` + `authorKind`; history is the membership window (current members and the owner of an invited Bot see `seq >=` their interval; leave withdraws access; rejoin starts a new interval); local cross-owner rooms accept each side's *granted* Bots (#90: default deny, Chief included); a friend's Bot from `social/remote-bots` (`cleanRemote`) may be added and ungranted Bots stay private, and a room with a friend's Bot holds only granted local Bots (a Bot that joined by room code, `viaCode`, only for that room); `view()` labels remotes with an owner badge and shows an invited owner **Shared room from \<inviter\>**. Face-to-face rooms (#83) reuse the same `participants` / membership-window / owner-badge presentation with `origin: 'face-to-face'`: room-only remotes may sit in the room without a person-grant or a friendship, `presentRoom` treats the viewer as a member (not Shared room from), leave skips the two-Bot floor, and `fanoutRoomLine` goes to `rt.faceRoomFanout` instead of friend `flybotSend`. Still not team mode — see [team](team.md). Per-Bot grants (#90) add host module `src/host/reach.js`, installed after room-membership: `state.grants[botId]` is the list of independent grants (one Bot → one grantee, optionally room-scoped); default deny, Chief included; a Bot whose owner is not a member has none. Grants are set with `rt.setGrants`, exposed as `BotView.granted`, `flybot.bot.hasGrant` / `hasAnyGrant`, `flybot.grants` and the `bot.grants` event. `reach()` is the owner policy: a friend's Bot may reach only local Bots granted to that sender, only a granted Bot (or one code-joined in that room) may message a friend's Bot, another owner's Bot is reached only if both sides have matching grants or both are members of the room the message belongs to. It is not a middleware: hooks.js runs it before the `bot.send` chain, again on approval release, and on every deliver with a sender or remote origin (resumed, retried, deferred, re-sent), so no verdict or `bypass` can skip it and a queued message is judged by what is true when it is delivered. Revoking a grant, or replacing its Chief, removes it from rooms that have friends' Bots or several owners at once (`rt.evictUnshared`). Approval binding (#52) completes the held-send half of this: `state.flybot.approvals` records carry `requestId`, a sha256 `version` over the request content, server-derived `ownerId` and `origin` (`via`/`hop`/audience) — claims in the message (`meta`, text) never confer authority. `flybot/decide` is allowed through authz for any signed-in actor and the per-record check happens in hooks (`decide` requires the sender Bot's owner's session, `bot/forbidden` otherwise, `bot/unauthorized` without a session); `release()` revalidates before dispatch and marks the record `stale` when the request changed, the sender or target Bot is gone (also invalidated eagerly on `deleteBot`), or the Bot changed owners; a demoted Chief's sender-side holds are invalidated eagerly on `setMain` (not inside `staleReason`), and `release()` re-checks immediately before dispatch so an in-flight approve cannot go out after a concurrent invalidation. Unknown `invalidateFor` field values throw. `flybot/approvals` lists only the actor's own holds while enforcement is on; decided stale records keep their attribution in state but appear in no member's list.

- Context sharing (#53) is specified in [team](team.md), **Context sharing foundation**: the own-chat brief is share-gated (`share-brief` / `briefShared`), a memory review reads only its owner as the user (`isUserLine`) and labels another human as `peer` (not `bot`), and keeps cross-owner entries out of the team scope (`teamAllowedFrom`), `list_bots` lists only the caller's owner's Bots (a granted child: that child's `createdBy` subtree), Bots granted to the same owner, and Bots in the current room — another owner's folder and instructions stay private — and a `dsh-session:` chip in actor-authored `send` / `room-post` / `answer-question` / `schedule-create` text must resolve for the author (`sessionOwnedBy`; `schedule-create` authz keys off `body.target`). Bot-authored group posts and Bot-to-Bot / own-chat followups drop chips so they cannot tunnel a private chat into another Session. Host modules: `src/host/groups.js`, `src/host/memory.js`, `src/host/tools.js`, `src/host/channel.js`, `src/host/room-membership.js`, `src/host/authz.js`. Team mode stays disabled.

### Tasks

A tracked request with a stable id (`task-<hex>`) and a small state machine, owned by `src/host/tasks.js` with `state.tasks` (additive; corrupt values reset, no version bump). States: `open → claimed → working → blocked ⇄ working → result-ready → accepted`, with `cancelled`/`failed` terminal and `accepted` reachable only from `result-ready` — a failed or cancelled task can never display as accepted (#54). Transitions after create are the requester's (server-derived `requesterId`, the signed-in actor or the single owner; `bot/forbidden` otherwise, `bot/stale` on invalid moves), recorded with per-status actor entries. Create does not require owning the Bot: a matching per-Bot grant, or both the requester and the Bot as current members of the named room, is enough; outgoing holds stay the owner's (#52 card). A working task's held send blocks **that** task (`meta.taskId` stamped on the send, matching origin when the Bot has several working tasks) with the approval id; the owner's decide resumes (approve) or cancels (reject) it; deleting the responsible Bot fails its open tasks. `result-ready` is protected from prune while it waits for acceptance. Endpoints `tasks` / `task-create` / `task-accept` / `task-start` / `task-return` / `task-accept-result` / `task-cancel` are an explicit authz allow-list and are record-checked in tasks.js. Records store pointers and a copied summary, never private transcripts. Clarification and `workBotId` wait on #55's exchange wiring. Team mode stays disabled.

### Inbound shared rooms

- Bot Social conversations are 1:1; it does not list a FlyBot group. When a room gains a granted remote Bot (create-room, addParticipants, or 新建群聊 picking a friend's chat), the host fans out a `FLYBOT-ROOM-SHARE` envelope (`src/shared/room-share.js`) through `flybotSend` (`via: 'room-share'` for join/leave, `via: 'room'` for lines, `meta.roomId` set) so the Bot's owner's FlyBot can project it immediately — including a room with no chat lines yet. Receive is `rt.applyInboundRoomShare` (`origin: 'inbound-share'`, `recordInboundSharedRoom`), labelled **Shared room from \<inviter\>** with the room name stored. A leave envelope, hide, or grant revoke marks it left/hidden. `reach()` allows a local member to message a remote that already sits in that room when `roomId` is on the send. Still not team mode.

### Face-to-face owner send

- Channel `send` on a face-to-face room (`origin: 'face-to-face'`) always `postRoomMessage`s, then shows a quiet local notice (`postToRoom` `quiet`+`notice`). It does not call `sessionController.prompt` unless a local Bot is @mentioned. Unsigned-in cloud UI uses `implicitRoomOwner` (the local human) so the line still fans out over `onFaceLine` / `FLYBOT-FACE-HUMAN` and the other FlyBot instance shows it; that path must not open a bot round (#124). Covered by `core/test/remote-room.test.js` and `core/test/rounds.test.js`.

### Face-to-face participant look

- `syncFaceParticipants` / `faceRemoteRecord` keep optional `color` / `avatar` from the Bot Social member payload on the remote participant. The client seeds a distinct generated look from the handle when those fields are absent (see [core-client](core-client.md)). Face-room REST still does not require a person-grant.
- A member that left and joins again is the same participant record with `leftSeq` cleared and a new `joinedSeq` — not a second live row. `upsertFaceRoom` treats `startedAt` (or an explicit `open`) as an open room so the Friends' Bots card does not stay on the matching countdown after **Enter chat**.

### FlyBot display copy

- Host-facing copy the user reads says FlyBot: workspace title, store / read-only messages, diagnostics table row, secrets descriptions, tools settings hints, parts notes, and update errors as **FlyBot core**. `update.js` still reads `package.json` `name` / `repository` for the check and GitHub links.

### Diagnostics

- Host diagnostics never depend on `ctx.logger`: DSH may export no logger, and a test or plugin-local host may carry one without `warn`. `rt.warn` still writes stderr and the diagnostics log in that case (`src/host/diagnostics.js`). Plugins reach the same log through `flybot.warn` (#68); see [plugin-runtime](plugin-runtime.md).

### Untrusted fences in every shared room

- `authoredRoomLine` fences peer-controlled text by the line's origin, not the room kind (#98): a remote participant, a local remote-chat record (`state.bots[id].remote`), a botId that is no team Bot, or `line.remote`. A friend's Bot speaking in a non-face group is fenced the same way as in a face room. A complete wrap is left as-is so outbound fanout does not nest residue; a mention of the marker in the body still fences. `stripUntrusted` is one fixed-point pass over both `untrusted-message` and `untrusted-file`. Inbound-share lines from the other instance are `remote: true` so owner-typed text is fenced too. Face join/leave notices stay unfenced platform copy. Channel room previews use `unwrapUntrusted` so the sidebar never shows the wrap. A human line whose `who` is `User` is rewritten from the signed-in display name before it is stored or fenced.
- A late group model failure posts a short friendly line into the room (`This Bot could not answer right now.` / `This Bot has no model set up yet.`); `failureLine` stays on Bot-to-Bot deliver and in diagnostics, not in the human transcript.

### Remote chats and mentions

- Channel `view()` puts `pendingCount` on a friend's chat (`bot.remote`) from `rt.listChatApprovals`, the same gold wait badge rooms already use. Local team Bots stay at 0. The social plugin supplies the list via `flybot.chatApprovals.setProvider` ([plugin-runtime](plugin-runtime.md)). Still not team mode.
- `remoteTurn` (`src/host/remote-chat.js`) finds what the user typed on a friend's remote chat by skipping host-appended `role:'user'` context: forms `snapshot`, `instructions` (the AGENTS.md baseline on a chat's first turn) and `notice`, and the time-context kinds. Match by form, not by a whitelist of senders, or the first message of a new chat is dropped (#66).
- Remote-chat `open` copies optional published `color` / `avatar` / `avatarUpdatedAt` onto the chat record (cached by `avatarUpdatedAt`) so headers, the picker, and group lists match Friends' Bots. A missing look stays handle-seeded (#137).
- `0002-flybot-api-host` `cleanRemote` sanitizes those peer-controlled `name` / `homeName` / `owner` labels (strip `@` and controls/newlines, 60-char cap) before they are stored. Details in [plugin-runtime](plugin-runtime.md) (#75).
- A friend's Bot @-mentioned in a group never has its reply delivered back into that group (it lands in the friend's Bot's own chat), so the host posts one receipt line into the room per mention (`src/host/hooks.js` `mentionReceipt`, source role `mention`) and the client renders it as a muted event line (`src/client/cells.js`) (#80, #81). The role stays outside the room's round trigger (`groups.js` `opens`) and outside `RELAY_ROLES`, so the receipt opens no round and folds no turns. When that friend's Bot is already a current participant of the room, `sendUserMentions` skips the 1:1 `bot.send` entirely (#143): the human line in the room is the delivery, and Chief's grant is not consulted. A failed 1:1 remote-chat send (`remote-chat.js` `forward` / `notSentLine`) is one short English line with a next step, never a raw `Bot Social send_as_member: …` preview.

## Tests

`npm test` in `core/`; smoke test for `index.js` / `src/host/` changes.
