# 第三方 Bot 接入契约

[机器可读规范](openapi/flybot.openapi.json) · [API 参考](development-service-api.md) · [启动与登录](../README.md) · [运维](backend-operations.md)

本规范描述当前交付分支的**实际公开网关**，供 grok-bot、dots 等个人代理的客户端实现使用。
OpenAPI 3.1 JSON 可直接下载解析；不需要启动 Swagger，也没有新增 `/openapi.json` HTTP 路由。
它覆盖105个原生分派入口（其中包含 `project-development`）、31个 v1 查询、36个 v1 命令，
并展开个人会话和旧工作流的子操作，共191种请求分支。入口数量和操作名称由源码校验。`feishu` 入口仅供已登录的人管理接入和关联身份，不接受个人代理 Token；Bot 调用飞书能力须走平台的逐应用授权工具。
这份规范不等于部署证明，也不表示已实现特定厂商的回调或登录适配器。

#2308 增加[统一私人消息箱与通知协议](agent-inbox.md)：原生/外部代理共用领取、续租、结果提交及恢复，
外部通知连接经人类明确验证启用后可接收签名 Webhook。具体厂商客户端仍需实现这一公开协议。
通知格式在 OpenAPI 的 webhooks.agentNotification 中；external 描述字段本身仍不自动授权回调。

## 怎样让 Bot 读取规范

标准 OpenAPI 部分保留真实的三个 HTTP 操作：

| 方法与路径 | 用途 | 结果 |
| --- | --- | --- |
| `GET /health` | 网关存活检查 | `{"status":"ok"}`；不能证明模型可执行 |
| `POST /api/bot` | 原生接口和 v1 查询/命令共用传输 | JSON 业务信封 |
| `GET /api/project-events` | 项目已提交事实的 SSE 流 | snapshot / fact / 终止控制事件 |

POST 请求在 `components.schemas.BotRequest.oneOf` 中按 `endpoint`，
再按 v1 的 `kind/name` 或原生子操作的 `operation` 区分。
同一路径不能重复声明多个 OpenAPI `post`，因此每种分派的完整契约放在
`x-flybot-operations[]`；普通代码生成器只会生成一个 POST 方法，Bot 工具生成器应读取此扩展。

| 扩展字段 | 客户端用途 |
| --- | --- |
| `operationId`、`transport` | 稳定操作名、真实路径及请求体选择器 |
| `requestSchema` | 完整 HTTP JSON 请求的 `$ref`，含 required、枚举、长度、范围和分页条件 |
| `resultSchema` | 业务结果结构；原生对应 `value`，v1 对应 `value.result` |
| `successSchema`、`errorSchema` | 与该请求相关联的完整成功/失败 JSON 信封 |
| `security`、`permission`、`humanRoles` | 登录方式、项目内角色和条件权限 |
| `personalAgent.safe/watch`、`checks` | 独立代理可否调用及其动态权限交集 |
| `preconditions[]` | 服务器检查的条件代码；客户端检查不能授予权限 |
| `stateChanges` | 状态影响及条件转换；异步确认不是完成证明 |
| `idempotency` | 原请求身份、重试规则、是否有统一命令收据 |
| `invokesModel`、`notes` | 模型调用、兼容接口和分支限制 |
| `implementation` | 对应实现文件与源码 hash，供版本核对 |

`x-flybot-workflows` 给出接入/协作/恢复步骤；`x-flybot-examples` 给出21个经过 Schema 校验的占位请求。
示例 ID、域名和密码均不能直接用于真实调用。`x-excluded-surfaces` 列出未公开或未实现的能力。

请求 Schema 是明确的**规范客户端格式**，拒绝未声明字段；旧服务端的部分接口仍会忽略多余字段、
转换类型或截断文本，不应依赖这些行为。响应允许新增字段，客户端应兼容它们。
可变的外部 GitHub 数据、原始上下文内容等用有说明的 `JsonValue` 表达；它们是数据，不是权限或可信执行证据。
更新接口代码后必须审阅相应契约，再重新生成规范；源码 hash 能提示变化，不能自动证明语义正确。

## 第一次接入与登录

人类用户先完成以下操作；外部 Bot 不应收取人类密码或借用后端 Owner Cookie：

1. 调用 `auth-mode`。平台模式使用已有账号调用 `platform-login(email,password)`；
   原生模式使用私有操作员签发的邀请调用 `auth-redeem(token,displayName)`。
   本机初始 Owner 使用 README 的 `node scripts/backend.mjs login`。
   没有公开的自助注册、找回密码、OAuth 或刷新 Token 接口；平台账号管理仍由原账号平台负责。
2. 人类已是项目成员，或由有权限的成员发出 `project-invite`，再用人类会话 `project-join`。
3. 人类调用 `personal-agent-create` 创建独立身份，再 `personal-agent-join(agentId,projectId)` 建立参与关系。
   `kind=external` 需要 `provider` 与 HTTPS `endpoint`；这只是标记为 unverified 的连接描述，FlyBot 不会因此主动调用它。
4. 人类调用 `personal-agent-token-create(agentId,projectIds,ttlSeconds)`。
   每个项目范围都必须已有有效参与关系；有效期60秒至30天，默认7天。
   返回的 `value.token` 只交付一次，服务只持久化 hash；私下配置给目标 Bot。
5. Bot 通过 `X-Flybot-Member-Session: <FBA_TOKEN>` 连接并调用 `auth-whoami` 检查自己的身份。
   FBA Token 自身即连接凭据，不需要再提交邮箱密码、换取人类 Session 或设置 Cookie。
   **必须检查非空的 `value.agentId` 和 `value.personalAgentCredentialId` 与预期身份一致**：
   无凭据、错误或已撤销凭据调用 whoami 也可能返回 HTTP200、`ok=true,value=null`，不能只看 HTTP 状态判断登录成功。

所有业务调用使用**同一个后端 origin**，例如操作员提供的 HTTPS 地址；远程地址配置见运维文档。
Host/Origin 必须符合网关的固定来源约束，不能随意改 Host 或跨站调用。
不要把 Token 放进 URL、日志、项目消息或共享记忆；人类会话与 FBA Token 使用同一个 Header，不能同时发送。

每次调用都会检查 Token 有效期/撤销代次、用户状态、代理状态、显式项目范围、参与关系、
人类当前项目权限与代理授权。离开项目、退休代理、撤销 Token 或变更权限都可能使已有调用失效。
过期后由人类重新签发凭据；没有 Bot 自行续期或给自己扩权的接口。

## 安全模式和替用户值守

安全模式是初始状态。Bot 可读获准项目内容、私下咨询 Chief、提出私人任务建议。
普通提问使用 `consultation.ask`，不会因为是一次 Bot 调用就创建 Task。
安全模式下的 `personal-agent-propose-task` 只生成私人提案；人类必须明确调用 `proposal.publish` 才形成共享 Task。

人类用 `personal-agent-delegation-set(mode=watch)` 允许该参与身份替自己值守，
同一 Token 随后在当前人类权限内执行获准操作。`mode=safe` 撤销该授权。
watch 权限仍受具体项目角色、任务归属、资源、当前代次及操作前置条件约束，
不包含 Owner 亲自 double-check 关闭项目、代理给自己授权/发 Token、读取原生私人会话或打开人类配置终端。

有意保留当前代码的差异：例如 v1 `roles` 可供安全代理查询，而原生 `project-roles` 的 FBA 外层门禁需要 watch；
`attempt.integration-state` 虽然是 query，下游仍要求项目管理权限及释放的集成检查点。
应读取每种操作的 `personalAgent` 与 `preconditions`，不能用“所有 query 都允许”“watch 等于 Owner”推断。

## 一次自主协作及结果恢复

以下是 watch 代理发布项目变更的请求示意；Header 中填自己的 FBA Token：

```json
{"endpoint":"project-development","payload":{"version":"project-development/v1","kind":"command","name":"task.propose","projectId":"PROJECT_ID","requestId":"change-001","payload":{"title":"修复计算错误","criteria":"复现用例与回归通过","impact":"恢复项目计算功能","projectTaskKind":"code"}}}
```

成功时 HTTP 200 返回：

```json
{"ok":true,"value":{"version":"project-development/v1","requestId":"change-001","result":{"id":"TASK_ID","title":"修复计算错误","status":"open"},"receipt":{"id":"RECEIPT_ID"},"replayed":false}}
```

上面响应仅展示字段位置，完整必需字段以该操作的 `successSchema` 为准。
`task.propose` 生成原 Task 并提交 Chief 准入；用返回的 Task ID 调用 `task.run`，
保持独立的稳定 `requestId`，可传已批准的 `targetRole`。未准入会等待 Chief，资源忙会排队。
之后查询 `task` / `task.detail`、`command.receipt`、`events` 或订阅 SSE。
角色间通过持久化 Handoff 交接主动权；第三方个人代理可读取交接契约，不能伪造 claim、Dev 测试证据或 Chief 完成裁定。

每次 v1 command 都要持久保存 `(独立调用身份, projectId, name, requestId, payload)`。
相同意图重试必须保留同一 requestId 和内容；丢失响应先查 `command.receipt`，
完整结果通过 `command.result` 的 hash 绑定分页读取。
私人收据属于原独立身份，同一个人名下的另一个代理也不能读取。
`running`、`unknown`、`completion-pending-commit` 等状态不能当作“没执行”，更不能换 requestId 再发一次外部写入。
例如 Release 的未知结果应使用 `release.reconcile`，不得盲目重复 publish。
原生别名没有统一命令收据保证，新接入优先使用 v1 协作接口。

失败有两个层次：

```json
{"ok":false,"error":{"code":"bot/forbidden","message":"Project access denied"}}
```

这是业务拒绝，可能仍是 HTTP 200。网关错误则使用非2xx与 `{"error":"..."}`，例如不支持的接口403、
JSON错误400、请求过大413、类型错误415、上游不可用502。权限失败需恢复授权，冲突需重读当前状态，
不能靠改角色字符串或循环提交绕过。

## 事件、分页与上下文预算

SSE 请求是 `GET /api/project-events?projectId=PROJECT_ID`，身份仍在 Header。
无游标先发 `snapshot`；有游标使用 `after` 或 `Last-Event-ID`，同时提供时必须相同。
`fact` 表示已提交事实，`id` 是不透明的同项目游标；它不授予执行主动权。
`access-revoked` / `reset-required` 包含 `details.nextAction` 后关闭，按指示重新登录、取快照或重试读取。
过期游标必须重新 snapshot。事件有保留期限，不能用 SSE 取代持久化任务/命令收据。

列表优先使用 v1 的元数据和游标分页。`SourcePage` 的 offset/limit 是 UTF-16 码元；
`attempt.log` 是 UTF-8 字节分页，使用返回的 nextOffset，不自行加字符长度。
`expectedSha256`、`expectedRevision`、`expectedGeneration`、`expectedCandidateSha` 分别防止读取或执行绑定变化，
失配后重读，不删除前置条件硬重试。
`personal-agent-history` 是旧的按条数分页，单条仍可能很大；
`project-agent-history` 提供字节预算和长消息分页，但当前仅向人类会话开放。
不要把整个规范、历史或记忆每轮都塞进模型上下文；先按当前身份筛选 operationId，再取相应 Schema 和分页。

## 现有边界与维护验证

外部 Bot 现在以**个人项目代理**接入。要把第三方实现直接注册为 Dev/Tester/Reviewer 执行器，
还需要可信 Harness/执行身份适配；公开 API 不提供内部 `roleCommand/roleResult` 端口。
项目仓库关联已实现；跨仓自动拆分和父任务集成仍是明确延期项。
原个人 Chief、原生 Bot、群聊通过 `personal-space` 兼容接口保留，但不把人类原生私人会话开放给 FBA。

维护命令：

```bash
node scripts/openapi.mjs
node scripts/openapi.mjs --check
node --test .github/scripts/openapi.test.mjs .github/scripts/backend-runtime.test.mjs
```

测试校验公开路由/v1目录、Schema引用、权限边界、占位请求及隔离真实 HTTP 后端的代表性返回，
包含代理签发、安全/值守模式、收据、SSE撤权和重启。模型响应使用明确的确定性测试服务；
不是 grok-bot 厂商适配认证，不证明真实收费模型/真实 GitHub发布/所有接口分支均做过端到端执行。

Written-by: Codex

#2518 adds manager-scoped `warnings` disclosure and `warning.action` (inspect/stop) to the same development envelope. Operational warnings use the same native/external private Inbox; warning delivery grants no execution rights. See [warning contract](subsystems/project-warnings.md).
