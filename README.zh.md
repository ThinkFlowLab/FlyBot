# FlyBot：AI 协作开发后端

Project 管理项目、成员、角色与仓库；Chief 常驻协调，Dev/Reviewer/Tester
按 Task 使用独立角色 Session，通过持久化 Handoff 自主接手、打回和转交。
普通提问直接咨询 Chief，不创建 Task。个人 Chief、个人 Bot、群聊与私有记忆继续保留。

本交付分支包含后端收敛工作，尚未合入主仓 main 或部署到现有实例。
它复用 FlyBot/DSH、原账号服务、任务池和执行器；没有另建一套调度系统。

## 启动持久服务

需要 **Node.js22.22+、npm、Git**，首次安装需要访问 npm。Linux 是当前验证环境。

```bash
git clone --branch feat/2189-backend-quickstart https://github.com/ThinkFlowLab/FlyBot.git
cd FlyBot
node scripts/backend.mjs init
node scripts/backend.mjs start
```

`init` 安装锁定的依赖及 pnpm，默认数据保存在 `~/.flybot-backend`；不会创建临时项目或删除退出后的数据。
`start` 输出服务地址，默认 `http://127.0.0.1:3080`。Ctrl-C 正常停止，再次 `start` 恢复同一数据。
端口占用或需要指定数据目录时，见[配置和运维](docs/backend-operations.md)。

**执行 AI 工作前**，为启动服务的环境配置真实模型，例如 `DEEPSEEK_API_KEY`，
或沿用 DSH 的模型配置。密钥放在私有环境/凭据存储中，不写入 Git。
Codex/Claude 执行还需配置角色的 Harness、Resource、独立登录环境及仓库权限，
见[执行配置](docs/backend-operations.md#执行配置)。未配置时任务会等待配置或资源，不会伪装成已执行。

## 登录和第一次调用

另开终端，在同一源码目录执行：

```bash
node scripts/backend.mjs login
node scripts/backend.mjs request projects
node scripts/backend.mjs request project-create --json '{"name":"My project","goal":"维护产品代码与技术决策"}'
```

未连接账号平台时，首次 `login` 通过原生邀请机制建立本机 Owner 会话，后续复用；
凭据仅保存在数据目录的私有文件中。已配置 control-plane 时使用
`node scripts/backend.mjs login --email YOUR_EMAIL`，在提示中输入已有密码，账号和权限复用原平台。
配置账号平台不需要修改它的代码或操作其管理 UI。

将下列 `PROJECT_ID` 换成创建项目返回的 `project.id`：

```bash
node scripts/backend.mjs command consultation.ask --project PROJECT_ID --request-id ask-1 --json '{"text":"解释一下项目当前的情况"}'
node scripts/backend.mjs query consultation.list --project PROJECT_ID
node scripts/backend.mjs query tasks --project PROJECT_ID
```

咨询异步返回，结果留在当前个人代理的私有咨询记录中，Task 数量不增加。
创建有项目影响的工作时才发布 Task：

```bash
node scripts/backend.mjs command task.propose --project PROJECT_ID --request-id change-1 --json '{"title":"修复明确的代码问题","criteria":"复现用例及必要回归通过","impact":"恢复项目功能"}'
node scripts/backend.mjs query tasks --project PROJECT_ID
```

返回 `result.id` 是 Task ID。发布后先等待 Chief 接纳；配置好仓库、模型、角色与资源后，
Owner/Maintainer 可通过 `chief.configure` 启用 Chief。Chief 接纳会提交启动意图，再由现有任务池推进。
首个代码任务的[完整配置与推进步骤](docs/development-service-guide.md#首个代码任务)单独列出，避免把“发布成功”当作开发完成。

```bash
node scripts/backend.mjs query task --project PROJECT_ID --json '{"taskId":"TASK_ID"}'
node scripts/backend.mjs events --project PROJECT_ID
```

CLI 输出与 HTTP 是同一套接口；查询无需模型，事件支持游标恢复。
HTTP 入口为 `POST /api/bot`、事件为 `GET /api/project-events`，
成员或个人代理使用 `X-Flybot-Member-Session`；原始 Harness 端口和凭据留在服务内部。

## 进一步使用

| 需要 | 文档 |
| --- | --- |
| 对象、权限、全部25查询/28命令、原生接口、幂等与SSE | [API参考](docs/development-service-api.md) |
| Chief/角色/Task/Handoff、咨询、个人代理、安全与值守、状态与上下文 | [协作指南](docs/development-service-guide.md) |
| 数据目录、账号平台、模型/SDK/仓库、停止重启、备份升级、排障 | [部署运维](docs/backend-operations.md) |
| 个人Chief、多Bot、群聊、公共Bot、原版安装与桌面功能 | [原版FlyBot](README.native.zh.md) · [English](README.native.md) |
| 旧任务、原生群聊、Workflow和JSON/SQLite切换 | [兼容与迁移](docs/subsystems/project-compatibility.md) |
| 架构与实现边界 | [架构](docs/architecture.md) · [子系统](docs/subsystems/README.md) |

真实部署入口是 `scripts/backend.mjs`。`dev/demo/` 是隔离开发验证工具，会使用测试模型或临时数据，不能作为生产启动方法。
自动测试通过、真实 SDK 验证、浏览器验收、PR 合入与生产部署分别记录；本分支不承诺未验证的完整真实模型开发闭环。
