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
| `core/src/host/hooks.js` | Host hook points. |
| `core/src/client/flybot-slots.js` | Client slots. |
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
9. `flybot.rooms` hosts a Bot Social face-to-face matching room as a native room (`upsertFace` / `applyFaceLine` / `ofFace` / `dropFace` / `onFaceLine` / `postNotice` / `postRemote`). Slot `flybot.room.overview` is a block at the top of a group's overview (Leave / Start chat / Auto-send for origin `face-to-face`). Slot `flybot.new-chat.action` adds a row to the sidebar **+** new-chat menu (next to Create group chat; `label` / `hint` go through the same `t()` map). Still not team mode.

### Host Bot look for classic-script plugins

- Classic-script plugins cannot import `src/client/mark.js`. The host client `registry()` therefore also sets `globalThis.__flybot__.BotAvatar`, `BotMark` and `lookOf` to the same components the sidebar / session list / chat header use (configured image / shape / color, else a stable look from the Bot id or a remote handle). Plugins typically render `BotAvatar` at 24px with `badge: false`; face-to-face tiles pass 48. A stored `color` / `avatar` on the record still wins; a remote Bot without one is seeded by `remoteSeed(handle)`.

## Tests

`core/test/flybot.test.js`, `core/test/flybot-client.test.js` via `npm test`.

## Common mistakes

- Reaching into DSH internals instead of using hooks/slots.
- Changing slots without updating types or client tests.
