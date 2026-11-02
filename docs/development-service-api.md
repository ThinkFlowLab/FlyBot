# 自动开发服务 API 参考

适用：`delivery/development-service` 分支，业务源码基线 `1811e3b8f`。
覆盖本版本全部 **12 个 v1 查询、21 个 v1 命令**，以及完成登录、项目选择、
任务创建和个人代理交互所需的原生接口。不是全部 FlyBot/DSH 管理接口的目录。

[快速启动与登录](../README.md) · [操作流程与状态模型](development-service-guide.md) ·
[内部服务契约](subsystems/project-development-service.md)

## 1. 传输、登录和请求信封

当前共享入口：`POST http://127.0.0.1:18080/api/bot`。
其他部署使用自己的网关地址。所有请求使用 `Content-Type: application/json`。
登录后的请求携带 `X-Flybot-Member-Session: <sessionToken>`；调用不依赖浏览器。
README 中的 `fb_api`、`fb_dev` 是 Bash 调用函数，不是另行安装的 CLI。

### 登录与注销

原生请求（不包装为 v1）：

```json
{
  "endpoint": "platform-login",
  "payload": {"email": "YOUR_EMAIL", "password": "YOUR_PASSWORD"}
}
```

成功时从 `value.sessionToken` 取得会话；密码和 Token 不应写入仓库。
注销请求是 `{"endpoint":"auth-revoke","payload":{}}`，带本次会话的请求头。
它撤销本次 Session，不是停止整个后端，也不等于撤销独立的个人代理值守授权。

### v1 查询示例

以下 ID 均为占位符，应替换为服务实际返回的值。

```json
{
  "endpoint": "project-development",
  "payload": {
    "version": "project-development/v1",
    "kind": "query",
    "name": "tasks",
    "projectId": "PROJECT_ID",
    "payload": {"limit": 20}
  }
}
```

### v1 命令示例

```json
{
  "endpoint": "project-development",
  "payload": {
    "version": "project-development/v1",
    "kind": "command",
    "name": "task.run",
    "projectId": "PROJECT_ID",
    "requestId": "run-example-001",
    "payload": {"taskId": "TASK_ID"}
  }
}
```

| 信封字段 | 类型与要求 |
| --- | --- |
| `version` | 必填字符串，固定为 `project-development/v1` |
| `kind` | 必填，`query` 或 `command`，必须与操作对应 |
| `name` | 必填，见后续完整索引 |
| `projectId` | 必填，当前用户必须有该 Project 权限 |
| `payload` | 对象，缺省为 `{}`；下文的接口参数均指这一层 |
| `requestId` | 命令必填；1–100 字符，只允许字母、数字、`_`、`-` |
| `expectedGeneration` | 可选非负整数；校验目标 Task 当前协作代次 |
| `expectedCandidateSha` | 可选，完整 40 位小写 SHA 或 `null`；校验当前候选 |

两个 `expected*` 字段位于信封层。使用它们时需要能通过 taskId/attemptId 等解析到 Task。
内部 payload 的 projectId 若存在，必须与信封一致。任务、Attempt、队列、proposal、worker、
Effect 等引用不能借助一个信封跨 Project 或指向互不相关的 Task。
调用者身份只从认证得到，body 中填写 memberId、Owner 或 Bot 名称不会获得权限。

### 响应与异步操作

```json
{
  "ok": true,
  "value": {
    "version": "project-development/v1",
    "result": {"tasks": [], "next": null}
  }
}
```

命令的 v1 `value` 还会返回外层 `requestId`。原生接口的 `value` 直接是业务结果，
没有自动添加 v1 包装。业务失败可能仍使用 HTTP 200：

```json
{
  "ok": false,
  "error": {"code": "bot/forbidden", "message": "Project access denied: configure"}
}
```

先检查 HTTP 传输，再检查 `ok`。`already:true` 是该操作的重复处理结果，不是任务已完成。
启动、巡检、输入提交、Effect 重试的成功响应只是接受/安排处理；通过查询继续跟踪。
`requestId` 不会让所有命令自动具备相同的幂等语义，具体见各操作说明。

## 2. 权限约定

| 下文权限名 | 当前共享 Project 策略 |
| --- | --- |
| `read` | 当前 Project 的 Owner、Maintainer、Member |
| `create` | 活跃 Project 的成员；归档后不能创建新工作 |
| `task-write` | Owner、Maintainer，或该 Task 的原发起人 |
| `configure` | Owner、Maintainer |
| `run-control` | Owner、Maintainer |
| `accept` | Owner、Maintainer；仍须通过全部候选证据门禁 |
| manager | Owner 或 Maintainer；清理等操作还有资源释放检查 |
| own | 当前用户自己的代理、会话、提案、凭据 |

表中是基础权限；还会检查活跃项目、实时账号状态、授权代次、具体任务与资源。
可调用 `execution.boundary` 并携带 taskId 查看当前身份下的权限元数据。
AI 角色名不赋予人类权限。值守代理也不能超越其授权用户或跨出该 Project。

## 3. 全部查询（12 个）

本节均使用 `kind:query`，无需 requestId。`*` 表示必填；参数均为 payload 字段。

| 操作 | 参数 | `result` 主要字段 | 权限及备注 |
| --- | --- | --- | --- |
| `tasks` | `limit?:integer=50`，1–200；`after?:taskId` | `tasks:TaskView[]`, `next` | read；按创建时间、ID 升序；游标必须属于本项目 |
| `task` | `taskId*:string` | `task:TaskView` | read；用于轻量轮询 |
| `task.detail` | `taskId*`；`attemptLimit?:integer=20`，1–50；`beforeAttemptId?` | 原始 `task`、`attempts` 摘要、派生 `view`、`attemptsPage` | read；默认最新一页，before 游标向历史翻页 |
| `pools` | 无 | `pools:[{botId,role,tasks}]` | read；显示可领取的 queued/arbitration 任务，不是全部执行进程列表 |
| `chief.state` | 无 | `policy`, `template`, `schedule`, `runs` | read；返回最近 Chief 协调 Run 与巡检配置，不会自行启动巡检 |
| `inputs` | `taskId*`；`limit?:integer=50`，1–200；`after?:inputId` | `inputs`, `next` | read；包含输入文本、来源与传递/读取/处理回执 |
| `sources` | `limit?:integer=50`，1–100；`threadId?`；`after?:eventId`；或 `eventId?`,`offset?:integer=0` | 列表形态：`sources`,`threads`,`subscriptions`,`events`,`next`；详情形态见下文 | read；项目必须有合法登记仓库 |
| `effects` | `taskId?`；`limit?:integer=50`，1–200 | `effects` | read；按更新时间倒序；不返回内部 payload/history/key，没有分页游标 |
| `execution.boundary` | `taskId?` | 见下文边界元数据 | read；重新校验身份，不启动 SDK 或测试 |
| `attempt.context` | `attemptId*`,`section*`；`offset?:integer=0`；`limit?:integer=8000`，1–16000；`expectedSha256?` | `attemptId`,`section`,`sha256`,`offset`,`text`,`totalChars`,`nextOffset` | read；section 仅 roleSessions / roleSessionHistory / rolePolicies |
| `attempt.log` | `attemptId*`；`role?:string` | `text`,`sha`,`sha256`；无日志时 `text:null,reason` | read；缺省读宿主测试日志，role 指定已有角色执行日志；会核对哈希，不分页 |
| `attempt.integration-state` | `attemptId*` | `attemptId`,`generation`,`inputs`,`snapshot` | configure；仅当前池协议 Attempt，须确认执行退出；不是忙碌时可随意读取的普通监控接口 |

### 查询结果细节

`task.detail.attemptsPage` 包含 `total`、`limit`、`before`；下一次请求将 before 放入
`beforeAttemptId`。摘要不重复发送完整角色上下文，使用 `contextRef` 指定的分页查询。
`attempt.context` 应按 `nextOffset` 继续，后续页带首次的 `expectedSha256`；变化则重读。
其 `text` 是原始记录 JSON 文本的片段，不一定单页就能解析成完整 JSON。

`sources` 的 `eventId` 详情模式返回 `event` 元数据、`text`、`offset`、`nextOffset`、`sha256`；
每页最多 16000 字符。列表模式的 limit 约束事件页，不限制所有 threads/subscriptions 数量。

`execution.boundary` 返回 `version,projectId,memberId,profile,host,permissions,taskScope,delegation,resources,credentials,preflight,memory,invariants,evidence`。
凭据仅为配置状态/选定身份等元数据；测试、SDK 运行状态在此处标注为未执行，不得据此认定环境已跑通。

`attempt.integration-state.snapshot` 若已有工作区，包含 `workspaceId,head,mergeHead,indexSha256,statusSha256`；
尚未分配时可以为 null。不要绕过“等待退出”错误去直接修改 Git index 或 state.json。

### TaskView 字段

v1响应中的 `value.result.tasks[]` 和 `value.result.task` 使用同一种 TaskView。
字段从当前持久记录及实际活动派生；不要把原Task的status字段直接当成这里的phase。

| 字段 | 类型/含义 |
| --- | --- |
| `version` | 固定 project-development/v1 |
| `projectId`, `taskId` | 字符串，稳定归属与身份；ID按不透明标识处理 |
| `publication` | 当前已发布任务视图为 published；未发布私人提案不在这里 |
| `phase` | 派生阶段；完整枚举与解释见操作指南 |
| `waitingFor`, `reason` | 字符串或null，当前等待对象与原因；reason不是可执行指令 |
| `botId`, `currentRole` | 当前逻辑Bot及chief/developer/tester/reviewer角色，未知时null |
| `generation` | 当前协作代次或null；乐观并发控制用此值，不是worker代次 |
| `attemptId` | 当前开发尝试ID或null；返工可变化，Task身份不变 |
| `executionId` | 当前claim或Run ID，可能null；不是SDK thread ID |
| `workerId` | 当前claim绑定的worker，可能null；有ID不等于仍在运行 |
| `queueId` | 当前关联准入队列或null |
| `candidateSha` | 完整40位候选Git SHA或null；不是main当前HEAD |
| `executionGeneration` | 关联SDK worker代次或null，用于execution.input |
| `inputRequestId` | 当前SDK待回答问题ID或null，不是普通Task补充输入ID |
| `lastMeaningfulProgress` | null或 `{at,evidence}`；依据可验证候选/宿主测试，不以消息数量当进展 |
| `evidence.tests` | null或 `{sha,sha256,passed,current}`；current指是否匹配本候选 |
| `evidence.review` | null或 `{sha,verdict,current}`；不是仓库合并授权 |
| `inputs` | 最多20条accepted非handoff输入摘要，含id/sha256/createdAt/deliveries/readConfirmed；完整状态查inputs分页 |
| `effects` | 当前pending/running/failed副作用摘要，含id/kind/status/failures/dueAt/error/waitingFor；完整可见记录查effects |
| `nextActions` | 当前用户可尝试的操作名数组；之后仍需实时重新校验 |

时间戳如createdAt/at/dueAt通常为Unix毫秒；业务SHA与日志/正文SHA256用途不同，不能互换。
`readConfirmed`是当前角色的已读声明，不是独立的理解正确性证明。单个查询是快照，下一次操作前状态可能变化。

## 4. 全部命令（21 个）

每项均另需第 1 节的外层 requestId。下列 JSON 是内部 payload 示例，不是完整 HTTP 请求。
写操作示例不要整段盲跑到正在开发的 Task 上。这里没有“修改 phase”的接口。

### C01 `task.run`

```json
{"taskId":"TASK_ID"}
```

权限：create + 该 Task 的 task-write。结果为 `{attempt,already?}` 或 `{queue,already?}`。
资源/配额不足时排队，排队不会预先分配新工作区。相同 Task/requestId 复用已有 Attempt/队列；
已有活跃 Attempt 时不能靠换 requestId 并行重跑。Task 发布本身不等于启动。

### C02 `task.accept`

```json
{"attemptId":"ATTEMPT_ID"}
```

权限：accept。结果 `{attempt,already?}`。需要 waiting-acceptance、当前且完整的候选证据、
已处理的输入、同 SHA 宿主测试/Review、仍匹配的开放 PR 等；池协议还需要 Chief 批准。
成功推进 Task/Attempt 验收状态，不合并 PR、不部署代码。已 accepted 可返回 already。

### C03 `task.reject`

```json
{"attemptId":"ATTEMPT_ID","reason":"验收中发现具体问题"}
```

权限：accept。`reason?:string`，缺省为 Human requested changes，保存最多1000字符。
仅 waiting-acceptance；结果 `{attempt}`，记录返回人并置为失败/待后续处理。
该接口本身不等于已经启动下一轮；通过后续合法调度/Chief 决定恢复。

### C04 `attempt.stop`

```json
{"attemptId":"ATTEMPT_ID"}
```

权限：run-control。结果 `{attempt,already?}` 或 `{attempt,stopping:true,remainingWorkers}`。
先保存停止意图，再停止实际执行；仍有未确认退出的 worker/租约时不会假装容量已释放。
终态重复停止可 already。查询 TaskView 的 stopping 与工作区释放情况，不靠 HTTP 成功判断停止完毕。

### C05 `attempt.cleanup`

```json
{"attemptId":"ATTEMPT_ID"}
```

权限：manager。结果 `{attempt}`。清理服务所拥有的终止工作区；活跃 Attempt、等待验收、
残留 worker/租约会拒绝。其他 Attempt 仍复用的目录不会被误删。它不是取消任务，也不是清除审计历史。

### C06 `attempt.publication-retry`

```json
{"attemptId":"ATTEMPT_ID"}
```

权限：configure。结果 `{attempt,already}`。只恢复当前活跃 Attempt 的既有 PR 发布绑定，
要求已确认角色退出、同候选测试/Review/执行日志完整，需求未变化。
不能给任意 SHA“补一个成功发布”，也不能用它绕过 PR HEAD 不一致；远端事实仍须重新核对。
requestId 不代表强制重复外部发布；底层 outbox 和原 PR 绑定负责协调。

### C07 `attempt.integration-bind`

```json
{
  "attemptId":"ATTEMPT_ID",
  "generation":7,
  "inputs":[{"ref":"refs/remotes/operator/backend","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],
  "expectedWorkspace":null
}
```

权限：configure。必填 generation、1–4 个唯一 ref/SHA、expectedWorkspace。
ref 只允许 `refs/remotes/operator/...` 下经操作者提供的来源，SHA 必须是完整小写40位且引用仍匹配。
已有工作区时必须原样传入刚查询到的 snapshot，不能用 null；该示例仅适用于尚无工作区的情况。

仅当前未封存、未取消的 running/interrupted 池协议 Attempt；执行、Chief、租约必须已确认释放。
已有准入不可静默替换或移除。结果 `{admission,already}`，admission 包含输入、快照、操作者、
持久化 Effect 和前后 generation。相同 requestId 内容必须完全一致。
这个操作只登记可信输入，不修改工作区、不执行 merge、不启动 worker。

### C08 `queue.cancel`

```json
{"queueId":"QUEUE_ID"}
```

权限：task-write。仅 waiting/blocked 队列；结果 `{queue}`，变为 cancelled，不撤销已启动的 Attempt。
重复取消终止队列会拒绝，不是通用幂等命令。

### C09 `queue.retry`

```json
{"queueId":"QUEUE_ID"}
```

权限：run-control。仅 blocked 队列，结果 `{queue}`，重新变为 waiting。
同时重新检查原发起人的权限/账号及仓库；不会把执行身份偷换为重试操作的管理员。
已有活跃 Attempt 或原任务结束则拒绝。

### C10 `chief.inspect`

```json
{"taskId":"TASK_ID"}
```

权限：configure。taskId 可省略，以检查项目范围；结果 `{run}`。
外层 requestId 用于该巡检请求的复用。它请求一个 Chief Run，不等于同步完成裁定。
查询 chief.state、TaskView 及对应 Run 追踪结果。只有后端专用协议能提交 Chief 的裁定。

### C11 `chief.configure`

```json
{
  "enabled":true,
  "inspection":{
    "enabled":true,
    "when":{"kind":"every","seconds":1800},
    "thresholds":{"maxHandoffsWithoutProgress":4,"longExecutionMs":2700000,"missingHeartbeatMs":1200000,"longWaitMs":3600000}
  }
}
```

权限：configure；启用前校验可持续使用的当前人类身份。可选 inspection 与现有配置/模板合并，
支持 title、prompt、when、enabled、thresholds；阈值需正整数。
enabled:false 关闭项目仲裁授权；inspection.enabled:false 可单独关闭巡检。
结果同 chief.state。更改会提升 policy revision，并可能重新绑定授权人和原生定时任务；
不能当作无副作用轮询，也不是按 requestId 去重的统一配置事务。

### C12 `schedule.configure`

保存示例：

```json
{
  "operation":"save",
  "target":{"kind":"project-source","threadId":"THREAD_ID"},
  "title":"PR feedback polling",
  "prompt":"Poll the configured PR thread",
  "when":{"kind":"every","seconds":120},
  "enabled":true
}
```

权限：configure。save 支持可选 `id` 更新原逻辑定时任务；新建需要 target、title、prompt、when。
当前注册 target.kind 为 project-chief / project-source；项目从信封绑定，更新不能换目标。
title 非空最多120码点，prompt 非空最多16000长度，enabled 为布尔，when 由原生调度器校验。
保存返回逻辑定时任务记录（id、revision、status、config、原生调度映射等）。

`{"operation":"delete","id":"LOGICAL_SCHEDULE_ID"}` 删除映射并返回 `{tasks}`；
`{"operation":"list"}` 返回 `{tasks}`。这两个也使用 command 信封并要求 requestId。
重复 save 无 id 会创建新逻辑定时任务；编辑要保留已有 id。正常 Chief 巡检优先通过 chief.configure 管理。

### C13 `agent.mode`

```json
{"mode":"safe"}
```

权限：当前已登录的人类，Project read；mode 必填 `safe` 或 `watch`。
返回 `{mode,grant,already?}`。safe 默认要求发布提案前人工确认；watch 创建可撤销的当前用户/Project 持续授权。
watch 在退出浏览器后可继续，但必须配置并通过实时账号校验，且不能超出用户的当前 Project 权限。
同一 active grant 重复启用可 already；safe 撤销授权，不抹去已经发布任务的历史。

### C14 `proposal.publish`

```json
{"proposalId":"PROPOSAL_ID"}
```

权限：own + create。只发布自己的已展示私人提案；返回 `{task,already?}`。
同一 proposalId 重复发布返回原 task；不自动启动执行，也不会公开整个私人对话。

### C15 `execution.input`

普通回答：

```json
{"workerId":"WORKER_ID","generation":1,"text":"对当前问题的回答"}
```

权限：task-write；仅当前真实 waiting-input worker。generation 是 **worker 的代次**，
不是 Task 协作代次；返回 `{sent:true}`，恢复该 worker 的输入处理。
text 非空且不超过8000长度。若 pending.kind 是 permission，还需要 configure，使用
`{"workerId":"WORKER_ID","generation":1,"requestId":"PENDING_QUESTION_ID","allow":true}`。
内部 requestId 必须匹配待回答权限问题；外层另提供传输 command 的稳定 requestId。
这不是给任意繁忙 worker 直接注入文本的接口；一般追加需求使用 input.publish。

### C16 `input.publish`

```json
{"taskId":"TASK_ID","text":"具体的补充反馈"}
```

权限：task-write + active Project。text 必填，去空白后非空且原长度不超过4000；
终止/关闭/正在停止的任务拒绝。不能提交伪造的 source、recipient、claim。
返回 `{input,already}`。同一发起人/requestId/Task 的输入内容不可变，内容变化必须使用新 ID。
接收后持久化 input.notify；正在忙碌的 Bot 在安全的后续轮次取得输入，不另开并行 writer。

### C17 `source.subscribe`

```json
{"taskId":"TASK_ID","threadKind":"pull","number":48,"mode":"active","includeHistory":false}
```

权限：configure + task-write。threadKind 为 issue/pull，number 为正整数；
mode 可选 active/context（默认 active），includeHistory 可选布尔（默认 false）。
repository 若填写必须等于当前 Project 仓库。
结果 `{subscription,already}`；重复由 Thread+Task 等业务身份决定，已有配置变化需要显式协调。
同一 Thread 最多一个 actionable active Task，其他任务可 context 跟踪。
默认旧讨论只作上下文；订阅不等于已配置轮询，另使用原生 schedule.configure。

### C18 `source.disable`

```json
{"subscriptionId":"SUBSCRIPTION_ID"}
```

权限：configure。结果 `{subscription,already}`，重复关闭可 already。
关闭的是该订阅，不是删除整个 Thread、Task 或历史输入；不会撤销其他订阅。

### C19 `source.poll`

```json
{"threadId":"THREAD_ID"}
```

权限：configure + 当前后台身份验证。结果 `{threadId,acceptedEvents,inputs,cursor}`。
读取已登记 Thread，持久化新观察和原任务输入；返回数量不代表模型读过或处理完成。
通过游标/事件版本去重，requestId 不会强制重放所有历史。接口不是 webhook，也不接收外部伪造的 GitHub 事件。

### C20 `effect.retry`

```json
{"effectId":"EFFECT_ID"}
```

权限：configure。仅重试本项目已耗尽自动重试的 failed Effect，返回 `{effectId,status,already?}`。
相同 requestId 的重试记录复用；其他状态会拒绝。它重置失败计数并排入 pending，
不立即声明远端成功，也不能把旧代次回调变成当前证据。

### C21 `comment.publish`

```json
{"issueNumber":48,"text":"以本人身份发布的具体评论","scope":"personal"}
```

权限：create + own personal GitHub 身份。issueNumber 必填正整数，text 非空最多10000长度；
scope 若填写只能 personal。操作者必须为当前人类/Project 配置并验证其个人凭据，不能借项目自动化账号兜底。
结果是已核对发布身份的 `{audit}`；包含发起人、选定 GitHub 身份、URL、正文哈希、Effect 归属等。
同一请求内容通过持久化 outbox 协调，回执不明确时先核对原评论和 Effect，不重复制造外部写入。

## 5. 非 v1 的必要接口

这些通过 `fb_api ENDPOINT JSON` 调用，不应编造为 fb_dev 的操作名。
表中 result 指外层成功响应的 `value`。

| endpoint | payload 参数 | 返回/权限 |
| --- | --- | --- |
| `projects` | `{}` | `{projects}`；仅当前用户有权访问的项目 |
| `project-create` | `name`，可选已授权 `repository`,`defaultBranch` | `{project}`；人类身份成为 Owner；不自动配置真实 SDK/仓库权限 |
| `project-detail` | `id`（或共享入口中的 projectId），可选 `view:"summary"` | 项目、权限及关联工作记录；read |
| `project-agents` | `projectId`，可选 `view:"summary"` | shared definitions/public Chief 及自己的 mine/privateMemory/proposals/delegation；summary 只返回公共摘要；完整读取可能确保当前代理存在 |
| `task-create` | `projectId`,`botId`,`title`，可选 `criteria`,`projectTaskKind` | 返回 Task 本身；create；botId 应为当前项目公共 Chief，kind 为 code/decision/release，默认 code |
| `project-agent-message` | `projectId`,`text`，可选 visibility:private/public，默认 private；公共直接发布意图另用 publicationApproved | `{agent,queued:true}`；当前人类发起对话，busy 会拒绝；不把普通消息响应当最终模型回答 |
| `project-agent-history` | `projectId`，可选 visibility:private/public | `{agent,live,messages,busy}`；派生当前人类私有身份，不能选别人的私聊；可能确保代理存在 |
| `project-chief-question` | `projectId`,`text`,`requestId` | `{handoff,already?}`；只读对话 handoff 给 Chief 并回原私聊，不创建/启动 Task；相同 requestId 文本必须一致 |
| `project-agent-memory-write` | `projectId`,`text` | `{saved:true,id}`；写自己的私有笔记，最多2000长度，保留最近100条；不写共享知识 |
| `project-credential-status` | `projectId` | 个人/自动化 GitHub 配置元数据；read；不是凭据内容 |

`task-create` 没有 v1 的统一创建幂等合同；网络响应不明确时先查询列表，避免重复发布。
私人对话、自己的记忆不能自动塞进公共 Chief 上下文；只有明确提问/发布的内容才能流转。
个人代理安全/值守的真实验收边界见[操作指南](development-service-guide.md)。

## 6. 状态、幂等与错误码

TaskView 是派生状态。原始 Task 业务状态、collaboration、Attempt、worker、Effect 可能不同，
例如 result-ready + blocked 表示已有结果，但协作受阻。完整含义见[状态模型](development-service-guide.md#状态由谁承载和更新)。
不要在客户端根据“Bot 存在”“API 返回200”“有 PR”推断已执行或完成。

幂等强度按操作分别规定：run 的 requestKey、proposalId、input 来源、Thread 订阅身份、
Effect/PR outbox 和配置保存并不是同一种机制。同 requestId 的恢复也不承诺可任意改变 payload。

auth-revoke 只注销本次 Session；切回 safe 撤销 watch grant；停止 Attempt、清理工作区又是不同操作。
重启后保留 Task/Attempt 历史，只有经过已退出证明及恢复校验才重新派活，不凭缺失 PID 释放资源。

| 错误码族/情况 | 解释与处理 |
| --- | --- |
| `bot/unauthorized` 或认证失败 | 登录失效/身份未提供；重新登录，不提交 DSH owner cookie |
| `bot/forbidden` | Project、Task 或对象范围/操作权限不符；不能靠 body 提升角色 |
| `bot/invalid` | version/kind/name/形状/必填参数不合法；部分底层校验也使用该码 |
| `bot/conflict` | expectedGeneration、expectedCandidateSha、分页快照等已变化；重读后重新判断 |
| `bot/read-only` | 该宿主不能写状态；先解决锁/存储归属，不重复外部副作用 |
| `bot/delivery` | Attempt 生命周期、候选、证据、PR、已退出证明或集成源不满足；读 message 和当前详情 |
| `bot/effect` | 持久意图、Effect协议、回执或重试条件不满足；查effects及原远端对象，不能直接改成done |
| `bot/task-input` | 输入大小、身份、来源、当前 Task/claim 不满足 |
| `bot/project-source` | Thread/订阅/仓库、游标或 Source 合同不满足 |
| `bot/delegation` | watch/principal/grant 失效或缺少后台校验；不能借浏览器或别人的身份兜底 |
| `bot/chief`、`bot/harness`、`bot/busy` | Chief 配置/执行合同、SDK/worker 合同或当前对话忙；查相应状态 |
| 其他底层错误 | 本表不是穷举 HTTP 错误；保留原 code/message，不把它们统一当成可自动重试的网络错误 |

## 7. 使用示例与证据边界

先按 README 登录、定义函数、设置 FLYBOT_PROJECT_ID。以下只读：

```bash
fb_dev query tasks '{"limit":10}'
fb_dev query pools '{}'
fb_dev query task.detail '{"taskId":"TASK_ID","attemptLimit":5}'
fb_dev query inputs '{"taskId":"TASK_ID"}'
fb_dev query effects '{"taskId":"TASK_ID","limit":10}'
fb_dev query execution.boundary '{"taskId":"TASK_ID"}'
```

以下会写入、启动模型或产生外部操作，按需选择，不能当作连通性测试自动执行：

```bash
fb_dev command task.run '{"taskId":"TASK_ID"}' 'start-001'
fb_dev command input.publish '{"taskId":"TASK_ID","text":"请补充边界测试"}' 'feedback-001'
fb_dev command chief.inspect '{"taskId":"TASK_ID"}' 'inspect-001'
```

接口存在、契约测试通过、真实 SDK 专项通过、实际任务闭环、UI/部署验收是不同证据。
尤其 comment.publish 需要个人身份，示例中的假 ID 不可直接调用；本次文档补充不会为实服开启值守、
发布任务、改变巡检、重试 PR 或停止正在运行的工作。代码基线的完整/专项结果记录在 README，
不能当作后续文档提交的全量业务测试结果。
