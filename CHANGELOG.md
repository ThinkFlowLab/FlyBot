# Changelog

All notable changes to FlyBot (earlier: DS Bot) are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version can contain breaking changes. Entries from the historical `0.1.0-dsbot` preview and earlier describe the pre-FlyBot DS Bot lineage.

New entries are written as one fragment file per change in [changelog.d/](changelog.d/README.md) and folded into a release section at release time; `[Unreleased]` below holds entries written before that.

## [Unreleased]

## [0.2.2] - 2026-10-21

### Added

- An **Inbox** row at the top of the sidebar opens one list of your own Bots' work: **Needs you** (tool approvals, held messages, tasks waiting for you or failed), **In progress** (running turns and tasks) and **Done** (the last 7 days). Each card has one clear status and an **Open** button to its chat; tool approvals from a group chat can be answered right there with the same buttons as in the chat ([#349](https://github.com/ThinkFlowLab/FlyBot/issues/349)).
- FlyBot can run in a container that you build yourself: a `Dockerfile` and `compose.yaml` start `dsh web` with the FlyBot core and plugins as a normal user, with one data volume, no keys in the image, the port on the host's `127.0.0.1` only and a health check. A guide in English and Chinese, [Run FlyBot in Docker](docs/docker.md), covers start, stop, upgrade, roll back and back up; CI builds the image and runs a start check, and nothing is published ([#352](https://github.com/ThinkFlowLab/FlyBot/issues/352)).
- FlyBot now sends a system notification when one of your own Bots finishes or fails a turn while you are in another chat or app (`Coder finished`, `Coder failed: <reason>`), alongside the existing approval-waiting one; clicking it opens that chat, and it never approves, rejects or sends anything. Settings → General has a **Notifications** switch, on by default, that turns all of them off ([#353](https://github.com/ThinkFlowLab/FlyBot/issues/353)).
- Scheduled tasks can be edited and paused: in Settings → Scheduled tasks and a Bot's card, **Edit** opens the task in its form, filled in, and **Pause** / **Resume** stop and restart a task without deleting it. The docs now say what happens to a run missed while the app was closed: a recurring task runs once, for its latest missed time, never once per missed time ([#354](https://github.com/ThinkFlowLab/FlyBot/issues/354)).
- Settings → Connectors: pick Composio apps by searching Composio's app list instead of typing app names, and see for each picked app whether it is ready or still needs a sign-in ([#359](https://github.com/ThinkFlowLab/FlyBot/issues/359)).
- On a phone browser (about 400px wide) you can skim a chat, press **Approve** / **Reject** on a held reply and work the Agent inbox: approval buttons become full-size touch targets, floating approval cards span the screen beside the icon rail, and inbox cards put their buttons under the text so titles stay readable. Wider screens are unchanged ([#362](https://github.com/ThinkFlowLab/FlyBot/issues/362)).
- You can now see which model each turn used and which model each Bot runs on: a Timeline turn's tooltip ends with the model that turn ran on (`· deepseek-v4-pro`), and hovering a Bot in the sidebar tree or Bot list shows its model (`Coder · DeepSeek V4 Pro`). Nothing new stores keys; models are still chosen per Bot in its settings ([#366](https://github.com/ThinkFlowLab/FlyBot/issues/366)).
- Chief now places new Bots sensibly up front instead of piling them flat under itself. Before creating a Bot it can search the whole tree with `find_bots` and reuses a Bot that already has the same role, at any depth, instead of making a duplicate. `create_team` sets up a project as one lead with its roles under it (for example Chief → FlyBot Lead → Dev, Test, Maintenance, Repo), which takes one slot under Chief, and `create_child_bot` can put a Bot under one of the caller's own descendants; a later Bot of a group goes under that group's lead. A Bot whose parent is gone is moved back into the tree by role. A full level, orphans and duplicates stay the job of the tree's automatic reorganization ([#447](https://github.com/ThinkFlowLab/FlyBot/issues/447)).
- A guide, [Set a DeepSeek API key](docs/deepseek-api-key.md), explains the ways to give DeepSeek Harness your key (the key dialog, its credentials file, or `DEEPSEEK_API_KEY`), and the missing-key error and the no-model setup choices link to it ([#451](https://github.com/ThinkFlowLab/FlyBot/issues/451)).
- Notifications go further: an approval that is still waiting after 15 minutes gets one reminder (`Coder has waited 15 min for your approval`), Settings → General → **Notifications** has a separate switch for waiting approvals, finished turns and failed turns, and each chat keeps a single notification that a newer one replaces and that counts its updates ([#469](https://github.com/ThinkFlowLab/FlyBot/issues/469)).
- The Agent inbox now lists a turn of your own Bot that failed under **Needs you**, with the reason, until the Bot finishes a turn in that chat again, from the same events as the finished/failed notifications; and each inbox card shows a one-line **Latest:** row with what happened last in its chat ([#471](https://github.com/ThinkFlowLab/FlyBot/issues/471)).
- Each scheduled task in Settings → Scheduled tasks now says when it last ran and how it went (still running, finished, stopped, or failed with the reason). A run fails only when DSH could not deliver it or the Bot's turn errored; a failed run gets **Retry**, which runs the task once now with the same prompt, and the failure also shows up in notifications ([#473](https://github.com/ThinkFlowLab/FlyBot/issues/473)).
- Face-to-face rooms have one room lead (总负责人), a Bot from any home. The person who created the room picks it with the Room lead button in the room's details; until then it is the first Bot of the creator's home that joined, and everyone else sees it read-only. The lead sees everyone in the room with their roles, writes the one plan and gives out the parts; every other Bot, a Main Bot too, does only its own part or answers when named. With an older Bot Social server the default lead is used and cannot be changed ([#476](https://github.com/ThinkFlowLab/FlyBot/issues/476)).
- Share a Bot with an existing friend in one click from Sharing (no invite link); the new share appears in People with access and can be Revoked or declined as usual ([#500](https://github.com/ThinkFlowLab/FlyBot/issues/500)).
- Opt-in state journal for debugging multi-Bot bugs ([#511](https://github.com/ThinkFlowLab/FlyBot/issues/511)): with `stateJournal: true` in the `bot` config, every change to the saved team is recorded on this computer only (`<home>/journal/state.jsonl`, private to the user, kept 7 days or 20 MB), and the dev script `core/scripts/replay.mjs` rebuilds the team as it was after any recorded step. Off by default.
- Tool approval cards in a group and in the Inbox add **Always allow for this Bot** and **Always allow for this group** next to Reject / Allow once, so a Bot stops asking for the same kind of permission (for example a `bash` sandbox escalation to full access). Standing approvals are kept across restarts and listed under **Always allowed** in Bot settings and Group settings, each with Remove ([#540](https://github.com/ThinkFlowLab/FlyBot/issues/540)).
- Memory recall now finds entries by meaning, and shows what memory links. `recall` gains `semantic: "true"`, which ranks entries with a local, dependency-free TF-IDF score over words, word stems and CJK n-grams, so an entry whose wording differs from the query still matches; and `related`, which lists the topics a `[[topic]]` links to and who wrote a memory. The default exact-word recall is unchanged.
- The Timeline plugin can now be asked for an export on demand. `timeline/export` returns the current trace as one OpenTelemetry OTLP/HTTP JSON payload — the same mapping the timer exporter uses — so a tool or the panel can pull it now instead of waiting for the next flush. It is read-only, sends Bot and room ids only unless the caller sets `names: true`, and needs no configuration.
- The Timeline plugin can now export its trace as OpenTelemetry spans. Set `exporter: "otlp"` with an `otlpUrl` (https, or http on localhost only) to POST OTLP/HTTP JSON to any collector (Jaeger, Phoenix, Langfuse…), or `exporter: "json"` to append `dir/export.jsonl`. Finished Bot turns become `invoke_agent` spans and their tool calls `execute_tool` spans beneath them. Off by default; it exports only the same metadata the panel shows (never message text, tool arguments or output), sends Bot and room ids only unless `exportNames: true`, and an open turn is held until it ends rather than exported as finished.
- A tree coordinator can now see how busy its children are. Each Bot's running turns are counted from the activity feed, shown as one line in the coordinator's prompt (`Child load right now — Work: busy (2 running), Travel: idle`) and a `load` count on each entry of `list_children`, so a new part goes to a free child instead of a busy one. Nothing is stored; the counts start from zero on each start.

### Fixed

- Face-to-face rooms: a Bot now looks the same on every home and in every place (waiting tiles, chat bubbles, Members, sidebar). A Bot with no look of its own sends the look its home generates for it to Bot Social, before it joins, so the other home no longer invents a different one; your own Bot in the waiting dialog uses its roster look right after joining; a friend's Bot speaks in the room with the look its owner gave it. Other people show their initial on a color picked from their name instead of a grey silhouette ([#182](https://github.com/ThinkFlowLab/FlyBot/issues/182)).
- Past rooms list everyone who was in a face-to-face room (a home that stayed no longer drops the person who left), each row shows when the room ended, clicking anywhere on the row opens it, and the Past rooms fold stays open or closed across a reload ([#304](https://github.com/ThinkFlowLab/FlyBot/issues/304)).
- Face-to-face rooms: another person's line, or another home's approved Bot reply, that arrives while your Bots are answering now shows right away as that person's or Bot's bubble, never as a queued "[Group post from …]" row above the composer that Cmd/Ctrl+Enter could steer; a person's line breaks are kept on the receiving side ([#455](https://github.com/ThinkFlowLab/FlyBot/issues/455)).
- Face-to-face rooms: a Bot reply held for your approval shows only on its approval card, greyed, and becomes a room bubble only after you approve it; a rejected reply collapses to one grey "Not sent" line, also after a reload and in Past rooms. A decided card leaves no "Approved" / "Rejected" stub, the card names the Bot with its person ("Researcher (Alice) → the room"), and each Bot answers a person's line at most once ([#456](https://github.com/ThinkFlowLab/FlyBot/issues/456)).
- Face-to-face rooms are person-first: one tile and one Members row per person (Members counts people, and only people are "(you)"), every Bot named "Bot (person)" including your own, a mention of a friend's Bot stays with that Bot after it leaves, bubble headers show just the name with the handle on hover, and your own typed line keeps your name and colour. Auto-send in a face room is now one switch per Bot, off by default ([#457](https://github.com/ThinkFlowLab/FlyBot/issues/457)).
- Face-to-face rooms: a number nobody is using no longer silently opens a room. Join says "Nobody is using 111111 yet." with Cancel and Start a room, and a room nobody else ever joined (left, or run out) leaves no Past rooms entry. A room stays open while two or more people are in it; when you are the last one, it reads "Room closed." with one Close button, and Leave (or Close) takes you back to the chat you were in without opening Bot settings. Both homes count down to Bot Social's one deadline, even when a device clock is off or a tab was in the background. A room's turns no longer take over its Bots' sidebar preview, the room row leads with its number ("482915 · Alice, Bob"), Enter chat steps aside while "Leave this room?" asks, Join waits for all 6 digits, and a click outside the dialog closes it like Escape ([#458](https://github.com/ThinkFlowLab/FlyBot/issues/458)).
- Face-to-face rooms: a friend's plain line is now answered like your own: your Bots decide who answers it (usually one, the Bot that spoke last first), and a Bot's @mention in its answer no longer calls another Bot on, so Bots in two homes cannot set each other off ([#462](https://github.com/ThinkFlowLab/FlyBot/issues/462)).
- Face-to-face rooms: when a friend's Bot has already answered or posted a plan for a line, your Bots no longer have to answer it again (no forced "nobody answered" reply), a Bot that still speaks to a line for everyone adds only its own part, and a friend's Bot writing `@all` / `@所有人` no longer wakes all of your Bots; its `@YourBot` still calls that Bot ([#475](https://github.com/ThinkFlowLab/FlyBot/issues/475)).
- **People with access** keeps listing a friend after the two of you joined each other's invite, so the owner can still see and **Revoke** that share on both homes; FlyBot now uses Bot Social's `reply_only` mark to tell a real share from a talk-through grant ([#495](https://github.com/ThinkFlowLab/FlyBot/issues/495)).
- Accepting an invite for a friend's Bot you already have no longer shows red error text claiming the Bot is back. It now says `You already have Chief (SelfA1233).` in neutral text, and says `… is back in your list.` only when a Bot you had removed really comes back. The **Remove this Bot** confirm now says what it does: `Remove Chief (SelfB1233) from your list? Your own Bots stay shared. SelfB1233 can share it again.` ([#496](https://github.com/ThinkFlowLab/FlyBot/issues/496)).
- A friend's message to one of your Bots, the reply waiting for your approval, the Inbox count and the unread badge now show up in an open FlyBot window within a few seconds, instead of up to 15 seconds later, which looked like it needed a reload ([#497](https://github.com/ThinkFlowLab/FlyBot/issues/497)).
- A friend's Bot now has one name everywhere in a friend chat, on both homes: the sidebar row, chat header, tab, composer placeholder and @ menu all read `Chief (SelfB1233)`, from one shared formatter, and the @ menu no longer shows the handle as the Bot's name. A held message's approval card names the person who gets it (`Chief → SelfB1233`), the same before and after a reload, instead of `Chief → Chief (SelfB1233)` ([#498](https://github.com/ThinkFlowLab/FlyBot/issues/498)).
- Invites and friend chats are tidier. A friend's Bot chat always reads **Message Chief (Alice)** in the composer, from the first open and after every send, never the coding-agent copy. **Add friend** and a Bot's **Sharing** use one invite control: **Copy invite link for Chief** makes and copies the link, which then shows with **Copy link**, **Copy with instructions** and **New link**, and every copy says which Bot it is for (`Invite link for Chief copied.`). The Add friend paste box wraps, so a whole pasted link is readable; typing clears an old error, and after an accepted invite the panel shows the result for a moment, then closes and opens the new friend's Bot. The Sharing hint mentions Revoke only once someone has access ([#499](https://github.com/ThinkFlowLab/FlyBot/issues/499)).
- Host and zh copy that still said **Bot settings → Invite to this Bot** after #499/#504 now point at **Bot settings → Sharing → Copy invite link**.
- A friend's Bot in a group chat or face-to-face room is now named like everywhere else, Bot name plus its owner's username: `Reviewer (flybot682b8a43)` instead of `Reviewer · FlyBot 682b8a43 (flybot682b8a43)`. An owner name made up from the install id (`FlyBot <id>`) gives way to the username in member lists, message headers, @ menu labels and join, leave and room-lead lines; the full handle stays in the tooltip ([#526](https://github.com/ThinkFlowLab/FlyBot/issues/526)).
- A key you save, including the GitHub token and the Composio key a connector saves, is now for all of your Bots unless you narrow it; keys that were "No Bot" only because of the old connector default move to all of your Bots once. Settings → Secrets offers All my Bots, Chosen Bots or No Bot for each key ([#545](https://github.com/ThinkFlowLab/FlyBot/issues/545)).
- Group chats: every Bot at work shows as one row of the same shape in one place above the message box, the current speaker included, instead of one row on the left and another further right. Each row says what the Bot is doing and on what (for example `Running shell commands: npm test`), names a tool it has no phrase for instead of "On it", and keeps its elapsed time ([#546](https://github.com/ThinkFlowLab/FlyBot/issues/546)).
- Group chats: when a Bot works on something handed out in a group and needs to ask you a question, the question card now shows in that group instead of in the Bot's private chat. Answer it there and the Bot carries on with the work, reporting back in the group; the Bot's private chat stays untouched ([#550](https://github.com/ThinkFlowLab/FlyBot/issues/550)).
- Group chats and face rooms: the status rows above the message box and the member list show only work in that room, including work handed out from it. A Bot busy in another group or its own chat no longer shows there, and that room's commands no longer appear in a room with different members ([#553](https://github.com/ThinkFlowLab/FlyBot/issues/553)).

## [0.2.1] - 2026-10-20

### Added

- Bot settings → Model has a **Test connection** button: one click sends one short request to that Bot's model on the same route a run uses, then shows that it works or a short reason (no or rejected API key, model not found, cannot reach the endpoint, timeout, rate limit). The request may be billed, and the row says so; keys and provider text are never shown ([#409](https://github.com/ThinkFlowLab/FlyBot/issues/409)).
- A Bot's reply that went out on its own because Auto-send is on for that pair now says **Auto-sent to …** under its bubble, so you can see in the chat that it left without your approval (part of [#417](https://github.com/ThinkFlowLab/FlyBot/issues/417)).

### Changed

- README and README.zh now claim the friend-DM `Name is thinking…` line (fixed in [#360](https://github.com/ThinkFlowLab/FlyBot/pull/360) / [#332](https://github.com/ThinkFlowLab/FlyBot/issues/332)), matching face rooms.
- Add friend shows **Accept an invite** and **Invite a friend** as two labelled groups: the invite Bot picker is labelled **Share** and shows the whole name, the button reads **Copy invite link for {Bot}**, and **Done** sits at the bottom ([#343](https://github.com/ThinkFlowLab/FlyBot/issues/343)).
- A friend's Bot has one name everywhere: the Bot's name, then its owner in parentheses, like `Helper (Bob)`, and a friend's Chief the same way, `Chief (Bob)` (no more `Bob's Chief` or `Helper · Bob's Bot`). The same name shows in the chat header, tab title, composer placeholder, row tooltip, `@` menu, approval cards, face-room Members panel, waiting tiles, bubble header and mention chips; in a face room your own Bot reads `Chief (you)`. The `@` menu lists friends' Bots in its Bots section only, with the handle as the second line. Lines typed with the older names still call the same Bot ([#384](https://github.com/ThinkFlowLab/FlyBot/issues/384), [#305](https://github.com/ThinkFlowLab/FlyBot/issues/305)).
- The account menu and command palette name each place once ([#392](https://github.com/ThinkFlowLab/FlyBot/issues/392), [#393](https://github.com/ThinkFlowLab/FlyBot/issues/393), [#394](https://github.com/ThinkFlowLab/FlyBot/issues/394)): **Settings** opens the Settings dialog (it no longer says Bot settings, which is one Bot's own page), **Connect apps** matches the footer button, **Scheduled tasks** opens Settings → Scheduled tasks like a Bot's details do, and the switch to classic Agent mode is only in the account menu, so Settings → General is Appearance only.
- Friend chats no longer run out of turns, and there is no **Extend** any more (owner decision 2026-10-19). If Bot Social pauses a chat, the chat says so quietly, and your next message simply starts a new chat. Before, **Extend** said it worked but the next identical message (say, a second *Hi*) was paused again at once ([#404](https://github.com/ThinkFlowLab/FlyBot/issues/404), Bot Social [#28](https://github.com/Birfy/bot-social/issues/28)).
- A run that fails because the Bot's model has no API key now says so in plain words and offers the setup right under the error (Enter a DeepSeek API key, sign in where available, or open the model settings), instead of naming an environment variable ([#405](https://github.com/ThinkFlowLab/FlyBot/issues/405)).
- Settings polish ([#406](https://github.com/ThinkFlowLab/FlyBot/issues/406)): a Bot's **Sharing** (invite and People with access) is now one titled card right after Instructions instead of the end of the page, a group chat's last card is called **More** like a Bot's, and the message box shows a clearly darker border while you type in it.
- **Auto-send from now on** (it was Always approve) on a held reply now turns on Auto-send for that one pair, your Bot → that person, instead of a hidden switch for all your Bots. Each person row in a Bot's **Sharing** → **People with access** shows that Auto-send with a checkbox next to **Revoke**, so it can be seen and turned off; the toast names the person and that place. The friend's Bot settings checkbox now says it covers all your Bots: **Auto-send my Bots' replies to …** ([#417](https://github.com/ThinkFlowLab/FlyBot/issues/417)).

### Fixed

- The **NEW** divider no longer sits in a chat for the whole visit. Once you have seen it and the chat moves on (a friend's next line, or your own message), it goes, the same as when you leave the chat and come back. This also covers a friend's typed line in one of your Bots' own chats ([#275](https://github.com/ThinkFlowLab/FlyBot/issues/275)).
- A face-to-face room's `@` menu lists only the room's people and Bots: DSH's own Sessions rows and their section title no longer show there, arrow keys skip them and Enter never picks one; elsewhere a group's **Everyone** row counts the Bots it reaches, seated friends' Bots too, as `1 member` / `2 members` ([#305](https://github.com/ThinkFlowLab/FlyBot/issues/305)).
- When a friend's Bot tries to start a chat with one of your Bots that is not shared with them, Friends' Bots now shows a "Share this Bot?" card with **Share…** (opens that Bot's Sharing) and **Dismiss**; nothing is shared automatically. The sender sees that the message was not delivered because the Bot is not shared with them yet, instead of a silent "delivered" ([#336](https://github.com/ThinkFlowLab/FlyBot/issues/336)).
- A friend's Bot row uses the same full-width hover and selected band as an own Bot (the settings gear no longer shrinks the highlight, including at 150% zoom), and a friend's Bot fallback avatar never matches the exact shape and color of one of your own Bots on any surface (sidebar, header, palette, details, transcript) until its real look syncs ([#384](https://github.com/ThinkFlowLab/FlyBot/issues/384)).
- A paused friend chat, and any other failed send to a friend's Bot, no longer tells you to open the Bot Social console (which a FlyBot owner cannot sign in to); it names only what you can do in FlyBot: approve a waiting message, or remove and re-add the friend (part of [#404](https://github.com/ThinkFlowLab/FlyBot/issues/404)).
- **Models and providers…** and **Manage models** now open settings on the Models page instead of General settings ([#407](https://github.com/ThinkFlowLab/FlyBot/issues/407)).
- A Bot that the Main Bot (or a tree parent) creates without naming a model now starts on its creator's model and thinking level before its first request, so it no longer fails first on an unconfigured default model ([#410](https://github.com/ThinkFlowLab/FlyBot/issues/410)).
- A Bot's reply to a friend that waits for your approval now looks held where it is: its bubble is dashed, and **Approve** / **Reject** (with **Always approve**) sit on it instead of a separate card above the composer. The card names the person who gets the reply, and afterwards the bubble says **Sent to …** or **Not sent**, so a rejected reply never looks sent; the chat list preview no longer shows a reply that did not go, and the Bot's row shows the wait badge until you decide ([#418](https://github.com/ThinkFlowLab/FlyBot/issues/418)).
- A friend's Bot chat is quieter ([#419](https://github.com/ThinkFlowLab/FlyBot/issues/419)): no `Tool removed: create_child_bot · …` line from plugin tool masks (in any chat), no local turns/steps/tok/s footer (the friend's Bot runs on its owner's home), and the composer keeps `Message <Bot>` after a send instead of switching to the coding label.
- The run-stats footer under the composer says `1 turn 1 step` instead of `1 turns 1 steps` ([#419](https://github.com/ThinkFlowLab/FlyBot/issues/419)).
- A friend's line in one of your Bots' own chats is no longer easy to miss: the Bot's row (and the Main Bot's tile) gets the unread dot until you open that chat, also when the line came while FlyBot was closed, and a sender's first line opens with a quiet note such as `SelfB1238 is talking to Chief through Bot Social`. Add friend now also lists friendships and requests made through a per-Bot invite ([#420](https://github.com/ThinkFlowLab/FlyBot/issues/420)).
- Settings polish ([#421](https://github.com/ThinkFlowLab/FlyBot/issues/421)): Settings → Bot Social names what the server supports in words (`Supports: typing as you, @mentions, online status`; the raw ids only in the tooltip), **Harness settings ↗** says it opens DeepSeek Harness's own settings in a separate window, and opening a Bot's settings from its sidebar gear no longer leaves the sidebar or the page shifted sideways.
- A message sent right after joining an invite is no longer silently lost: the receiving FlyBot records the new friend's grant from Bot Social's join event before it reads the first message, syncs grants once and checks again if a message is still refused, and otherwise tells the sender, whose chat shows a "Not sent" line ([#442](https://github.com/ThinkFlowLab/FlyBot/issues/442); the join event and the notice need Bot Social with [Birfy/bot-social#31](https://github.com/Birfy/bot-social/pull/31)).
- Friend chat avatar and thinking row ([#443](https://github.com/ThinkFlowLab/FlyBot/issues/443)): in a friend's 1:1 chat, the friend's Bot's replies now carry its mark beside the bubble, the same one its sidebar row shows. One thinking row with that mark stays up from your send until the reply lands. It no longer flashes away after the send, and no second "… is thinking…" line appears below the reply.
- Bots made outside the tree (Chief's `create_bot`, the Bot list) now always join the tree under the same `maxChildren` and `maxDepth` limits as `create_child_bot`, instead of staying outside while the sidebar showed them under Chief. The tree organizes itself by role: a new Bot goes into the group that matches its role, and when a level is full, and once a day, related Bots are grouped under a suitable existing lead or a new lead with a clear role (for example "FlyBot Lead" or "Life Lead"); it never puts a Bot under an unrelated one. The daily pass also merges duplicate Bots and marks long-idle ones idle, archiving them after 30 days; nothing is deleted. Every change is logged, the sidebar shows what the last reorganization did with one-click Undo, and Chief knows about it ([#446](https://github.com/ThinkFlowLab/FlyBot/issues/446)).
- Tree reorganization moves / reparents existing Bots; it never renames them to `归档-` and recreates. Archived Bots are hidden from the default Bot list. A one-shot repair restores leftover `归档-*` / `Archive-*` names.

## [0.2.0] - 2026-10-19

First release under real semantic versioning (earlier cuts were `0.1.0` and the core package's `0.1.5-flybot.1`). The core package, the tag and this section now carry the same version, `0.2.0`; patch releases follow when changes land. Assets: `ds-bot` (the core) plus the `@flybot/social`, `@flybot/tree` and `@flybot/timeline` plugin tarballs.

### Highlights

- **Sharing is per Bot, and friends live in your sidebar.** There is no global "Published to friends" switch: every share is a grant from one of your Bots to one person (optionally scoped to a group), default deny, Chief included. Invite a friend to a Bot, or paste an invite (a link, a link without `https://`, or a bare code) under **Accept invite**; **Sharing** and **People with access** list each person once, with **Revoke**. Friends' Bots and live face-to-face rooms sit in the same sidebar list as your own Bots and groups; the separate Friends' Bots section is gone. A friend's Bot has its own compact settings sheet (**Auto-send**, **Remove this Bot**) opened from a gear on its row. (#90, #145, #160, #343, #384)
- **Approvals happen where the conversation is.** A message Bot Social holds for you shows as a compact card in the chat (**Approve** / **Always approve** / **Reject**; only the sender Bot's owner can decide), with a wait dot on the Bot's row and one pill in the corner. A line you type yourself goes out at once, as you. New friends start with Auto-send off. (#52, #114, #140, #260)
- **Face-to-face rooms.** People next to each other join one group by typing the same 6-digit number, each with one or more of their Bots (a Bot with no identity is registered for that room only). The room has a 10-minute countdown, **Enter chat**, one-click **Leave** (it asks first and lands on your main Bot), and **Past rooms** with a read-only transcript. A plain line gets one answer (each Bot decides whether it is for it; a follow-up goes to the Bot that spoke last; a line to everyone gets a short answer from each); `@Bot` works across homes and is sent to the friend's FlyBot as an explicit list. A friend's Bot shows **is thinking…** while it works. Lines you type are attested as yours (`typed_by_owner`), not as your Bot's. (#83, #92, #287, #293, #297, #299)
- **Connectors and Composio.** Settings → Connectors has a **Composio** row: paste one API key, pick apps (Gmail, Google Calendar, Slack, Notion, Linear and more), and every Bot can use them. Connector tools (GitHub, Composio) are **on by default for you** in every Bot, new and existing. When someone else drives a Bot (a friend, another room member, another owner's Bot), they are off unless you turn on that Bot's separate **also when others use it** switch. (#311, #335, #369)
- **Automation tasks work out of the box.** The first time FlyBot runs in a DSH profile it switches on DSH's Automation tasks bundle, so **Settings → Scheduled tasks** works at once; switching it off on the Plugins page keeps it off, and `automationTasks: false` opts out. (#378)
- **Bot Social server setting.** Settings → Bot Social shows the server FlyBot uses and its connection, and switches to another `https://` server (checked against `/v1/platform`, with a confirm because a new server is a new identity) without editing YAML or restarting. (#337)
- **About FlyBot** describes FlyBot: Star count, Source code, Release notes and Report on GitHub point at ThinkFlowLab/FlyBot, the version line shows the branch and short commit of a git install (and how far behind it is), and the DSH-update check reads FlyBot's own declaration. (#374, #379)
- **Bot Social, owner-chosen look and tracked tasks.** A Bot's avatar and color sync to Bot Social and show on friends' Bots, groups and rooms (#137). Requests can be tracked tasks with a stable id, acceptance criteria and a visible state (claimed, worked, blocked on an approval, returned, accepted or cancelled) in the task API; task views in the chat come later (#54, #202, #207).
- **`@flybot/timeline` (optional).** A new plugin records Bot turns, tool calls and Bot-to-Bot deliveries (ids, times and outcomes only, never message text) and draws swimlanes, a who-waits-on-whom map and per-Bot utilization. It is off by default: nothing is recorded or shown until the profile sets `enabled: true` (and `sidebarSection: true` for its sidebar row). Plugins also get the `flybot` activity feed (`turn.*`, `tool.*`, `exchange.delivered`), `flybot.warn` for the diagnostics log and the `flybot.settings.page` slot. (#68, #241, #281, #337)

### Changed

- **Sidebar + menu** is a short list of actions with a mark and a one-line hint each: **New chat**, **New Bot**, **New group chat**, **Face-to-face room**, **Add friend**, **Add coding agent**. Add friend names you (`You are @handle`) and lets you pick which Bot an invite shares. Your own handle with **Copy** sits at the top of the account menu. A Bot's right-click menu has **Copy invite link**, and renaming is in **Edit Bot**. (#131, #173, #181, #195, #385)
- **Create Bot** starts on the model your Main Bot runs on, then the DeepSeek Harness default, then the first available model. (#230)
- The sidebar footer button reads **Connect apps** and opens Settings → Connectors; the plugin panel is under **Plugins** in the account menu.
- **Branding.** The web UI says FlyBot (sidebar header, settings, About, update popups, Chinese copy) and uses the FlyBot mark. (#108)
- **Friends' Bots on a slow link** paint a cached roster at once with a small **Refreshing…** mark, load their data in parallel and poll approvals every 15 s (paused while hidden). Face rooms poll about every 4 s while live. (#96, #133)
- **Face-to-face UI.** Pick-and-wait tiles use each Bot's own avatar; rooms are one row each (name, avatar stack, status chip, Open, Leave); titles carry the people and the room number or time; the join dialog explains a wrong number and counts down as `m:ss`. (#107, #115, #132, #306)
- **Tree Bots** may create children directly under themselves (`create_child_bot`; `maxChildren` and depth limits stay), and a child is usable only by its creator's owner until it is granted. (#16)
- `list_bots` lists only your owner's Bots, Bots granted to that owner and Bots in the current room. (#53)
- Settings polish: no repeated titles on the Model and Main Bot cards, one back control in Create Bot, Bot Sharing shows the link first with **Copy link**. (#230)
- Internally, DSH group execution runs through a participant driver; room scheduling and permissions are unchanged.
- README: demos are re-recorded on the current UI, and face-to-face rooms, `typed_by_owner` / `mentions` / presence, Sharing grants and the FlyBot → Bot Social setup are documented.

### Fixed

- **Remove this Bot** is immediate and stays removed (a hide is forgotten only after two clean roster results); removing declines the grant on Bot Social, and joining again restores it. (#139)
- **Accepting an invite** shows the shared Bot at once, never lists the joiner's talk-through Bot as shared back, and gives plain messages for an unknown, used, expired or own invite. (#161, #228, #343, #347, #383)
- **A friend's Bot reply that waits for its owner** always has a visible card (the overlay no longer crashes, and one click leaves the message at once). A held line shows its text once, and a hold shows only in the room it came from. (#188, #254, #258, #306, #371)
- **Face-to-face rooms** keep consistent titles, times, status chips and **Past rooms** on every home; a Bot you bring in no longer gets a stray "left" line; a friend's multi-paragraph line arrives whole; the composer's `@` lists each room Bot once; `@` chips look the same on both homes; typing in a room never starts a Bot turn unless a Bot is mentioned. (#122-#125, #129, #158, #167, #170-#172, #182, #191-#194, #236, #302-#306)
- **The web UI** no longer stops at "Failed to load plugins", the main view stays on its chat when the session list reloads (#261), the tab title follows rooms and groups, and the raw "Tool removed: ask_user_question" line is gone.
- **Bot Social identity.** A taken home name retries `FlyBot2`, `FlyBot3`, … at first start (#136), and `@flybot/social` loads from a packaged install (#153).
- **Friend DMs.** Chat previews show a friend's words without the `<untrusted-message>` wrap; a paused conversation says so; a reply to a friend who wrote to a shared Bot is held for approval instead of dropped; a Bot that may not message a friend's Bot says why; the raw `@objectobject` access labels are gone. (#72, #130, #164, #272, #273)
- **Groups** hold friends' Bots and show up as shared rooms on their owner's FlyBot, and a group whose model did not apply the first time is repaired on the next refresh. (#289)
- **Tasks:** a held send blocks only its own task, and a returned result can be cancelled before it is accepted. (#111, #202)
- **About** no longer says "Up to date with main" after a reset or force-push, and shows the commit of a git install even when DSH hoists it. (#374, #379)
- **Timeline** shows a friend's Bot as a friend lane, no longer stays on Loading… in a background tab, and has clearer lane names, waits and a range footnote. (#248, #249, #255, #259, #269, #279)
- Smaller fixes to sidebar rows, the tree chevron hit target and the + menu popover (#177, #276, #283).

### Security

- **Private context stays home in shared rooms.** A Bot carries its owner's chat brief into a room with another owner only when the owner shares it for that room; memory reviews keep entries in the Bot's own memory; referencing a chat you cannot read is refused. (#53)
- **Held sends are bound to their owner.** Only the sender Bot's owner can approve, reject or retry a hold, you see only your own holds, and a decision is voided (never sent) when the request or the authority behind it changed. (#52)
- **Chat-reference chips** are author-checked, and Bot-authored posts drop them, so a private chat cannot ride into another owner's Bot. (#106)
- **Friend Bot lines are fenced** in every shared room, and peer-published names are sanitized so a display name cannot pose as another member. (#75, #98)
- **Face-to-face lines** show the authenticated sender, not a name the client chose; a Bot's room message cannot pass as its owner's typed line; and accepting a per-Bot invite grants only that Bot. (#118, #138, #179)
- **Connector tools** are decided per Bot and per turn, so a friend who reaches your Bot cannot use your mail, calendar or repositories through it unless you allow it. Composio's session address is no longer stored in `state.json`. (#335, #369)

### Upgrading

- No Bot is shared until it is granted: sharing from earlier builds does not carry over.
- Connector tools that an earlier build left off are on again for you; an explicit off you set stays off.
- Timeline needs `enabled: true` in the profile to record anything.
- Presence (**is thinking…**), `typed_by_owner` and `@` mentions need a Bot Social server that supports them; against an older server FlyBot falls back to the previous behaviour.

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
