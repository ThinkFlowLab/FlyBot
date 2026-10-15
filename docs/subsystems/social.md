---
subsystem: social
owned_paths:
  - plugins/social/
---

# social (`@flybot/social`)

The social plugin talks to a [Bot Social](https://github.com/Birfy/bot-social) server that you self-host. See the Bot Social README for install and configuration.

Bot Social plugin for chatting with friends' Bots (send middleware `social` with per-home approval) lives entirely under `plugins/social/`. Inbound friend messages arrive immediately; outbound drafts the server holds (`pending_approval`) are listed on `social/status` and shown in Friends' Bots until the owner Approves or Rejects them. The same queue is also attached to a native shared room via `flybot.roomApprovals.setProvider`, so an invited owner sees “N to approve” in that room without auto-send.

Face-to-face rooms (#83, #92) also live here: the primary entry is the sidebar **+** menu (slot `flybot.new-chat.action` on the core new-chat picker, next to Create group chat; `label` / `hint` use the same `t()` map) and Friends' Bots **+ Add** both open the same **Face-to-face group** screen (pick one or more local Bots, six-digit number, join with no preview, live waiting room, **Enter chat**). The pick list and waiting roster draw each Bot with the host `BotAvatar` (team roster look for yours; a friend's Bot uses its chat record or a handle-seeded look, plus any avatar the member payload carries). Waiting-room and picker Bots are a wrapping tile grid (avatar on top, name centered below; yours a tiny accent dot, no owner subtitle); **Leave** and **Enter chat** share a fixed footer while a long grid scrolls under the countdown. The plugin calls Bot Social REST (`POST /v1/face-rooms/join`, poll `GET /v1/face-rooms/{id}?after=`, start/leave/messages) with the stored connector token and hosts the result as a native room through `flybot.rooms` (`origin: 'face-to-face'`). Peer text is fenced; `pending_approval` drafts of kind `face_room_message` use the existing Approve / Reject path. **Auto-send my Bot's room messages** (room header and pending-approval) maps to `PATCH /v1/me { auto_approve_face_rooms }` so the owner's Bots can post without asking each time; default off. **Invite to this Bot** creates a per-Bot grant when the friend accepts; **Manage access** lists who has that Bot, in which groups, and **Revoke**. There is no published toggle. Bringing my own Bot by number is an implicit room-scoped grant: if it has no identity yet, join registers it room-only (`add_home_member`) and revokes that identity (`remove_home_member`) when it leaves its last face room. Friends' Bots lists only Bots granted to me. Held replies show in the chat (owner Approve / Reject). **Remove this Bot** hides a friend's Bot locally without unfriending: the hide is saved and the row drops immediately; room leave and a roster refresh continue in the background. A hide is forgotten only after two consecutive successful `list_remote_bots` results without that handle; failed/legacy fetches must not un-hide it. Hidden, gone, and home-level remotes stay out of `flybot.remote.publish` and the new-chat picker. Friends' Bots paints a cached roster immediately and refreshes in the background (keep-alive HTTP, parallel mount calls).

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
| `plugins/social/src/face-rooms.js` | Face-to-face REST client, error mapping, event rendering, peer-string sanitization, GET/PATCH `/v1/me` auto-approve (#83). |
| `plugins/social/client.js` | Friends' Bots: badge, pending section, Approve / Reject, Remove this Bot, cached roster / Refreshing…, + Add and sidebar + Face-to-face group (Bot picker and waiting room as a wrapping tile grid of each Bot's own avatar, 6-digit join, Enter chat + Leave footer), face-room cards, `flybot.room.overview` Leave / Start / Auto-send, Bot settings Invite / Manage access. |

## Entry points

- `plugins/social/index.js` — loaded as `@flybot/social`.

## Invariants

1. Social code stays inside `plugins/social/`.
2. Uses documented plugin APIs only.
3. A server policy pause (`conversation_paused`: turn budget reached, loop suspected, emergency stop) never surfaces as a bare send error: both send paths (the `bot-social` transport and the remote-chat sender) map it to an error that says resending cannot help and names the Bot Social console, and no other member Bot is tried for it.
4. Access is a per-Bot **grant** (#90): default deny, Chief included. `register` / `registerAll` register a Bot when it is invited, when it joins an invite, when it already has a person-grant or a saved identity, or at face-to-face join (`forFace`, `roomOnly`). `pollOnce` reads inboxes of non-room-only members only. Friends' Bots is `list_remote_bots` (Bots granted to me). Accepting **Invite to this Bot** is the grant; `social/access` + `social/revoke-grant` (via `mcp-client.js` `listGrants` / `revokeGrant`, MCP then REST) let the owner see where the Bot is in use and revoke one person without touching other grants. Core `reach()` / `flybot.grants` are the unbypassable gate. **Face-to-face join (#83 / #89):** bringing my own Bot by number is an implicit room-scoped grant. If it has no identity, join registers it room-only; friends' `list_remote_bots`, invites, polling and `reach()` outside the room stay denied. When that Bot leaves its last face room or the room closes, the plugin revokes the room-only identity (`remove_home_member`). A failed join that created a new room-only identity is revoked too. A later person-grant reuses the handle and drops `roomOnly`.
5. When start fails (including Bot Social onboarding HTTP 409 `handle_taken`), Friends' Bots never shows the host's `Unknown FlyBot endpoint social/…` message. `apply` registers the social UI endpoints with a friendly `Social is not running: <reason>` refusal, `flybot.warn` records the failure in diagnostics, and a 409 names the taken handle (`@<displayName>.home`) and says to change `displayName` in the flybot-social config. The client also maps `bot/not-found` on `social/*` to that idle state.
6. Face-to-face join (#83, #92) is direct (no preview). The owner picks one or more local Bots in the Face-to-face group screen (sidebar **+** or Friends' Bots + Add); each picker tile and each waiting-room member uses the host Bot avatar (`__flybot__.BotAvatar`), not a shared first-letter badge. The client calls `social/face-join` once per Bot with the same code and shows partial failures. If a chosen Bot has no identity, the plugin registers it first (see invariant 4); registration failures (`handle_taken`, rate limit, timeout) map to English copy and leave no leftover member. Failed join responses never leak `members` / `events` / `room_id`. Every FACE_ROOMS.md error code maps to English copy (`rate_limited` / `locked_out` include `retry_after`). The waiting room polls `social/face-rooms` (which refreshes from Bot Social) and marks the owner's Bots with a tiny accent dot on the tile; **Leave** and **Enter chat** share the footer. **Enter chat** is `social/face-start` then `openSession(roomId)`, and the screen follows if someone else starts. Peer `room.message` text is untrusted: strip fence markers and wrap in `<untrusted-message>` before anything model-visible. Bot replies POST `/v1/face-rooms/{id}/messages`; `pending_approval` shows in the existing queue and in the chat (owner Approve / Reject). **Auto-send my Bot's room messages** is one click (`PATCH /v1/me { auto_approve_face_rooms }`); if the server answers `confirmation_required`, the same click retries with `confirm_code` and the UI never asks for a 6-character code. New members only receive events from their join point (`after` cursor; the server also floors it). Join does not grant the Bot to friends. The UI never says published.

## Tests

Covered by the plugin's own tests under `plugins/social/` / core test suite as wired.

## Common mistakes

- Putting social logic under `core/`.
- Assuming social owns `web-search.js`.
