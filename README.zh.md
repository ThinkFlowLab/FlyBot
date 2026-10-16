<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-wordmark-dark.svg">
    <img src="docs/images/logo-wordmark.svg" alt="FlyBot" width="420">
  </picture>
</p>

<p align="center"><b>长期存活的 AI Bot 团队：能按树拆分任务，也能和朋友的 Bot 聊天。</b></p>

<p align="center">
  <a href="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml"><img alt="Test" src="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/nightly.yml"><img alt="Nightly" src="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/nightly.yml/badge.svg?branch=main"></a>
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.2.0--rc.2-3B5BFD">
  <a href="LICENSE"><img alt="许可" src="https://img.shields.io/badge/许可-Apache_2.0-green"></a>
</p>

<p align="center"><a href="README.md">English</a> | 中文</p>

FlyBot 是在固定版本的 [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) 核心之上，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 准备的两个插件：

- **`@flybot/tree`**：递归 Bot 树，把请求拆成几块，按层委托，再汇总答案。
- **`@flybot/social`**：通过你自己部署的 [Bot Social](https://github.com/Birfy/bot-social) 服务器，把 Bot 加为好友并聊天（带主人审批）。

## 功能

### 树插件（`@flybot/tree`）

把你的 Bot 组成一棵递归树：把请求拆成几块，一层层往下委托，再把答案汇总回来。

![树插件：Chief 把杭州行程拆给 Travel、Food、Budget](docs/images/demo-tree.gif)

- **一个根。** 树的根是主 Bot（Chief），不会再新建一个根。只有团队里有 Bot、却没有主 Bot 时，才会单独建一个 `Root`。已有的本地 Bot 会挂到根下面作子节点，数量不超过 `maxChildren`。
- **按需生子。** 树中的任意 Bot（不只是主 Bot / 根）调用 `create_child_bot(name, role_description)`，在**自己**下面直接建子 Bot；工具没有 parent 参数。同一父节点的调用串行处理，避免超限或重名。规则：
  - 名称 1–40 个字符；同级重名会被拒绝（忽略大小写和空格）；
  - 深度最多 5（根算第 1 层），每个 Bot 最多 8 个子节点（见 `limits.json` 或插件配置）；
  - 新建的子 Bot 默认只给创建者的主人用；分享给别人仍需对该 Bot 单独授权（默认拒绝，没有发布机制）。
- **按层委托。** 每个 Bot 只能看到直接子节点（`list_children()`），看不到更深。
  - 有子节点的 Bot 当协调者：拆任务，把每块发给职责匹配的子节点，等待，再汇总给父节点。
  - 没有子节点的 Bot 自己干活。
- **消息规则**（`tree` 发送策略）：
  - 树中 Bot 可给父节点、直接子节点以及远端（好友）Bot 发消息（树不拦截远端消息；由社交插件决定）；
  - 根还可以给任意本地 Bot 发消息；
  - 树外的本地 Bot 只能给根发消息；
  - `stopped` 与 `report` 通知永不拦截，Chief 总能叫停任意 Bot。
- **换父。** 删除某个 Bot 时，其子节点上移到它的父节点；父节点与整棵子树会刷新提示词与路径，子节点不会丢失。
- **路径行。** 树中 Bot **向父节点**汇报时，答案以路径开头，例如 `Chief → Work → Dev`。回给你或好友 Bot 时不加路径；根也不会加。
- **保留你的提示词。** 插件把规则写在系统提示词里的标记块中，只替换该块，不会覆盖你自己写的内容。
- **侧栏。** Bot 列表画成可展开的树，Chief 在顶上；树外的 Bot 直接挂在 Chief 下。

安装（需要先装核心 `path:/core`）：

```bash
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/tree"
```

### 社交插件（`@flybot/social`）

每个本地 Bot 都可以通过你**自己部署**的 [Bot Social](https://github.com/Birfy/bot-social) 服务器，和朋友的 Bot 聊天。邀请按 Bot 计；你的 Bot 主动发出的消息可以等你审批；好友 Bot 写的内容一律放进不可信围栏。

![社交插件：添加好友、和对方的 Bot 聊天、在 Bot Social 里批准被暂扣的回复、回复送达](docs/images/demo-social.gif)

*演示：添加好友、给对方的 Bot 发消息，回复因含金额被 Bot Social 暂扣，好友的主人批准后送达对话。* [观看完整视频（MP4）](docs/images/demo-social.mp4)

- **一键入驻。** 配置好 `server` 后首次启动会调用 `POST <server>/v1/onboard/flybot`，创建家（`@<name>.home`），凭证写在 `$DSH_HOME/bot/flybot-social.json`（权限 600）。
- **成员。** 访问是按 Bot 的**授权**（默认拒绝，Chief 也一样）。本地 Bot 在你邀请别人使用它、它加入邀请、或你把它带进面对面房间时，才会在服务器上成为 `@<bot>.<home>`。侧栏只列出别人授权给你的 Bot。每个 Bot 的 **管理访问** 列出谁有它，并可 **撤销**。删除 Bot 会撤销其身份。未授权的 Bot 没有对外身份：朋友够不到它，它也不能给朋友发消息。
- **侧栏里的好友。** 好友的 Bot 和你自己的 Bot 在同一列表，名字后面有一个小地球标记。面对面房间也在这份列表里，带一个小人标记；已结束的折在 **过去的房间** 下。点开就是普通对话。本地 Bot 右键 → **复制邀请链接**（或带说明的邀请），或用侧栏 **+** → **添加好友** 粘贴好友的链接加入。**面对面建群**、**复制邀请链接** 和 **复制我的 handle** 也在同一个 **+** 菜单里。对该好友的 **自动发送** 在那个 Bot 的设置里。
- **审批。** 好友发来的消息会立刻送达。你的 Bot 发出的回复可能停在当前聊天里等你批准（或拒绝），除非对该好友开了自动发送。FlyBot 本地也会暂扣 Bot 自己发起的发送；文件一律先审批。
- **工具。** 每个本地 Bot 都有 `list_friend_bots` 与 `message_friend_bot`（可带附件）。

在指向 Bot Social 服务器之前，社交插件会保持空闲（见下方快速开始）。

## 快速开始

### 1. 环境

- **Node.js 22.19+** 与 **pnpm**
- **Git**（从 GitHub 安装）
- 至少一个模型提供商的 API Key（例如 DeepSeek）

### 2. 安装 FlyBot（核心 + 插件）

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/core"
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/social"
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/tree"
```

第一行是核心（包名 `ds-bot`）。桌面版：侧栏 **插件 → 添加插件**，粘贴上面的 `github:` 地址后安装并启用。

### 3. 启动 Web

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --port 3080
```

打开打印出的 `http://127.0.0.1:3080/?token=…`。第一次打开 Chief 时选择模型。

### 4. 自建 Bot Social（好友功能需要）

`@flybot/social` **依赖**你自己部署的 [Bot Social](https://github.com/Birfy/bot-social)，仓库里不附带服务器。按 Bot Social 的 README 部署，并设置对外地址：

```sh
# 示例：换成你自己的域名
export PUBLIC_BASE_URL=https://your-server.example.com
export PORT=8787
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 里写上服务器地址并重启 DSH：

```yaml
- id: flybot-social
  config:
    server: https://your-server.example.com
    displayName: 你的名字
```

首次启动只登记你家。在你授权之前，没有任何 Bot 被共享。若家句柄已被占用，FlyBot 会自动改用带后缀的名字（`你的名字2` …），而不用你去改配置。侧栏 **+** 里的 **复制我的 handle** 会复制你的句柄。授权某个 Bot：右键该 Bot → **邀请使用此 Bot**，把链接发给对方；对方在侧栏 **+** → **添加好友** 里粘贴。接受邀请只授权这一个 Bot。

好友发来的消息会立刻送达。你的 Bot 回过去的内容会停在当前聊天里等你批准（或拒绝）。新好友默认关闭自动发送。如果对方只看见自己的话，先看 **待批准** 角标。

未配置 `server` 时，社交插件会故意保持空闲。树插件不依赖 Bot Social。

## 架构简述

上游 DS Bot 核心保持字节一致（`ds-bot/`，见 `ds-bot.pin.json`），经 `patches/` 打出 `core/`，插件在 `plugins/`。详见 [#34](https://github.com/ThinkFlowLab/FlyBot/issues/34)。网页界面（顶栏、关于、设置、更新提示）显示 FlyBot；npm 包名和更新检查仍走上游 `ds-bot` 仓库。

## 许可与声明

[Apache License 2.0](LICENSE)。FlyBot 是独立社区项目，**不是 DeepSeek 官方产品**。Bot 会使用你自己的模型额度，并可能按你的要求读写文件、执行命令——重要操作请自行核对。
