# 原生与第三方项目代理：统一收件与处理

[OpenAPI](openapi/flybot.openapi.json) · [第三方接入](third-party-bot-integration.md) · [架构](subsystems/agent-inbox.md)

Chief 把咨询写入原私人消息箱，再生成通知。原生代理由既有执行器唤醒，外部代理接收 Webhook；
两者随后使用同一套领取、续租、结果提交与失败恢复服务。通知不会直接执行咨询正文，也不授予 Task 主动权。

| 步骤 | v1 操作 | 说明 |
| --- | --- | --- |
| 查自己的消息 | inbox.list | agentId?、after?、limit1..100；返回元数据、通知状态及游标 |
| 领取处理权 | inbox.claim | messageId、expectedVersion?；返回 claimId、generation、expiresAt |
| 读取完整内容 | inbox.get | messageId、offset?、limit1..4000、expectedSha256?；返回私人咨询 JSON 源页 |
| 续租 | inbox.renew | messageId、claimId、generation；在过期前提交新命令 requestId |
| 回传结果 | inbox.complete | messageId、claimId、generation、text、publish?；Chief 答案使用 acknowledge=true |
| 失败 | inbox.fail | messageId、claimId、generation、retryable；不代表执行器已退出 |
| 查看连接 | inbox.connection | 仅返回自己的非敏感连接状态 |
| 启用/禁用通知 | inbox.connection.configure | 本人亲自选择预置 connectionId 与 enabled；代理不能自行启用 |

沿用 POST /api/bot 的 project-development/v1 信封；command 必须有稳定 requestId。
原生代理的 project_agent_inbox 工具调用同一应用服务，不额外绕行 HTTP。
旧 consultation.list/get/reply 保持兼容；旧 reply 会经过共同领取及结果校验。

```json
{"endpoint":"project-development","payload":{"version":"project-development/v1","kind":"command","name":"inbox.claim","projectId":"PROJECT_ID","requestId":"claim-001","payload":{"messageId":"MESSAGE_ID"}}}
```

领取后使用返回的 claimId 和 generation；不要把 expiresAt 一起塞进请求 payload。

```json
{"endpoint":"project-development","payload":{"version":"project-development/v1","kind":"command","name":"inbox.complete","projectId":"PROJECT_ID","requestId":"answer-001","payload":{"messageId":"MESSAGE_ID","claimId":"CLAIM_ID","generation":1,"text":"已检查，建议采用方案 A","publish":true}}}
```

安全代理的回复先成为私人建议，需要人类用原 consultation.reply 明确批准发布；
watch 代理在用户当前权限内显式 publish，才会向原 Task 加入输入。requiresHuman 的请求仍需本人批准。
输入已保存、Chief 已读取/处理、Task 已完成是不同事实；最终 Task 裁定仍属于 Chief。
没有角色执行记录的早期 Task 同样能因咨询回复重新唤醒 Chief。

每次领取、续租和提交都检查当前身份、参与关系、授权代次及问题是否仍有效。
并发进程只能有一个有效领取；过期后新领取会增加 generation，旧结果不能提交。
原生执行器退出未确认时保持占用，不能靠租约过期或 fail 重启第二个实例。
服务重启保留消息、领取和收据；丢失响应先查 command.receipt，避免换 requestId 重复操作。
原消息历史继续保留，已取代的问题显示 superseded，不重新投递；私人消息不会进入公开项目 SSE。

## 配置一个第三方 Webhook

先按接入指南创建个人代理、加入项目并由人类签发 FBA Token。代理的 external endpoint 只是描述，
不会自动被调用。操作员须在私有后端 bot 配置中预置该用户/代理/项目的连接，例如：

```json
{"projectAgentWebhooks":{"my-receiver":{"ownerId":"MEMBER_ID","agentId":"AGENT_ID","projectId":"PROJECT_ID","endpoint":"https://receiver.example.invalid/flybot","signingKeyFile":"/srv/flybot/private/agent-notification.key","revision":1}},"projectAgentInbox":{"leaseMs":120000,"attentionMs":1800000},"projectEffectRetry":{"consultation.notify":{"maxFailures":6,"baseDelayMs":1000,"maxDelayMs":60000}}}
```

签名密钥文件使用独立随机密钥，权限0600、归服务运行用户所有、使用绝对路径，不使用符号链接，
不放进仓库或执行工作区。它与 FBA Token 分开管理，不通过公开 API 上传，也不会注入模型/SDK环境。
正常远程连接使用 HTTPS，不允许 URL 用户名密码、query、fragment、重定向或环境代理。
私网 IP 需要操作员为该连接显式设置 allowedAddresses；allowLoopback=true 仅用于明确配置的本机测试/私有端点。
更换 key 文件引用、endpoint 或 revision 后须由本人重新验证启用。

人类登录后调用：

```json
{"endpoint":"project-development","payload":{"version":"project-development/v1","kind":"command","name":"inbox.connection.configure","projectId":"PROJECT_ID","requestId":"enable-receiver-001","payload":{"agentId":"AGENT_ID","connectionId":"my-receiver","enabled":true}}}
```

验证成功后才启用；已有待处理消息会通过同一个 Effects 通知补投。设置 enabled=false 关闭推送，
不撤销 FBA 身份或删除消息，代理仍可按权限轮询补拉。撤销代理访问应使用原 Token 撤销/离开/退休接口。

## 接收与验证通知

OpenAPI 的 webhooks.agentNotification 给出了通知请求和响应 Schema。
接收端读取原始请求字节，验证以下 Header：

- X-Flybot-Event-ID：同一次投递意图的稳定事件 ID，重试可能重复。
- X-Flybot-Timestamp：毫秒时间戳字符串；建议容差5分钟，并持久化 eventId 去重。
- X-Flybot-Signature：sha256= 加 HMAC-SHA256(key, timestamp + "." + 原始请求体) 的十六进制结果。

首次 connection.verify 包含随机 challenge。接收端验证请求签名后返回 challenge 及
signature=sha256=HMAC-SHA256(key, "challenge." + challenge)，证明掌握同一通知密钥。
只有 echo challenge 而没有正确签名不能启用连接。

后续 inbox.available 仅携带 eventId/messageId、项目、代理、源版本及连接版本，
不含私人问题正文、FBA Token 或 Owner Cookie。收到后用自己的 FBA Token 补拉并领取消息。
2xx 只表示接收通知；它不表示已经读消息、完成处理或接受 Handoff。
响应丢失可导致重复通知，接收端去重与 FlyBot 的领取/幂等结果共同防止重复业务效果。

投递失败复用 Effects 的退避和预算；长期未响应会出现在消息状态及 Chief 的原配置化巡检中。
不需要新建轮询调度引擎；推送丢失或外部离线恢复后，仍从同一私人消息箱按游标补拉。

当前验收包含真实后端/DSH 原生代理与独立接收进程的闭环，模型为确定性测试驱动。
这不等于 grok-bot/dots 厂商客户端已完成适配或实连认证。

Written-by: Codex
