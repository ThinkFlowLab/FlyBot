<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-wordmark-dark.svg">
    <img src="docs/images/logo-wordmark.svg" alt="FlyBot" width="420">
  </picture>
</p>

<p align="center">
  <b>Long-lived AI Bots that work as a team in your browser: one request goes in, the team takes it apart, one answer comes back.</b>
</p>

<p align="center">
  <a href="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml"><img alt="Test" src="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/ThinkFlowLab/FlyBot/releases"><img alt="Release" src="https://img.shields.io/github/v/release/ThinkFlowLab/FlyBot"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache_2.0-green"></a>
</p>

<p align="center">English | <a href="README.zh.md">中文</a></p>

FlyBot is a local team of AI Bots you run in your own browser, on top of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). You talk to one Bot — the **Chief**. It keeps
the rest of the team, hands each part of a job to the Bot whose role fits, and comes back with one answer. Every Bot
keeps its own memory, working folder, model and schedules between turns, so the team you set up on Monday is still
there on Friday.

## Is this for you?

**Yes, if** you want work that outlives one chat — a team that keeps its own notes, folders and schedules and picks
it up again tomorrow; you would rather run it yourself, on your machine, with your own model keys; or you want your
Bots to be able to talk to a friend's Bots.

**Probably not, if** you just need one quick answer (any chat app does that), or you want a framework to build your
own agents on — FlyBot is an app you run, on top of DeepSeek Harness.

## See it work

### One request, a whole team

![Tree plugin: Chief splits a Hangzhou trip across Travel, Food, and Budget](docs/images/demo-tree.gif)

*Demo: Chief starts alone in the sidebar, creates the child Bots Travel, Food and Budget, hands each one a part, and
then combines their answers into one plan. Some waiting is sped up.*
[Watch the full video (MP4)](docs/images/demo-tree.mp4)

- **You only talk to the Chief.** It splits the request and sends each part one level down; a Bot with children
  coordinates, a Bot without children does the work itself.
- **The tree grows itself.** Any Bot can create a child for a slice of work. Bots are grouped by role, duplicates
  are merged, and a Bot idle for 30 days is archived — never deleted, and each reorganization can be undone in one
  click.
- **You can always stop it.** A running turn ends on `stop_bot`, and no message rule ever blocks a stop.

### Your Bots and your friends' Bots

![Social plugin: invite a friend, message their Bot, approve the held reply, and see it arrive](docs/images/demo-social.gif)

*Demo: one owner invites a friend to their Chief from **Sharing**; the friend pastes the link in **Add friend** and
messages that Chief. The reply waits in the owner's chat with an **Approve** card, and after **Approve** it arrives in
the friend's chat. Some waiting is sped up.* [Watch the full video (MP4)](docs/images/demo-social.mp4)

- **The meeting point is yours.** A [Bot Social](https://github.com/Birfy/bot-social) server you self-host connects
  two homes. With no server configured, FlyBot simply stays local.
- **Sharing is one Bot at a time, and off by default.** An invite grants exactly one Bot; **People with access** lists
  who has it, and **Revoke** takes it back.
- **Your replies can wait for you.** What a Bot sends can sit in the chat with **Approve** / **Reject** until you
  decide, or go straight out where **Auto-send** is on for that Bot and that person. What a friend's Bot writes
  arrives fenced as untrusted text.

### Several Bots in one room

![Face-to-face room: two homes join with the same 6-digit number and chat with their Bots](docs/images/demo-face.gif)

*Demo: each home picks its Bots in **+** → **Face-to-face room** and types the same 6-digit number, then **Enter
chat**. A plain line is answered by the Bots in the room; **@Planner** is answered by that Bot alone. Auto-send was on
here, so Bot lines post without a hold. Some waiting is sped up.*
[Watch the full video (MP4)](docs/images/demo-face.mp4)

- **No friendship needed.** Two homes type the same 6-digit number within about ten minutes and are in one room: a
  plain line is answered by the Bot it fits, `@Name` by that Bot alone, `@all` by everyone.
- **Only the Bots you brought.** The other home sees neither your other Bots nor your other chats.

## Also in the app

- **Task board.** One card per piece of work — owner, column, and how far it got — and a card can be handed to a Bot
  or to a Workflow.
- **Group chats.** You and some Bots in one room; the room's board says who does what, and a plain message is answered
  by the member it fits.
- **Workflows** (`@flybot/workflow`). A pipeline drawn as a flowchart of your Bots: drag a Bot onto the canvas,
  connect it, save. A run walks the graph and posts its progress in the Workflow chat. In v1 a step posts that progress
  and moves on; it does not call that Bot's model yet.
- **Schedules.** A Bot wakes at a fixed time to do one job, then sleeps again.
- **Connectors.** GitHub and Composio, connected once in Settings and on for every one of your Bots, unless you turn
  one off for a particular Bot.
- **Timeline** (`@flybot/timeline`, optional and off by default). Swimlanes per Bot, who waits on whom, and how busy
  each Bot is. It stores ids, times and names — never message text, tool arguments or output.

## Install

**1. What you need**

- **Node.js 22.19+** and **pnpm** (`npm install -g pnpm`, or `corepack enable`)
- **Git**, to install from GitHub
- An API key for at least one model provider — for example DeepSeek ([how to set one](docs/deepseek-api-key.md))

**2. Add FlyBot to DeepSeek Harness**

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/core"
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/social"
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/tree"
```

The first line is the FlyBot core (package `ds-bot`); the two plugins are what turn it into a team. Add
`/plugins/workflow` or `/plugins/timeline` the same way if you want them.

On DSH Desktop: **Plugins → Add plugin**, paste one `github:` address at a time, then **Install** and **Enable now**.

`0.2.0-rc.2` is the DeepSeek Harness release FlyBot is built and tested against — the same version `dev/harness`
pins and CI runs, so keep it in all four commands.

**3. Run it**

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --port 3080
```

Open the printed `http://127.0.0.1:3080/?token=…` link, pick a model the first time, and say hello to the Chief. To
keep FlyBot running on a machine that stays on, use the container: [Run FlyBot in Docker](docs/docker.md).

## Friends' Bots are opt-in

Social stays idle until you point it at a server you host.

1. Deploy [Bot Social](https://github.com/Birfy/bot-social) — FlyBot does not ship one. Its README covers
   `PUBLIC_BASE_URL`.
2. Add the server to `$DSH_HOME/profiles/web/cordis.patch.yml` and restart DSH:

   ```yaml
   - id: flybot-social
     config:
       server: https://your-server.example.com
       displayName: Your Name
   ```

3. On the first start FlyBot registers your home (`@<name>.home`) and shares nothing. To share one Bot: that Bot's
   settings → **Sharing** → **Copy invite link for <Bot>**; your friend opens **+** → **Add friend**, pastes the link
   and accepts.

Change the server later in Settings → **Bot Social**, without editing YAML: a new server is a new identity, and the
old credentials are kept as a backup. Details: [social subsystem](docs/subsystems/social.md).

## Docs

- Core options, models and updates: [`core/README.md`](core/README.md)
- Plugins: [`tree`](plugins/tree/README.md), [`social`](plugins/social/README.md),
  [`workflow`](plugins/workflow/README.md), [`timeline`](plugins/timeline/README.md)
- Architecture and subsystem pages: [docs/architecture.md](docs/architecture.md),
  [docs/subsystems/](docs/subsystems/README.md)
- Known issues: [docs/known-issues.md](docs/known-issues.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), [LESSONS.md](LESSONS.md)

## Built on

FlyBot is the upstream [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) core, kept byte-identical and pinned in
`ds-bot.pin.json`, plus a short patch series (`patches/` → `core/`) and the plugins under `plugins/`. It is developed
and tested against DeepSeek Harness `0.2.0-rc.2`, the version the commands above pin. The npm package keeps
the upstream name `ds-bot`, while everything you see in the app says FlyBot.

## License

[Apache License 2.0](LICENSE). Third-party notices in [NOTICE](NOTICE).

## Disclaimer

FlyBot is an independent community project. **It is not an official DeepSeek product.** Bots use your own model quota
and can read, write, and run commands when you ask them to — check important actions yourself.
