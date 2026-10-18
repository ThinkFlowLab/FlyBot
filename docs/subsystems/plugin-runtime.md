---
subsystem: plugin-runtime
owned_paths:
  - core/src/host/hooks.js
  - core/src/host/flybot-feed.js
  - core/src/client/flybot-slots.js
  - core/src/client/flybot-registry.js
  - core/types/flybot.d.ts
  - core/test/flybot.test.js
  - core/test/flybot-feed.test.js
  - core/test/flybot-client.test.js
---

# plugin-runtime

FlyBot's plugin API surface on top of the patched core: host hooks, client slots/registry, and types.

## Owns

- `core/src/host/hooks.js` — host-side plugin hooks.
- `core/src/host/flybot-feed.js` — the team activity feed (`turn.*`, `tool.*`, `exchange.delivered`) folded from `session/event` (#241).
- `core/src/client/flybot-slots.js` — client slot registry.
- `core/src/client/flybot-registry.js` — plugin discovery/registration.
- `core/types/flybot.d.ts` — public types.
- Flybot unit tests (`flybot.test.js`, `flybot-client.test.js`, `flybot-feed.test.js`); `flybot-client.test.js` also pins the sidebar footer button (Connect apps opens Connectors) and the account menu's Plugins row.

## Does not own

- Generic host/client code under `core/src/` (→ [ds-bot-core](ds-bot-core.md)).
- Concrete plugins `plugins/tree/`, `plugins/social/`.

## Key files

| File | Role |
| --- | --- |
| `core/src/host/hooks.js` | Host hook points: send middleware, transports, grants, the owner-bound held-send approvals (#52), and task hold/decide/delete seams (#54). |
| `core/src/host/flybot-feed.js` | Activity feed: folds a Bot Session's `session/event`s into `flybot.on('turn.start' \| 'turn.end' \| 'tool.start' \| 'tool.end' \| 'exchange.delivered')` (#241). |
| `core/src/client/flybot-slots.js` | Client slots, including the approval card queue (`flybot.approvals`, `flybot/decide`). |
| `core/src/client/flybot-registry.js` | Registry. |
| `core/types/flybot.d.ts` | Types. |

## Entry points

- Host: `hooks.js` loaded by the core host.
- Client: slots/registry wired into the built client.

## Invariants

1. Hooks are the only sanctioned extension surface; never monkey-patch DSH.
2. Slots/registry must keep the client build green (`npm run build`).
3. Types in `flybot.d.ts` stay in sync with hooks/slots.
4. Plugins report a host-visible failure with `flybot.warn` (Settings → Feedback / `diagnostics.jsonl`). They must not depend on `ctx.logger`: DSH may export none, and `flybot.warn` delegates to `rt.warn`.
   A tool whose `visibleTo` says no is taken out of that Bot's list with `agent.ctx.tools.restrict({ deny })` (`hidePluginTools`). DSH's `tools.schemas(agent)` lists only what the Agent sees, so the tools the current mask hides count as known when the mask is recomputed; otherwise every other resolve lifts the mask and the chat shows `Tool added` / `Tool removed` on each turn (#276).
5. Reach (#90): the core's owner policy (`reach.js`) is not a middleware. `hooks.js` runs it before the `bot.send` chain, on approval release and on every deliver that carries a sender or a remote origin; a plugin's `allow` or `bypass` never skips it, and plugins see its denial as `{ action: 'deny', by: 'owner-policy' }`. Plugins read grants through `flybot.bot.hasGrant` / `hasAnyGrant`, `BotView.granted`, `flybot.grants` and the `bot.grants` event. A group's mention receipt (`mentionReceipt`) turns a not-shared refusal (`cannot message their Bots`, #273) into its short invite-or-add hint.
6. `flybot.roomApprovals.setProvider` lets a plugin (social) attach pending outbound holds to a shared-room view. It does not enable team mode.
7. `cleanRemote` is the record boundary for a friend's granted Bot: `name`, `homeName` and `owner` strip `@` (so they cannot look like a mention of another Bot in `nameMentions` chips/previews) and control characters/newlines, then cap at 60 characters. Handles stay on the `handle` field. Optional look fields (`color`, `avatar` object, `avatarUpdatedAt`) pass through when present so remote chats, group lists, and headers can render a peer's chosen look; missing look stays handle-seeded. Those labels then flow into delivery `fromName` (still `cleanName`'d and the body fenced) and into `list_bots` friends lines via the remote-chat roster. Group room logs use local team names, not peer labels.
8. A user's @ of a friend's Bot in a group gets a receipt line in that group (`hooks.js` `mentionReceipt`, relay role `mention`): where the reply lands, or why the send was denied, held, or failed. The receipt's role stays outside the room round trigger (`groups.js` `opens`), so it never opens a round; peer names go through `cleanName`. A human line that names a friend's Bot already in that room is **not** 1:1-relayed as the group's admin (Chief): the room message is the delivery, so Chief's missing grant does not block it (#143). A Chief-originated `bot.send` to an ungranted friend Bot is still deny. A remaining grant deny on a mention that is *not* in the room says to invite the Bot or add it to the group.
9. `flybot.rooms` hosts a Bot Social face-to-face matching room as a native room (`upsertFace` / `applyFaceLine` / `ofFace` / `dropFace` / `onFaceLine` (`fn(room, line, { mentions })`: for the owner's typed line, the handles its `@` names, #293) / `postNotice` / `postHuman` (quiet; it reads the friend's line for `@` of a local Bot by label or handle and passes `callIds`, so only those Bots answer, #287; an optional `mentions` handle list from an attested line is resolved first, #293; `attested: true`, passed only for a line the server stamps `typed_by_owner`, lets a plain or `@all` line start this home's Bots in one capped pass, #295; a plain line is answered by the Bots that judge it theirs, `@all` is not routed, #299) / `postRemote`; `postHuman` draws another member's typed line as a chat bubble from that person, #180). Slot `flybot.room.overview` is a block at the top of a group's overview: while joining, a tile grid (avatar above name + owner) with **Leave** and **Enter chat** on one row; once open, compact **Leave** and Auto-send — not Open/Start/Leave together. Slot `flybot.new-chat.action` adds a row to the sidebar **+** short action menu (next to Create group chat; `label` / `hint` go through the same `t()` map). Still not team mode.
10. Held sends are owner-bound (#52): a hold stamps server-derived provenance on the record — `requestId`, a sha256 `version` over the request content, `origin` (`via`/`hop`/audience) and the sender Bot's `ownerId`; message claims (`meta`, text) never confer authority. `flybot/decide` passes authz for any signed-in actor and hooks binds the decision to the sender Bot's owner's session; `release` revalidates and marks records `stale` (changed request, deleted sender/target Bot, changed owner — `deleteBot` invalidates eagerly; a demoted Chief's sender-side holds are invalidated eagerly on `setMain`, not inside `staleReason`). `release()` re-checks immediately before dispatch so an in-flight approve cannot go out after a concurrent invalidation. Unknown `invalidateFor` field values throw. The pending list is filtered per actor under member enforcement. The default approval card shows `senderName`/`targetName` and a delegated marker (`Approval.origin`).
11. Task lifecycle (#54): `bot.send` stamps `meta.taskId` from the working task (`rt.taskIdForSend`); a held send then calls `rt.taskHeld` (blocks **that** task). The owner's `flybot/decide` calls `rt.taskDecided` (approve resumes, reject cancels); `deleteBot` of a local Bot calls `rt.taskBotDeleted` (open tasks fail). Incoming holds stay the owner's. The state machine lives in `tasks.js`; hooks only fire those three seams. Clarification and `workBotId` wait on #55.
12. Activity feed (#241): plugins that want to see where team time goes subscribe through `flybot.on(...)` and never to raw DSH `session/event` (the maintainer decision on #241). Events: `turn.start` / `turn.end` (a Bot's own chat `place: 'chat'`, its hidden group Session `'group'`, the group's own Session `'room'`, whose turn is one round, or a friend's Bot chat `'remote'` (#248: its Session runs no model and only carries lines to and from the friend, so those turns are transport, not a team Bot's work; `remote: {handle, name}` names the friend as the sidebar does (`Helper · Bob's Bot`, `Bob's Chief`; a `{kind: 'remote'}` party carries the same `name` when the roster knows it), and the friend's line into the chat is an `exchange.delivered` with `role: 'remote'`)), `tool.start` / `tool.end` (paired by `callId`, closed `interrupted` when their turn ends first) and `exchange.delivered` (a message arrived in a Session's log: `exchangeId` as in `state.exchanges`, `replyTo` of the answer, `from` a user / Bot / group / friend's Bot). The feed is metadata only: message text, tool arguments, tool output and model output never leave `flybot-feed.js`, so a consumer that stores it cannot persist a secret. Strings from outside the team (tool names, remote handles) go through `cleanLabel` (which also removes `untrusted` fence markers when spaced out or split), error outcomes carry an upper-case code (`RATE_LIMIT`, else `UNKNOWN`) and no message. Delivered means "in the recipient's log", not read; the feed cannot see read. Host nudges (retry, resume, kickoff, deferred and re-sent deliveries) are not deliveries. Not replayed: a listener hears events after it subscribes. Listeners get copies and a throwing one cannot reach the Session or the other listeners. Events fire in a read-only host too, since they only observe.

### Chat-row pending badge

- `flybot.chatApprovals.setProvider` attaches pending Bot Social holds to a 1:1 friend's-Bot chat the same way `roomApprovals` does for groups. The team view puts `pendingCount` on that bot; the sidebar paints the gold wait dot. `flybot.chatApprovals.changed()` tells the host the list changed (a hold arrived or was decided), so the badge refreshes at once instead of on the next unrelated revision (#226). Still not team mode.

### Sidebar + friend actions

- `hooks.js` hands a transport `approved: true` (never read from the message) when the owner approved that send on a FlyBot card; social uses it to finish Bot Social's own hold with the same click (#258).
- A `flybot.session.dock` entry may set `policy` (the `by` of the approvals it draws; social registers `policy: 'social'`) and receives `claim(ids)`: call it with the approval ids the dock shows so the overlay draws no second card for them (#260). The host also marks the chat each mounted session dock belongs to as open (`chatOpened`), and the overlay draws no pointer for an approval of the open chat (#271). The pointer's chat is the approval's room, else the friend's chat it is addressed to, else its sender Bot (#278).
- Social registers a second `flybot.session.dock` entry, `social-room-end` (`FaceRoomStatus`, order 40): the plain ended-room line for a left/closed face room (#191).
- Social registers `flybot.settings.page` (`SocialServerSettings`, label **Bot Social**): the server address, its status and the switch form (#337). The host side is `social/server` (a read) and `social/server-check` / `social/server-set` (writes: blocked on a read-only host and, like every plugin write, while the team has more than one member).
- Social also registers `flybot.account.header` (`MyHandle`): my own Bot Social handle plus Copy at the top of the account menu (#181), hidden while not connected.
- Social registers two `flybot.new-chat.action` rows (Face-to-face group, Add friend). Each `run` closes the picker. Copying an invite and seeing your own handle happen inside the Add friend panel (#181). Still not team mode.
- A friend's Bot opens **Bot settings** through core `remote-bot-settings` (`openSettings('bots', id)`): a compact sheet (`data-flybot=remote-bot-sheet`) with `FlyBotDetails` from slot `flybot.bot.details`, not the local Bot editor. The sheet stacks above its scrim like the host settings overlay (#166).

### Inbound shared rooms on `flybot.rooms`

- `flybot.rooms.applyInbound` turns a Bot Social inbox envelope into the owner's inbound-share projection; `leaveInbound` hides those rooms when the invited Bot is removed or its grant is revoked. Face-to-face methods are unchanged. Still not team mode.

### Face-to-face owner lines

- `onFaceLine` receives every appended room line, including the owner's typed human lines. Channel `send` posts those through `postRoomMessage` (not `sessionController.prompt`) so they reach this hook immediately; the social plugin sends them through Bot Social as the owner's local room Bot with a `FLYBOT-FACE-HUMAN` envelope so every human in the room sees the text; incoming envelopes apply as `authorKind: 'human'` and the stored body is fenced (#98). A held owner line stays on the in-chat approval card (human text, never the raw envelope) unless face Auto-send is on. Bot replies stay bot-authored. The displayed sender is the Bot Social `from` snapshot (`trustedFaceWho`); the envelope `who` is ignored so a peer cannot impersonate another member. An event with no `from` falls back to the authenticated handle's home label, then Someone. Still not team mode.

### Host Bot look for classic-script plugins

- Classic-script plugins cannot import `src/client/mark.js`. The host client `registry()` therefore also sets `globalThis.__flybot__.BotAvatar`, `BotMark` and `lookOf` to the same components the sidebar / session list / chat header use (configured image / shape / color / emoji, else a stable look from the Bot id or a remote handle). Plugins typically render `BotAvatar` at 24px with `badge: false`; face-to-face tiles pass 48. A stored `color` / `avatar` on the record still wins; a remote Bot without one is seeded by `remoteSeed(handle)`. A face-room `members[]` look overlays the chat record (`lookBotForRemote`).

## Tests

`core/test/flybot.test.js`, `core/test/flybot-client.test.js` via `npm test`.

## Common mistakes

- Reaching into DSH internals instead of using hooks/slots.
- Changing slots without updating types or client tests.
- `flybot.remote.chats.deliver({ handle, text, name?, home?, human?, ownerName? })` (#227): `human: true` is the plugin's server-attested "the friend typed this line themselves" (Bot Social `typed_by_owner`, never derived from text) and `ownerName` the authenticated owner label; the host then draws that turn's reply as the person. Plugins that cannot attest leave both out and the line stays the Bot's.
- `flybot.bot.send({ from: { kind: 'remote', handle, home?, typedBy? }, ... })`: `typedBy` is the plugin's server-attested owner name for a line the friend typed (Bot Social `typed_by_owner`); `toRemote` (`src/host/hooks.js`) cleans it and the host stores it as the message source's `remote.typedBy` so the chat draws the person, not the Bot. Never derive it from text; plugins that cannot attest omit it.
- The approval card queue (`FlyBotApprovals`) runs all its hooks on every render, before its empty-queue early return: a hook after it makes React throw when the first hold arrives and no card ever draws (#254; `core/test/overlay-approvals.test.js`).
