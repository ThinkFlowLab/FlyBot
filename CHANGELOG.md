# Changelog

All notable changes to FlyBot (earlier: DS Bot) are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version can contain breaking changes. Entries from the historical `0.1.0-dsbot` preview and earlier describe the pre-FlyBot DS Bot lineage.

New entries are written as one fragment file per change in [changelog.d/](changelog.d/README.md) and folded into a release section at release time; `[Unreleased]` below holds entries written before that.

## [Unreleased]

## [0.2.0] - 2026-10-16

FlyBot product release with core `ds-bot` at `0.1.5-flybot.1` and `@flybot/social` / `@flybot/tree` at `0.1.0`. Package versions are unchanged.

Highlights: a unified sidebar for local and friends' Bots, face-to-face and shared-room conversations, per-Bot grants, in-chat approvals, tracked tasks, owner-chosen Bot avatars, and tree child creation. Team mode remains disabled; in-chat task cards are still planned ([#57](https://github.com/ThinkFlowLab/FlyBot/issues/57)).

### Added

- **Private context stays home in shared rooms.** A Bot only carries its owner's chat brief into a group where another owner sits when the owner shares it (a per-room, revocable share from the Bot's owner — host API `share-brief` now, room UI next); memory reviews in such a room keep entries in the Bot's own memory, never the team's, and read only their own owner as "the user"; `list_bots` no longer discloses another owner's Bot folder or instructions; and referencing a chat you cannot read is refused. Previously received messages are not retroactively unseen. ([#53](https://github.com/ThinkFlowLab/FlyBot/issues/53))
- **Held sends are bound to their owner.** An approval card shows who sent the request (and when it was relayed between Bots); only the sender Bot's owner can approve, reject, or retry it, the list shows you only your own holds, and a decision is voided safely (`stale`, never sent) when the request changed after it was held or the Bot / Chief authority behind it is gone. ([#52](https://github.com/ThinkFlowLab/FlyBot/issues/52))
- **Remove a friend's Bot** from that Bot's settings takes it out of rooms and declines its Bot Social grant; older servers fall back to hiding it on this install. This does not unfriend the person, and rejoining an invite can restore access. Held Bot replies show in the chat as **Waiting for approval** (owner: Approve / Always approve / Reject; others: waiting for the owner). ([#90](https://github.com/ThinkFlowLab/FlyBot/issues/90))
- **Face-to-face join registers a Bot for that room only** when it has no identity yet. `@flybot/social` calls the same `add_home_member` path used for invites, then joins. The identity is not polled, not listed for friends, and is revoked with `remove_home_member` when you leave the last face room or the room closes. A failed join that created one is revoked too so retry is clean. ([#83](https://github.com/ThinkFlowLab/FlyBot/issues/83), [#89](https://github.com/ThinkFlowLab/FlyBot/issues/89), [#90](https://github.com/ThinkFlowLab/FlyBot/issues/90))
- **Face-to-face group.** People next to you join one group by typing the same 6-digit number. Joining is direct — no preview. The room is a normal group with the full member list as `<Bot> · <owner>'s Bot` (owner badges from #82), one-click **Leave**, and **Start chat** / **Enter chat** (voids the number; a 10-minute countdown while it is still a candidate). Joins, leaves, start, and peer messages render as system / attributed lines; Bot replies go through Bot Social (`pending_approval` uses the existing Approve / Reject queue). **Auto-send** controls `auto_approve_face_rooms`; it defaults off and can be turned off again. The in-chat **Always approve** action enables it for subsequent room messages. Peer text is fenced. Entry and waiting-room UI: #92. ([#83](https://github.com/ThinkFlowLab/FlyBot/issues/83))
- **Native rooms take human, Chief, and granted friend Bots.** A room can list people (Alice, Bob), each side’s designated Chief, and a friend’s Bot that was granted to you (`social/remote-bots`). Remotes show as `<Bot> · <owner>'s Bot` (Chief: `<owner>'s Chief`) with an owner badge. The owner of an invited Bot sees **Shared room from \<inviter\>**, only lines from that Bot’s join seq, and can remove their Bot. Ungranted specialists stay private (host-enforced). Replies still go through Bot Social’s outbound hold. Team mode stays disabled. ([#50](https://github.com/ThinkFlowLab/FlyBot/issues/50))
- **Pending approvals for friends' Bots:** outbound drafts Bot Social holds (`pending_approval`) show an **N to approve** badge in the social strip that opens a held chat for approval or rejection. Inbound messages still arrive immediately; enabling Auto-send skips the hold. (#69)
- Plugins can write to the host diagnostics log with `flybot.warn` (Settings → Feedback). `@flybot/social` uses this when start fails. ([#68](https://github.com/ThinkFlowLab/FlyBot/issues/68))
- Owner-chosen Bot avatar and color sync to Bot Social (`update_bot_profile`) and show on friends' Bots, groups, and face-to-face rooms. Peers without a look keep the handle-seeded palette. ([#137](https://github.com/ThinkFlowLab/FlyBot/issues/137))
- **Tracked tasks.** A request can be created as a task with a stable id, acceptance criteria, and a visible state — claimed, worked, blocked while a send waits for your approval, returned, and accepted by you (or cancelled). You do not have to own the Bot: a grant to you, or sharing a room with it, is enough to hand work to a granted child. Wrong-account moves are refused, a task cannot be accepted before its result exists, and deleting the responsible Bot fails its tasks instead of dropping them. Task views in the chat are next ([#57](https://github.com/ThinkFlowLab/FlyBot/issues/57)). ([#54](https://github.com/ThinkFlowLab/FlyBot/issues/54))

### Changed

- Friends' Bots and live face-to-face rooms sit in the same sidebar list as your own Bots and groups (a small globe or people mark). **Past rooms**, **N to approve**, and the + panels stay in the social strip. **Copy my handle** is on the sidebar **+**; per-friend **Auto-send** and **Remove this Bot** are on that friend's Bot settings. The separate Friends' Bots section is gone. A group @ of a friend's Bot that is not in the room still posts a mention receipt; the sent line points at that Bot's own chat. ([#145](https://github.com/ThinkFlowLab/FlyBot/pull/145))
- **Bot Social on a high-latency link.** Grant listing runs with a concurrency cap, and MCP/REST share a keep-alive HTTP agent instead of a new TLS handshake per call. The social strip polls approvals every 15s and pauses while the window is hidden. Friends' Bots now appear in the main sidebar (#145); live face-room polling was tuned in #133 (below). ([#96](https://github.com/ThinkFlowLab/FlyBot/pull/96) follow-up)
- **Face-to-face group lives on the sidebar + menu (#92).** The global **+** (next to Search) includes **Face-to-face group** / **面对面建群** through `flybot.new-chat.action`. The final short action menu is described in #131 below; the separate Friends' Bots **+ Add** entry has been removed. ([#92](https://github.com/ThinkFlowLab/FlyBot/issues/92))
- **Face-to-face group join screen (#92).** **Face-to-face group** opens a screen: pick one or more of your Bots (multi-select; default: the Main Bot), type the 6-digit number, and join at once (no preview). Several selected Bots join the same room (one `social/face-join` per Bot; partial failures stay on screen). A live waiting room lists who joined (Bot and owner in avatar tiles) with the countdown, **Enter chat** (starts the room and opens it), and **Leave**. If someone else starts the chat, this screen opens it. Joining an unregistered Bot still registers it for that room only; the screen does not mention published. ([#92](https://github.com/ThinkFlowLab/FlyBot/issues/92))
- **Per-Bot grants replace `published` (#90).** There is no global “Published to friends” toggle and no “publish all my Bots” concept. Every access is an independent grant: one of my Bots → one person (optionally scoped to a group). Default deny, Chief included. Accepting **Invite to this Bot** creates the grant; **Manage access** on that Bot lists who has it, in which groups, and **Revoke**. Only Bots granted to me appear as friends' Bots in the main sidebar. A granted Bot can be chatted with and added to a group; inside that group every human may talk to it only there and only within the Bot's own authority. Bringing my own Bot into a face-to-face room by its 6-digit number is an implicit room-scoped grant (room-only auto-registration from #89), never visible outside the room. Upgrading means no Bot is shared until it is granted. Core `reach()` is grant-based; `@flybot/social` isolates grant/invite server calls in `src/mcp-client.js`. ([#90](https://github.com/ThinkFlowLab/FlyBot/issues/90))
- **Face-to-face pick and wait lists use each Bot's own avatar in a wrapping tile grid.** The "choose which of your Bots to bring" tiles and the live waiting roster use the same host `BotAvatar` as the sidebar / session list / chat header (configured image, character, or color; a friend's Bot uses its chat record or handle-seeded look, plus any avatar the member payload carries). Tiles wrap several per row with the avatar above the name; the waiting grid also shows the owner after #125. The same grid is the Bot picker (tap a tile; a check overlay marks the ones you bring). **Leave** and **Enter chat** share one footer row while a long grid scrolls under the countdown. ([#107](https://github.com/ThinkFlowLab/FlyBot/pull/107))
- **FlyBot branding in the web UI.** The sidebar header, About page, settings title, update popups, diagnostics notes, and Chinese copy say **FlyBot** (update lines name **FlyBot core** so they stay true to the `ds-bot` package). The header and favicon use the existing FlyBot mark (`docs/images/logo.svg`). Package names, the update-check channel, and repository URLs still point at upstream DS Bot. ([#108](https://github.com/ThinkFlowLab/FlyBot/pull/108))
- Held Bot replies are approved or rejected in the open chat or group: a compact card under the composer shows the draft, **Approve** / **Reject** (owner only; others see “Waiting for the owner's approval”), and **Approve all** when several are waiting. The social strip's **N to approve** badge opens a held chat. ([#114](https://github.com/ThinkFlowLab/FlyBot/issues/114))
- Live face-to-face rooms appear in the main sidebar and open their chat when clicked; **Leave** and **Auto-send** are on the open room. Closed and left rooms fold under **Past rooms** in the social strip with Open only. Creation actions live on the sidebar **+** menu (`flybot.new-chat.action`), simplified further in #131. ([#115](https://github.com/ThinkFlowLab/FlyBot/issues/115))
- The sidebar + menu is a short list of actions (not a New chat composer). Add friend has one-click Copy invite link. The social strip keeps the **N to approve** badge; holds appear in the chat with readable names, not raw bot ids. ([#126](https://github.com/ThinkFlowLab/FlyBot/issues/126))
- The sidebar **+** menu is a short list of creation actions: **Face-to-face group**, **Add friend**, **Accept invite**, one-click **Copy invite link**, and **Copy my handle** (#145). Duplicate Friend requests is gone, and individual Bots no longer clutter that menu. ([#131](https://github.com/ThinkFlowLab/FlyBot/issues/131))
- Held face-room drafts say **Chief → the room** (the real Bot name). Face-to-face titles include the people, else the room code or time. Auto-send remains the setting label; the in-chat action is Always approve. The social strip shows **N to approve** when replies are waiting, without the old Friends' Bots count or header. ([#132](https://github.com/ThinkFlowLab/FlyBot/issues/132))
- While a Face-to-face room is live, FlyBot polls Bot Social about every 4s (about 3s in the open room) so a peer's message shows within a few seconds, then backs off to 15s when idle. ([#133](https://github.com/ThinkFlowLab/FlyBot/issues/133))
- **Tree Bots may create children under themselves.** Issue [#16](https://github.com/ThinkFlowLab/FlyBot/issues/16) is Option B: any tree Bot (not only Main/root) can call `create_child_bot` for a child directly under it. `maxChildren` and depth limits stay. A new child is usable only by its creator's owner; sharing it with another person still needs an independent per-Bot grant (default deny). There is no publish path.
- **list_bots stays inside the grant.** It lists your owner's Bots, Bots granted to that owner, and Bots in the current room — not every other owner's Bot by name. A granted child only sees its own subtree, not the owner's whole roster with folders and instructions. ([#53](https://github.com/ThinkFlowLab/FlyBot/issues/53) follow-up)
- The in-chat **Waiting for approval** card is a compact bubble (not full chat width): who → whom with real names, a short clamped preview, and **Approve** / **Always approve** / **Reject** on one row. **Always approve** turns on Auto-send for that pair (the same setting in the friend's Bot settings or the open face room) so later messages are not held.

### Fixed

- `@flybot/social` loads after a packaged install (`plugin add …&path:/plugins/social`): face-room titles no longer import a repo-relative `core/` path that is missing from the tarball. ([#153](https://github.com/ThinkFlowLab/FlyBot/issues/153))
- **Removed friends' Bots no longer immediately reappear.** A hide is forgotten only after two consecutive successful `list_remote_bots` results without that handle (or a real revoke), never on a failed, partial, or legacy `list_friends` fetch. Hidden handles stay out of `flybot.remote.publish`; gone and home-level remotes (`Friend` at `@something.home`) are hidden in the sidebar and the **发给 / 和谁聊…** picker, with history kept. Picker rows use the same owner label as the sidebar (`<Bot> · <owner>'s Bot`, Chief → `<owner>'s Chief`).
- **Remove this Bot** no longer waits for room leave or a roster refetch: the hide is saved and the filtered list returns immediately; rooms leave in parallel and a fresh fetch continues in the background. Concurrent removes keep their own “Removing…” state. Use **Remove this Bot** in that friend's Bot settings.
- Peer-published Bot labels (`name`, `homeName`, `owner`) are sanitized at `cleanRemote`: `@` and control characters/newlines are stripped, then the 60-character cap still applies, so a display name cannot impersonate another member's handle. ([#75](https://github.com/ThinkFlowLab/FlyBot/issues/75))
- A chat with a friend's Bot that Bot Social has paused (turn budget reached, loop suspicion, emergency stop) now says so and points at the Bot Social console, instead of failing with a bare "Not sent: …" card. A paused conversation is no longer retried with the friendship's other Bots. ([#72](https://github.com/ThinkFlowLab/FlyBot/issues/72))
- The social strip no longer shows the raw host error `Unknown FlyBot endpoint social/remote-bots` when `@flybot/social` failed to start. It shows `Social is not running: <reason>` instead, and the start failure is written to host diagnostics (Settings → Feedback). Taken home names now retry with a numeric suffix (#136 below). ([#68](https://github.com/ThinkFlowLab/FlyBot/issues/68))
- Owner-scoped access (#49) now lets a signed-in owner actually use their own team: session targets resolve again for Bot ids, current chats, group Sessions and earlier parts (own-bot sends were denied), the `flybot/*` plugin endpoints reach the plugin layer instead of answering `bot/not-found`, approvals are answered by their approval id, and the sole signed-in owner keeps the deployment-wide UI surfaces (agents, secrets, questions, connectors, memory reviews) that the first cut hid. With more than one member, plugin writes and `add-agent` join the explicitly blocked shared resources, and `create-room` refuses an empty member list.
- Bot-to-Bot sends and own-chat followups drop `dsh-session:` chips, including a granted Bot of another owner, so a private chat cannot ride into the other Bot's Session. ([#106](https://github.com/ThinkFlowLab/FlyBot/issues/106))
- Chat-reference chips are author-checked on answer-question and schedule-create as well as send and room-post, schedule-create authorization keys off the Bot or room the endpoint uses, and Bot-authored group posts drop chips so a member Bot cannot tunnel a private chat into a shared room. ([#106](https://github.com/ThinkFlowLab/FlyBot/issues/106))
- A held send blocks only the named working task (or that Bot's only working task), a task waiting for your acceptance is not pruned, and task channel names are an explicit allow-list rather than any `task-*` prefix. ([#111](https://github.com/ThinkFlowLab/FlyBot/issues/111))
- A working Bot's send stamps `meta.taskId` (the matching origin, or the latest working task) so a hold with two tasks in flight blocks the right one. ([#111](https://github.com/ThinkFlowLab/FlyBot/issues/111))
- Face-to-face rooms label waiting tiles with the owner (`Chief · BoxB`), revive a rejoined Bot instead of duplicating it and still post a join line when the other side's first event is missing, refresh room state and the main sidebar without a reload, show member avatars on the sidebar row and chat header, and fan an owner's typed line to the other instance as a human message in that room. ([#117](https://github.com/ThinkFlowLab/FlyBot/issues/117))
- Face-to-face poll no longer turns an empty handle into `@` or calls `GET /v1/face-rooms/:id?as=@` (which 404s). Empty handles stay empty, a stored bogus `@` is healed or ignored, and rooms discovered from the list seed `asBot` from `my_bots`. ([#122](https://github.com/ThinkFlowLab/FlyBot/issues/122))
- A waiting-for-approval chat notice no longer calls `remote.chats.deliver` with a home-level friend handle when there is no 1:1 session (that threw `resume failed for session "undefined"`). FlyBot opens or resolves a listed friend Bot chat so the notice lands, or skips with a clear log. ([#123](https://github.com/ThinkFlowLab/FlyBot/issues/123))
- Typing in a face-to-face room posts a human line to Bot Social (`FLYBOT-FACE-HUMAN`) and shows it on the other FlyBot instance. A plain human line no longer starts a local Bot turn or stays local-only; explicit Bot mentions still route to the named Bots. ([#124](https://github.com/ThinkFlowLab/FlyBot/issues/124))
- Face-to-face waiting is a tile grid (avatar above name and owner) with Leave and Enter chat on one row. Leave after joining has ended still moves the room to Past rooms. Past rows are unique with Open only; live rooms open from the main sidebar, with **Leave** on the open room. Join copy uses the owner and Bot name. ([#125](https://github.com/ThinkFlowLab/FlyBot/issues/125))
- Expired matching and a peer leaving the last remote seat move Face-to-face rooms into **Past rooms** on their own, so active cards no longer keep a stale **Leave**. ([#129](https://github.com/ThinkFlowLab/FlyBot/issues/129))
- Chat and sidebar previews show the inner words of a remote line, not the `<untrusted-message>` wrap, and use the person's real name instead of **User**. A Bot that has no model or API key posts a short friendly line; the raw error stays in diagnostics. ([#130](https://github.com/ThinkFlowLab/FlyBot/issues/130))
- Face-to-face room titles include the people and a distinguisher (`Face-to-face · Alice, Bob · 482913`, or `Oct 16 21:40` when there is no code), so two rooms with the same people are not both named Face-to-face room. ([#132](https://github.com/ThinkFlowLab/FlyBot/issues/132))
- A taken Bot Social home name at first start retries `FlyBot2`, `FlyBot3`, … instead of failing until the owner edits YAML, and the sidebar **+** menu offers **Copy my handle** (#145). ([#136](https://github.com/ThinkFlowLab/FlyBot/issues/136))
- Removing a friend's Bot declines that grant on Bot Social so it leaves the owner's Manage access; an older server still hides it locally. Re-join after a decline can restore access (`regranted`). ([#139](https://github.com/ThinkFlowLab/FlyBot/issues/139))
- Removing a friend's Bot asks once, and joining again after a hide unhides that Bot with English errors instead of raw `relationship_exists` / `invite is used`. ([#139](https://github.com/ThinkFlowLab/FlyBot/issues/139))
- New friends start with Auto-send off, the owner sees Approve / Reject in the chat (not a waiting bubble), and a message the owner typed is labelled You. ([#140](https://github.com/ThinkFlowLab/FlyBot/issues/140))
- The raw **Tool removed: ask_user_question** line no longer appears in Bot chats. FlyBot already takes that DSH tool off Bot sessions; the leftover context row is hidden. Other tool cells are unchanged. ([#140](https://github.com/ThinkFlowLab/FlyBot/issues/140))
- A human message in a Face-to-face room (or any group) that names a friend's Bot already in that room is delivered as that human in the room. It is no longer relayed as Chief, so Chief's missing grant cannot block it ([#143](https://github.com/ThinkFlowLab/FlyBot/issues/143)). A Chief-originated send to an ungranted friend Bot is still refused. Failed 1:1 sends to friends' Bots now say one short English line with a next step, not a raw `Bot Social send…` preview.
- Held-send invalidation matches the contract: a hold addressed to a replaced Chief stays pending and decidable, unknown `invalidateFor` fields throw, and an in-flight approve is re-checked before dispatch so a concurrent Chief replacement cannot send on the old verdict. ([#97](https://github.com/ThinkFlowLab/FlyBot/issues/97))
- **Friend Bot lines are fenced in every shared room.** A granted friend's Bot speaking in a non-face group used to land raw in the room log, so peer-controlled markers reached every member Bot unfenced ([#98](https://github.com/ThinkFlowLab/FlyBot/issues/98)). The fence is keyed on the line's origin (remote participant, remote-chat record, or `line.remote`), not the room kind; already-wrapped lines are not nested; the room view unwraps the fence for display like the 1:1 chat.
- **Face-to-face Auto-send and friend avatars.** Auto-send of room messages is read and saved through Bot Social MCP (`whoami` / `set_auto_approve` with the owner's click as consent), so a connector token no longer hits REST `/v1/me` (403). Face-room join/list/messages stay on the REST routes that allow that token. A friend's Bot in the room member list, message headers, waiting grid, and main sidebar uses its chat look or a stable handle-seeded avatar — never the shared letter badge. Profile images and colors now sync through Bot Social (#137 above); peers without a profile look retain the handle-seeded fallback.
- Adding a friend's Bot to a group chat (新建群聊 or later) now shows that group on the Bot's owner's FlyBot as a shared room, so they can follow the conversation and approve the Bot's replies in-chat — including before anyone has sent a message. Removing the Bot from the group or revoking the grant hides it again.
- The Bot tree collapse/expand chevron in the sidebar is a 16px glyph on a 28×28 hit target, vertically centered in the row, with a hover background and a keyboard focus ring. Collapse still rotates the chevron; Expand/Collapse labels and `aria-expanded` are unchanged.

### Security

- A face-to-face human line no longer shows a name the sending client chose. The room labels the authenticated Bot Social `from` member (home / handle / display name). A spoofed `FLYBOT-FACE-HUMAN` `who` is ignored; old events without `from` fall back to that peer's home label, not another member. ([#118](https://github.com/ThinkFlowLab/FlyBot/pull/118))
- Accepting a per-Bot invite grants only that Bot: the joiner's talk-through Bot is not shared back, Manage access lists people by name and home, and leaving a face-to-face room drops room-only remotes from the main sidebar. ([#138](https://github.com/ThinkFlowLab/FlyBot/issues/138))

## [0.1.0] - 2026-10-14

First public FlyBot-branded cut (core package remains `0.1.5-flybot.1`).

### Highlights

- Peer plugins `@flybot/tree` and `@flybot/social` under `plugins/`
- Pristine ds-bot + FlyBot patches → `core/` at `0.1.5-flybot.1`
- Send middleware priorities ROUTING / DEFAULT / APPROVAL
- `types/flybot.d.ts` documents the browser `flybot` service

### Changed

- The core is now pristine upstream ds-bot (`ds-bot/`, pinned at Fei2411/DeepSeek-Bot@2b10c70) plus FlyBot's ordered patch series (`patches/ds-bot/`), applied into the committed `core/` (#34). Install paths move from `path:/ds-bot` to `path:/core` and `path:/plugins/{social,tree}`. The core's version is `0.1.5-flybot.1`.
- Send middleware can set a `priority` (`ROUTING` 100, `DEFAULT` 500, `APPROVAL` 900; `flybot.bot.send.priority`); names in `before`/`after` still work and win over priority. `@flybot/social` runs at `APPROVAL`.
- `types/flybot.d.ts` documents the browser `flybot` service and its slots.
- The plugins are peer packages at the repo root: `@flybot/tree` (`plugins/tree`, by recursive-bot) and `@flybot/social` (`plugins/social`, moved out of `core/plugins/social`). Each needs `ds-bot >=0.1.5-flybot.1`, tests itself against `core/`, and has its own CI job (`plugins (tree)`, `plugins (social)`, both required by `tests-ok`). Reinstall the social plugin from `path:/plugins/social`.

## [0.1.5] - 2026-10-13

### Added

- **Working folder**: a Bot can work directly in a folder you choose instead of the team workspace. Set it in the Bot's settings or details panel: type a path, pick one of your DSH projects, or browse. A group chat can set one folder for all its members there. You can also ask a Bot to change its own folder, or a Main Bot to change any Bot's or group's folder. A Bot that sets a folder outside the team workspace, or adds a Bot to a group that works in one, asks for your approval first when those Bots can only write in their folder. After a change, the Bot's chat goes on in a fresh part that starts in the new folder.

### Fixed

- A new Bot asks where to start in its first reply instead of on a question card, and follows its own instructions where they say otherwise.
- Bots no longer use DeepSeek Harness's own question card, which held the Bot until you answered it while messages from other Bots waited.
- A Bot that messaged a Bot stuck on earlier work was told "Delivered" every time, with no sign that nothing was read. It is now told how many earlier messages wait unread and when the other Bot waits for your approval, and after 10 unread messages `message_bot` fails and tells it to report the stuck Bot to you.
- On model providers that need every request to name its conversation, such as OpenCode Go, the memory panel, automatic memory updates, the context check of long chats and image reading for text-only models failed. They now work there too.
- The memory panel's summary, its "ask or update" and the memory review no longer stop when the Bot's model refuses the call or runs out of output budget: they try once more on the profile's default model. After you change the Bot's model, a failed summary is written again automatically. ([#116](https://github.com/ThinkFlowLab/FlyBot/issues/116))
- With the `ptc` agent preset, the team view and a Bot's character show the tool the Bot runs from its code, an approval card says what that tool does, and a question card asked from code is kept in chat search and in the next part of the chat. In a group chat, a member that only reads the chat or checks the team no longer leaves the round as if it had gone off to work.
- Switching from Bot mode back to Agent mode no longer leaves parts of the Bot interface on screen, such as the chat header or Bot messages without their styles, when one part fails to close. The other parts still close, and Bot mode opens normally again.
- DS Bot no longer sets DeepSeek Harness's work-details mode (Settings → General) to the most detailed one, and no longer hides that setting. Bot chats stay flat in every mode, and your choice applies again outside them. If you had chosen another mode before, choose it again once: DS Bot cannot tell which one it was.
- Your own messages in a Bot chat stay readable under dark skins that recolor message bubbles.
- A Bot chat now shows the cards of the files a Bot hands over with DeepSeek Harness's `present` tool, and of the files a turn changed, as DSH's own chat does. A file path in the reply links to the file when the turn made or delivered it.
- With the `ptc` agent preset, the chat shows the tools a Bot runs from its code again: group replies, question and key cards, and the lines for messages, Bots, groups and memory.
- A question or key card whose call is not on screen, such as one asked in an earlier part of the chat or in a Bot-to-Bot turn, waits above the message box. A card shows in one place only.
- With `DSH_HOME` empty or starting with `~`, DS Bot now keeps its data in `bot/` inside the folder dsh uses. Before, it used a folder relative to the one dsh was started in; to keep a team made that way, close dsh and move that `bot/` folder into dsh's folder.

## [0.1.4] - 2026-10-13

### Added

- Settings → **Capabilities**: share MCP servers and skills with the team, group them into packs, and choose which capabilities each Bot can use.
- A Bot that was working when DeepSeek Harness closed or restarted picks its work back up when DS Bot starts again. A group chat shows which member was cut off, and a Bot that was answering another Bot still sends its answer.
- The sidebar marks a Bot or group chat that waits for your approval. Where the system allows notifications, a notification also names the Bot.
- In a group chat, any Bot can hand work to another with @Name. The Bot does the work without holding up the group, and the group, the sidebar and the Bot's own chat show what it is doing. When it is done, it posts the result in the group. You can stop the work in the group's details.

### Changed

- What a group member posts after its round moved on is answered by the Bot that asked for the work, and no longer by the admin. Work you asked for yourself is left for you to read.

### Fixed

- When a model wrote its tool call as text instead of making it, nothing ran and the Bot stopped as if it were done. The Bot is now asked once to make the call, and the text of the call is kept out of group chats.

## [0.1.3] - 2026-10-12

### Added

- In a Bot's chat or a group chat, `@` lists the Bots you can mention first: a group's members and **Everyone**, or the other Bots. Picking one writes `@Name`.
- **Reference a chat** in the composer's **+** menu adds another Bot's chat, or a recent conversation outside the team, to your message as context.
- A Main Bot can stop another Bot's running turn. The Bot is told why, and its reply goes back to the Main Bot.
- In a group chat, a member that asks for an approval no longer holds up the round. You allow or reject the request in the group's details panel, and a line above the composer names the members who are waiting or at work. What a member says after the round moved on is posted in the group.

### Changed

- When a Bot messages another Bot that is working, the message reaches it at its next step instead of waiting until its current work is done. It answers once that work is done, and the reply comes back. A Bot can still queue a separate task behind the current work.
- Bots give a brief progress message when starting a multi-step task in their own chat with the user, and at meaningful milestones on long tasks.
- Every Bot can change its own name, role, color, model and instructions; only a Main Bot changes other Bots.
- Updating a copy installed from GitHub uses the repository's current address.
- The Usage page groups its statistics, chart, rankings and activity into one panel.
- Hover over an Activity day to see its token count.

### Fixed

- When DS Bot cannot save the Bot team, the change now fails with an error instead of being lost silently.
- A Bot team file that cannot be read is no longer replaced by an empty team; a damaged file is kept as a backup.
- Warnings in the host log hide keys and tokens.
- Bots receive the current time on their first model step and refresh it after ten minutes, even when their DSH preset does not supply a clock.
- In a group chat, a conversation referenced in a message reached none of the members, and a reference whose title started with a member's name called that member. Now the members who answer the message get the referenced conversation.
- In a group chat, typing `@` and a Bot's name and pressing Enter inserted a conversation reference instead of the Bot's name.
- Deleting a Bot or group chat also removes its scheduled tasks, including ones left on the Bot's earlier chat parts. Before, armed tasks stayed active and kept running the deleted Session; the archive that would have stopped them was refused and the failure was silent.
- A long conversation's fresh part keeps the Bot's model and thinking level. Before, the new part fell back to the default model.
- A provider adapter that cannot measure tokens no longer fails every turn. The context size is estimated instead, with one warning in the log.
- When the recent errors were too long for **Report on GitHub**, the new issue got no diagnostics at all. Now it keeps the versions, the system and the models, and only the errors go by the clipboard.
- The memory panel's summary works on models that think by default. The call asks for the model's lowest thinking level, and when the answer is cut off at the output limit it is written once more with a larger budget instead of failing or being saved half-written.
- A message sent to a group chat while a round is running joins that round before the next member speaks. Everyone still to speak sees it, and the members it is for answer it in the same round. Before, it waited for the whole round to end. A message with images or a referenced conversation still waits for its own round.
- In your own messages, `@Name` of a Bot shows as that Bot and opens its chat, instead of a file named after the first word. A group chat calls exactly the Bots a message shows as called: code, links, web addresses and file references such as `@docs/guide.md` call nobody.
- A Bot chat no longer stays stuck when the model keeps turning down its requests, for example over an image it cannot read. Images from finished turns are no longer sent with every later request. When a request is turned down on two turns in a row, the Bot moves on to a fresh conversation part and tells you that the last message could not be sent.

## [0.1.2] - 2026-10-11

### Added

- Settings → About DS Bot: the DS Bot and DSH versions, **Check for updates** and the update buttons, and links to the source code, the release notes and the feedback page. A **Star** button opens the GitHub repository and shows its star count.

### Fixed

- The update card offers a DSH update only when a DS Bot release names a verified DSH version. DS Bot 0.1.1 offered DSH `0.2.1-alpha.1`, which was not verified. In DSH Desktop the card shows a DSH update only when the update the app offers is the verified version.

## [0.1.1] - 2026-10-11

Tested with DeepSeek Harness `0.2.1-alpha.1` (DSH Desktop and DSH Web).

### Added

- Voice chat uses the local speech recognition of the official DSH Voice Input plugin (SenseVoice) when the plugin is on, and the browser's speech recognition otherwise. When the plugin has no speech model yet, the voice panel opens its settings.
- The update card also offers DSH updates, but only the DSH version that the newest DS Bot release was verified with (`dsBot.verifiedDsh`). A DSH installed with npm updates in one click; DSH Desktop opens its own update panel.
- Each Bot can pick a thinking level with its model, in the model menu or when the Bot is created. **Default** uses the model's own level.
- A permission setting in each Bot's details panel: **Read only**, **Workspace** or **Full access**, from the presets DSH offers. The Bot keeps it in its own chat, its group chats and its new conversation parts.

### Fixed

- A handoff note whose headings the model translated (for example `## 目标`) is kept, with the headings put back in English, instead of being written again. A note with a repeated or missing heading is still written again. Handoff notes keep file paths in full.
- Group the first model choices by provider, so models with the same name can be distinguished. Providers with the same display name also show their provider IDs.
- A turn with many steps shows one "Thought it through" row instead of one per step. The row holds the thinking of every step in order.
- The Usage page counts the calls of subagent Sessions too. Before, each scan skipped them and wrote one warning per subagent Session to the terminal.

## [0.1.0-dsbot] - 2026-10-10

The pre-FlyBot DS Bot preview lineage, retitled so its version anchor does not collide with FlyBot's `0.1.0`.

The first public preview. Tested with DeepSeek Harness `0.2.1-alpha.1` (DSH Desktop and DSH Web).

### Added

- A team of long-lived Bots. Each Bot is a DSH Session with its own name, role label, instructions, model and character. Every Bot runs on one model of its own, chosen from the models configured in DSH (the `list_models` tool lists them). Creating a Bot opens a form: pick its look, its model (the DSH default model comes first) and its name.
- Main Bots that create, change and remove other Bots. You can have more than one Main Bot, change the Main Bot in one step on Settings → Bots, and move one to the front; there is always at least one. A Main Bot wears a large star on its avatar.
- Messages between Bots, questions to you that do not stop the other Bots, and a view of what each Bot is doing.
- Group chats in which members speak in turn, can be called with `@name` and stay silent when they have nothing new to add. A new group chat starts with its admin, who wears a small star and manages the group. Every group chat has its own settings page: name, notice, who answers, members and admin, pin and hide, and delete.
- The DSH Agent: one plain DSH entry in the sidebar beside the Bots, with its own Sessions on the native DSH conversation page and none of the team tools.
- Long conversations that stay inside the model's window. The context lines follow the model's `contextWindow` (500,000 tokens when a model reports none), and the check line is a share of it (`checkRatio`, default 0.8). When a turn ends past the check line, a small separate model call decides once: condense the conversation in place into a checkpoint (a handoff summary plus the user's recent messages word for word) while the work is under way, or let the Bot write a handoff note and continue in a new part when the work has reached a stopping point. Neither leaves a marker in the chat. DSH's own compaction does not run on Bot conversations. Earlier parts and condensed messages stay in a local full-text index that the Bot can search.
- Memory. Each Bot keeps notes across all its conversations (`MEMORY.md` and topic files in the Agent Memory Repo format), and the team shares one more memory that Main Bots and group admins write. Bots use the `remember`, `forget` and `recall` tools, and after each turn the Bot's model reviews what is new and keeps, updates or removes entries itself (`memoryReview: false` turns this off). Each conversation reads the memory once, when it starts, so the prompt cache holds. Sizes are fixed, keys and tokens are refused, and `memory/journal.jsonl` keeps every change. `memory: false` turns memory off.
- The memory panel, opened from the Memory row in a Bot's details panel or settings, or from "Memory updated" in its chat: a summary that the Bot's model writes from the entries, every entry with remove, and "Ask or update" to ask about the memory or change it in plain words.
- Scheduled tasks for Bots and group chats: once, every day, every week on chosen days, or every so many minutes, hours or days. Add them from Settings → Scheduled tasks or from **Scheduled task** in the composer's **+** menu. A task sends its message to the chat when it is due. The tasks run on DSH's Automation tasks.
- A Usage page in Settings: token usage over the last 24 hours, 7 days, 30 days, 12 weeks or 12 months, or over days picked on a calendar, with the change from the period before, a chart by Bot or by model, a ranking of Bots and models, and a year of daily activity. Each Bot and each model opens its own page. The counts are kept in `usage.sqlite`. Tokens only, no cost.
- A Connectors page in Settings, with GitHub as the first connector: paste a GitHub token to use GitHub's tools for repositories, issues and pull requests. The token is kept as the `GITHUB_TOKEN` secret. `github: false` hides it.
- The `auto` web-search provider: the native search of the current model route, with a keyless fallback to public results pages.
- A Bot browser in DSH Desktop: each Bot has its own browser with tabs and its own storage partition, in the same side panel as the Bot's details. The Bot reads the open page as structured Markdown (headings, lists, tables, code blocks, open Shadow DOM, same-origin frames) and never reads password, card or one-time-code values.
- Secret cards: a Bot asks for an API key or token in its own chat, you choose which Bots may use it, and the Bot gets it only as a shell environment variable. Saved values are hidden as `[secret:<NAME>]` in tool results and model requests. Settings → Secrets manages them.
- Text descriptions of images for models that cannot read images, made by a configured model that declares image input.
- Customization of the name, role label, instructions, model, character, theme and accent color. The first Main Bot is a whale in DeepSeek blue.
- Avatar animation in three levels (Settings → Bots → Animation): **Quiet**, **Normal** (the default) and **Lively**. Panels, menus and controls move on springs.
- Settings with pages for General, Bots, Group chats, Connectors, Scheduled tasks, Usage, Secrets and Feedback.
- The interface follows the DSH language (English or Chinese).
- **Classic Agent mode** (Settings → General) gives the window back to the native DSH interface; the **DS Bot** button at the bottom of the sidebar brings the team view back.
- Settings → Feedback: the DS Bot and DSH versions, the system and the recent errors, with **Report on GitHub**, **Copy**, **Download** and **Clear**. Keys, tokens, saved secrets and the home folder are removed from the text. Errors are also written to `<home>/logs/diagnostics.jsonl` (`diagnosticsFile: false` keeps them in memory only), and a failed request shows a short notice with a **Details** link.
- Update checks: DS Bot looks for a newer release where it was installed from (the npm registry, or GitHub for a versioned git install) and shows a cloud button at the sidebar's top right when one exists. One click installs it; the new version runs from the next DSH start. `updateCheck: false` turns the checks off.
- One writer per team: when DSH Web and DSH Desktop share a DSH home, the second one opens the team read-only, says why, and takes over when the first one quits.

If you used the legacy `dsh-bot` package, remove it before you install `ds-bot`. The team data stays in `<DSH_HOME>/bot`, and the theme, Bot colors and browser settings move over the first time DS Bot opens.

### Known limitations

- Tested with DSH `0.2.1-alpha.1`, mainly on Linux and in DSH Web. DSH is an alpha, and a newer DSH can break the plugin.
- The Bot browser is in DSH Desktop only, and Bots can only read pages ([Bot browser](ds-bot/README.md#bot-browser)).
- Secrets are stored without encryption, and only exact copies of a value are hidden ([Secrets](ds-bot/README.md#secrets)).
- Only one DSH can change a team at a time; a second DSH on the same DSH home opens it read-only ([Data and backups](ds-bot/README.md#data-and-backups)).
- Group chats use many tokens: each member reads the group and answers in turn.

[Unreleased]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.0...v0.2.0
[0.1.5]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ThinkFlowLab/FlyBot/releases/tag/v0.1.0
[0.1.0-dsbot]: https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.1.0
