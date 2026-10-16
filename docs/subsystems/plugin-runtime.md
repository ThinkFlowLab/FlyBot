---
subsystem: plugin-runtime
owned_paths:
  - core/src/host/hooks.js
  - core/src/client/flybot-slots.js
  - core/src/client/flybot-registry.js
  - core/types/flybot.d.ts
  - core/test/flybot.test.js
  - core/test/flybot-client.test.js
---

# plugin-runtime

FlyBot's plugin API surface on top of the patched core: host hooks, client slots/registry, and types.

## Owns

- `core/src/host/hooks.js` — host-side plugin hooks.
- `core/src/client/flybot-slots.js` — client slot registry.
- `core/src/client/flybot-registry.js` — plugin discovery/registration.
- `core/types/flybot.d.ts` — public types.
- Flybot unit tests (`flybot.test.js`, `flybot-client.test.js`).

## Does not own

- Generic host/client code under `core/src/` (→ [ds-bot-core](ds-bot-core.md)).
- Concrete plugins `plugins/tree/`, `plugins/social/`.

## Key files

| File | Role |
| --- | --- |
| `core/src/host/hooks.js` | Host hook points: send middleware, transports, grants, the owner-bound held-send approvals (#52), and task hold/decide/delete seams (#54). |
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
5. Reach (#90): the core's owner policy (`reach.js`) is not a middleware. `hooks.js` runs it before the `bot.send` chain, on approval release and on every deliver that carries a sender or a remote origin; a plugin's `allow` or `bypass` never skips it, and plugins see its denial as `{ action: 'deny', by: 'owner-policy' }`. Plugins read grants through `flybot.bot.hasGrant` / `hasAnyGrant`, `BotView.granted`, `flybot.grants` and the `bot.grants` event.
6. `flybot.roomApprovals.setProvider` lets a plugin (social) attach pending outbound holds to a shared-room view. It does not enable team mode.
7. `cleanRemote` is the record boundary for a friend's granted Bot: `name`, `homeName` and `owner` strip `@` (so they cannot look like a mention of another Bot in `nameMentions` chips/previews) and control characters/newlines, then cap at 60 characters. Handles stay on the `handle` field. Those labels then flow into delivery `fromName` (still `cleanName`'d and the body fenced) and into `list_bots` friends lines via the remote-chat roster. Group room logs use local team names, not peer labels.
8. A user's @ of a friend's Bot in a group gets a receipt line in that group (`hooks.js` `mentionReceipt`, relay role `mention`): where the reply lands, or why the send was denied, held, or failed. The receipt's role stays outside the room round trigger (`groups.js` `opens`), so it never opens a round; peer names go through `cleanName`.
9. `flybot.rooms` hosts a Bot Social face-to-face matching room as a native room (`upsertFace` / `applyFaceLine` / `ofFace` / `dropFace` / `onFaceLine` / `postNotice` / `postRemote`). Slot `flybot.room.overview` is a block at the top of a group's overview: while joining, a tile grid (avatar above name + owner) with **Leave** and **Enter chat** on one row; once open, compact **Leave** and Auto-send — not Open/Start/Leave together. Slot `flybot.new-chat.action` adds a row to the sidebar **+** short action menu (next to Create group chat; `label` / `hint` go through the same `t()` map). Still not team mode.
10. Held sends are owner-bound (#52): a hold stamps server-derived provenance on the record — `requestId`, a sha256 `version` over the request content, `origin` (`via`/`hop`/audience) and the sender Bot's `ownerId`; message claims (`meta`, text) never confer authority. `flybot/decide` passes authz for any signed-in actor and hooks binds the decision to the sender Bot's owner's session; `release` revalidates and marks records `stale` (changed request, deleted sender/target Bot, changed owner — `deleteBot` invalidates eagerly; a demoted Chief's sender-side holds are invalidated eagerly on `setMain`, not inside `staleReason`). `release()` re-checks immediately before dispatch so an in-flight approve cannot go out after a concurrent invalidation. Unknown `invalidateFor` field values throw. The pending list is filtered per actor under member enforcement. The default approval card shows `senderName`/`targetName` and a delegated marker (`Approval.origin`).
11. Task lifecycle (#54): a working task's held send calls `rt.taskHeld` (blocks **that** task: `meta.taskId`, or the Bot's only working task); the owner's `flybot/decide` calls `rt.taskDecided` (approve resumes, reject cancels); `deleteBot` of a local Bot calls `rt.taskBotDeleted` (open tasks fail). Incoming holds stay the owner's. The state machine lives in `tasks.js`; hooks only fire those three seams. Clarification and `workBotId` wait on #55.

### Chat-row pending badge

- `flybot.chatApprovals.setProvider` attaches pending Bot Social holds to a 1:1 friend's-Bot chat the same way `roomApprovals` does for groups. The team view puts `pendingCount` on that bot; the sidebar paints the gold wait dot. Still not team mode.

### Sidebar + friend actions

- Social may register several `flybot.new-chat.action` rows (Face-to-face group, Add friend, Accept invite, Copy invite link). Each `run` closes the picker; Copy invite link mints and copies in that click and may return a toast string. Still not team mode.

### Inbound shared rooms on `flybot.rooms`

- `flybot.rooms.applyInbound` turns a Bot Social inbox envelope into the owner's inbound-share projection; `leaveInbound` hides those rooms when the invited Bot is removed or its grant is revoked. Face-to-face methods are unchanged. Still not team mode.

### Face-to-face owner lines

- `onFaceLine` receives every appended room line, including the owner's typed human lines. Channel `send` posts those through `postRoomMessage` (not `sessionController.prompt`) so they reach this hook immediately; the social plugin sends them through Bot Social as the owner's local room Bot with a `FLYBOT-FACE-HUMAN` envelope so every human in the room sees the text; incoming envelopes apply as `authorKind: 'human'` and the stored body is fenced (#98). Bot replies stay bot-authored. The envelope `who` is still taken from the JSON (a follow-up should bind the display name to the sending member record). Still not team mode.

### Host Bot look for classic-script plugins

- Classic-script plugins cannot import `src/client/mark.js`. The host client `registry()` therefore also sets `globalThis.__flybot__.BotAvatar`, `BotMark` and `lookOf` to the same components the sidebar / session list / chat header use (configured image / shape / color, else a stable look from the Bot id or a remote handle). Plugins typically render `BotAvatar` at 24px with `badge: false`; face-to-face tiles pass 48. A stored `color` / `avatar` on the record still wins; a remote Bot without one is seeded by `remoteSeed(handle)`.

## Tests

`core/test/flybot.test.js`, `core/test/flybot-client.test.js` via `npm test`.

## Common mistakes

- Reaching into DSH internals instead of using hooks/slots.
- Changing slots without updating types or client tests.
