---
subsystem: core-client
owned_paths:
  - core/src/client/
  - core/client.js
---

# core-client

The browser side of the patched `ds-bot` core (`core/`): sources in `core/src/client/`, built into the committed bundle `core/client.js`. Split out of [ds-bot-core](ds-bot-core.md) so a host-only change does not have to edit this page. `client.js` is generated: never hand-edit it, run `npm run build` in `core/` and commit both.

## Owns

- Browser client: sidebar, chat, panels, themes, characters, Bot browser panel (`core/client.js` generated from `core/src/client/`). The sidebar **+** new-chat picker (`core/src/client/new-chat.js`) takes extra rows from slot `flybot.new-chat.action` (next to Create group chat; `label` / `hint` go through the same `t()` map) and lists only `listedChatBots` (gone, hidden, and home-level remotes stay out; owner labels match the sidebar). Covered by `core/test/new-chat.test.js` in patch `0003-flybot-api-client`.

## Does not own

- The server side, `core/index.js`, `core/src/host/`, `core/src/shared/` → [core-host](core-host.md).
- Plugin slots and the browser `flybot` service (`flybot-slots.js`, `flybot-registry.js`) → [plugin-runtime](plugin-runtime.md).
- Pin, patches, `core/dev/` → [ds-bot-core](ds-bot-core.md).

## Key files

| File | Role |
| --- | --- |
| `core/src/client/` | Client sources → build to `core/client.js`. |
| `core/src/client/new-chat.js` | Sidebar **+** picker. Plugin rows via `flybot.new-chat.action` (`newChatActionRows` in `flybot-registry.js`); Face-to-face group is the social plugin's row. |
| `core/test/new-chat.test.js` | Picker filters and the **+** menu order (Create group chat, then plugin actions, then Add DSH Agent). |

## Invariants

Add a new invariant under the heading it belongs to (or a new heading), not at the end of the page: parallel PRs then do not edit the same lines.

### Generated bundle

- `client.js` matches `core/src/client/`; `npm run build` + `--check` (also invariant 3 of [ds-bot-core](ds-bot-core.md)).

### Host Bot look in the bundle

- The committed bundle includes `flybot-slots.js` `registry()`, which exposes `BotAvatar` / `BotMark` / `lookOf` on `globalThis.__flybot__` for classic-script plugins. Behavior is specified on [plugin-runtime](plugin-runtime.md).

### Remote Bot display

- A friend's remote Bot is stored and delivered by its handle (`@<bot>.<home>` — what the @ menu inserts and `sendUserMentions` matches). Where the user reads it — mention chips (`src/client/user-message.js`) and sidebar previews (`nameMentions` in `src/client/text.js`) — the client rewrites the handle to the display name taken from the local roster (`roster.bots[].remote`, `roster.remoteBots`), never from message text, so a remote-controlled name reaches the UI only through the sanitized roster records (#71; display names, #9).
- A remote Bot's generated look is seeded by its handle (`remoteSeed` in `src/client/characters.js`), never by its session id: the chat record (`src/host/remote-chat.js`) carries no look, and every consumer funnels through `lookOf`/`colorOf`, so the record and `remoteSpeaker`'s no-record fallback (`src/client/cells.js`) render one stable look per handle — across surfaces, after a delete/re-add, and identically in the friend's home. A stored `color`/`avatar` on the record still wins. Carrying the friend side's real look over the wire needs Bot Social member-profile fields (#84).
- A friend's Bot the owner hid, a remote chat marked `gone`/`hidden`, and a home-level handle (`@friend.home`, not `@bot.friend.home`) must not reappear in the sidebar, the **发给 / 和谁聊…** picker, `@` mentions, or `list_bots` friends lines (`isListedRemoteChat`). `flybot.remote.publish` skips those handles so remote-chat sync marks the persisted session gone/hidden instead of opening it again; history is kept. Handle comparison is case-insensitive (`normRemoteHandle`).

### New-chat menu

- Slot `flybot.new-chat.action` (`0003-flybot-api-client`, types in `flybot.d.ts`) is a row on the sidebar **+** new-chat menu, next to Create group chat. Plugins register `{ id, order, label, hint?, visible?, run }`; the picker looks `label` / `hint` up with `t()` like the neighbouring rows. The social plugin's Face-to-face group row is the first consumer; see [plugin-runtime](plugin-runtime.md) and [social](social.md).

## Tests

`npm test` in `core/` (it also fails when `client.js` is stale).
