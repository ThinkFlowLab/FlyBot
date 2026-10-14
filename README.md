<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DeepSeek Bot" width="260">
  </picture>
</p>

# DeepSeek Bot

English | [中文](README.zh.md)

![version](https://img.shields.io/badge/version-v0.1_preview-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

DeepSeek Bot (DS Bot) is a bot plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It turns DSH into bots. You create your own bots, then talk and work with them.

![Say one sentence to Chief, and it sets up the bots and the group chat](docs/images/team.png)

## Install

First install DSH and set up at least one model in it. DS Bot uses the models from DSH.

**DSH Desktop (Windows, macOS)**

1. In the sidebar, select **Plugins** → **Add plugin**.
2. In **Package name or address**, enter `ds-bot`. In mainland China, set **Registry** to **Mainland China mirror**.
3. Select **Install**, then **Enable now**. If DSH says the change takes effect at the next start, quit DSH completely and open it again.

If npm is not reachable, in step 2 you can also enter the full path of `ds-bot-0.1.5.tgz` downloaded from [Releases](https://github.com/Fei2411/DeepSeek-Bot/releases), or `github:Fei2411/DeepSeek-Bot#v0.1.5&path:/ds-bot` (needs Git).

**DSH Web (Windows, macOS, Linux)**

Needs Node.js `22.19` or later, and pnpm.

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

## Setup

I strongly recommend that you set up your other bots and group chats by just talking to a bot.

## Features

### Bot

You can do all your talking and work with one bot, in one window. You don't need to worry about the context behind it. The bot's details page shows its info, and there you can pick the model you want it to use. You can switch models at any time, but I still recommend that you keep one model for a bot for a long time, and switch only when you really need to.

Bots also have memory. A bot remembers what you like and uses it in later work. You can manage its memory on the bot's details page, or just tell the bot.

![Bot details: model, memory, usage](docs/images/details.png)

### Main bot

The main bot is your chief. It has very high rights: it manages the other bots and the group chats. The first time you open DS Bot, there is already a main bot called Chief. Talk to it, and it walks you through the setup.

In short: have a question? Ask the main bot.

### Group chats

DS Bot has group chats. A group chat is a great way to get several bots to work together, but it clearly costs more. So DS Bot does this: every group chat has an admin. The admin answers your messages by default and calls in the other bots for you. You can also @ a bot directly, and it answers you directly: type @ and pick the bot from the list. To give the bots another chat as context, use + → Reference a chat in the message box.

Any bot can hand work to another bot with @. That bot does the work on its own, and the group goes on. While it works, the group, the sidebar and the bot's own chat show what it is doing. When it is done, it posts the result in the group, and the bot that asked for the work answers. To stop the work, open the group's details.

![Group chat: the admin, Chief, hands the work to Writer and Coder](docs/images/group.png)

### Capabilities

Settings → **Capabilities** is a shared library of MCP servers, skills and packs. Add a capability to a Bot in its settings; it is available from that Bot's next message in its own chat and group chats. A local MCP command that a Bot adds needs your approval before it can run. While other Bots use a capability, only you or a Main Bot can change or delete it.

### Usage

In **Settings** → **Usage**, you can see token usage by time, by bot and by model.

![Usage page](docs/images/usage.png)

## Data

All data stays on your own computer, in `bot/` and `sessions/` in the DSH home folder (`~/.dsh` by default). Uninstalling the plugin does not delete this data.


## Contributing (FlyBot)

Agent and maintainer loop: see [AGENTS.md](AGENTS.md), [LESSONS.md](LESSONS.md), [docs/code-standards.md](docs/code-standards.md), and [CONTRIBUTING.md](CONTRIBUTING.md). PR reviews use [`.claude/skills/review-pr/SKILL.md`](.claude/skills/review-pr/SKILL.md).

## Development

The plugin source is in [`ds-bot/`](ds-bot/). For options and internals, see [`ds-bot/README.md`](ds-bot/README.md). For development and tests, see [CONTRIBUTING.md](CONTRIBUTING.md). For changes between versions, see [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): DS Bot is built on the DSH plugin system. Every bot is a DSH session and uses the DSH tools and models.
- [esbuild](https://esbuild.github.io/): bundles the plugin's interface code.
- Thanks to these projects for the ideas they published. DS Bot learned from their designs and does not contain their code:
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo): the Markdown format of Bot memory.
  - [OpenAI Codex](https://github.com/openai/codex): checkpoints that keep the user's messages next to the summary, and message anchors for chat search.
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot): group chat rounds and @mention relays.
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode): one session per member per group chat, and handoffs that carry the earlier user messages.
  - [OpenCode](https://github.com/sst/opencode), [goose](https://github.com/block/goose), [pi](https://github.com/badlogic/pi-mono) and [Gemini CLI](https://github.com/google-gemini/gemini-cli): when to condense a long chat, and what a handoff note holds.
  - [obelisk](https://github.com/tommy0103/obelisk): chat search with a SQLite full-text index.
- Everyone who tries DS Bot, asks questions and reports bugs.

## License

[Apache License 2.0](LICENSE). Provided "as is", without any warranty. Third-party code and its license are listed in [NOTICE](NOTICE).

## Disclaimer

DS Bot is an independent community project. **It is not an official DeepSeek product**, and it is not affiliated with, endorsed by or sponsored by DeepSeek. "DeepSeek", "DeepSeek Harness" and the other names are trademarks of their owners. They are used here only to say what this plugin works with.

Bots use your own model quota, and they read and write files and run commands when you ask them to. Check important actions yourself.

## FlyBot plugin architecture

FlyBot is DS Bot (`ds-bot/`) plus feature plugins. ds-bot itself provides the extension
API, so plugins never patch it.

### Install FlyBot (clean profile)

Needs Node.js >= 22.19 and pnpm. Add ds-bot and the two plugins to a DSH profile, then
enable them in that profile's `cordis.patch.yml` (with the Bot Social server URL for social):

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:Birfy/FlyBot#flybot-plugins&path:/ds-bot"
npx @deepseek-ai/dsh plugin --profile web add "github:Birfy/FlyBot#flybot-plugins&path:/ds-bot/plugins/social"
npx @deepseek-ai/dsh plugin --profile web add "github:Birfy/FlyBot#flybot-plugins&path:/ds-bot/plugins/tree"
```

Update later with `pnpm update ds-bot @flybot/social @flybot/tree` inside the profile
folder, then restart DSH. A plugin that fails to start logs one warning; its UI slots
draw nothing and the rest of ds-bot keeps working.

### Host API (`ctx.flybot`)

`ds-bot/src/host/hooks.js`, provided with `ctx.provide('flybot')`. Plugins declare
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
  `flybot.bot.details`, `flybot.approvals` (`ds-bot/src/client/flybot-slots.js`). Each
  plugin component renders inside an error boundary.
- Types: `ds-bot/types/flybot.d.ts`.
- Plugins (`ds-bot/plugins/`): `social` (friends' Bots via Bot Social) and `tree`
  (recursive Bot tree, maintained by recursive-bot).

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
