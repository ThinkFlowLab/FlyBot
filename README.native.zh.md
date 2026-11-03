<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-wordmark-dark.svg">
    <img src="docs/images/logo-wordmark.svg" alt="FlyBot" width="420">
  </picture>
</p>

<p align="center"><b>在你自己的浏览器里干活的长期存活 AI Bot 团队：一句话进去，全队拆开做，一个答案回来。</b></p>

<p align="center">
  <a href="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml"><img alt="Test" src="https://github.com/ThinkFlowLab/FlyBot/actions/workflows/test.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/ThinkFlowLab/FlyBot/releases"><img alt="发布" src="https://img.shields.io/github/v/release/ThinkFlowLab/FlyBot"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="许可" src="https://img.shields.io/badge/许可-Apache_2.0-green"></a>
</p>

<p align="center"><a href="README.md">English</a> | 中文</p>

FlyBot 是跑在你浏览器里的一支本地 AI Bot 团队，构建在
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 之上。你只跟一个 Bot 说话——**Chief**。它带
着其余的人：把一件事拆开，交给职责合适的 Bot，再把答案合成一份给你。每个 Bot 都有自己长期保存的记忆、工作
目录、模型和定时任务，所以周一搭好的团队，周五还在。

## 适合谁用？

**适合你，如果**你要的活不止一个聊天窗口——团队自己记笔记、管目录、排定时任务，明天接着干；你更愿意用自己的
机器、自己的模型额度来跑；或者你想让自己的 Bot 能和朋友家的 Bot 说话。

**大概不适合，如果**你只想要一个快速答案（任何聊天应用都能做），或者你在找一个能二次开发的 agent 框架——
FlyBot 是一个直接跑起来的应用，建在 DeepSeek Harness 之上。

## 看看它怎么工作

### 一个请求，一整支团队

![树插件：Chief 把杭州行程拆给 Travel、Food、Budget](docs/images/demo-tree.gif)

*演示：侧栏里一开始只有 Chief；它建出子 Bot Travel、Food、Budget，各分一块，再把答案汇总成一份行程。等待的
部分做了加速。* [观看完整视频（MP4）](docs/images/demo-tree.mp4)

- **你只跟 Chief 说话。** 它把请求拆开、往下一层各发一块；有子节点的 Bot 当协调者，没子节点的自己动手。
- **树会自己长。** 任意 Bot 都能为一块活建子 Bot。Bot 按角色分组、重名合并，闲置 30 天的归档（从不删除），
  每次整理都能一键撤销。
- **随时叫停。** 运行中的回合用 `stop_bot` 结束，任何消息规则都不会挡住这次叫停。

### 你的 Bot 和朋友的 Bot

![社交插件：邀请好友、给对方的 Bot 发消息、批准被暂扣的回复、回复送达](docs/images/demo-social.gif)

*演示：一方在 **Sharing（分享）** 里邀请好友使用自己的 Chief；好友在 **添加好友** 里粘贴链接，并给这个 Chief
发消息。回复停在主人的聊天里，出现 **Approve（批准）** 卡片，批准后到达好友的聊天。等待的部分做了加速。*
[观看完整视频（MP4）](docs/images/demo-social.mp4)

- **碰头的地方是你自己的。** 两台机器之间靠你自己部署的 [Bot Social](https://github.com/Birfy/bot-social)
  服务器相连；没配服务器时，FlyBot 就只是本地的。
- **一次只共享一个 Bot，而且默认不共享。** 一次邀请只授权一个 Bot；**People with access（访问权限）** 列出谁
  有它，**Revoke（撤销）** 收回。
- **回复可以等你点头。** Bot 要发的内容会停在聊天里等你 **Approve / Reject**；对这个 Bot 和这个人开了
  **Auto-send（自动发送）** 时直接发出。好友 Bot 写来的内容一律放进不可信围栏。

### 一个房间里的几个 Bot

![面对面房间：两家输入同一组 6 位数字加入房间，和各自的 Bot 聊天](docs/images/demo-face.gif)

*演示：双方在 **+** → **面对面房间** 里各选自己的 Bot、输入同一组 6 位数字，再点 **Enter chat（进入聊天）**。
普通一句话由房间里的 Bot 回答；**@Planner** 只由那个 Bot 回答。演示中开了自动发送，所以 Bot 的消息不会被暂扣。
等待的部分做了加速。* [观看完整视频（MP4）](docs/images/demo-face.mp4)

- **不用先加好友。** 两家在十分钟内输入同一组 6 位数字就进同一个房间：普通一句话由合适的 Bot 回答，`@名字`
  只由那个 Bot 回答，`@all` 叫全员。
- **只带你带来的 Bot。** 对方看不到你的其他 Bot，也看不到你的其他聊天。

## 应用里还有

- **任务看板。** 一件活一张卡：谁在干、在哪一列、做到几成；卡可以直接交给某个 Bot 或某个 Workflow。
- **群聊。** 你和几个 Bot 在同一个房间；房间的看板决定谁做什么，普通一句话由合适的那位回答。
- **工作流**（`@flybot/workflow`）。把流水线画成一张 Bot 流程图：拖一个 Bot 上画布、连线、保存。运行时沿着图
  走，把进度发在 Workflow 聊天里。v1 的一步只发这条进度就往下走，还不会调用那个 Bot 的模型。
- **定时任务。** Bot 到点醒来做一件事，做完再睡。
- **连接器。** GitHub 与 Composio，在设置里连一次，你的每个 Bot 都能用；也可以单独给某个 Bot 关掉。
- **时间线**（`@flybot/timeline`，可选，默认关闭）。每个 Bot 一条泳道、谁在等谁、各自多忙。只存 id、时间和
  名称，不存消息正文、工具参数和输出。

## 安装

**1. 你需要**

- **Node.js 22.19+** 与 **pnpm**（`npm install -g pnpm`，或 `corepack enable`）
- **Git**（从 GitHub 安装）
- 至少一个模型提供商的 API Key，例如 DeepSeek（[怎么设置](docs/deepseek-api-key.md)，英文）

**2. 把 FlyBot 加到 DeepSeek Harness**

```sh
npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/core"
npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/social"
npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/tree"
```

第一行是 FlyBot 核心（包名 `ds-bot`），后两行才把它变成一支团队。想要工作流或时间线，照样再加
`/plugins/workflow`、`/plugins/timeline`。

桌面版：**插件 → 添加插件**，一次粘一个 `github:` 地址，然后**安装**并**立即启用**。

`0.2.1-rc.2` 是 FlyBot 构建与测试所用的 DeepSeek Harness 版本，也正是 `core/dev/harness` 钉住、CI 在跑的那一版，
四条命令保持一致。

**3. 跑起来**

```sh
npx -y @deepseek-ai/dsh@0.2.1-rc.2 web --port 3080
```

打开打印出的 `http://127.0.0.1:3080/?token=…`，第一次先选一个模型，然后跟 Chief 打个招呼。想让它在一台一直开着
的机器上常驻，用容器：[用 Docker 运行 FlyBot](docs/docker.zh.md)。

## 朋友功能是可选的

没把社交插件指向服务器之前，它一直空闲。

1. 部署 [Bot Social](https://github.com/Birfy/bot-social)——FlyBot 不附带服务器，部署见它的 README
   （`PUBLIC_BASE_URL`）。
2. 把服务器写进 `$DSH_HOME/profiles/web/cordis.patch.yml`，重启 DSH：

   ```yaml
   - id: flybot-social
     config:
       server: https://your-server.example.com
       displayName: 你的名字
   ```

3. 首次启动会登记你家（`@<名字>.home`），什么都不共享。要共享某一个 Bot：该 Bot 设置 → **Sharing** →
   **Copy invite link for <Bot>**；对方在 **+** → **添加好友** 里粘贴链接并接受。

之后换服务器不用改 YAML：设置 → **Bot Social** 里换。换服务器等于换新身份，旧凭证会作为备份留着。细节见
[社交子系统](docs/subsystems/social.md)。

## 文档

- 核心选项、模型与更新：[`core/README.md`](core/README.md)
- 插件：[`tree`](plugins/tree/README.md)、[`social`](plugins/social/README.md)、
  [`workflow`](plugins/workflow/README.md)、[`timeline`](plugins/timeline/README.md)
- 架构与子系统页：[docs/architecture.md](docs/architecture.md)、[docs/subsystems/](docs/subsystems/README.md)
- 已知问题：[docs/known-issues.md](docs/known-issues.md)
- 参与开发：[CONTRIBUTING.md](CONTRIBUTING.md)、[AGENTS.md](AGENTS.md)、[LESSONS.md](LESSONS.md)

## 它建立在什么之上

FlyBot 是上游 [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) 的核心，保持字节一致并钉在 `ds-bot.pin.json`
里，加上一组简短的补丁（`patches/` → `core/`）和 `plugins/` 下的插件。开发和测试针对 DeepSeek Harness
`0.2.1-rc.2`，也就是上面命令钉住的版本。npm 包名沿用上游的 `ds-bot`，而你在界面里看到的都是 FlyBot。

## 许可

[Apache License 2.0](LICENSE)。第三方声明见 [NOTICE](NOTICE)。

## 声明

FlyBot 是独立社区项目，**不是 DeepSeek 官方产品**。Bot 用的是你自己的模型额度，并可能按你的要求读写文件、执行
命令——重要操作请自己核对。
