# 后端 API 参考

[快速开始](../README.md) · [协作语义](development-service-guide.md) · [部署](backend-operations.md)

[OpenAPI 3.1 JSON](openapi/flybot.openapi.json) 给出全部公开分派请求/响应 Schema、逐操作权限、
状态影响和前置条件；第三方个人代理的凭据签发、登录和自主协作见[接入指南](third-party-bot-integration.md)。

本页对应当前分支实际路由：**29个v1查询、34个v1命令**，以及对象管理使用的原生接口。
咨询和Task主动权交接是两种契约；角色执行回调不是公开HTTP命令。没有Swagger页面；以下请求均可由CLI或HTTP调用。

## 传输、身份与统一返回

共享服务：`POST /api/bot`，`Content-Type: application/json`。
登录后携带 `X-Flybot-Member-Session: <member-session-or-FBA-token>`。
请求不能提供可信memberId、Chief身份、claim、权限或进程退出证明。
共享网关保留DSH Owner凭据在服务内部；不向调用方开放原始Harness API。

原生请求用于登录、Project/PersonalAgent等对象管理：

```json
{"endpoint":"project-read","payload":{"id":"PROJECT_ID"}}
```

v1请求用于项目协作命令、查询和恢复：

```json
{"endpoint":"project-development","payload":{"version":"project-development/v1","kind":"command","name":"task.propose","projectId":"PROJECT_ID","requestId":"change-1","payload":{"title":"修复计算错误","criteria":"复现用例与回归通过","impact":"恢复项目计算功能"}}}
```

所有命令需要信封层稳定 `requestId`，匹配 `[A-Za-z0-9_-]{1,100}`。
query不需要requestId。projectId必填，payload必须是对象且不能指向另一个Project。
可选 `expectedGeneration` / `expectedCandidateSha` 放在v1信封层，校验当前Task代次/候选；不是绕过下游权限的凭据。
具体对象ID应使用上次响应值，不使用示例常量作为真实ID。

HTTP成功响应为 `{ok:true,value:...}`；v1 value为 `{version,requestId,result,receipt?,replayed?}`。
CLI只输出value，所以下列查询的业务结果位于 `result`。

```json
{"ok":true,"value":{"version":"project-development/v1","result":{"task":{"taskId":"TASK_ID","projectId":"PROJECT_ID","phase":"awaiting-chief","waitingFor":"admission"}}}}
```

这是响应结构示意，不是任务已真实执行的证据。错误为 `{ok:false,error:{code,message,...}}`；
HTTP200也可能是领域拒绝，必须检查ok。网关/事件还会使用HTTP400/401/403/409/429/503。

## 权限与重试

表中：`读`=当前项目成员（含已授权且scope匹配的个人代理）；`写`=Owner/Maintainer或有权操作本人Task的成员；
`管`=Owner/Maintainer；`本人`=认证用户或其明确允许的个人代理。私有咨询/命令回执还检查独立代理/当前用户身份，不因同属项目而共享。
安全模式的个人代理不能直接发布共享Task；值守模式与当前用户权限、参与状态和token scopes取交集。
角色名、公开Bot、网页按钮都不是权限。关闭Project后保留授权读取，拒绝新工作/配置修改。

同一主体、Project、命令名和requestId标识同一意图，payload必须一致。
响应丢失时重试原请求；内容变化用新意图ID。不能通过换ID绕过未知外部结果。
receipt区分completed、running、unknown、completion-pending-commit；unknown先查command.receipt/实际Task/Chief，绝不盲目重发外部动作。
持久Effects的提交、入池、接手、执行和Chief关闭是不同事实；receiving SSE不会获得执行权限。

## User / PersonalAgent（原生对象接口）

这些请求不包v1信封，CLI使用 `request ENDPOINT --json JSON`。
所有“本人”由认证派生，不接受body指定另一个Owner。

| 原生endpoint | payload主要字段 / 返回 | 主体与边界 |
| --- | --- | --- |
| platform-login | email:string、password:string → sessionToken/memberId | 已配置账号平台；CLI login --email隐藏输入和返回Token |
| auth-whoami / auth-revoke | {} → 当前身份 / 撤销结果 | 本次会话；注销不等于停止Task |
| auth-invite / auth-redeem | 邀请{} / 兑换{token,displayName?} → 邀请/成员会话 | 原生认证；首次邀请仅私有操作者入口，后续需已登录邀请人 |
| personal-agent-create | name、kind:internal或external；外部另需provider、HTTPS endpoint → agent | 本人；外部descriptor初始未验证，不声称已接入特定产品 |
| personal-agent-list / personal-agent-read | limit?:1..200、after? / agentId → 本人身份列表/身份 | 本人；不公开私有carrier历史 |
| personal-agent-join / personal-agent-default | agentId、projectId → participation | 本人且当前项目成员；默认路由不授予权限 |
| personal-agent-participations | limit?:1..200、after? → 本人的参与列表 | 本人；独立参与ID |
| personal-agent-history | agentId、projectId、offset?、limit?:1..100 → 私有历史页和nextOffset | 本人；历史保留原ID |
| personal-agent-propose-task | projectId、title、criteria、projectTaskKind、requestId；impact?/scope? → 私有proposal | FBA连接；等待人类授权，显式影响/范围保留到原Task |
| personal-agent-leave / personal-agent-retire | agentId，leave另需projectId → 状态 | 撤销对应连接/委托能力，保留历史 |
| personal-agent-token-create | agentId、projectIds:string[]、ttlSeconds?:60..2592000 → 一次性原始token及metadata | 本人；存储只留hash，token限当前活跃参与Project |
| personal-agent-token-list / personal-agent-token-revoke | agentId / credentialId → metadata/撤销 | 本人；不重新返回原始token |
| personal-agent-delegation-set | agentId、projectId、mode:safe/watch | 本人；见[身份契约](subsystems/personal-agent-auth.md) |
| personal-space | operation:list/read/send/memory等、id及对应参数 | 原个人Chief/Bot/群聊入口；原ACL和私有记忆隔离 |

外部调用方持FBA token调用同一HTTP协议，不能把外部URL当作已验证身份或新的Task执行器。
SDK角色worker使用宿主内部绑定，不可拿“Dev”字符串调用角色私有写接口。
详细原生字段/期限/撤销规则见[独立代理](subsystems/personal-agents.md)、[代理授权](subsystems/personal-agent-auth.md)、[安全与值守](subsystems/project-delegations.md)。

## Project / Role（原生管理 + v1治理）

| 原生endpoint | payload与返回概要 | 权限/前置 |
| --- | --- | --- |
| projects / project-read / project-detail | {} / id / id、view:summary? → 当前成员可见项目/详情 | 读；summary不复制完整Task历史 |
| project-create | name必填；goal/scope/repository/repositories/defaultBranch等可选 → project | 当前用户；仓库关联0..N，仓库也可被多项目关联 |
| project-repositories | projectId → repositories | 读 |
| project-repository-link / project-repository-unlink | projectId、repository，link可含defaultBranch → 关联结果 | 管；不悄悄改动已有Task执行仓库 |
| project-members / project-invite / project-join | id / id / token → 成员/邀请/加入 | 读 / 邀请权限 / 当前认证受邀人 |
| project-role / project-member-remove / project-leave | id及memberId/role等 → 成员状态 | 原角色策略；Owner不可把自己移走留下无主项目 |
| project-close-request | projectId、reason等 → 建议记录 | Maintainer/个人代理建议；不关闭项目 |
| project-close-prepare / project-close-confirm | projectId、prepare另需finalRecord；confirm带prepare返回的confirmationToken | Owner本人二次确认，限时挑战和当前状态重验；保留未完Task及最终记录 |
| project-agents / project-agent-history | projectId、对应agent/分页 → 公开Chief及本人私有代理/历史 | 读；私有信息仅本人 |
| project-agent-definition / project-role-memory-write | projectId、定义/记忆字段 → 版本化目录/记忆 | 管理及原治理校验；不得覆盖历史执行快照 |
| project-room-create/read/message等 | projectId、roomId、text/文档等 → 原Project群聊 | 项目成员且符合房间参与权限；普通消息不自动发布Task |

角色治理、上下文及public Bot人设/记忆仍走原服务；完整字段和治理提案源见[角色/代理](subsystems/project-agents.md)、[Project](subsystems/project-domain.md)及[房间](subsystems/project-collaboration.md)。

## v1查询（kind=query）

下表payload之外统一需要projectId。`?`表示可选。字段均为JSON；ID/游标是响应返回的string。
所有查询确定性读取现有事实，不调用模型更新项目定位。大内容通过限定源分页，不塞进列表。

| 查询名 | payload | result / 权限与分页 |
| --- | --- | --- |
| github.connection | repository? | 已选项目自动化连接、revision、配置状态和已授权选项；不返回凭据或私钥路径 |
| inbox.list | agentId?、limit?:1..100、after? | 本人消息元数据/通知/处理状态；私人，不进入公开SSE |
| inbox.get | messageId、agentId?、offset?、limit?:1..4000、expectedSha256? | 本人咨询正文源页；UTF-16偏移，含message元数据 |
| inbox.connection | agentId? | 本人通知连接非敏感状态 |
| tasks | limit?:1..200、after?:TaskID | TaskView列表及游标；读 |
| task | taskId | 单个TaskView；读 |
| task.detail | taskId、attemptLimit?:1..50、beforeAttemptId? | 有界Task详情、Attempt摘要与历史来源引用；读 |
| task.history | taskId、section、offset?、limit?、expectedSha256? | 精确源字符串页、SHA256和nextOffset；section为requirements/requirementsHistory/waitHistory/results/dependencies/admissionDecisions/note/result/actors/handoffs |
| roles | role?、offset?、limit?:1..16000、expectedSha256? | 当前已批准角色目录及revision；读，不初始化目录 |
| role.proposals | proposalId?、limit?:1..50、after? | 公共角色变更提案及有界来源；不返回个人代理私有提案 |
| consultation.list | agentId?、limit?:1..100、after? | 本人当前参与的私有咨询页 |
| consultation.get | consultationId、agentId? | 私有咨询/答案/状态；从不转移Task主动权 |
| handoff.list | taskId、limit?:1..100、after? | 同Task的持久交接记录页；读 |
| handoff.get | taskId、handoffId | 原交接契约与receipt：来源/目标/上下文版本/确认等；读 |
| pools | {} | 每个逻辑Bot的任务池和现有claim/阻塞状态；读 |
| inputs | taskId、limit?:1..200、after? | Task持久输入/投递和确认状态；读 |
| sources | 原source查询过滤/分页 | 当前项目绑定的Issue/PR来源订阅与游标；读 |
| execution.boundary | taskId? | 当前权限/仓库/资源/Harness边界及readiness；不运行测试/不授予权限 |
| attempt.context | attemptId、section、offset?、limit?:1..16000、expectedSha256? | roleSessions/roleSessionHistory/rolePolicies/evidence/feedback/requirement/failure/agentDefinitions/integrationAdmissions精确页；读 |
| attempt.continuation-state | attemptId | 管；返回取消/中断后当前工作区快照、代次与可选 continue/latest，供 task.run 显式续作 |
| attempt.integration-state | attemptId | 当前候选/受信集成绑定、availableInputs、materialization和工作区快照；读 |
| attempt.log | attemptId、role?、offset?、limit?:4..8192、expectedSha256? | UTF-8字节页，返回text/sha256/nextOffset/totalBytes；读，不接受宿主路径 |
| release.status | attemptId | 当前Release请求/目标/外部证据；项目读，不发布 |
| chief.state | {} | 当前Chief策略、原定时任务、待裁定/活跃控制工作；读 |
| effects | taskId?、limit?:1..200 | 已提交意图/执行/等待/失败摘要；私有command结果限当前主体 |
| command.receipt | commandRequestId、commandName? | 当前独立主体的幂等回执/commit状态/结果引用 |
| command.result | commandRequestId、commandName?、offset?、limit?:1..16000、expectedSha256? | 精确原JSON结果页；同主体、hash保护 |
| project.snapshot | entityType?:task/attempt/execution/resource/input/role-proposal、after?、limit?:1..100、expectedRevision? | 已提交Project版本、cursor及实体页；默认Task50项 |
| events | after?、limit?:1..100 | 当前Project已提交变更页、next cursor；默认100项 |
| compatibility | offset?、limit?:1..100 | 旧工作baseline计数/hash/提交状态，当前contract/legacy/held/active计数和引用页；默认50项 |

字符串源页offset按字符而非UTF-8字节；把返回SHA256带入下一页，变更则重新读源。Task/Attempt列表是摘要，不能用preview代替验收证据。attempt.log的offset/limit按UTF-8字节计，使用返回nextOffset续读，边界不会切断字符；每次仍流式验证完整封存源哈希。
TaskView.phase包括published/awaiting-chief/queued/starting/running/awaiting-input/blocked/stopping/accepted/cancelled等；waitingFor/reason解释等待对象。
Worker已登记不等于已运行；进程或Bot消失不等于退出；角色目录当前revision与执行固定revision分别展示。

## v1命令（kind=command）

每个命令统一带requestId，返回result和命令receipt。作用域、前置版本、角色代次及实时权限由各领域服务继续校验。

| 命令名 | payload主要必填字段（其余可选字段见对应子系统） | 结果与权限 |
| --- | --- | --- |
| github.connection.configure | connectionId:string/null、expectedRevision；repository? | 人类Owner/Maintainer选择已预置连接；只读认证后持久化，null显式禁用且不回退 |
| inbox.claim | messageId；agentId?、expectedVersion? | 本人有效参与；领取消息租约，不取得Task主动权，安全代理可用 |
| inbox.renew | messageId、claimId、generation | 原身份当前有效租约续期；安全代理可用 |
| inbox.complete | messageId、claimId、generation；text/publish或acknowledge | 同身份/代次/源版本；安全建议等待人类审批，watch授权后显式发布原Task输入 |
| inbox.fail | messageId、claimId、generation、retryable | 记录失败或重新待领取；不推断执行器退出 |
| inbox.connection.configure | enabled；agentId?、connectionId? | 本人亲自选已预置连接；签名challenge验证后启用，禁用/换连接不修改个人凭据 |
| consultation.ask | text；agentId? | 私有咨询receipt，异步答案；本人，不创建Task |
| consultation.reply | consultationId、text；publish?、agentId? | 私有回答；显式publish且有权才进入原Task输入，安全代理仍需授权 |
| role.decide | proposalId、expectedSha256、decision:approve/reject | 管；精确批准Chief提案，不能由提案Chief借Owner身份自批 |
| task.propose | title；criteria/impact接纳前必需；scope/projectTaskKind/botId? | 创建唯一Task并提交Chief intake；当前成员发布权限；kind仅code/decision/release |
| task.change.request | taskId、action:revise/cancel/reopen、reason；revise可带requirements | 写；仅请求Chief判断，不立即改承诺/关闭Task |
| task.run | taskId, requestId, targetRole?, repository? | 写；未接纳则waitingFor:chief；接纳后原配额/资源队列，不是强制绕过Chief |
| task.accept | attemptId | 旧兼容交付的人工验收；管；新Task最终关闭仍由Chief |
| task.reject | attemptId、reason等原返工参数 | 管；原证据/停止/新Attempt路径，新Task不改变Chief裁定权 |
| attempt.stop | attemptId | 管；请求原worker停止，未证实退出继续持有租约 |
| attempt.cleanup | attemptId | 管；只在受支持的终止/退出状态清理，不删除Task历史 |
| attempt.reconcile-exit | attemptId、claimId、generation、reason | 管；核验实际退出与待对账责任，持久退场旧 claim 并 fence 代次；不取消/选路，随后重新取 integration-state |
| attempt.integration-bind | attemptId、generation、inputs:[{ref,sha,purpose?}]、expectedWorkspace（取integration-state快照） | 管；实际引用、SHA/测试/Review绑定，非伪造“已合并” |
| attempt.publication-retry | attemptId | 管；原PR绑定/幂等恢复，不另建重复PR |
| release.request | attemptId、tag、sha、mode?:observe/publish、name?、notes? | 管；默认只观察，publish是显式发布授权 |
| release.reconcile | attemptId | 管；仅核对已有外部结果，不重复发布 |
| queue.cancel | queueId | 写；取消原等待请求，不伪造worker退出或Chief关闭 |
| queue.retry | queueId, targetRole? | 管；重验原始发起人、要求和资源；不是换请求人借权 |
| chief.inspect | taskId? | 管；一次原Chief巡检/裁定工作，不增框架轮询器 |
| chief.configure | enabled；inspection? | 管；配置原Chief授权和原生定时任务，默认巡检30分钟是配置值 |
| schedule.configure | operation:save/delete等、id?及原schedule定义 | 管；复用Project定时任务，不创建另一调度器 |
| agent.mode | mode:safe/watch；personalAgentId? | 当前人类本人；值守全权仍受实时人类权限及显式scope约束 |
| proposal.publish | proposalId | 当前人类授权发布私人提案；原Task/回执幂等，不公开私有草稿历史 |
| execution.input | workerId、generation；text或requestId/allow | 当前Task写权限；permission还需管；payload.requestId是原permission请求ID，不是信封幂等键 |
| input.publish | taskId、text:1..4000字符 | 写；宿主选择当前收件角色/代次，用户不能自造source/recipient/claim |
| source.subscribe | taskId、threadKind:issue/pull、number；mode/includeHistory? | 管；原准确仓库/凭据/订阅域；见来源契约 |
| source.disable | subscriptionId | 管；保留已提交输入/游标，停止后续拉取 |
| source.poll | threadId | 管；复用原来源拉取，重复事件按版本去重 |
| effect.retry | effectId | 管；只恢复耗尽失败的原Effect，不重置已完成动作 |
| comment.publish | issueNumber:正整数、text:1..10000字符；scope仅personal | 当前项目与个人GitHub授权；不借Owner或环境凭据 |

复杂原生字段/证据前置的完整规范：[Task](subsystems/project-task-lifecycle.md)、[Handoff/任务池](subsystems/project-pools.md)、[输入](subsystems/project-inputs.md)、[来源](subsystems/project-sources.md)、[Chief/定时任务](subsystems/project-chief-control.md)、[交付](subsystems/project-delivery.md)、[GitHub](subsystems/project-github-read.md)。
Role的get-context、accept/return/transfer/complete/split/Chief裁定走已绑定Task-role执行通道，宿主校验完整claim/代次/退出与证据。
公开v1没有通用handoff/accept-claim接口供人冒充角色；handoff.get/list是查询，不等于接手。

## Execution / Resource / Session（原生配置接口）

| 原生endpoint | payload概要 | 权限 / 返回 |
| --- | --- | --- |
| project-resources | projectId | 读；授权资源/健康/Harness元数据，不暴露profile或进程秘密 |
| project-resource-environment-check | projectId、resourceId及对应Harness | 管理及资源grant；固定探测，非任意shell |
| project-runtime-check | projectId、resourceId、harness | 管理/资源admin；实际登录与环境结果，配置存在不等于成功 |
| project-terminal-open/poll/input/resize/close | projectId、资源/Harness/terminalId及操作参数 | 当前管理/资源admin；原PTY用于SDK登录，不进入公共Project上下文 |
| project-execution-input | workerId、generation、text或原permission字段 | 与v1 execution.input相同实时权限 |
| project-agent-memory-write / project-role-memory-write | projectId、文本/来源及角色字段 | 私人记忆与公开角色记忆独立授权；保留revision/来源，按需召回 |

Harness实际ID：flybot、codex、claude-agent。Task-role Session固定Task/角色身份，打回resume同一上下文；不能恢复时明确阻塞，不偷偷另起空白会话。
执行仅在claim、资源绑定和持久激活都确认后启动。身份/要求/资源撤销使原执行合作停止，必须确认退出才能把主动权交给下一角色。
SDK负责其自身compaction，FlyBot负责输入/工具输出/记忆预算和来源分页；不把累计usage当当前上下文占用。
详细配置/端点字段见[执行环境](subsystems/project-runtime-setup.md)、[资源](subsystems/project-resources.md)、[Harness](subsystems/project-harness.md)。

## SSE与断线恢复

```text
GET /api/project-events?projectId=PROJECT_ID
X-Flybot-Member-Session: MEMBER_SESSION_OR_FBA_TOKEN
Accept: text/event-stream
```

也可使用 `node scripts/backend.mjs events --project PROJECT_ID [--after CURSOR]`。
首次发送event:snapshot并带id；后续event:fact的id为该项目的opaque cursor。
重连带 `Last-Event-ID` 或同值after参数，二者冲突拒绝。以cursor/实体revision去重，不解码或合成cursor。
按project.snapshot.next补完当前实体页，可用expectedRevision防并发跨页混合；事件不是永久审计历史。
当前有界保留每Project1024项/24小时，读取每页最多100项。过期/不同epoch返回bot/cursor-expired或bot/conflict，重取snapshot后续传。
权限每次拉取重验，撤权发access-revoked并关闭；其他恢复条件发reset-required。未提交save、失败事务和私人聊天/凭据/私有提案不产生公共项目事件。
宿主背压有界，慢客户端需断线续传；代理禁用SSE缓冲，服务退出关闭stream。

## 错误与旧入口兼容

| code/状态 | 处理 |
| --- | --- |
| bot/invalid | 校正版本、kind、必填字段、分页或原生操作参数 |
| bot/unauthorized / bot/forbidden | 重新认证/核对当前成员、参与、scopes和委托；不换身份借权 |
| bot/conflict | 重读代次/候选/hash/版本，再判断；相同意图的内容不能改后重试 |
| bot/cursor-expired | 重取project.snapshot，继续新的cursor |
| bot/read-only / bot/state-storage | 修复锁/格式/存储迁移；不删除守卫强行写入 |
| bot/compatibility | 未登记的旧Project Task不能执行；让Chief明确处理原Task，活动执行先到安全点 |
| blocked/unknown/stopping | 查询Task、Effect、边界及实际worker退出证明；不是PASS或资源空闲 |
| HTTP429/503 | 有界退避、重读当前状态，保留原requestId |

保留task-create、project-task-run、project-task-pools、project-chief-question等原接口，映射同一领域服务。
新调用方优先v1命令以获得主体范围的持久回执。旧Group/track_tasks仅保留已提交旧任务及其返工，不得为新Project工作建立旁路；个人任务不受该Project切换限制。
原public Bot人设/长期记忆可授权查看，个人代理/Chief私有记忆不会因此公开。具体保留对象和回退限制见[兼容盘点](subsystems/project-compatibility.md)。

Task requirements accept optional repository (owner/name or null). An admitted explicit selection cannot be overridden by task.run. Cross-repository child outputs are references, not permission to merge into another repository. Repository-free decision Tasks currently execute on local resources.

project-agent-history保留messages字段，默认最近50条，limit为1..100。cursor绑定用户/代理作用域与历史前缀快照；新消息追加不破坏旧游标，原消息变化则拒绝。超长记录仅返回预览及sourceRef，带messageIndex/cursor/expectedSha256与textOffset/textLimit（上限4000字符）可逐页取回原始JSON。nextCursor向后，previousCursor查询更早历史；完整记录不删除。

## Release Task接口

| 名称 | 类型及payload | 权限与行为 |
| --- | --- | --- |
| release.request | command；attemptId、tag、sha、mode?:observe/publish、name?、notes? | Owner/Maintainer或有效值守代理；默认只观察。publish是显式真实发布授权，sha须等于当前Release Attempt的baseSha |
| release.reconcile | command；attemptId | 管理权限；仅核对已有请求，未知结果不重复发布 |
| release.status | query；attemptId | 项目读；返回状态、目标、已观察证据，不调用模型或外部发布 |

原生对应project-release-request / project-release-reconcile / project-release-status。需显式配置仓库release.provider=github、release.enabled=true及已有选定GitHub凭据；创建请求不等于发布成功，发布成功也不等于Task关闭。Chief仍需当前外部证明及原验收门禁。详见[契约、配置与例子](subsystems/project-releases.md)。测试不会创建真实Release。

GitHub App 的操作权限、Token生命周期、故障恢复及审计见 [GitHub自动化](github-automation.md)。连接选择与Task执行权限独立，代理不得替自己更换凭据。

#2325：purpose 默认为 integrate，封存时要求实际集成；inspect 只让获准提交在执行资源中可见，不要求合并，也不代表测试通过。availableInputs 最多列20个已由操作员提供的 refs/remotes/operator/* 引用。提交不在目录中时先由获准操作员提供，不自动获取任意远端。


#2330：`chief.configure.payload.inspection.lifecycle` 支持 queueTimeoutMs/runTimeoutMs/recoveryDelayMs/overdueMs（1–86400000 毫秒）和 maxRecoveries（0–4）；默认分别为 600000/900000/5000/3600000 和 2。`chief.state.result.health` 返回启用、逾期/退化状态及各阶段时间；`runs` 中 correction-pending/incomplete/partial/interrupted 具有不同含义。定时 delivery 通过持久 runId 对账，acknowledgement、巡检成功、裁决应用、实际项目推进相互独立。

Chief 配置补充 `operationsContact:{memberId,agentId}|null`（仅本人配置，当前 Owner/Maintainer
拥有的有效参与代理）与 `autonomy:{maxRecoveryActions,maxRecoveryMs,guidance}`。
`chief.state.compensation` 提供附加原 Chief schedules 的 nextCheckAt 等元数据。
新 incoming consultation 的 assistance/assistanceScope 绑定当前任务状态；旧代次回复拒绝。
完整约束、原始信封及运维边界见 [协助闭环](chief-assistance.md) 和 OpenAPI schemas。


## SDK GitHub App候选恢复（#2365）

角色App模式复用当前接口，不公开Token签发端点。`github.connection`返回roleGithub
配置状态、revision和identityReuse。`task`/`tasks`的execution.githubAccess仅含身份、
scope hash、状态、续期标记及到期时间；`task.detail`的Attempt保留sdkPublication和
sdkCandidateEffect，PR身份区分Dev与宿主merger。`attempt.context`新增
sdkPublication/publicationRecoveries分页源。

`attempt.publication-retry`的payload可加`phase:"candidate"`：当前有配置权限的管理者
在原执行已确认退出、保留干净SDK提交/角色证据和原远端PR时，通过原github.candidate
Effect对账采纳真实SHA。失败Effect先走effect.retry；不创建新PR、不重写SHA、
不替代测试/Review/Chief关闭。省略phase保留原有审核后发布恢复前置条件。
完整操作顺序、示例和凭据边界见[角色App指南](role-github-apps.md)和OpenAPI。

`task.run` 可带 `continuation:{mode:"continue"|"latest",previousAttemptId,generation,expectedWorkspace,expectedBaseSha?}`，需要当前管理权限；快照取 `attempt.continuation-state`。continue 沿用已核验旧 seed 与来源，latest 要求 expectedBaseSha 等于快照的 latestBaseSha，且不丢弃草稿，基线冲突仍须显式 integrate。取消的前序不会复活，新 Attempt 不继承测试/Review 通过。

### 已合入候选的 Chief 收尾状态

现有 `task`/`task.detail`、Attempt 元数据及 `effects` 查询可共同读取 `merge.chiefHandoff`：`effectId`、`status`、`reason`、`waitingFor`、`runId`、`runStatus`、`runFailure`、`waitingRunId`、`createdAt`、`requestedAt` 和 `candidateSha`。具体结构见 OpenAPI `MergeHandoff`。`status=delivered` 表示 Chief 请求已持久化，不代表 Chief 已执行成功或 Task 已验收。通知重试仍用原 `effect.retry` 权限和请求契约；无需重新 publish/merge。
