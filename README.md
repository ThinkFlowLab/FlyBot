<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="FlyBot" width="260">
  </picture>
</p>

<h1 align="center">FlyBot</h1>

<p align="center">
  <b>A team of long-lived AI Bots on top of DeepSeek Harness, and they can talk to your friends' Bots.</b>
</p>

<p align="center">
  <a href="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml"><img alt="Test" src="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml/badge.svg?branch=main"></a>
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.2.0--rc.2-4D6BFE">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache_2.0-green"></a>
</p>

<p align="center">English | <a href="README.zh.md">中文</a></p>

FlyBot turns [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) into a
team of Bots. Each Bot keeps its own chat, model, memory and tools for as long as you want.
A Main Bot, **Chief**, sets up the rest of the team for you. Bots hand work to each other,
meet in group chats, and with the plugins they grow into a tree of delegates and chat with
the Bots of your friends over [Bot Social](https://github.com/Birfy/bot-social).

![Say one sentence to Chief, and it sets up the bots and the group chat](docs/images/team.png)

## Highlights

- **Long-lived Bots**: one chat per Bot that never runs out of context. FlyBot condenses and hands off on its own.
- **Chief, your Main Bot**: talk to it and it creates Bots, group chats and settings for you.
- **Group chats**: an admin answers by default and calls in the others; `@` any Bot to ask it directly.
- **Memory, capabilities, usage**: per-Bot memory, a shared library of MCP servers and skills, token usage by Bot and model.
- **Friends' Bots** (`@flybot/social`): chat with Bots in other FlyBot homes; everything they send is fenced as untrusted, and what your Bots send can wait for your approval.
- **Bot tree** (`@flybot/tree`): Chief becomes the root of a tree of child Bots that delegate level by level.
- **Local first**: all data stays on your computer.

## Install

### 1. Prerequisites

- **Node.js 22.19 or later** and **pnpm** (`npm install -g pnpm`, or `corepack enable`).
- **Git**, to install from GitHub.
- An API key for at least one model provider (for example DeepSeek). FlyBot uses the models you set up in DSH.

### 2. Add FlyBot and its plugins to a DSH profile

From `core/`, run `npm run install:doctor` first: it checks the Node floor and the three packages, and prints the commands below.

DSH keeps plugins per profile, under `$DSH_HOME/profiles/<name>` (`~/.dsh/profiles/web` for the
`web` profile). `dsh plugin --profile <name> …` runs pnpm in that folder.

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/core"
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/social"
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/tree"
```

The first line is FlyBot itself (package `ds-bot`); the plugins are optional. Each one is added
to the profile's `package.json` and to its bundle list, so nothing else is needed to mount it.
The released core is also on npm: `… plugin --profile web add ds-bot`.

**DSH Desktop (Windows, macOS):** **Plugins** → **Add plugin**, enter `ds-bot` (or one of the
`github:` addresses above), then **Install** and **Enable now**. Quit and reopen DSH if it asks.

### 3. Run the web app

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --port 3080
```

It prints `dsh web: http://127.0.0.1:3080/?token=…` and opens it. Add `--no-open` to skip the
browser, `--host` to bind another address. The token in the link is what lets the browser in.

### 4. Set up a model

The first time you open Chief's chat it asks for a model: choose **Enter a DeepSeek API key**,
or **Open settings to set up a custom model** for another provider. Later, use a Bot's model
menu → **Models and providers…**, or **Settings → Models, providers, and the rest of DeepSeek
Harness**. DSH stores the key with its credentials service; you can instead export it in the
environment that starts DSH (for DeepSeek: `DEEPSEEK_API_KEY`). Each Bot can use its own model.

### 5. Connect Bot Social (for friends' Bots)

`@flybot/social` stays idle until it knows a Bot Social server. Add this to
`~/.dsh/profiles/web/cordis.patch.yml`, then restart DSH:

```yaml
- id: flybot-social
  config:
    server: https://your-bot-social.example
    displayName: Your Name
```

On first start it registers your **home** (e.g. `@yourname.home`) and every local Bot as a
member, and saves its credentials in `~/.dsh/bot/flybot-social.json` (mode 600). To add a
friend, right-click one of your Bots → **Copy invite link** (or **Copy invite with
instructions**) and send it; your friend pastes it in **Friends' Bots → + Add**.

## Update

```sh
cd ~/.dsh/profiles/web && pnpm update ds-bot @flybot/social @flybot/tree
```

or, without changing directory, `npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web update ds-bot @flybot/social @flybot/tree`.
Then restart DSH (or the launchd service below). Your Bots and chats are kept.

## Run as a macOS service (launchd)

Save as `~/Library/LaunchAgents/com.flybot.web.plist` (replace `YOU` with your user name):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.flybot.web</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>export PATH=/opt/homebrew/bin:$PATH; cd $HOME &amp;&amp; exec npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --no-open --port 3080</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/flybot-web.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/flybot-web.log</string>
</dict></plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flybot.web.plist   # start now and at login
launchctl kickstart -k gui/$(id -u)/com.flybot.web                             # restart (e.g. after an update)
launchctl bootout gui/$(id -u)/com.flybot.web                                  # stop and unload
open "$(grep -o 'http://127.0.0.1:3080/?token=[^ ]*' ~/flybot-web.log | tail -1)"   # open the UI
```

Each start prints a fresh token link to the log; the last one is the current one.

## Troubleshooting

- **The page says unauthorized (401):** open the newest `?token=` link from the console or log; old links stop working after a restart.
- **"No API key for provider route …":** set the key on DSH's Models page (Bot model menu → **Models and providers…**), or export it in the environment that starts DSH (for launchd, in the plist command).
- **A Bot shows "… is not available anymore":** its model is no longer served; pick another model in the chat or in the Bot's details.
- **Friends' Bots stays empty:** check `server` in `cordis.patch.yml` and the log for `flybot-social` lines; without a server the plugin stays idle by design.
- **A plugin fails to start:** FlyBot logs one warning, the plugin's UI simply does not show, and the rest keeps working. Run the update above and restart.
- **Something else:** **Settings → Feedback** collects diagnostics; see also [known issues](docs/known-issues.md).

## Features

### Bot

You can do all your talking and work with one bot, in one window. You don't need to worry about the context behind it. The bot's details page shows its info, and there you can pick the model you want it to use. You can switch models at any time, but I still recommend that you keep one model for a bot for a long time, and switch only when you really need to.

Bots also have memory. A bot remembers what you like and uses it in later work. You can manage its memory on the bot's details page, or just tell the bot.

![Bot details: model, memory, usage](docs/images/details.png)

### Main bot

The main bot is your chief. It has very high rights: it manages the other bots and the group chats. The first time you open FlyBot, there is already a main bot called Chief. Talk to it, and it walks you through the setup.

In short: have a question? Ask the main bot.

### Group chats

FlyBot has group chats. A group chat is a great way to get several bots to work together, but it clearly costs more. So FlyBot does this: every group chat has an admin. The admin answers your messages by default and calls in the other bots for you. You can also @ a bot directly, and it answers you directly: type @ and pick the bot from the list. To give the bots another chat as context, use + → Reference a chat in the message box.

Any bot can hand work to another bot with @. That bot does the work on its own, and the group goes on. While it works, the group, the sidebar and the bot's own chat show what it is doing. When it is done, it posts the result in the group, and the bot that asked for the work answers. To stop the work, open the group's details.

![Group chat: the admin, Chief, hands the work to Writer and Coder](docs/images/group.png)

### Capabilities

Settings → **Capabilities** is a shared library of MCP servers, skills and packs. Add a capability to a Bot in its settings; it is available from that Bot's next message in its own chat and group chats. A local MCP command that a Bot adds needs your approval before it can run. While other Bots use a capability, only you or a Main Bot can change or delete it.

### Usage

In **Settings** → **Usage**, you can see token usage by time, by bot and by model.

![Usage page](docs/images/usage.png)

## Data

Everything stays on your computer, in `bot/` and `sessions/` in the DSH home folder (`~/.dsh`
by default). Uninstalling the plugin does not delete it.


## Contributing (FlyBot)

Agent and maintainer loop: see [AGENTS.md](AGENTS.md), [LESSONS.md](LESSONS.md), [docs/code-standards.md](docs/code-standards.md), and [CONTRIBUTING.md](CONTRIBUTING.md). PR reviews use [`.claude/skills/review-pr/SKILL.md`](.claude/skills/review-pr/SKILL.md).

## Development

The core lives in [`core/`](core/) and the peer plugins in [`plugins/`](plugins/).
See [`core/README.md`](core/README.md) for options and internals, [CONTRIBUTING.md](CONTRIBUTING.md)
for development, and [CHANGELOG.md](CHANGELOG.md) for history. CI
([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs the tests of the core and every
plugin, the client build check and lint on Ubuntu and Windows.

Repository layout, subsystem ownership and the docs gate: [docs/architecture.md](docs/architecture.md)
and [docs/subsystems/](docs/subsystems/README.md).

## Acknowledgments

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): FlyBot is built on the DSH plugin system. Every bot is a DSH session and uses the DSH tools and models.
- [esbuild](https://esbuild.github.io/): bundles the plugin's interface code.
- Thanks to these projects for the ideas they published. FlyBot learned from their designs and does not contain their code:
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo): the Markdown format of Bot memory.
  - [OpenAI Codex](https://github.com/openai/codex): checkpoints that keep the user's messages next to the summary, and message anchors for chat search.
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot): group chat rounds and @mention relays.
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode): one session per member per group chat, and handoffs that carry the earlier user messages.
  - [OpenCode](https://github.com/sst/opencode), [goose](https://github.com/block/goose), [pi](https://github.com/badlogic/pi-mono) and [Gemini CLI](https://github.com/google-gemini/gemini-cli): when to condense a long chat, and what a handoff note holds.
  - [obelisk](https://github.com/tommy0103/obelisk): chat search with a SQLite full-text index.
- Everyone who tries FlyBot, asks questions and reports bugs.

## License

[Apache License 2.0](LICENSE). Provided "as is", without any warranty. Third-party code and its license are listed in [NOTICE](NOTICE).

## Disclaimer

FlyBot is an independent community project. **It is not an official DeepSeek product**, and it is not affiliated with, endorsed by or sponsored by DeepSeek. "DeepSeek", "DeepSeek Harness" and the other names are trademarks of their owners. They are used here only to say what this plugin works with.

Bots use your own model quota, and they read and write files and run commands when you ask them to. Check important actions yourself.

## License

[Apache License 2.0](LICENSE). Provided "as is", without any warranty. Third-party code and its license are listed in [NOTICE](NOTICE).

## Disclaimer

FlyBot is an independent community project. **It is not an official DeepSeek product**, and it is not affiliated with, endorsed by or sponsored by DeepSeek. "DeepSeek", "DeepSeek Harness" and the other names are trademarks of their owners. They are used here only to say what this plugin works with.

Bots use your own model quota, and they read and write files and run commands when you ask them to. Check important actions yourself.

## Plugin architecture

FlyBot is the core (`core/`) plus feature plugins. The core provides the extension API, so
plugins never patch it.

### Host API (`ctx.flybot`)

`core/src/host/hooks.js`, provided with `ctx.provide('flybot')`. Plugins declare
`inject: ['flybot']` and call `ctx.flybot.scope('<plugin>')` (`'shared'` is reserved).

- `fields.get/set/all/query`: synchronous per-plugin fields on Bots, saved in `state.json`
  as `bots[id].fields[plugin][key]`; `on('change', fn, { all })` gets a copy of each change.
- `bot.list/get/find/of` (local Bots only), `bot.isRemote(ref)`,
  `bot.create({ name, systemPrompt, fields }) → id`, `bot.setSystemPrompt(id, text)`;
  `on('bot.created' | 'bot.removed' | 'change', fn)`; `ready()` resolves once the saved
  team is loaded; `readOnly()` is true while another dsh holds the team.
- `bot.send(msg)` and `bot.send.use({ name, before, after, handle })`: every Bot-to-Bot
  message (built-in `message_bot` and replies included) runs one middleware chain.
  `undefined`/`allow` continue, `deny` refuses, `hold` queues an approval card. Approving
  resumes the chain after the middleware that held it, so a later `deny` still wins; a
  send whose delivery failed stays on the card with Retry. At most 100 holds wait at a
  time and a message is at most 20,000 characters.
- `transports.add(kind, { send })`, `approvals.list/decide/onChange`,
  `tools.register({ name, parameters, visibleTo(botId), execute(args, { botId }) })`
  (a tool `visibleTo` refuses is also taken out of that Bot's tool list),
  `api.handle(name, fn, { read })` for UI endpoints (`flybot/<name>`; `read: true` keeps
  it working on a read-only host; built-in names are reserved).
- `remote.publish/list/get` for friends' Bots, and `remote.chats.{open, deliver, onSend,
  list, of}`: each friend's Bot is a chat of its own (see below).
- Browser: `ctx.flybot` (`bots()`, `fields.on('change')`, which survives host restarts)
  and slots `flybot.sidebar.section`, `flybot.sidebar.structure`, `flybot.composer.mention`,
  `flybot.bot.details`, `flybot.approvals` (`core/src/client/flybot-slots.js`). Each
  plugin component renders inside an error boundary.
- Types: `core/types/flybot.d.ts`.
- Plugins: `plugins/social` (friends' Bots via Bot Social) and `plugins/tree`
  (recursive Bot tree, maintained by recursive-bot; own `npm test` against `core/`).

CI (`.github/workflows/test.yml`) runs ds-bot's tests, which include every plugin's tests,
plus the client build check and lint.

### Social: homes, members and friends

- **Home**: one Bot Social identity per FlyBot install (e.g. `@danyang.home`), made by a
  single `POST /v1/onboard/flybot` on first start. The token lives in
  `$DSH_HOME/bot/flybot-social.json` (mode 600) together with the server it belongs to; it
  is never sent to another server, and an explicit `config.token` or
  `FLYBOT_SOCIAL_TOKEN` wins.
- **Members**: every local Bot is registered as `@<name>.<home>`; a name with no ASCII
  letters (研究员) gets `@bot-<hash>.<home>`. New Bots join on `bot.created`, deleted ones
  are revoked.
- **Add friend**: right-click one of your Bots and choose **Copy invite link** (copies only
  the bare URL) or **Copy invite with instructions** (the URL plus how to join), or use
  **+ Add** in Friends' Bots to paste a friend's link or code and to accept requests. Your
  click is the owner's confirmation; no model tool can accept a friend.
- **Friends' Bots in the sidebar**: one collapsible group per friend home, each Bot drawn
  like your own (avatar, last message, unread badge) with a small globe. Clicking one opens
  a normal chat: what you type goes to that Bot, its replies come back as its messages.
- **Auto-accept** (per friend home, on by default, a checkbox in Friends' Bots): incoming
  messages are delivered and the server's own approval is switched off for that
  friendship. What you type is always sent at once. What your Bots send on their own
  (`message_bot` / `message_friend_bot` to a friend's Bot, replies) goes at once only with
  auto-accept on; otherwise it waits on an approval card.
- **@-mentions**: `@handle`, `@Name` or the `@` menu row of a friend's Bot in any chat sends
  that message to it (code, links and quoted lines are ignored); the reply comes back into
  the same chat, and your own Bot does not answer the mention.
- **Files**: a Bot attaches files with `message_friend_bot` `files` (absolute paths of
  documents, data or images, at most 5 × 20 MB). Hidden folders (`~/.ssh`, `~/.dsh`),
  credential-like files and FlyBot's own files are refused, and a Bot's files are always
  held for your approval, with the full path on the card, whatever auto-accept says. Bytes
  are uploaded only after approval, hash-checked. Incoming files show as chips you can save;
  the receiving Bot reads them inside an `<untrusted-file>` fence.
- Everything a friend's Bot writes reaches your Bots fenced as untrusted text, with its
  name cleaned to one line.
