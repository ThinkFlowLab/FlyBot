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
| `core/src/client/new-chat.js` | Sidebar **+** picker. Plugin rows via `flybot.new-chat.action` (`newChatActionRows` in `flybot-registry.js`); social adds Face-to-face group, Add friend, and Friend requests. |
| `core/test/new-chat.test.js` | Picker filters and the **+** menu order (Create group chat, then plugin actions, then Add DSH Agent). |

## Invariants

Add a new invariant under the heading it belongs to (or a new heading), not at the end of the page: parallel PRs then do not edit the same lines.

### Generated bundle

- `client.js` matches `core/src/client/`; `npm run build` + `--check` (also invariant 3 of [ds-bot-core](ds-bot-core.md)).

### Host Bot look in the bundle

- The committed bundle includes `flybot-slots.js` `registry()`, which exposes `BotAvatar` / `BotMark` / `lookOf` on `globalThis.__flybot__` for classic-script plugins. Behavior is specified on [plugin-runtime](plugin-runtime.md).

### New group chat with a friend's Bot

- 新建群聊 (`new-chat.js`) picks a local Bot as admin; a friend's remote chat is split into `participants: [{ kind: 'bot', remote: true, handle }]` (`splitRoomPicks`). The host also converts remote chat ids passed as members, so the friend's owner gets the inbound-share projection instead of a silent local-only member.

### Held-send approval card

The default card (`flybot-slots.js`) shows where a held request came from: `senderName` / `targetName` resolved server-side, plus a delegated marker when the send was relayed (`hop > 0`). The strings live in `i18n.js` (`Sent by {sender}`, `Sent by {sender} · delegated`). The decision itself is owner-bound in the host (#52); see [core-host](core-host.md).

### Remote Bot display

- A friend's remote Bot is stored and delivered by its handle (`@<bot>.<home>` — what the @ menu inserts and `sendUserMentions` matches). Where the user reads it — mention chips (`src/client/user-message.js`) and sidebar previews (`nameMentions` in `src/client/text.js`) — the client rewrites the handle to the display name taken from the local roster (`roster.bots[].remote`, `roster.remoteBots`), never from message text, so a remote-controlled name reaches the UI only through the sanitized roster records (#71; display names, #9).
- A remote Bot's generated look is seeded by its handle (`remoteSeed` in `src/client/characters.js`), never by its session id: the chat record (`src/host/remote-chat.js`) carries no look, and every consumer funnels through `lookOf`/`colorOf` / `lookBotForRemote`, so the record, `remoteSpeaker`'s no-record fallback (`src/client/cells.js`), and the group overview / settings member rows (`details-drawer.js`, `group-settings.js`) render one stable look per handle — across surfaces, after a delete/re-add, and identically in the friend's home. A stored `color`/`avatar` on the record still wins. Bot Social `publicBot` / `faceMemberPublic` / `get_bot_profile` do not store an image today; when a member payload carries `avatar`/`color` the client passes them through. Persistently carrying the friend side's uploaded photo still needs Bot Social member-profile fields (#84).
- A friend's Bot the owner hid, a remote chat marked `gone`/`hidden`, and a home-level handle (`@friend.home`, not `@bot.friend.home`) must not reappear in the sidebar, the **发给 / 和谁聊…** picker, `@` mentions, or `list_bots` friends lines (`isListedRemoteChat`). `flybot.remote.publish` skips those handles so remote-chat sync marks the persisted session gone/hidden instead of opening it again; history is kept. Handle comparison is case-insensitive (`normRemoteHandle`).

### FlyBot product chrome

- User-visible chrome says **FlyBot** (header mark + name, About, settings title, tab title, favicon, zh copy). The mark is the existing FlyBot logo (`docs/images/logo.svg`), inlined as `FlyBotMark` from `src/client/brand.js`. Update popups say **FlyBot core {version}**. The npm package remains `ds-bot`; plugin id, localStorage keys, and `console.warn('[ds-bot]')` stay upstream.

### Approval wait badge on chat rows

- A Bot row uses the same gold wait dot as a room row when `bot.pendingCount > 0` (Bot Social holds on that friend's chat) or a local hold is open. Shared-room overview pending lines stay one line with ellipsis (`bt-shared-wait`).

### Bot tree chevron

- The sidebar Bot-list tree (`sidebar.js` `TreeNode`, from slot `flybot.sidebar.structure`) draws collapse/expand as `.bt-tree-toggle`: a 28×28 hit target with a 16px `.bt-tree-chev` glyph, hover background, and a `:focus-visible` accent ring. The glyph rotates when `aria-expanded` is false; the button stays upright so hover and focus stay square. Expand/Collapse `{name}` labels and `aria-expanded` are unchanged. Leaf rows use the same 28px width as a spacer (`.bt-tree-leaf`) so names stay aligned; indent is still `depth * 16px` and the Bot row keeps its height.

### New-chat menu

- Slot `flybot.new-chat.action` (`0003-flybot-api-client`, types in `flybot.d.ts`) is a row on the sidebar **+** new-chat menu, next to Create group chat. Plugins register `{ id, order, label, hint?, visible?, run }`; the picker looks `label` / `hint` up with `t()` like the neighbouring rows. Social registers Face-to-face group, Add friend, and Friend requests; see [plugin-runtime](plugin-runtime.md) and [social](social.md).

## Tests

`npm test` in `core/` (it also fails when `client.js` is stale).
