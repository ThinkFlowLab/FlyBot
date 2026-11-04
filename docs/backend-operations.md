# 后端配置与运维

[快速开始](../README.md) · [API](development-service-api.md) · [协作流程](development-service-guide.md)

## 安装和数据目录

源码入口复用原 DSH web profile、FlyBot五个插件及 restricted gateway。一个启动命令管理原运行进程和现有共享HTTP/SSE入口；没有第二套任务事实、角色执行器或调度器。
Node22.22+、npm、Git；首次 init 会下载依赖，使用仓库锁文件和与 Docker 相同的 pnpm10.34.6。
本地 native/SDK 执行所需的系统工具、Git/SDK登录由操作者配置。源代码目录不可在服务运行中删除或切换分支。

所有命令可传 `--home /absolute/private-directory`，也可设置 `FLYBOT_HOME`；默认 `~/.flybot-backend`。
同一服务的 init/start/login/调用必须使用同一 home。不要把本机验证目录或另一个实例的数据作为默认配置。

| 路径（相对home） | 用途 |
| --- | --- |
| backend.json / backend.patch.yml | 操作者配置及生成的DSH覆盖，0600；改backend.json后重启生效 |
| profiles/web | 原生DSH profile、插件链接和依赖；保留现有插件配置 |
| bot/state.json | SQLite迁移守卫，或显式JSON模式的状态文件 |
| bot/state.sqlite及配套文件 | 默认事务状态、历史、Effects、事件和私有认证记录 |
| bot下其余目录、DSH Sessions/凭据 | 原有会话、长期记忆、执行证据；备份时一并保留 |
| workspace | 原生DSH工作目录；项目代码工作区仍由原Workspace服务管理 |
| private/backend.log | 私有原始运行日志，可能含DSH登录链接，不要粘贴到Issue |
| private/backend-transport.json | 内部Harness连接；不对成员或公网提供 |
| private/backend-session.json | CLI当前成员会话；login不输出Token，logout撤销它 |

## 配置端口和账号平台

默认可不写配置，先完成本机原生Owner初始化。自定义配置放在私有JSON文件：

```json
{"port":3081,"bot":{"projectWorkbench":true,"stateStorage":"sqlite","projectDispatch":"pools"}}
```

```bash
node scripts/backend.mjs init --home /your/private/flybot --config /your/private/backend-config.json
node scripts/backend.mjs start --home /your/private/flybot
```

重复 init 保留 backend.json 和已有 profile 插件；使用 --config 明确替换配置。入口固定使用项目协作和任务池，新工作不因配置回退到DAG。
修改 backend.json 后 start 重建覆盖；不直接改生成的 backend.patch.yml。

复用已有 control-plane 时，在 bot 内配置：

```json
{"controlPlane":{"origin":"https://accounts.example.org","ownerSubject":"EXISTING_PLATFORM_OWNER_SUBJECT"}}
```

这是 bot 配置片段，不是完整配置文件。origin/ownerSubject必须由操作者明确提供，不能由首次登录猜测。
账号平台需已可用；不内置演示账号、密码、数据库或修改平台的步骤。已有邮箱密码使用 login --email；平台暂停、注销和项目撤权在每次调用生效。
平台会话的上游证明仅存内存，服务重启后需再次 login --email。无人值守还需原 controlPlane.principalCheckCommand 校验实际账号状态，不能拿旧浏览器会话永久授权。
未配置平台时本机首次 login 仅在原生bootstrap仍开放时发行邀请；后续会话复用原认证。丢失会话且bootstrap关闭时使用现有Owner的邀请流程，不清空认证状态来重置Owner。

## 执行配置

先区分四项：Chief的模型、角色的Harness、可用Resource、仓库及GitHub授权。配置存在不代表已登录或能执行。

- Chief/原生Bot使用原DSH模型配置或真实供应商环境。不要让长期服务依赖当前终端里遗失的环境变量；托管时由私有EnvironmentFile等方式提供。
- Codex资源使用已安装的锁定SDK及该Resource/成员专属 `profiles.<MEMBER_ID>.codex`。配置其 home、configDir、model，使用原 runtime-check 和 terminal 接口完成登录。Claude使用 `claude-agent` 配置，不把“claude-code”误当实际Harness ID。
- Resource需明确允许的Project Owner、Harness、容量、工作区根和管理人。角色可以选多个 resourceIds；实际执行只领取当前可用的一份租约。
- `projectRepositories` 按 `owner/repo` 配置可访问的绝对 path、真实 testCommand、allowedPaths、模型及需要的凭据；项目须关联该仓库。代码任务缺少仓库/测试命令时阻塞，不造测试证据。
- GitHub写入使用准确登录人的 gh-cli configDir/login，重验实际身份；不借用本机ambient gh登录或其他成员凭据。
- Chief对角色的结构/约定变更须提出proposal，Maintainer/Owner用准确哈希批准；人类可在原配置入口直接维护角色执行设置。使用 roles/role.proposals 检查当前目录；执行快照与当前目录可能有不同revision，不能覆盖活动Session。

例如以下是**完整配置中的bot片段**，路径、模型、仓库、成员都要换成你的实际值：

```json
{
  "projectRepositories":{
    "YOUR_ORG/YOUR_REPO":{"path":"/your/repositories/repo","model":"YOUR_CHIEF_MODEL","testCommand":["npm","test"],"allowedPaths":["src","test"]}
  },
  "projectResources":{
    "local-dev":{"type":"local","root":"/your/execution-root","capacity":1,"allowedProjectOwnerIds":["owner-1"],"adminMemberIds":["owner-1"],"harnesses":["codex"],"profiles":{"owner-1":{"codex":{"home":"/your/private/sdk-home","configDir":"/your/private/codex-config","model":"YOUR_CODEX_MODEL"}}}}
  }
}
```

真实项目可能使用平台映射成员ID，不要照抄 owner-1。完整角色/资源参数见[资源](subsystems/project-resources.md)、[Harness](subsystems/project-harness.md)、[执行配置](subsystems/project-runtime-setup.md)和[仓库策略](subsystems/project-workbench.md)。
原生FlyBot执行可复用原宿主资源；将角色切换到SDK不会替你登录SDK，也不会自动授权仓库或发布/部署。

## 停止、重启、备份、升级

前台服务用Ctrl-C/SIGTERM正常停止；不要按猜测的PID杀进程或删除锁/租约。需要常驻时交给现有systemd/容器管理，ExecStart指向同一源码和home，工作目录固定到源码。启动器有原生home锁和45秒启动诊断；持续巡检仍是Chief的定时任务配置。
同一home只运行一个实例。新启动失败不会停止占用端口的其他服务。

备份先正常停止该实例，私下备份**完整home**以及独立配置的仓库工作区、SDK profile和外部凭据。SQLite不能只复制运行中的主文件而丢掉WAL；原Store迁移工具会要求独占锁。
升级先记录源码SHA、备份，停止原服务，检出目标代码并运行 init，再 start 同一home；检查 compatibility、pools和execution.boundary，确认恢复中的未知退出仍保持阻塞。
健康活动任务应等待完成或在受支持的检查点停止，不强制重开Session。当前本机普通退出/重启验证不等于所有监督器崩溃恢复都通过。

```bash
node core/scripts/state-storage.mjs inspect --home /your/private/flybot/bot
node core/scripts/state-storage.mjs export --home /your/private/flybot/bot --migration MIGRATION_ID --output /your/private/export.json
node core/scripts/state-storage.mjs rollback --home /your/private/flybot/bot --migration MIGRATION_ID
```

export/rollback在停服后执行，使用inspect得到的准确ID；中断回退需显式 --resume。回到JSON后把backend.json的bot.stateStorage改为json再启动。
JSON/SQLite回退保留新代码格式守卫、ID和已完成Effects，**不是旧二进制降级许可**；不得抹掉守卫或重置回执来重跑外部动作。更多见[存储](subsystems/project-state-storage.md)及[兼容](subsystems/project-compatibility.md)。

## 网络与排障

默认服务只监听回环；需要共享网址时使用自己的HTTPS反代，转发到输出的服务端口。
配置顶层 `publicOrigin: "https://flybot.example.org"` 后保留该Host/Origin；SSE关闭代理缓冲并允许长连接。不要代理原始Harness端口、DSH Owner cookie或整个private目录。
这不要求control-plane代码变更；浏览器与API使用同一个服务地址。

- 启动失败：只在本机检查private/backend.log；排查端口占用、依赖、权限、模型配置，修复后重试。不要把原始日志发到公开讨论。
- `awaiting-chief`：查chief.state、Chief启用/模型/原发起人权限；这不是Dev执行中。
- `queued/blocked`：查pools、execution.boundary、资源runtime-check与Effects；未知worker退出不能手工当作资源已释放。
- `bot/conflict`：重读代次/候选/快照；相同request-id只重试同一意图，unknown先查command.receipt与实际对象。
- 上下文接近预算：用限定来源分页/摘要/长期记忆引用；同Task打回恢复原角色Session，不用“重新开一个”绕过限制。

[测试分层](testing-layers.md)区分单元、真实DSH/本机HTTP持久化、真实SDK与完整模型开发闭环。确定性测试供应商只出现在测试里，启动工具不创建mock模型或样例仓库。

项目自动化可选择 gh-cli 或 App installation，个人操作保留独立用户授权；配置步骤、最小权限和恢复方法见 [GitHub自动化](github-automation.md)。


#2328：`project-resources` 的 `capacity` 区分 `activeSlots`、`waitingInput`、`waitingResume`、`exitUnknown`。`occupied` 是资源租约占用；已确认退出的输入等待可释放项目槽位，退出未知仍占槽。输入到达后由 Chief 决定恢复，原队列按项目配额、资源和权限重新准入；不要通过新建重复 Task 绕过等待。


#2330：`chief.state.health` 区分 enabled 与 pending/healthy/degraded/overdue，展示最近提醒、启动、完成、成功巡检和有效裁决应用时间。`chief.configure` 的 `inspection.lifecycle` 可配置队列/执行期限、恢复延迟/次数和逾期阈值。超时不等于退出；`waiting-exit` 必须等待可信 SDK/native 或原有 systemd 退出证据。未知执行继续隔离，不能通过删租约或重建会话强行恢复。


#2336：资源 reservation 记录 Task/claim/代次归属。已证明未启动的失效预留由原对账回收；registered/starting/spawned 是不同阶段，starting 或退出未知继续占用。reclamation 和 releaseProof 保留回收依据；不要通过清 bindings、删工作树或强清 lease 恢复容量。

### Codex configuration readiness (#2337)

The pinned SDK and CLI must both be 0.166.0 on the selected resource. FlyBot checks
the SDK-resolved executable, not global PATH, before inference. Named role profiles
use `:tmpdir` and their own scratch directory. A `bot/harness-capability` failure
requires inspecting the selected profile's explicit legacy sandbox settings or
installing the pinned CLI with optional platform dependencies; do not disable the
sandbox, expand network access, or replace credentials to hide a configuration
error. Fix the resource profile through authorized operations, then retry the
original Task. Readiness is not a login/model/test PASS; health keeps configuration
failures distinct. Offline regression instructions are in the Harness contract.

### Dependency preparation and test outcomes (#2334)

Example operator repository configuration (not client/Task input):

```yaml
workspacePrepareCommand: [node, /approved/prepare-workspace.mjs]
dependencyEnvironment:
  packageManager: npm
  lockFiles: [package-lock.json]
  tools: [{argv: [node, --version]}]
  requiredPaths: [node_modules]
  npmCachePath: .prepared-npm-cache
  network: offline
  timeoutMs: 30000
```

The fixed hook must create ignored dependencies/cache in each checkout. No hook
installs automatically. Prewarm offline data through authorized provisioning. If an
existing preparation command requires network, declare operator-preparation and the
same dependencyPreparationNetwork capability on its resource/repository; this grants
no network or credentials to role SDKs. Host verifier preparation is separate from
Docker preparation and runs after reset/clean. Missing tools/cache/locks block
verification. Inspect status/reason/testsStarted/executor and preparation references,
not just passed=false. The original Task/Chief controls decide retry or consultation;
fixing environment can rerun the same candidate while retaining old logs. Unknown
remote exit holds capacity until trusted recovery evidence. Use attempt.context
(testHistory/preparationFailures) and attempt.log(environmentRole) for bounded reads.

Missing `vitest` after candidate clean is an environment blocker even when npm
starts: inspect stage=runner-startup and reason=test-runner-unavailable. Exit127 is
not a business assertion failure. Configure an authorized workspacePrepareCommand
for every host-verifier checkout; a manual npm ci or Docker preparation is not a
replacement for this hook, and configuration alone is not a same-candidate test PASS.
