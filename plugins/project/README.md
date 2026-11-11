# @flybot/project

The Project domain of FlyBot as a peer plugin (built on ds-bot / DeepSeek Harness).

## English

### What it does
- **The Project domain, out of the core (#2830).** Project State, the Project board, the Project's
  own Chief, the team dossier, the Project metrics and the Project Assistant used to be
  `core/src/host/project-*.js`. They are this package now: `apply()` installs them on the core
  runtime through `ctx.flybot.projectHost()`, so `rt.projectBoard`, `rt.projectChief`,
  `rt.projectTeam` and `rt.projectAssistant` are the same seams the core's store, meetings and
  channel already call.
- **Project State (`project_state`).** The Project State files of the Session's working folder —
  `PROJECT.md`, `ROADMAP.md`, `docs/governance.md`, `decisions/*.md`, `LESSONS.md` — listed with
  byte size, a sha256 content hash and last-modified time, so a caller can compare the hash with
  the copy it already has; or one file handed over whole, bounded at 200,000 bytes. Answers
  `absent`, `too large`, `not a repository` or `unreadable: <path> (<reason>)` with the reason
  instead of an empty document.
- **The board.** One read model over the core's task records, the `decisions/*.md` files, the
  decided meetings and the workflow run refs: rows, the role queues and leases, the blocked cards,
  the decision cards and the Project roles (`owner` / `maintainer` / `member`, with the one policy
  that keeps a Project's Owner). Read-only by construction — it writes nothing and starts nothing.
- **The Project's own Chief.** Every Project gets one hidden Bot, bound to that Project, with
  instructions naming that one Project and forbidding an answer for any other; it is retired with
  the Project.
- **The team dossier.** `rt.projectTeam(projectId)` answers the Project's Chief, its assistant and
  its role pool with persona, the head and topic names of each Bot's own memory, the skills it
  carries and only this Project's rooms.
- **Metrics.** The board's seven numbers read from GitHub REST and the local task store with a
  five-minute cache; a source that cannot be read is `unavailable` and every value is `null`,
  never `0`.
- **The Project Assistant (`project_digest`).** One hidden assistant per Project with exactly one
  09:00 Asia/Shanghai digest task on its own Session (a DSH schedule, never a cron in the plugin),
  memory private to (Project, owner), and a digest built only from board rows and Project State:
  what merged, what closed, what is in progress and on whom, the next slice — one line on a day
  with no change.

### The owner switch
Settings → Plugins → **Project**, stored as `flybot.plugins.project.enabled` in `state.json`. Off
means the plugin registers no tool, no seam and no background work at the next start; the core then
keeps its documented fallbacks — a Project is created without a Chief or an assistant, and the
board and the dossier answer empty. Without this plugin installed, the same fallbacks apply.

### Config
```yaml
- id: project
  name: "@flybot/project"
  # no config keys in this slice: the domain reads the Project record, the board and the
  # Session, and takes the metrics' credentials from the install's own connector
```

### Install
Installed next to the core in the same DSH profile (a default FlyBot install includes it):

```sh
npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/project"
```

### Tests
```sh
cd plugins/project
npm test          # needs a FlyBot core checkout at ../../core (or FLYBOT_CORE) and DSH_HARNESS
```

The suite is the domain's own tests, moved here from `core/test/project-*.test.js` when the code
moved, plus `test/host.test.js` for the plugin boundary itself. The core's suite keeps the
integration cases that read a Project through the store, the channel and the client.

## 中文

### 做什么
- **Project 域整体搬出 core（#2830）**：Project State、项目看板、项目自己的 Chief、团队档案、
  项目指标和项目助理原本是 `core/src/host/project-*.js`，现在是这个包。`apply()` 通过
  `ctx.flybot.projectHost()` 把它们装回 core 运行时，所以 `rt.projectBoard`、`rt.projectChief`、
  `rt.projectTeam`、`rt.projectAssistant` 仍是 core 的 store、meetings 与 channel 调用的那几个接缝。
- **Project State（`project_state`）**：列出会话工作目录里的 Project State 文件（`PROJECT.md`、
  `ROADMAP.md`、`docs/governance.md`、`decisions/*.md`、`LESSONS.md`）的字节数、sha256 与修改时间，
  便于核对手里那份是否过期；也可整份读出一个文件（上限 200,000 字节）。读不到时回答原因
  （`absent` / `too large` / `not a repository` / `unreadable: <path> (<reason>)`），不拿空文档冒充。
- **看板**：任务记录、决策文件、已决定的会议与 workflow 运行引用合成一份只读视图：卡片、角色队列与租约、
  被阻塞的卡片、决策卡与项目角色（owner / maintainer / member）。只读，不写、不启动任何东西。
- **项目 Chief**：每个项目一个隐藏 Bot，绑定该项目的 `projectId`，指令里只认这一个项目，随项目一起退休。
- **团队档案**：`rt.projectTeam(projectId)` 按看板顺序回答 Chief、助理与角色池，含人设、各自记忆的头部与
  主题名、技能和只属于这个项目的房间。
- **指标**：看板的七个数，五分钟缓存；读不到就 `unavailable`、值为 `null`，绝不用 0 冒充「今天没有」。
- **项目助理（`project_digest`）**：每个项目一个隐藏助理，它自己的会话上有且只有一个 09:00（Asia/Shanghai）
  摘要任务（走 DSH 的定时，不是插件里的 cron）；记忆按（项目, 所有者）隔离，摘要只用看板行和 Project State。

### 开关
Settings → Plugins → **Project**（`state.json` 的 `flybot.plugins.project.enabled`）。关掉后下次启动
不再注册任何工具、接缝或后台动作，core 保留既有兜底：项目照常创建，只是没有 Chief 和助理，看板和档案返回空。
未安装本插件时同样是这套兜底。

### 测试
```sh
cd plugins/project
npm test
```
