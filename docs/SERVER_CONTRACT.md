# 管理面与运行实例目标契约

实施状态更新：PR16 仍是冻结的认证/工作区切片；后续独立分支已实现 instance/jobs、revision、manager 租约边界及显式模拟，详见 [生命周期切片](RUNTIME_IMPLEMENTATION.md)。以下“首 PR 未实现”描述保留 PR16 边界，不代表后续分支没有这些代码；真实容器/产品对照仍未通过。

这是目标契约，不是已经实现的 API 清单。首个实施 PR **只实现账号/会话/CSRF 与 owner 隔离的工作区记录**。实例、jobs、manager 鉴权、fake RuntimeBackend、Compose 执行与真实容器验收仍待后续切片；请求不会假成功。完整 #2 及总任务 #1 保持开放。

独立新写设计，MIT 只适用于本仓新材料；不授予任何上游代码/镜像复用权。具体已实现请求、限额、安全边界见 [管理 API](MANAGEMENT_API.md)。

最新生命周期规则：重复 start/stop 按 desired 复用当前 revision/operation_id（包括 pending）；restart 是独立操作，同 operation_id 重试复用，新 id 产生新意图并验证进程重启，不展开为 stop+start。此规则在本 PR **仅为后续实现契约**，尚未执行验收。

## 0. 评审结论与当前架构

现行架构为每个用户一个独立 DS-Bot 实例。下表同时记录生命周期首期实现的工程选型。

| 建议 | 评审 | 第一刀处理 |
| --- | --- | --- |
| 抽象 `RuntimeBackend`：`create/start/stop/restart/inspect/logs/backup/restore/upgrade/reclaim` | 采纳。与 bootstrap「显式生命周期接口、编排未选定」一致。 | 接口全定义；MVP 必须实现 create/start/stop/inspect/logs（logs 可最小）；backup/restore/upgrade/reclaim（及 purge）允许 `unsupported`，但要在响应与文档写清缺口，不得假装已交付。 |
| 每个用户一个 DS-Bot 实例 | 已确定的实例分配规则。 | 实例主键为 `instance_id`，生产实例由 `owner_id` 唯一归属。工作区用于共享资源授权。 |
| `desired` + `revision`；观测绑定该 revision | 采纳。避免把过期观测当成当前意图已达成。 | 仅当意图本身变化时才递增 `revision`（例如 desired 从 stopped 变为 running，或一次新的 restart `operation_id`）。`desired` 未变且仅为重复的 start/stop（含尚未观测到的 pending）必须复用当前意图，**不得** `revision++`。`inspect` / 状态 API 必须带回 `desired`、`revision`、`observed_revision`、`observed` 以及当前 `operation`（含 `type` 与 `operation_id`）。仅当 `observed_revision == revision` 时，才可把观测状态视为该次意图的结果。 |
| 幂等、实例互斥；`stop` 保卷；`purge` 单独授权 | 采纳。 | 同一 `instance_id` 的生命周期操作互斥（串行）。重复的 start/stop：只要目标 `desired` 与当前记录相同（无论是否已观测到），一律复用当前 pending/已完成意图并返回同一 `revision` 与 `operation_id`，不另开任务。`stop` 不删数据卷。删除卷 / 销毁实例走 `purge`（或 `reclaim` 的破坏性路径），需单独授权，默认不开放给普通会话。 |
| `inspect` 禁止返回 token | 采纳，硬性。 | inspect、logs、list、status 均不得返回登录 cookie、运行时令牌、模型密钥、Bot Social 凭证或任何 secret 明文 / 可恢复密文。 |
| 首后端：Compose **命令规划** + fake adapter 测试；Web 不挂 Docker socket、不接受任意镜像/命令/挂载；特权操作由 CLI manager 白名单执行 | 采纳，硬性安全边界。 | 管理 **Web/API 进程**不得挂载或持有 Docker socket，不得把调用方传入的 image/command/bind-mount 当参数执行。计划中的第一刀「Compose 路径」是：管理面只改 desired 状态；由本机 **CLI manager** 按白名单执行预先登记的 compose 命令（项目名、服务名、卷名来自配置，不来自请求体）。单元测试用 in-process **fake** backend；fake 通过 ≠ 真实容器部署成功。 |
| 管理 cookie + CSRF；内部 manager 鉴权；运行容器保留自身登录；管理 DB 不存明文 token | 采纳，硬性。 | 三套凭证分离，见 §3。 |
| 专用 Bot Social | 管理跨用户共享状态。 | 工作区、成员、群消息和公开分享见[架构](ARCHITECTURE.md)。复用仍遵守[复用政策](REUSE_POLICY.md)。 |

未采纳或仍开放：编排器不锁定 Docker Compose（它只是第一条自托管验证路径）；数据库不锁定 Postgres/SQLite；不引入 Traefik / 公网入口 / 特定云厂商；不把任一现有控制面实现当规范源码。

---

## 1. 职责边界与数据所有权

### 1.1 三层（管理面不强制单进程）

| 层 | 职责 | 不做什么 |
| --- | --- | --- |
| **管理 server（管理面）** | 账号与会话、工作区记录、角色授权、实例登记、desired 生命周期、状态/审计元数据、对 CLI manager 下发已授权意图 | 不在管理进程内直接跑 Agent；不把任意编排命令暴露给浏览器或 Agent |
| **CLI manager（特权面，可与管理 API 分进程）** | 按白名单执行 create/start/stop 等特权操作，回报 observed 状态与 revision | 不对外提供浏览器可达的 Docker API；不接受请求里的任意镜像/命令/挂载 |
| **运行实例（容器）** | Agent 运行、会话与运行时工作负载、实例自己的登录/会话 | 不自选他人 workspace/instance（仅凭标识符不够）；不承担全局账号体系 |

浏览器客户端只走管理面的已认证产品 API，以及运行实例**自身**的登录后 UI。浏览器与 Agent **不得**直接访问编排基板（socket、manager 控制口、宿主文件系统）。

### 1.2 数据所有权

| 数据 | 所有权 | MVP 落点 | 说明 |
| --- | --- | --- | --- |
| 用户账号、密码哈希、管理会话、CSRF | 管理面 | 管理存储（选型未定，须可迁移） | 密码只存不可逆哈希 |
| 实例登记：`instance_id`、映射、desired、revision、观测摘要、审计 | 管理面 | 管理存储 | 按用户分配，见 §2.2 |
| 管理↔manager、manager↔实例的控制凭证 | 管理面签发，manager / 实例持有 | 密钥文件或密封存储，**管理 DB 不存明文 token** | 可存单向哈希、密钥标识或密封信封，不得可逆写回明文 |
| 运行实例登录会话、实例内用户偏好 | **运行实例自己** | 实例数据卷 | 管理登录不能冒充实例内登录；MVP 不强行打通单点登录 |
| 对话、记忆、任务、附件、Project State 等运行时状态 | 运行实例 | 实例数据卷（stop 后仍在） | 跨实例可见性 / 工作区隔离策略待后续设计 |
| 模型密钥等用户密钥 | 待设计 | 目标 MVP：留在实例卷或由用户在实例内配置；管理面若代存只能密封，且不得出现在 inspect | 现有 FlyBot `docs/docker.md` 把凭证放在 `/data` 卷，仅作历史证据，不是本仓已导入实现 |
| 社交图、跨实例 grant / 审批 | 专用 Bot Social | Bot Social 共享存储 | 用户自己的 DS-Bot 执行个人及智能体任务。 |

备份、恢复、升级、purge 的物理落点随生命周期接口定义，但 MVP 实现可声明 `unsupported`。

---

## 2. 核心模型

### 2.1 Instance（独立主键）

```
Instance {
  instance_id: string          // 主键，独立于用户与工作区
  owner_id: string             // 生产实例的唯一用户归属
  workspace_id: string | null  // 历史兼容字段
  image_ref: string            // 来自**服务端配置/允许列表**，不是请求任意指定
  volume_ref: string           // 由 backend 分配并登记，不是调用方传入任意路径
  desired: "running" | "stopped"
  revision: integer            // 仅在意图变化时 +1，从 1 起
  operation: {                 // 当前意图
    type: "create" | "start" | "stop" | "restart" | ...
    operation_id: string       // 稳定幂等键；restart 必须独立于 start/stop
  }
  observed_revision: integer | null
  observed: ObservedState
  error: { code, message } | null   // 人话，禁止内部栈或密钥
}
```

`ObservedState`：`pending | starting | running | stopping | stopped | failed | unknown`，以及可选的健康摘要（无 secret）、最近心跳时间。
**判定意图已达成**：`observed_revision == revision` 且 `observed` 与 `desired` 一致（running↔running，stopped↔stopped）。revision 落后时只能报告「观测过期 / 调和中」，不能当成功。

### 2.2 每用户一个实例

管理面按 `owner_id` 分配并查找该用户唯一的 DS-Bot 实例。重复分配请求应复用已有实例。同一用户加入或切换工作区时沿用该实例。跨用户共享的工作区与成员权限由专用 Bot Social 管理。早期按工作区组织的实例接口保留为兼容入口，平台托管请求按用户路由。

### 2.3 生命周期语义

| 操作 | 意图 | 数据卷 | 授权 |
| --- | --- | --- | --- |
| `create` | 登记实例，卷可创建，desired 默认 `stopped`，revision=1，分配 create 的 `operation_id` | 创建空卷或按配置初始化 | 已认证用户，且对该 workspace 有权 |
| `start` | 将 desired 设为 `running`。若当前 desired 已是 `running`（不论是否已观测到），**复用**现有意图：不递增 revision、不新分配 operation_id | 保留 | 同上 |
| `stop` | 将 desired 设为 `stopped`。若当前 desired 已是 `stopped`（不论是否已观测到），**复用**现有意图，规则同 start | **保留** | 同上 |
| `restart` | **独立操作**，必须带自己的 `operation_id`（客户端可给幂等键，省略则服务端新发一个并返回）。不是 stop API + start API 的组合，也不得用两次 desired 翻转来模拟。一次新的 restart（新 operation_id）即使 desired 已是 running 也视为新意图：revision++，要求 manager 回收并拉起进程；观测须重新对齐该 revision。用**同一** operation_id 重试则复用，不递增 | 保留 | 同上 |
| `inspect` | 只读，绑定 revision | 不改 | 授权读；**响应无 token** |
| `logs` | 只读，截断 / 红线过滤 | 不改 | 授权读；过滤密钥与令牌模式 |
| `backup` | 快照卷 | 不删源卷 | 可高于普通用户；MVP 可 `unsupported` |
| `restore` | 从合法备份恢复 | 覆盖语义须文档化 | 单独授权；MVP 可 `unsupported` |
| `upgrade` | 更换允许列表内的镜像引用并调和 | 默认保卷 | 单独授权或管理员；MVP 可 `unsupported` |
| `reclaim` | 释放计算资源；默认**保卷**（停止并卸下运行对象） | 默认保留 | 授权操作；MVP 可 `unsupported` 或与 stop 合并说明 |
| `purge` | 销毁实例登记 **并删除卷**（不可逆） | **删除** | **单独更高授权**（确认令牌 / 管理员策略）；MVP 可 `unsupported`，但不得用 stop/reclaim 偷偷删卷 |

**start/stop 幂等（硬性）：**

- 比较的是记录上的 `desired`，不是 `observed`。
- `desired` 已等于请求目标时（包括 `observed_revision < revision` 的 pending），重复 start/stop 返回当前快照，revision 与 operation_id 不变。禁止在等待观测时因重试而无限 `revision++`。
- 仅当 `desired` 实际切换（stopped↔running）时才 revision++，并分配该次 start 或 stop 的新 `operation_id`。

**restart（硬性）：**

- 使用独立 `operation_id`，不得实现为「先调 stop 再调 start」，也不得把语义写成这两种说法的可选项。
- 新 `operation_id`：revision++，desired 变为（或保持）`running`，manager 必须执行一次进程级回收再启动；卷保留。
- 同一 `operation_id` 重试：复用该次 restart 意图，不递增。
- 对已 `desired=stopped` 的实例：restart 是新意图（desired→running + 一次启动），仍使用 restart 的 operation_id，而不是先创造一个 stop 意图。
- 进行中的 start 与新的 restart（不同 operation_id）冲突：串行或 `409 conflict`（响应带当前 revision 与 operation），须测试锁定。禁止交叉改卷。

并发：同一 `instance_id` 同时只运行一个调和循环。

---

## 3. 鉴权（三套凭证分离）

1. **管理用户会话**：HTTP cookie（建议 `__Host-` 前缀当 HTTPS；本地明文 HTTP 开发须写清降级风险）。状态改变请求必须带 CSRF（cookie + 头，如 `X-CSRF-Token`）。注册 / 登录有速率限制。
2. **内部 manager 凭证**：管理 API 与 CLI manager 之间的共享密钥或签名，只走本机或受控回环，不进浏览器，不进运行实例日志。Manager 调管理面回报观测时必须鉴权。
3. **运行实例自身登录**：实例 Web 继续用自己的登录（历史 FlyBot 为实例内 token 链接，仅作行为参考）。管理面**不**把实例登录 token 写入管理 DB 明文，也**不**通过 inspect/launch 响应回传 token。若日后做「一键打开实例 UI」，须另设计短时一次性交付，且不得把 token 持久化到管理库；**MVP 不做 launch-token 交付，用户按实例本地地址自行登录**，以避免把秘密送进管理面。

禁止：用用户 cookie 直接驱动 Docker；把 manager 密钥发给前端；运行实例凭一个 workspace_id 改绑到其他工作区。

---

## 4. `RuntimeBackend` 接口（语言无关）

实现必须遵守 §2–§3。测试用 `FakeRuntimeBackend`（内存，可注入失败）；自托管路径用 `ComposeCliBackend`（只发白名单命令，见 §6）。二者实现同一接口。不得在 Web 进程内嵌套「任意 docker run」。

```
RuntimeBackend
  create(ctx, req) -> InstanceSnapshot
  start(ctx, instance_id, expected_revision?) -> InstanceSnapshot
  stop(ctx, instance_id, expected_revision?) -> InstanceSnapshot
  restart(ctx, instance_id, operation_id, expected_revision?) -> InstanceSnapshot
  inspect(ctx, instance_id) -> InstanceSnapshot    # 无 token 字段
  logs(ctx, instance_id, opts) -> LogPage          # 已红线，有截断标记
  backup(ctx, instance_id) -> BackupRef | Unsupported
  restore(ctx, instance_id, backup_ref) -> InstanceSnapshot | Unsupported
  upgrade(ctx, instance_id, allowed_image_ref) -> InstanceSnapshot | Unsupported
  reclaim(ctx, instance_id) -> InstanceSnapshot | Unsupported
  purge(ctx, instance_id, confirmation) -> void | Unsupported
```

`ctx` 含已鉴权的 actor、workspace 范围、相关 revision。`expected_revision` 可选作乐观并发。
`Unsupported` 必须是显式错误码 `unsupported`，并带稳定的缺口说明，不得用空成功或把 stop 冒充 backup。
`InstanceSnapshot` 字段同 §2.1（含 `operation.operation_id`），**禁止**附加 `token`、`cookie`、`password`、`api_key`、`secret` 等键。

---

## 5. 管理 HTTP API（MVP）

前缀 `/v1`。JSON。错误形如 `{ "error": { "code": "...", "message": "人话" } }`，不回内部栈、文件路径秘密、令牌。未认证 `401`，无权限 `403`（不泄露他人实例是否存在时可统一 `404`），冲突 `409`，未实现 `501` + `unsupported`。

### 5.1 账号

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/auth/register` | 创建账号并开会话；首用户策略（开放注册 / 邀请码）为配置，须写清默认 |
| POST | `/v1/auth/login` | 设置会话 cookie + CSRF cookie |
| POST | `/v1/auth/logout` | 需 CSRF；吊销会话 |
| GET | `/v1/auth/session` | 当前用户；可轮换 CSRF；无秘密 |

### 5.2 工作区记录（产品向导不是本切片）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/workspaces` | 创建工作区记录，调用者成为 owner |
| GET | `/v1/workspaces` | 仅返回调用者可见的工作区 |
| GET | `/v1/workspaces/{workspace_id}` | 越权 `404` |

### 5.3 实例生命周期

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/workspaces/{workspace_id}/instances` | `create`：body 不得含 image/command/mount/token；镜像来自服务器配置 |
| GET | `/v1/workspaces/{workspace_id}/instances` | 列表，无 token |
| GET | `/v1/instances/{instance_id}` | `inspect` |
| POST | `/v1/instances/{instance_id}/start` | 需 CSRF |
| POST | `/v1/instances/{instance_id}/stop` | 需 CSRF；保卷 |
| POST | `/v1/instances/{instance_id}/restart` | 需 CSRF；保卷。Body 可含 `operation_id`（幂等键）。新 id 或省略（由服务端签发）表示一次新的 restart；重复同一 id 复用。响应含 `operation`。不得在服务端展开为 stop+start 两次 API。 |
| GET | `/v1/instances/{instance_id}/logs` | 查询参数限制行数 / 时间；已过滤 |

`backup` / `restore` / `upgrade` / `reclaim` / `purge` 的路径预留（例如 `POST /v1/instances/{id}/backup` 等），MVP 可全部 `501 unsupported`，OpenAPI/文档必须列出缺口。`purge` 即使日后实现也要求确认字段，禁止 GET。

内部（仅 manager 凭证，不进浏览器 CORS）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/internal/instances/{instance_id}/observe` | 上报 `observed`、`observed_revision`、健康、错误人话 |
| GET | `/v1/internal/instances?desired=running` | manager 拉取代调和列表（最小） |

不在 MVP：实例 UI 的 launch-token、对外 Agent API 网关、公开嵌入、渠道密钥、Social 适配。

---

## 6. 自托管隔离 MVP（最小可行部署）

目标：不依赖 Teamily 云、不依赖 Bot Social、不碰生产网络，在一台机器上证明「管理面能安全地管起来、停下去，且租户隔离」。

### 6.1 组件

1. 管理 API 进程（无 Docker socket）。
2. 管理存储（本地文件或单一嵌入/本地 DB 即可，选型未锁定，须可备份迁移）。
3. CLI manager（同一管理员在同一台机器运行；凭配置白名单调用 `docker compose` 或等价命令）。
4. 一个或两个运行容器（第二条用于隔离测试）；每实例独立数据卷；Web **只绑回环**，不发布到公网地址（与历史 `compose.yaml`「host 回环、勿对公网暴露」的安全意图一致，但不照搬其 `network_mode: host` 为唯一网络模式）。
5. 文档：如何启动管理面与 manager、如何创建用户与实例、备份缺口、凭证处理。

### 6.2 Compose 命令规划（第一条真实路径，不是唯一编排）

配置示例（实现可改名，原则不可改）：预先登记 `compose` 文件路径、项目名模板、服务名、卷名模板、允许的 image tag。manager 只执行类似：

- `create`：确保项目 / 卷存在，容器不要求已 running
- `start`：`compose up -d --no-build`（或 up 已构建镜像；构建策略在文档写清，禁止请求体带 Dockerfile）
- `stop`：`compose stop`（**不是** `down -v`）
- `inspect` / `logs`：`compose ps` / `compose logs --no-color --tail N`
- 若误用 `down -v`、`rm -v`、任意 `docker run`，视为违规

项目名必须由 `instance_id` 经受限字母数字派生，防止注入。不允许把用户输入拼进 shell。

### 6.3 成功标准（MVP）

1. 用户注册 / 登录管理面，创建 workspace，`create` 实例，`start` 后在 `observed_revision == revision` 且 observed=running 时 `inspect` 成功。
2. `stop` 后再 `start`：数据卷仍在（用实例内可观察的标记文件或管理面记录的 volume_ref 证明）。
3. 用户 B 不能 `inspect` / `start` / `stop` 用户 A 的 `instance_id`（测 404/403）。
4. `inspect` 与 logs 的测试夹具若注入 token/密钥，响应体不得出现。
5. 管理存储转储中不得出现明文会话 token 或实例登录 token。
6. 单元测试：`FakeRuntimeBackend` 覆盖：desired 已是 running 但未观测到时重复 start 不递增 revision；stop 同理；新 restart `operation_id` 递增且要求回收；同一 operation_id 重试不递增；revision 对齐、互斥、越权、unsupported 缺口。
7. 至少一条**真实** compose 路径的集成测试或手工脚本（可在隔离环境，不碰生产）。文档写明：仅 fake 全绿不能宣称已部署容器。
8. `backup` / `upgrade` / `purge` 在 API 与 README 中列为明确缺口（`501`）。

非目标见 [管理面与运行容器生命周期 issue #2](https://github.com/openTeamily/openTeamily/issues/2)。

---

## 8. 开放决策（不得写成已定）

- 容器粒度（每账号 / 每工作区 / 每 Agent 等）
- 编排器与操作系统发行；Compose 只是第一路径
- 管理存储引擎与高可用
- 对外总入口 / 反向代理 / TLS 终止
- 管理登录与实例登录是否以及何时打通
- 是否、以及以何种许可复用 FlyBot 运行时或 Bot Social
- `project` / `timeline` 等插件去留（已作静态能力审计；不作为核心默认依赖的建议仍待正式取舍，本契约不删除）

---
