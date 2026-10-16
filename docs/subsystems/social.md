---
subsystem: social
owned_paths:
  - plugins/social/
---

# social (`@flybot/social`)

The social plugin talks to a [Bot Social](https://github.com/Birfy/bot-social) server that you self-host. See the Bot Social README for install and configuration.

Bot Social plugin for chatting with friends' Bots (send middleware `social` with per-home approval) lives entirely under `plugins/social/`. Inbound friend messages arrive immediately; outbound drafts the server holds (`pending_approval`) are listed on `social/status` and approved in the open chat (`flybot.session.dock`). Friends' Bots shows a badge and a one-line jump list. The same queue is also attached to a native shared room via `flybot.roomApprovals.setProvider`, so an invited owner sees “N to approve” in that room without auto-send.

Face-to-face rooms (#83, #92) also live here: the primary entry is the sidebar **+** menu (slot `flybot.new-chat.action` on the core new-chat picker, next to Create group chat; `label` / `hint` use the same `t()` map). **Face-to-face group**, **Add friend**, **Accept invite**, and **Copy invite link** are those rows; Friends' Bots has no **+ Add** button. **Face-to-face group** opens the same screen (pick one or more local Bots, six-digit number, join with no preview, live waiting room, **Enter chat**). The pick list and waiting roster draw each Bot with the host `BotAvatar` (team roster look for yours; a friend's Bot uses its chat record or a handle-seeded look, plus any avatar the member payload carries). Waiting-room and picker Bots are a wrapping tile grid (avatar on top, name centered below; yours a tiny accent dot; waiting tiles use the server owner label, e.g. `Chief · BoxB`); **Leave** and **Enter chat** share a fixed footer while a long grid scrolls under the countdown. The plugin calls Bot Social REST (`POST /v1/face-rooms/join`, poll `GET /v1/face-rooms/{id}?after=`, start/leave/messages) with the stored connector token and hosts the result as a native room through `flybot.rooms` (`origin: 'face-to-face'`). Those face-room routes accept a connector token; owner settings do not (`GET`/`PATCH /v1/me` returns 403 `connector_token_rest_forbidden`). Peer text is fenced; `pending_approval` drafts of kind `face_room_message` use the in-chat Approve / Reject path. **Auto-send** is one compact checkbox (tooltip) on the Face-to-face rooms header, via MCP `whoami` (read) and `set_auto_approve { auto_approve_face_rooms }` (write; the owner's click requests and uses `confirm_code` in the same step); default off. A friend's Bot in the room card, waiting grid, Friends' Bots rows, and core group overview uses the host `BotAvatar` (chat record, optional member `avatar`, else a handle-seeded look). **Invite to this Bot** creates a per-Bot grant when the friend accepts; **Manage access** lists who has that Bot, in which groups, and **Revoke**. There is no published toggle. Bringing my own Bot by number is an implicit room-scoped grant: if it has no identity yet, join registers it room-only (`add_home_member`) and revokes that identity (`remove_home_member`) when it leaves its last face room. Friends' Bots lists only Bots granted to me. Held replies show in the chat (owner Approve / Reject). **Remove this Bot** hides a friend's Bot locally without unfriending: the hide is saved and the row drops immediately; room leave and a roster refresh continue in the background. A hide is forgotten only after two consecutive successful `list_remote_bots` results without that handle; failed/legacy fetches must not un-hide it. Hidden, gone, and home-level remotes stay out of `flybot.remote.publish` and the new-chat picker. Friends' Bots paints a cached roster immediately and refreshes in the background (keep-alive HTTP, parallel mount calls).

## Owns

Everything in `plugins/social/` (entry `plugins/social/index.js` and any helpers).

## Does not own

- Plugin runtime hooks/slots → [plugin-runtime](plugin-runtime.md).
- Core server/client → [ds-bot-core](ds-bot-core.md).
- Standalone `core/web-search.js` (not part of social).

## Key files

| File | Role |
| --- | --- |
| `plugins/social/index.js` | Plugin entry. |
| `plugins/social/src/social.js` | Host: roster, grants, inbox, `social/status` pending-approval queue, Approve / Reject, hide-remote, Manage access, shared-room approvals provider, face-to-face join/poll/leave/start/send and `social/face-auto`. |
| `plugins/social/src/mcp-client.js` | Owner MCP client plus isolated grant/invite REST fallbacks (`listGrants`, `revokeGrant`, invites). |
| `plugins/social/src/face-rooms.js` | Face-to-face REST client (join/list/get/start/leave/messages), error mapping, event rendering, peer-string sanitization. Auto-send is MCP in `social.js`. |
| `plugins/social/client.js` | Friends' Bots: badge, Remove this Bot, cached roster / Refreshing…, header without + Add; sidebar + Face-to-face group / Add friend / Accept invite / Copy invite link (tile grid, 6-digit join, Enter chat + Leave footer), one-line face-room rows + Past rooms, in-chat Approve / Reject dock, waiting `flybot.room.overview` tile grid then Leave / Auto-send, Bot settings Invite / Manage access, Add friend mint-and-copy. |

## Entry points

- `plugins/social/index.js` — loaded as `@flybot/social`.

## Invariants

1. Social code stays inside `plugins/social/`.
2. Uses documented plugin APIs only.
3. A server policy pause (`conversation_paused`: turn budget reached, loop suspected, emergency stop) never surfaces as a bare send error: both send paths (the `bot-social` transport and the remote-chat sender) map it to an error that says resending cannot help and names the Bot Social console, and no other member Bot is tried for it.
4. Access is a per-Bot **grant** (#90, #138): default deny, Chief included. `register` / `registerAll` register a Bot when it is invited, when it joins an invite, when it already has a person-grant or a saved identity, or at face-to-face join (`forFace`, `roomOnly`). `pollOnce` reads inboxes of non-room-only members only. Friends' Bots is `list_remote_bots` (Bots granted **to me**), minus reverse-friends of invites I created and minus face-room-only remotes. Accepting **Invite to this Bot** is the grant the other way; joining does not grant my talk-through Bot back. Join always offers **Talk through** (default Chief). `social/access` + `social/revoke-grant` (via `mcp-client.js` `listGrants` / `revokeGrant`, preferring `list_bot_grants` / `revoke_bot_grant`) list people as `Name (@home)` and revoke one person. Core `reach()` / `flybot.grants` are the unbypassable gate. **Face-to-face join (#83 / #89):** bringing my own Bot by number is an implicit room-scoped grant. If it has no identity, join registers it room-only; friends' `list_remote_bots`, invites, polling and `reach()` outside the room stay denied. When that Bot leaves its last face room or the room closes, the plugin revokes the room-only identity (`remove_home_member`) and drops room-scoped remotes from Friends' Bots. A failed join that created a new room-only identity is revoked too. A later person-grant reuses the handle and drops `roomOnly`.
5. First start retries a taken home handle (`FlyBot`, `FlyBot2`, …) instead of failing for a YAML edit (#136). If every retry is still taken, Friends' Bots never shows the host's `Unknown FlyBot endpoint social/…` message: `apply` registers the social UI endpoints with a friendly `Social is not running: <reason>` refusal and `flybot.warn` records the failure. The client also maps `bot/not-found` on `social/*` to that idle state. Friends' Bots shows the connected home handle with Copy.
6. Face-to-face join (#83, #92) is direct (no preview). The owner picks one or more local Bots in the Face-to-face group screen (sidebar **+**); each picker tile and each waiting-room member uses the host Bot avatar (`__flybot__.BotAvatar`), not a shared first-letter badge. The client calls `social/face-join` once per Bot with the same code and shows partial failures. If a chosen Bot has no identity, the plugin registers it first (see invariant 4); registration failures (`handle_taken`, rate limit, timeout) map to English copy and leave no leftover member. Failed join responses never leak `members` / `events` / `room_id`. Every FACE_ROOMS.md error code maps to English copy (`rate_limited` / `locked_out` include `retry_after`). The waiting room polls `social/face-rooms` (which refreshes from Bot Social) and marks the owner's Bots with a tiny accent dot on the tile; **Leave** and **Enter chat** share the footer. **Enter chat** is `social/face-start` then `openSession(roomId)`, and the screen follows if someone else starts. Peer `room.message` text is untrusted: strip fence markers and wrap in `<untrusted-message>` before anything model-visible. Bot replies POST `/v1/face-rooms/{id}/messages`; `pending_approval` shows in the existing queue and in the chat (owner Approve / Reject). **Auto-send my Bot's room messages** is one click (`whoami` / MCP `set_auto_approve { auto_approve_face_rooms }`); if the server answers `confirmation_required`, the same click retries with `confirm_code` and the UI never asks for a 6-character code. REST `/v1/me` is not used with the connector token. A friend's Bot in the room member list and waiting grid uses the host Bot avatar (handle-seeded when Bot Social sends no image). New members only receive events from their join point (`after` cursor; the server also floors it). Join does not grant the Bot to friends. The UI never says published.

### Inline approvals and compact Friends' Bots (#114, #115)

- Held Bot Social drafts (`social/status`, `social/decide-approval`) and matching local `flybot/approvals` holds show as an inline card in the open chat (`flybot.session.dock`): draft text, **Approve** / **Reject** for the owner, **Approve all** when several, and **Waiting for the owner's approval** with no buttons for anyone else. The owner does not get a waiting bubble in their 1:1; composer holds are labelled **You**. New friends start with **Auto-send** off. The owner's click is consent (`confirm_code` in the same `decide_approval` call). After a decision the card reads Approved or Rejected. The Friends' Bots "N to approve" block is a one-line jump list (chat name + truncated text, no explainer, no wrapping one word per line). Auto-send of face-room posts is a single compact checkbox (tooltip only) on the Face-to-face rooms header and the open room's overview — not on each pending row or room card.
- Each Face-to-face room in Friends' Bots is one compact row: name, a small member-avatar stack (`+N`), a muted open/closed/left/`10m` chip, click-to-open and **Leave** (no **Start** on the card). Closed, left, and ended matching rooms sit under **Past rooms** with **Open** only. With no live room the Face-to-face header and Auto-send are omitted. The list does not say "The number is no longer valid." 1:1 friend chats get the same wait badge as rooms (`flybot.chatApprovals.setProvider` → `bot.pendingCount`). The Friends' Bots header is title plus either the Bot count or the **N to approve** chip (not both) — no **+ Add** and no stacked approval list. **Add friend**, **Accept invite**, **Copy invite link**, and **Face-to-face group** are `flybot.new-chat.action` rows on the sidebar **+**. Add friend / Accept invite expand Friends' Bots and show mint-and-copy plus join / Accept / Decline.

### Face-to-face waiting grid, leave, and social + (#124, #125, #126)

- Waiting UI (join dialog and `flybot.room.overview` while `candidate`) is a WeChat-like tile grid: avatar above the Bot name, owner on a second line (`data-flybot=face-owner`). **Leave** and **Enter chat** share one footer row. Join copy uses owner + Bot name (`Chief · BoxA` / `BoxA's Chief`), never `BoxA's BoxA` or generic `BoxA's Bot`. Ended joining says **Joining has ended**, not “matching window”. The group subtitle is live participant count (no “0 members · No admin”).
- **Leave** after the number is void (`bot_not_found` / room already gone) still drops the room off the active list onto **Past rooms**. Past rows are unique by `faceRoomId` and have one primary action (**Open**); live rows are click-to-open with **Leave** only (no Open/Start/Leave triple in the narrow Friends' Bots column).
- Sidebar **+** is a short action menu, not the To:/composer. Add friend has one-click **Copy invite link** (mint + clipboard). Friends' Bots keeps the **N to approve** badge and opens that chat; the stacked jump list stays out of the column. Held `face_room_message` drafts show in that face chat with readable names (`Chief → the room`), never raw `bot_01…`.

### Face-room poll identity (#122)

- `list` / `poll` must not persist or send `as=@`. An empty, missing, or literal `@` handle stays empty; GET omits `as` unless it is a real Bot handle. Rooms first seen from `list` seed `asBot` from `my_bots[].handle` (or a local member already in the snapshot). A stored bogus `@` is healed, and `face_room_not_found` for a still-listed room repairs local meta (clear `as`, retry with `my_bots` or no `as`) instead of warning on every poll.

### Approval waiting notice (#123)

- Syncing a held outbound draft into chat must not call `remote.chats.deliver` with a home-level handle (`@box.home`) or with no session. Resolve a listed friend Bot under that home, `chats.open` that 1:1 if needed, then deliver so the waiting line lands. If no Bot/session can be opened, skip with a clear log; never throw into the poll loop.

### Onboarding, grants, hide, and approval (#136–#140)

- **#136:** A taken `displayName` at onboard retries `Name2` … rather than refusing to start. Friends' Bots shows `@your.home` with Copy.
- **#137 (deferred):** The owner's chosen Bot avatar/color does not cross homes. Live Bot Social `update_bot_profile` only has `display_name` / `bot_id`; face-room join POST is `{ code, bots: [handle] }`. Peers keep the handle-seeded look until the server grows profile look fields.
- **#138:** Accepting a Helper invite grants Helper only. The joiner picks a talk-through Bot (not shared). Success copy is `{person} shared {Bot} with you.` Manage access lists `SelfB1935 (@selfb1935.home)`. Core grants store a canonical `@handle` (never decorated `Chief@…`). On upgrade, remotes already on `list_remote_bots` are seeded into `inboundBots` once so reciprocal friends are not dropped. Face-room remotes leave Friends' Bots when the room is left; existing friend handles are not reclassified as room-only.
- **#139:** **Remove this Bot** asks once (`Remove Helper? Bob can share it again.`). Hide stays local (A's Manage access still shows the grant until A revokes — an incoming un-grant needs Bot Social). Re-joining an existing friendship unhides only that invite's Bot/peer home (not every hidden remote); used invites say “This invite was already used.”
- **#140:** Auto-send defaults off. Accepting a friend request uses that relationship's peer home for Auto-send, not the first roster entry. The owner sees Approve / Reject in the chat, not “Waiting for the owner's approval.” Composer drafts are labelled You.
- **#136 (suffix):** Onboard retries truncate the sanitized handle body so `Name2` / `Name3` still change within the 32-character `homeHandleOf` limit.

### Past rooms, unique titles, poll, and + (#129–#133)

- Expired matching (`candidate` whose `expiresAt` has passed) and a peer leaving the last remote seat move the hosted room to **Past rooms** on the next poll (`rememberPastFace`, status `closed` / `left`). The local room stays so **Open** still works; **Leave** is not shown on those cards. Face-room names include the other owners, else the 6-digit code, else a clock time — not a pile of identical "Face-to-face room".
- Inbox and face poll share one timer: `facePollMs` (default 4s) while any live face room exists, else `inboxPollMs` (default 15s). The open face overview keeps polling about every 3s after **Enter chat**, not only while matching. Friends' Bots still refreshes rooms about every 5s while that section is open.
- Sidebar **+** holds Face-to-face group, Add friend, Accept invite, and one-click Copy invite link. Friend requests is not a duplicate + row. Per-friend and face-room hold toggles both say **Auto-send** ("Don't ask each time."). Hold labels resolve the real Bot name (`Chief → the room`), never `bot_01…`.

### Face-to-face two-instance rooms (#117)

- Friends' Bots polls `social/face-rooms` with `poll: true` about every 5s while the section is open, so an opened room, a new member, and the compact rooms card appear without a reload. While matching, the status chip is a short `10m` / `joining` label so the name and **Start** fit; after **Enter chat** / start the hosted `room.face.status` is `open`. After **Leave**, only **Past rooms** remains — no empty "Face-to-face rooms" header or Auto-send. Waiting tiles use the server `label` (`Chief · BoxB`). A snapshot member that is new on this side still gets a join line when the join event is before the floored `after` cursor. Owner-typed lines in the open room fan out over `onFaceLine`: Bot Social face messages are bot-authored, so FlyBot sends a `FLYBOT-FACE-HUMAN` envelope as the owner's local room Bot (the owner's click/type is consent; a `pending_approval` is decided in that same step) and the other instance applies it as `authorKind: 'human'`. Incoming peer/human bodies are stored fenced in the room log (#98). Join still does not grant the Bot to friends; Friends' Bots also refreshes `social/remote-bots` on its open timer.

### Inbound shared groups

- Bot Social has no FlyBot-group record (`list_conversations` is 1:1; inbox is `message.received` after a send). The plugin therefore carries a `FLYBOT-ROOM-SHARE` envelope on `send_as_member` text. `pollOnce` calls `flybot.rooms.applyInbound` before 1:1 chat delivery, so the Bot's owner sees the group as soon as they are added. `via: 'room'` / `via: 'room-share'` skip the social outbound hold (the add-to-group click is consent); the invited owner's Bot replies still go through `pending_approval`. A roster fetch that no longer lists a remote, or `social/revoke-grant`, leaves those rooms / hides inbound projections.

## Tests

Covered by the plugin's own tests under `plugins/social/` / core test suite as wired.

## Common mistakes

- Putting social logic under `core/`.
- Assuming social owns `web-search.js`.
