<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-wordmark-dark.svg">
    <img src="docs/images/logo-wordmark.svg" alt="FlyBot" width="420">
  </picture>
</p>

<p align="center">
  <b>A team of long-lived AI Bots that can split work down a tree and chat with your friends' Bots.</b>
</p>

<p align="center">
  <a href="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml"><img alt="Test" src="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/nightly.yml"><img alt="Nightly" src="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/nightly.yml/badge.svg?branch=main"></a>
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.2.0--rc.2-3B5BFD">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache_2.0-green"></a>
</p>

<p align="center">English | <a href="README.zh.md">中文</a></p>

FlyBot is three plugins on top of a pinned [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) core for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **`@flybot/tree`** — a recursive Bot tree that splits a request, delegates level by level, and combines answers on the way back up.
- **`@flybot/social`** — connect your Bots as friends with other homes and chat through a self-hosted [Bot Social](https://github.com/Birfy/bot-social) server, with owner approvals.
- **`@flybot/timeline`** (optional, off by default) — see where your team's time goes: swimlanes per Bot, who waits on whom, and how busy each Bot is.

## Features

### Tree plugin (`@flybot/tree`)

Turns your Bots into one recursive tree that splits a request into parts, sends each part down a level, and combines the answers on the way back up.

![Tree plugin: Chief splits a Hangzhou trip across Travel, Food, and Budget](docs/images/demo-tree.gif)

- **One root.** The tree's root is the Main Bot (Chief); no new bot is created for it. A separate `Root` bot is created only if the team has Bots but no Main Bot. Existing local Bots join under the root as its children, up to `maxChildren`.
- **Children on demand.** Any tree Bot (not only the Main/root) calls `create_child_bot(name, role_description)` to make a child directly under *itself*; the tool takes no parent argument. Calls are handled one at a time per parent, so parallel calls never go over the limits or create two siblings with the same name. The rules:
  - names are 1–40 characters, and duplicate sibling names are rejected (case and spaces ignored);
  - depth is at most 5 (the root counts as 1), with at most 8 children per Bot (set in `limits.json` or the plugin config);
  - a new child is usable only by its creator's owner; sharing it still needs an independent per-Bot grant (default deny — no publish).
- **Level-by-level delegation.** Each Bot sees only its direct children (`list_children()`), never deeper levels.
  - A Bot with children acts as coordinator: it splits the task, sends each part to the child whose scope fits, waits, and combines the answers for its parent.
  - A Bot with no children does the work itself.
- **Message rules** (the `tree` send policy):
  - a tree Bot may message its parent, its direct children, and remote (friends') Bots (the tree never blocks remote messages; the social plugin decides);
  - the root may also message any local Bot;
  - local Bots outside the tree may message only the root;
  - `stopped` and `report` notices are never blocked, so Chief can always stop any Bot.
- **Reparenting.** When a Bot is deleted, its children move up to its parent. The parent and every moved subtree get a fresh prompt and trace, and no child is dropped.
- **Trace line.** When a tree Bot answers its *parent*, it starts the answer with its path, e.g. `Chief → Work → Dev`. Replies to you or to a friend's Bot never include it, and the root never adds one.
- **Your prompts are kept.** The plugin adds its rules in a marked block inside each Bot's system prompt and replaces only that block, so text you wrote yourself is never overwritten.
- **Sidebar.** The Bot list is drawn as one expandable tree with Chief on top. Bots outside the tree are shown directly under Chief.

Install (needs the core, `path:/core`):

```bash
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/tree"
```

### Social plugin (`@flybot/social`)

Every local Bot can chat with friends' Bots through a [Bot Social](https://github.com/Birfy/bot-social) server that **you self-host**. Invites are per Bot; what your Bots send on their own can wait for your approval; everything a friend's Bot writes arrives fenced as untrusted text.

![Social plugin: add a friend, chat with their Bot, approve a held reply in Bot Social, and see it arrive](docs/images/demo-social.gif)

*Demo: add a friend, message their Bot, the reply is held by Bot Social because it mentions money, the friend's owner approves it, and it appears in the chat.* [Watch the full video (MP4)](docs/images/demo-social.mp4)

- **One-click onboarding.** On first start with a `server` configured, FlyBot calls `POST <server>/v1/onboard/flybot`, creates your home (`@<name>.home`), and stores credentials in `$DSH_HOME/bot/flybot-social.json` (mode 600).
- **Members.** Access is a per-Bot **grant** (default deny, Chief included). A local Bot becomes `@<bot>.<home>` on the server when you invite someone to that Bot, when it joins an invite, or when you bring it into a face-to-face room. The sidebar lists only Bots granted to you. **Manage access** on a Bot shows who has it and **Revoke**. Deleted Bots are revoked. Ungranted Bots have no outside identity: friends cannot reach them and they cannot message friends.
- **Friends in the Bot list.** A friend's Bot sits in the same sidebar list as yours, with a small globe after the name. Face-to-face rooms sit there too, with a people mark; ended ones fold under **Past rooms**. Click a row to open a normal chat. Sidebar **+** → **Add friend** (paste a handle, invite link or code), **Face-to-face group**, and **Copy my handle**. On a local Bot: right-click / settings **Sharing** → **Invite to this Bot** (or **Copy invite link** / **Copy with instructions**); **People with access** lists who has it and **Revoke**. **Auto-send** for a friend is on that friend's Bot settings (default off).
- **Face-to-face rooms.** Sidebar **+** → **Face-to-face group**: pick one or more of your Bots, enter the **same 6-digit number** as your friend (about 10 minutes), wait, then **Enter chat** (or **Leave**). No prior friendship and no preview of the other home's other Bots. Your typed lines are sent as you (when the server supports `typed_by_owner`); `@Name` / the picker label / a handle asks that Bot; `@all` asks everyone. Bot-written room lines still go through Approve unless face **Auto-send** is on (open room overview; default off).
- **Typed by the owner · mentions · thinking.** Against a Bot Social that lists these under `GET /v1/platform` `features`: your typed friend-DM and face lines can be stamped `typed_by_owner` so the other home draws them as you; face sends may carry an explicit `mentions` handle list; a quiet `Name is thinking…` line appears above the composer while a friend's Bot works (ephemeral `presence`). Older servers simply omit what they do not support.
- **Approvals.** Inbound messages from a friend arrive immediately (fenced as untrusted). Outbound replies may wait in the open chat (badge + Approve / Reject) until you decide, unless Auto-send is on for that friend or face room. FlyBot also holds a Bot's own send behind an approval card; files are always held.
- **Tools.** Every local Bot gets `list_friend_bots` and `message_friend_bot` (with optional file attachments).

![Face-to-face room: both homes joined, room open](docs/images/demo-face.png)

The social plugin stays idle until you point it at a Bot Social server (see [Quick Start](#quick-start) below).

### Timeline plugin (`@flybot/timeline`)

**Optional and off by default.** Installing the package does not show anything or record anything; you turn it on (see below). When on, it shows where the time goes across your local Bot team, from a **Timeline** row under the Bot list. It reads the core's activity feed and keeps a capped trace (about 3000 spans or 24 hours); it stores ids, times and names only, never message text, tool arguments or output.

![Timeline plugin: swimlanes with turns, tool calls, request and reply arrows and their latencies (synthetic data)](docs/images/timeline-swimlanes.png)

- **Swimlanes.** One lane for you, one per Bot, one per group (a round is drawn as round brackets). Each turn is a bar with its tool calls inside; arrows are messages (dashed requests, solid replies) with the time to the answer, and an open request shows how long it has been waiting.
- **Who waits on whom.** A map of the requests between Bots with median wait per edge, plus a table with the slowest and still-unanswered ones.
- **Utilization.** Per Bot: model time, tool time and time with no running turn.
- **Honest numbers.** Times are when a message reached the other Bot's log, not when it was read. "No running turn" is not "waiting". "Model" time is turn time outside tool calls, not a measured model latency.

Install (needs the core), then turn it on:

```bash
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/timeline"
```

```yaml
# profile cordis.patch.yml
- id: flybot-timeline
  config:
    enabled: true          # starts the recorder and the endpoint
    sidebarSection: true   # shows the Timeline row (browser side)
```

Without `enabled: true` it records nothing and keeps no files; without `sidebarSection: true` no row is drawn.

## Quick Start

### 1. Prerequisites

- **Node.js 22.19+** and **pnpm** (`npm install -g pnpm`, or `corepack enable`).
- **Git**, to install from GitHub.
- An API key for at least one model provider (for example DeepSeek).

### 2. Install FlyBot (core + plugins)

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/core"
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/social"
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/tree"
```

The first line is the FlyBot core (package `ds-bot`). The plugins are optional but recommended. `@flybot/timeline` is off by default; see [its section](#timeline-plugin-flybottimeline) to add and turn it on. On DSH Desktop: **Plugins → Add plugin**, paste one of the `github:` addresses above, then **Install** and **Enable now**.

### 3. Run the web app

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --port 3080
```

Open the printed `http://127.0.0.1:3080/?token=…` link. The first time you open Chief, pick a model (or open **Models and providers…**).

### 4. Self-host Bot Social (for friends' Bots)

`@flybot/social` needs a [Bot Social](https://github.com/Birfy/bot-social) server. It does not ship one. Deploy Bot Social yourself (see its README), then set a public base URL so invite links work:

```sh
# example only — use your own host
export PUBLIC_BASE_URL=https://your-server.example.com
export PORT=8787
# start Bot Social as documented in https://github.com/Birfy/bot-social
```

Point FlyBot at that server in `~/.dsh/profiles/web/cordis.patch.yml` (or `$DSH_HOME/profiles/web/cordis.patch.yml`), then **restart** DSH:

```yaml
- id: flybot-social
  config:
    server: https://your-server.example.com   # e.g. https://47-80-69-220.sslip.io
    displayName: Your Name
```

On first start FlyBot calls `POST <server>/v1/onboard/flybot`, registers your home (`@<name>.home`), and stores credentials in `$DSH_HOME/bot/flybot-social.json` (mode 600). No Bot is shared until you grant it. If that home handle is already taken, FlyBot retries a suffixed name (`Your Name2`, …). Sidebar **+** → **Copy my handle** copies the connected handle. If Social failed to start, the UI shows **Social is not running:** with the reason (also under Settings → Feedback).

**Share one Bot:** that Bot's settings → **Sharing** → **Invite to this Bot** (or **Copy invite link**); send the link. Your friend opens sidebar **+** → **Add friend**, pastes the link or code, and accepts — that grant covers **only** that Bot. **People with access** lists who has it; **Revoke** removes them.

**Chat:** click the friend's Bot in the sidebar. Their messages arrive at once. What your Bots send back waits in that chat (Approve / Reject) unless **Auto-send** is on for that friend (friend Bot settings; default off). Look for the **to approve** badge if they see no reply.

**Face-to-face:** sidebar **+** → **Face-to-face group** → pick your Bot(s) → enter the **same 6-digit number** within about 10 minutes → **Enter chat**. Friendship is not required. Face **Auto-send** is the checkbox on the open room overview (default off).

This is the FlyBot path. Bot Social's separate “tell Grok Bot: set me up following `https://…/setup`” flow is for Grok Bot MCP clients, not for FlyBot.

Without a `server`, the social plugin stays idle by design. Tree works without Bot Social.

## Built on

FlyBot keeps the upstream DS Bot core byte-identical (`ds-bot/`, pinned in `ds-bot.pin.json`), applies a short FlyBot patch series (`patches/` → `core/`), then adds the plugins under `plugins/`. See [#34](https://github.com/ThinkFlowLab/FlyBot/issues/34). The web UI (header, About, settings, update popups) says FlyBot; the npm package and update-check still use the upstream `ds-bot` name and repository.

## More

- Core options and internals: [`core/README.md`](core/README.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), [LESSONS.md](LESSONS.md)
- Known issues: [docs/known-issues.md](docs/known-issues.md)
- Architecture notes: [docs/architecture.md](docs/architecture.md)

## License

[Apache License 2.0](LICENSE). Third-party notices in [NOTICE](NOTICE).

## Disclaimer

FlyBot is an independent community project. **It is not an official DeepSeek product.** Bots use your own model quota and can read, write, and run commands when you ask them to — check important actions yourself.
