# Chief 自主推进与运维协助

Chief 首要目标是在现有授权内取得可核验的项目进展。框架提供基线、候选、执行目录、环境失败分类、
worker/租约退出证明、实际进展与咨询状态；下一步恢复、咨询或继续等待由 Chief 判断，不是固定 DAG。
`autonomy.maxRecoveryActions`（默认4，0–20）、`maxRecoveryMs`（默认3600000，1000–604800000）
和 `guidance`（最多8000字符的共享指导）是提示词预算，不增加工具权限，不自动转人工。
现有执行/Attempt/巡检超时仍是宿主的硬边界。预算统计从最近真实进展后的 route/return/request-tests/
retry-notification 计算；消息、inspect、通知送达不是进展。

## 选择接收人

Owner/Maintainer 以本人身份调用现有 v1 command `chief.configure`：

```json
{"operationsContact":{"memberId":"OPERATOR_MEMBER","agentId":"OPERATOR_PERSONAL_AGENT"},"autonomy":{"maxRecoveryActions":4,"maxRecoveryMs":3600000,"guidance":"先诊断当前证据，再决定恢复或咨询"}}
```

接收人必须是当前 Owner/Maintainer，代理属于该人且已主动加入项目并有效。代理不能自行选择/更改
运维接收人，Chief 不能修改自己的授权；`operationsContact:null` 清除，省略保留现有选择。
这只授权把 Chief 当前共享项目问题送入该代理的私人收件箱，不授权读取发起人的私人历史。
默认仍询问发起人的项目代理；Chief 明确选择 `recipient:"operations"` 才使用运维接收人。
没有合法运维对象时拒绝该选择，不偷偷借用 Owner 身份。接收人失效后可清除配置或重新选择。

Chief 的 `needs-human` 裁决可带 `recipient:"initiator"|"operations"`。
运维请求必须有 `assistance`，七个字段均为非空字符串，各最多1200字符：
`cause`、`evidence`、`attempted`、`requestedOperation`、`requiredPermission`、`verification`、`resumeCondition`。
记录只含共享项目事实与所需协助，不能携带私人笔记、凭证或臆造成功证据。
咨询保持 `initiativeTransferred:false`，不会把 Task 主动权交给个人代理。

## 原生/外部共用闭环

按 [统一 inbox 接入](agent-inbox.md) 完成身份、参与关系、FBA Token 或原生 watch 委托。
原生通知仍要求当前默认原生代理及有效 watch；其他有效代理可读取自己的消息箱。
外部 endpoint 只是描述，需要操作员预置连接，接收人本人通过 `inbox.connection.configure`
完成签名 challenge 后才能收到推送。不同用户不能借用彼此连接、Token 或 watch。

Chief 咨询 → 持久化原消息及 Effect → 原生唤醒/签名通知 → claim/get → 获授权协助或建议 →
complete/publish → 原 Task 输入 → Chief 重新判断。safe 回复停在私人建议，由本人批准发布；
watch 只能行使用户现有项目权限。`requiresHuman` 仍需本人批准。
SSH、root、容器配置、宿主依赖和凭证操作要单独提供受限运维工具/权限或由本人执行，watch 不会授予这些能力。
回复只是新证据；不能自动宣布环境已修好、释放未知 worker、重开 Session 或验收 Task。

新咨询绑定原 decision、Task generation、需求版本/内容、Attempt、候选及运维接收人当前配置/项目角色。
任何一项变化都会使延迟回复 superseded，领取、续租、提交和投递拒绝旧请求；历史保留。
旧版未携带绑定的记录保留原 decision 检查，不伪造迁移时的历史状态。已有 Session 的返工仍按原契约恢复。

## 配置小时补偿巡检

通过现有 v1 `schedule.configure` 创建附加的 Chief 逻辑定时任务，不增加框架计时器：

```json
{"operation":"save","target":{"kind":"project-chief","projectId":"PROJECT_ID"},"title":"Hourly assistance check","prompt":"检查真实进展和原咨询投递/领取/回复；必要时提醒原消息，勿重复修复或派活","when":{"kind":"every","seconds":3600},"enabled":true}
```

这是 v1 command 的 payload，信封仍需 projectId、稳定 requestId。可暂停、修改、删除；并非写死的每小时工作流。
Chief 看到通知失败/无进展后，可裁决 `retry-notification`，提醒同一条当前咨询。
原消息及 Effect key 保持，只有通知代次变化；活动领取、待处理通知、已处理/待审批回复不会重复唤醒。
未知原生执行仍等待退出。投递重试不重做外部运维操作；接收端必须用稳定请求、inbox claim/generation
及自己的操作幂等记录防止外部副作用重复。领取过期只撤销消息处理权，不证明修复进程已退出。

`chief.state.compensation` 返回附加逻辑任务的原生 `nextCheckAt`、enabled/status 和最近投递。
`inspection.assistance` 只投影接收对象、通知尝试/下次重试、claim 到期、回复/当前性；不公开私人正文。
`inspection.recoveryGuidance` 显示动作数、窗口和预算状态，`health.lastMeaningfulProgressAt` 与
`lastSuccessAt` 区分真实推进和成功巡检。没有原生到期证据时 nextCheckAt 为 null，不猜测。

## 实例接入与核验

1. 在固定部署 checkout 核对 `git rev-parse HEAD`、分支，以及实际进程使用的插件路径；不要只看仓库已合入。
   新版本需要 `project-agent-inbox.js`、`project-chief-assistance.js` 等完整构建，不能单独拷贝补丁。
2. 按 [后端部署](backend-operations.md) 在持久化私有 home 上升级原服务，保留 state/SQL、Session 和凭证。
   先核对该部署已有的停止/启动方式；未知 worker 必须按退出证明恢复，不用清 bindings 或杀任务规避。
3. 预置接收连接与独立0600签名密钥；本人启用后查询 `inbox.connection` 核对 revision/verifiedAt。
   实例无法访问接收端时先检查固定 HTTPS 地址、DNS/网络白名单、时间偏差及签名，不在模型里调试密钥。
4. 核对 `chief.state.policy.operationsContact`、双方参与关系和 safe/watch 委托。发送一个共享范围的咨询，
   用同一 consultationId 追踪通知、claim/get、回复、原 Task input、Chief 裁决和随后调度；不能用 enabled 代替成功证据。
5. 启用所需补偿 schedule，观察 nextCheckAt/最近成功巡检。离线后恢复时先查询原消息/command receipt，
   不创建替代 Task，不换请求号重做已发生的运维操作。

开发验证：`node dev/demo/run.mjs --chief-assistance` 在一次性真实 DSH 与原网关上运行，独立 HTTP
接收进程验证签名并 claim/get/reply；故意503后重启原宿主，验证同一咨询恢复、原生链路和重复通知。
推理为确定性 fixture。单测覆盖 stale generation/需求/候选/接收人、safe/watch、过期领取、提交失败回滚。
这不等于付费模型的自主诊断、真实宿主环境修复、等候一整小时或生产实例升级验收。
