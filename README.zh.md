<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="FlyBot" width="260">
  </picture>
</p>

# FlyBot

[English](README.md) | 中文

![版本](https://img.shields.io/badge/版本-v0.1_预览-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

FlyBot 是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的 bot 插件，插件将 dsh 改造为 bot 形式。你可以与自己创建的 bot 交流、工作。

![和 Chief 说一句话，它就把 bot 和群聊建好](docs/images/team.png)

## 安装

先装好 dsh，并在 dsh 里配好至少一个模型。FlyBot 直接使用 dsh 里的模型。

**dsh Desktop（Windows、macOS）**

1. 侧栏点 **插件** → **添加插件**。
2. **包名或地址** 填 `ds-bot`。在中国大陆，**安装源** 选 **中国大陆镜像源**。
3. 点 **安装**，再点 **立即启用**。如果提示“下次启动生效”，完全退出 dsh 再打开。

连不上 npm 时，第 2 步也可以填 [Releases](https://github.com/ThinkFlowLab/FlyBot/releases) 里下载的 `ds-bot-0.1.5.tgz` 的完整路径，或者 `github:ThinkFlowLab/FlyBot#v0.1.5&path:/ds-bot`（需要装 Git）。

**dsh Web（Windows、macOS、Linux）**

需要 Node.js `22.19` 以上和 pnpm。

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

## 配置

我强烈建议你直接通过和 bot 对话来配置其他 bot 和群聊。

## 功能

### Bot

你可以在一个窗口中和一个 bot 完成所有对话和工作，你无需担心背后的上下文问题。你可以在 bot 详情页查看 bot 信息，也可以为 bot 选择你想使用的模型。你可以随时切换模型，但我仍然建议你为一个 bot 长期保持一个模型，仅在真正必要的时刻切换。

另外，bot 拥有记忆，它会记住你的喜好并在下次的工作中应用。你可以在 bot 的详情页管理记忆，也可以直接和 bot 对话来进行管理。

![bot 详情页：模型、记忆、用量](docs/images/details.png)

### Main bot

这个 bot 作为你的 chief，它拥有非常高的权限，可以管理其他 bot 和群聊。第一次进入 FlyBot 时，默认会有一个 main bot 叫 Chief。你可以直接和它对话，让它引导你完成配置。

总之，有问题，找 main bot。

### 群聊

FlyBot 拥有群聊功能。群聊是非常好的多 bot 协作方式，但它会带来非常明显的费用问题。FlyBot 为此特意做了优化：在一个群聊中，你需要设置一个管理员。你的消息默认由管理员回复，它会帮你调用其他 bot。你也可以直接 @ 你需要沟通的 bot，它会直接回应你：输入 @，从列表里选 bot 就行。想让 bot 参考另一段对话，点输入框的 + → 引用对话。

任何 bot 都可以用 @ 把活派给另一个 bot。接活的 bot 自己去做，群聊照常进行。它干活时，群聊、侧边栏和它自己的聊天里都能看到它在做什么。做完后，它把结果发到群里，由派活的 bot 接着回应。要停下它的工作，打开群聊详情。

![群聊：管理员 Chief 把活派给写手和程序员](docs/images/group.png)

### 能力

设置 → **能力** 是团队共享的 MCP 服务、技能和能力包列表。在 Bot 设置中启用能力后，从该 Bot 下一条消息开始生效，也适用于它参与的群聊。Bot 添加的本地 MCP 命令需要你先批准才能运行。有其他 Bot 在用的能力，只有你或主 Bot 能修改、删除。

### 用量

在 设置 → 用量 里，可以按时间、按 bot、按模型查看 Token 用量。

![用量页](docs/images/usage.png)

## 数据

所有数据都在你自己的电脑上，在 dsh 主目录（默认 `~/.dsh`）的 `bot/` 和 `sessions/` 里。卸载插件不会删除这些数据。

## 开发

插件源码在 [`core/`](core/)。配置项和内部结构见 [`core/README.md`](core/README.md)，开发和测试见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：FlyBot 建在 dsh 的插件系统上。每个 bot 都是一个 dsh 会话，用的是 dsh 的工具和模型。
- [esbuild](https://esbuild.github.io/)：用来打包插件的界面代码。
- 感谢下面这些项目公开的设计思路。FlyBot 参考了它们的思路，没有使用它们的代码：
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo)：bot 记忆的 Markdown 格式。
  - [OpenAI Codex](https://github.com/openai/codex)：压缩时把用户原话留在摘要旁边，以及搜索聊天记录用的消息锚点。
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮流发言和 @ 接力。
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) 和 [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：每个成员在每个群里一个会话，以及交接时带上用户之前的原话。
  - [OpenCode](https://github.com/sst/opencode)、[goose](https://github.com/block/goose)、[pi](https://github.com/badlogic/pi-mono)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)：长对话什么时候压缩，交接笔记写哪些内容。
  - [obelisk](https://github.com/tommy0103/obelisk)：用 SQLite 全文索引搜索聊天记录。
- 每一位试用 FlyBot、提问题、报 bug 的人。

## 许可

[Apache License 2.0](LICENSE)。按“原样”提供，不附带任何担保。用到的第三方代码和它的许可见 [NOTICE](NOTICE)。

## 声明

FlyBot 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。“DeepSeek”“DeepSeek Harness”等名称是各自所有者的商标，这里只用来说明本插件和什么一起用。

bot 会消耗你自己的模型额度，也会按你的要求读写文件、运行命令。重要的操作请自己检查。

## FlyBot 插件架构

FlyBot = FlyBot（`core/`）+ 功能插件。扩展接口由 ds-bot 自己提供，插件无需改动 ds-bot。

### 安装 FlyBot（全新 profile）

需要 Node.js >= 22.19 和 pnpm。先把 ds-bot 和两个插件加入 DSH profile：在 `core/` 下运行
`npm run install:doctor` 检查 Node 版本和三个包是否齐全，并打印下面的命令，再在该 profile 的
`cordis.patch.yml` 里启用（social 需要填 Bot Social 服务器地址）：

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/core"
npx @deepseek-ai/dsh plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/social"
npx @deepseek-ai/dsh plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/tree"
```

之后在 profile 目录里运行 `pnpm update ds-bot @flybot/social @flybot/tree` 更新，再重启 DSH。
某个插件启动失败只会记一条警告，它的界面位置不显示，ds-bot 其余部分照常工作。

### 宿主接口（`ctx.flybot`）

实现在 `core/src/host/hooks.js`，用 `ctx.provide('flybot')` 提供。插件声明
`inject: ['flybot']`，并调用 `ctx.flybot.scope('<插件名>')`（`'shared'` 为保留名）。

- `fields.get/set/all/query`：Bot 上按插件划分的同步字段，存于 `state.json` 的
  `bots[id].fields[plugin][key]`；`on('change', fn, { all })` 收到每次变更的副本。
- `bot.list/get/find/of`（仅本地 Bot）、`bot.isRemote(ref)`、
  `bot.create({ name, systemPrompt, fields }) → id`、`bot.setSystemPrompt(id, text)`；
  `on('bot.created' | 'bot.removed' | 'change', fn)`；`ready()` 在团队数据加载后完成；
  `readOnly()` 在另一个 dsh 持有团队时为真。
- `bot.send(msg)` 与 `bot.send.use({ name, before, after, handle })`：所有 Bot 之间的消息
  （包括内置 `message_bot` 和回复）都经过同一条中间件链。`undefined`/`allow` 继续，
  `deny` 拒绝，`hold` 生成审批卡。批准后从暂扣它的中间件之后继续，后面的 `deny` 仍然生效；
  投递失败的消息留在卡片上，可点"重试"。同时最多 100 条待批，单条消息最多 20,000 字符。
- `transports.add(kind, { send })`、`approvals.list/decide/onChange`、
  `tools.register({ name, parameters, visibleTo(botId), execute(args, { botId }) })`
  （`visibleTo` 拒绝的工具也会从该 Bot 的工具列表中移除）、
  `api.handle(name, fn, { read })` 注册界面接口（`flybot/<name>`；`read: true` 的接口在只读宿主上也可用；内置名称保留）。
- `remote.publish/list/get` 管理好友的 Bot，`remote.chats.{open, deliver, onSend, list, of}`：
  每个好友 Bot 都有自己的对话（见下文）。
- 浏览器：`ctx.flybot`（`bots()`、`fields.on('change')`，宿主重启后仍继续推送）以及
  `flybot.sidebar.section`、`flybot.sidebar.structure`、`flybot.composer.mention`、
  `flybot.bot.details`、`flybot.approvals` 等界面位置（`core/src/client/flybot-slots.js`），
  每个插件组件都包在错误边界里。
- 类型：`core/types/flybot.d.ts`。
- 插件（`plugins/`）：`social`（通过 Bot Social 连接好友的 Bot）和 `tree`
  （递归 Bot 树，由 recursive-bot 维护）。

CI（`.github/workflows/test.yml`）运行 ds-bot 的测试（包含每个插件的测试）、客户端构建检查和 lint。

### Social：home、成员与好友

- **Home**：每个 FlyBot 安装在 Bot Social 上有一个身份（如 `@danyang.home`），首次启动时由
  一次 `POST /v1/onboard/flybot` 创建。令牌连同所属服务器保存在
  `$DSH_HOME/bot/flybot-social.json`（权限 600），绝不会发给其他服务器；显式的
  `config.token` 或 `FLYBOT_SOCIAL_TOKEN` 优先。
- **成员**：每个本地 Bot 注册为 `@<名字>.<home>`；没有 ASCII 字母的名字（如 研究员）
  使用 `@bot-<哈希>.<home>`。新 Bot 通过 `bot.created` 加入，删除的 Bot 会被吊销。
- **加好友**：右键自己的某个 Bot，选择 **Copy invite link**（只复制链接本身）或
  **Copy invite with instructions**（链接加加入说明）；或在 Friends' Bots 里点
  **+ Add** 粘贴好友的链接或邀请码、接受请求。你的点击就是主人的确认，模型工具无法替你接受好友。
- **侧边栏里的好友 Bot**：每个好友 home 一个可折叠分组，每个 Bot 的样子和你自己的 Bot 一样
  （头像、最新消息、未读标记），名字后有一个小地球图标。点击即打开普通对话：你输入的内容发给它，
  它的回复作为它的消息显示。
- **自动接受**（按好友 home 设置，默认开启，在 Friends' Bots 里勾选）：收到的消息直接送达，
  并关闭服务器对该好友关系的审批。你亲自输入的内容总是立即发送。你的 Bot 自行发给好友 Bot 的消息
  （`message_bot` / `message_friend_bot`、回复）只有在自动接受开启时才立即发送，否则等待审批卡。
- **@ 提及**：在任何对话里用 `@handle`、`@名字` 或 `@` 菜单选中好友的 Bot，这条消息就会发给它
  （代码、链接和引用行不算）；回复回到同一个对话，你自己的 Bot 不会抢答。
- **文件**：Bot 用 `message_friend_bot` 的 `files` 附加文件（文档、数据或图片的绝对路径，最多
  5 个、每个 20 MB）。隐藏目录（`~/.ssh`、`~/.dsh`）、疑似凭据的文件和 FlyBot 自己的文件会被拒绝；
  无论是否自动接受，Bot 附带的文件都要你批准，审批卡上显示完整路径。批准后才上传并校验哈希。
  收到的文件显示为可保存的附件，接收的 Bot 在 `<untrusted-file>` 围栏中读取内容。
- 好友 Bot 写的所有内容都以不可信文本的形式交给你的 Bot，名字会清理成单行。
