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
| `core/src/client/new-chat.js` | Sidebar **+** picker. Plugin rows via `flybot.new-chat.action` (`newChatActionRows` in `flybot-registry.js`); social adds Face-to-face group and Add friend (copy actions live inside Add friend, #181). The DSH Agent row reads **Add coding agent** (hint "A plain DSH session, not a Bot") so it is not mistaken for **Create new Bot** (#181). The short + menu does not list individual Bots. |
| `core/test/new-chat-menu.test.js` | **+** menu rows (#283): an action row's description is its own line under the title, an inline Bot hint is capped, so hovering never hides a title. |
| `core/test/new-chat.test.js` | Picker filters and the **+** short action menu (`data-menu`; New chat, then Create group chat, plugin actions, then Add Agent). |

## Invariants

Add a new invariant under the heading it belongs to (or a new heading), not at the end of the page: parallel PRs then do not edit the same lines.

### Generated bundle

- `client.js` matches `core/src/client/`; `npm run build` + `--check` (also invariant 3 of [ds-bot-core](ds-bot-core.md)).

### Host Bot look in the bundle

- The committed bundle includes `flybot-slots.js` `registry()`, which exposes `BotAvatar` / `BotMark` / `lookOf` on `globalThis.__flybot__` for classic-script plugins. Behavior is specified on [plugin-runtime](plugin-runtime.md).

### New group chat with a friend's Bot

- 新建群聊 (`new-chat.js`) picks a local Bot as admin; a friend's remote chat is split into `participants: [{ kind: 'bot', remote: true, handle }]` (`splitRoomPicks`). The host also converts remote chat ids passed as members, so the friend's owner gets the inbound-share projection instead of a silent local-only member.

### Main view landing and navigation trace (#261)

`useLandOnMainBot` (`sidebar.js`) puts an emptied main view back on a Bot. `landingPart` (`text.js`) picks where: a part archived for a fresh one goes on in the fresh part; a view that emptied while its chat is still the Bot's current part (a session list reload, not the user leaving) returns to that same chat; a blank New Session the user opened, or a removed Bot, goes to the Main Bot. Every `openSession` and `landOn` with no user activation behind it (`navigator.userActivation.isActive === false`) is written to the client diagnostics and the console (`navigation: landOn to … from … with no click (caller stack)`), so a jump a user cannot explain names its caller.

### Held-send approval card

The overlay (`flybot-slots.js` `FlyBotApprovals`) is the fallback, not a second copy (#260): an approval whose policy a `flybot.session.dock` entry declares (`policy`, e.g. social) is drawn by that dock in its chat, which reports the ids it shows through `claim(ids)`; the overlay skips claimed ids. A docked approval no open chat shows becomes a small pointer (`Sender → Recipient`, `Waiting for approval`, **Review** opens the chat via `actions.openSession`) after 1.2 s, so moving between chats never flashes it; the chat that is open never gets a pointer for its own approvals (each `FlyBotSessionDock` reports its chat through `chatOpened`, #271). An approval's chat is its room, else the friend's chat it is addressed to, else the Bot that wrote it; the pointer's Review opens that one (#278). Any other policy's approval is a card in the overlay, with the same two lines as the dock's card (`Waiting for approval` / `Not sent`, then `Sender → Recipient`; the policy's long reason is the tooltip) and Approve / Reject (Retry for a failed send). The recipient is named from the roster (`UiA1415's Chief`, `Helper · UiB1415's Bot`) when the friend's chat is known, else as the host named it. `senderName` / `targetName` are resolved server-side and a delegated marker follows a relayed send (`hop > 0`). The decision itself is owner-bound in the host (#52); see [core-host](core-host.md).

### Room avatars in face-to-face chats

- `RoomAvatar` (`src/client/mark.js` `roomAvatarPeople`) seats current local `room.members` and live remote `participants` (handle-seeded via `lookBotForRemote`). A face-to-face room with only remotes no longer falls back to the grey placeholder in the sidebar row or chat header.

### Room remote bubbles unwrap the fence

- Group `RemoteMessage` (`cells.js`) shows `remoteMessageText(reply.text)`, the same unwrap the 1:1 friend chat already uses. Stored room lines stay fenced for the model; the bubble shows the inner words, not the `<untrusted-message>` wrapper (#98).

### Remote Bot display

- A friend's remote Bot is stored and delivered by its handle (`@<bot>.<home>` — what the @ menu inserts and `sendUserMentions` matches). Where the user reads it — mention chips (`src/client/user-message.js`) and sidebar previews (`nameMentions` in `src/client/text.js`) — the client rewrites the handle to the display name taken from the local roster (`roster.bots[].remote`, `roster.remoteBots`), never from message text, so a remote-controlled name reaches the UI only through the sanitized roster records (#71; display names, #9).
- A remote Bot's generated look is seeded by its handle (`remoteSeed` in `src/client/characters.js`), never by its session id. When Bot Social sends `avatar` / `color` / `avatar_updated_at`, `flybot.remote.publish` stores them on the remote-chat record (cached by `avatar_updated_at`). `lookBotForRemote` overlays a person payload's look (face-room `members[]` is the source for room avatars). A stored `color`/`avatar` still wins over the seed; missing look stays handle-seeded (#137).
- A friend's Bot the owner hid, a remote chat marked `gone`/`hidden`, and a home-level handle (`@friend.home`, not `@bot.friend.home`) must not reappear in the sidebar, the **发给 / 和谁聊…** picker, `@` mentions, or `list_bots` friends lines (`isListedRemoteChat`). `flybot.remote.publish` skips those handles so remote-chat sync marks the persisted session gone/hidden instead of opening it again; history is kept. Handle comparison is case-insensitive (`normRemoteHandle`).
- The "@" reader is shared with the host (`core/src/shared/mentions.js`, bundled into `core/client.js`). #287 added `unmatchedMentions` there (the `@` words that name nobody, used by the host for the face-room hint); `mentionSpans` and what the bubbles draw are unchanged.
- A friend's Bot settings surface is not the local editor (#160): no rename, avatar editor, model, folder, instructions, Main Bot, Hide, Duplicate, or Delete. The details gear and context menu say **Bot settings**. The menu is Mark as Unread, Bot settings, and Copy conversation ID. Per-friend **Auto-send** and **Remove this Bot** stay on that page (`flybot.bot.details`); Remove closes the overlay so a stale local editor cannot appear. The Bots settings list is local Bots only.
- A friend's Bot details overview is that compact panel: handle plus `FlyBotDetails` (Auto-send and a muted Remove link), no Browser tab, no Usage / model / folder. Opening the gear uses `remote-bot-settings` (`RemoteBotSettingsSheet`): a bottom sheet on narrow viewports and a centered card from 520px up, with the scrim behind the dialog (`z-index` stacking like `bt-settings` / `bt-mem`) so the sheet stays clickable through enter/leave animations. The surrounding DSH settings-shell chrome (back/title) is not redesigned (#166). The sheet takes focus when it opens (`tabIndex -1`, `preventScroll`), closes on Escape from its own `onKeyDown` as well as `useEscape`, and gives focus back without scrolling; in the tree a friend's `.bt-row-wrap` (row plus gear) shrinks like a plain row (`.bt-tree-item>.bt-row-wrap`), so the gear never overflows the sidebar and focusing it cannot scroll it sideways (#274).
- Every listed Bot row in wide sidebar mode is a `bt-row-wrap`: the session `bt-row` and a sibling gear (`bt-row-settings`, hover/focus) that opens Edit Bot for an own Bot or Bot settings for a friend's (#166, #276).
- `HeaderPill` sets the composer placeholder CSS var and mirrors the localized **Message {name}** string on `[data-composer-input]`'s `aria-label`; cleanup restores the prior label when the header unmounts or the session changes (#166).

### Face-room held bubble and overview

- A face-to-face own message uses `data-held` on `.bt-umsg` while that room's `pendingCount > 0`: dashed, mixed user-surface, `--bt-ink` (not the finished sent user bubble). Incoming lines are unchanged. Face-to-face `GroupOverview` hides the Usage row.

### FlyBot product chrome

- User-visible chrome says **FlyBot** (header mark + name, About, settings title, tab title, favicon, zh copy). The mark is the existing FlyBot logo (`docs/images/logo.svg`), inlined as `FlyBotMark` from `src/client/brand.js`. Update popups say **FlyBot core {version}**. The npm package remains `ds-bot`; plugin id, localStorage keys, and `console.warn('[ds-bot]')` stay upstream.
- The tab title follows the open chat (`sessionTabLabel` in `brand.js`: a friend's Bot reads `Name · owner`, a room uses its display name; an ended face-to-face room, closed or left, reads `Face-to-face · closed` unless the user named it, #250). `installTabTitle` re-reads it on session **and** roster changes, so a face room the joiner opens before the roster names it, or a room renamed later, still gets its own title (#173). Sidebar row gear controls are hover/focus-only, and Bot settings call the duplicate/delete card **More**. An empty chat with a friend's Bot shows a one-line hint (`--bt-remote-empty`, set by `HeaderPill`) that the friend approves unless Auto-send is on (#173). The agent entry on **+** reads **Add Bot**.
- In `apply`, any `ctx.effect` that reads `roster` must come after `const roster = createSource(...)`: effects run immediately, and a read before the declaration throws and fails the whole client plugin load (`core/test/client-apply-order.test.js`).

### One sidebar list

- `TeamSidebar` lists local Bots, listed remote chats (`isListedRemoteChat`), live face-to-face rooms, and shared rooms in one `bt-list`. Own chats sort before foreign ones (a remote Bot, a face room, or `sharedFrom`); pinned and recency still win. A friend's Bot keeps the globe `RemoteMark`; a live face room gets a small people `FaceMark`. Past/ended face rooms stay out of this list (`isPastFaceRoom`) so the social section can fold them under **Past rooms**. With `@flybot/tree` on, only own Bots are tree nodes under Main; a friend's Bot stays in the flat ordered list (not hidden when Main is collapsed).

### Approval wait badge on chat rows

- A Bot row uses the same gold wait dot as a room row when `bot.pendingCount > 0` (Bot Social holds on that friend's chat) or a local hold is open. Shared-room overview pending lines stay one line with ellipsis (`bt-shared-wait`).

### Bot tree chevron

- The sidebar Bot-list tree (`sidebar.js` `TreeNode`, from slot `flybot.sidebar.structure`) draws collapse/expand as `.bt-tree-toggle`: a 28×28 hit target with a 16px `.bt-tree-chev` glyph, hover background, and a `:focus-visible` accent ring. The glyph rotates when `aria-expanded` is false; the button stays upright so hover and focus stay square. Expand/Collapse `{name}` labels and `aria-expanded` are unchanged. Leaf rows use the same 28px width as a spacer (`.bt-tree-leaf`) so names stay aligned; indent is still `depth * 16px` and the Bot row keeps its height.

### New-chat menu

- The + menu is a popover anchored next to the sidebar **+** (#195, #173): its `.bt-pane` carries `data-menu` and stays see-through, the menu is a 280px card at the top left with no title row, and a press on the pane outside the card (or Escape) closes it. New chat, Create group chat, Create Bot and plugin rows open their full pane as before.
- Create Bot starts on the Main Bot's model (#230): `startModel()` (`bot-draft.js`) picks the Main Bot's chosen model, else the one it last ran on, when it is served; then `roster.defaultModel`, then the first served model. Only served models are picked, so a provider without a credential is never preselected.
- Settings say each thing once (#230): the Model and Main Bot cards show no row label that repeats the card title (`SwitchRow` `showLabel: false` keeps the switch's accessible name), the Create Bot dialog has its Back / Close in the header only (the footer Back / Cancel is for the inline form), and the account menu is as wide as its longest item (`width:max-content`, capped to the viewport) instead of cutting `Switch to classic Agent mode`.
- Slot `flybot.account.header` (`0003-flybot-api-client`) is a compact block at the top of the account menu (`FlyBotAccountHeader`); social uses it for the owner's own handle (#181).
- Slot `flybot.new-chat.action` (`0003-flybot-api-client`, types in `flybot.d.ts`) is a row on the sidebar **+** new-chat menu, next to Create group chat. Plugins register `{ id, order, label, hint?, visible?, run }`; the picker looks `label` / `hint` up with `t()` like the neighbouring rows. A string returned from `run` is shown as a toast (`actions.notify`). Social registers Face-to-face group and Add friend; see [plugin-runtime](plugin-runtime.md) and [social](social.md).
- Sidebar **+** (`mode === 'new'`) opens a short action menu (`data-menu`, no To:/composer) until **New chat** or **Create group chat**. That menu does not list individual Bots (Chief and the rest stay behind **New chat**). The Agent row in that FlyBot menu is **Add coding agent**; **Add DSH Agent** stays the DSH product string on Agent rows elsewhere (#126, #181).
- Group bubbles, notices, and failed-reply lines never show a raw `<untrusted-message>` wrap or a developer error (`llm-deepseek: no API key`). `remoteMessageText` unwraps stored fences; `failureLabel` maps missing-key / unknown model failures to a short friendly line. Details stay in Settings → Feedback.
- `GroupReplies` draws a `user` reply with `other: true` (another member's face-room line, #180) as `PersonMessage` (`cells.js`): the person's name, the person mark (`PersonMark` in `mark.js`) and a received `--bt-bubble` bubble, not a centred `bt-event` notice and not the sent `--bt-user` style; own lines keep the right-hand bubble (#229). `other` comes only from the host's person-line post (`hooks.js` `postHuman`), never from text. Another home member's line in a shared group (`UserMessageCell`, author stamped by the host) gets the same person mark and the received surface (`.bt-umsg-other .bt-ubody`).
- A face-to-face room lists people first (`faceSeats` / `faceSeatLabel` in `group-settings.js`, used by the overview and group settings): one row per live Bot, `<person> · <Bot>`, with `(you)` on my own (`SelfB (you) · Chief`, `SelfA · Chief`), built from participant fields and the roster, never message text (#229).

### Hidden DSH tool-removal notices

- FlyBot `restrict()`s DSH's `ask_user_question` off Bot sessions (`hideBlockingQuestion`). DSH then appends a developer `tool-removal` context row, and `@deepseek-ai/dsh-client-ui-chat` renders it as "Tool removed: {name}". `ContextCell` shadows `conversation.chat.node` `context` and returns null for those notices (`HIDDEN_REMOVED_TOOLS`). Other tool-change context (tool-added, unrelated removals) still shows; `tool-call` cells are unchanged. Empty shadowed nodes collapse via the existing `:empty` flow-item rule. Covered by `core/test/tool-cells.test.js`.

- The held-send overlay (`FlyBotApprovals`, `flybot-slots.js`) runs every hook before its `if (pending.length === 0) return null`: a hook after that return made React throw on the first held message and no card ever drew (#254). `test/overlay-approvals.test.js` renders it with a stand-in that enforces React's hook-count rule.

### Discarded promise `.catch` (#213)

A discarded `.catch(() => {})` in the client sources either starts with `void` (fire and forget) or carries a one-line reason comment (an awaited wait); a `.catch(() => undefined)` whose value is used stays. `check-empty-catch` enforces it (see `docs/code-standards.md`).

## Tests

`npm test` in `core/` (it also fails when `client.js` is stale).
- A friend's line that Bot Social attests the friend typed themselves (#227) is drawn as the person: `AssistantCell` looks the turn up in `roster.remoteTypedTurns` (`typedBy` in `src/client/text.js`) and renders `PersonMessage` — the person's name and a person mark (`.bt-person-mark`) — instead of the Bot's `Bubbles`. The name comes from the roster (the authenticated Bot Social `from`), never from message text.
- The same attested line sent to one of my own Bots outside that friend's chat (a friend's Chief typing to my Helper) arrives as a remote message whose source has `remote.typedBy`; `RemoteMessage` (`cells.js`) then draws it as the person (name, person mark, `via <Bot>`) instead of the friend's Bot avatar and handle. Without `typedBy` it keeps the Bot rendering (#233 follow-up). The `via` name is the carrying Bot's plain name when this home knows that Bot (its chat or `roster.remoteBots`), and is left out when it does not; the model-facing sender label (`X (typed via @…, Bot Social)`) and the handle-derived `· owner's Bot` never reach that header (#275). Settings → Bots offers only the user's own Bots as a Main Bot, in the first-Main-Bot and Add a Main Bot selects (#276).
