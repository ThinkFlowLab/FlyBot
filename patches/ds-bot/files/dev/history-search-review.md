# 历史消息搜索：范围、只读边界与回归

2026-11-16，Asia/Shanghai；本轮补齐历史命中只读查看闭环。仅隔离源码树；不提交/部署、不接触生产/:3320、不启动端口、不再尝试被拒绝的 file:// 浏览器导航。无截图、无手写 HTML。

## 查明的宿主能力

- 现有 `src/host/chat-index.js` 可搜索 Bot 所有分段，但 `eventsBackwards` 会 `resolveAgent`，SQLite catch-up 会写派生索引，不能直接作为这次严格只读查询。
- 安装的 `dsh-experimental-session-search/lib/index.js` 只是 `export {}`，不能据包名假定有可调用搜索。
- `dsh-api-session-controller` 的 `search` 是真实能力，但会通过 `sessionQuery.searchSessions` 枚举宿主可见 corpus；SQLite provider 可创建/更新索引，而且只检索 current model surface。既不适合在 FlyBot owner 授权前跨实例扫描，也不等同于压缩前的人类对话历史。因此本轮没有调用它。
- `ctx.get('sessionQuery').observeSession(sessionId, {signal, projectionMode:'none'})` 提供 cold-safe、特定 Session 的不可变 observation，不激活 Agent、不计算 projections；冷历史恢复与 interrupted-turn 平衡在内存完成。返回 lease 必须 dispose。这是新查询实际使用的接口。
- `dsh-session.isAppendSurfaceEvent` 的源码注释明确：append-origin 才是 human transcript；model replacement 并非原对话。本轮保留压缩前原消息，不检索 model-only replacement 摘要。

上述为安装包源码审查与隔离适配器测试结论，未调用任何真实运行实例来读用户历史。

## 本轮实现

- 新 `src/host/message-search.js`，由 core/index.js 注册；`search-messages` 接入现有 `/api/bot`，加入只读白名单。
- 认证继续由 `x-flybot-member-session` 解析；authz 在成员模式拒绝匿名，新服务再按当前 actor 过滤。payload 仅接受 `{query, limit?, cursor?}`；actorId/sessionId/home/path 等多余 selector 一律拒绝。
- 只枚举**当前 FlyBot state.bots 中本地且属于 actor 的 Bot 的 own-chat 当前分段和 segments**，并调用现有 `sessionOwnedBy` 再检查 Session。每次 await 前后、发结果前、翻页均重验。不按目录扫描，不调用 listSessions、远程实例或插件文件搜索。
- 未开启成员认证时沿用既有单人实例规则，仅当前 state 登记的本地 Bot。不会因此查询 DSH 全部 Session。
- 文本仅来自 append-origin `user/message` 且 source.kind=user 和 `assistant/message` 的 text block。工具参数/结果、plugin records、后台 source.kind=ds-bot 输入、附件、图片、model replacement 不搜索。exchangeTurns 隐藏 turn 排除；带隐藏 turn 的会话中无法确定 turn 的消息 fail closed。
- NFKC + 大小写不敏感的字面子串；支持单字中文，无 SQL/正则/FTS 执行语义。不是分词、模糊或语义检索。
- API 返回 snippet、botId、sessionId、seq/turn、是否较早分段，不返回路径、header、配置、工具内容或底层错误。底层失败只给 incomplete，错误消息不回传日志路径/配置。
- 无 save/bootstrap/resolveAgent/flush、无 SQLite/文件写入。cursor 仅进程内随机 opaque token，绑定实例闭包、actor、规范化 query；60 秒过期，最多 64 个。历史变动使当前分段续页失效，必须重搜，不拿旧游标猜。
- 限额：API 默认20/最多50条；每请求最多8次 observation，6秒 cooperative timeout；每轮最多500个已授权 Session 分段、200个读取批次，每批最多1000个候选消息；单源超过100000原始事件跳过并标 limited；每 actor 最多1个、实例最多4个并发查询。每分段从新到旧，分段按 Bot 注册顺序/由新到旧；不是全局时间或相关性排名。

## Palette 接入

- 新 `src/client/history-search.js`：250ms debounce、忽略过期异步结果、卸载保护、显式继续检索、前端最多100条。只在 All/Messages 查询；Chats/Commands 不发历史读取。
- 保留原四标签与 loaded turnOutline 搜索。历史单独标为「本机 Bot 对话历史」，仍有已加载结果；相同 Session/turn 的结果尽量去重。
- 明确标注「本实例中你拥有的本机 Bot；其他对话仅已加载」。空、查询中、后续未检索、部分失败、达到上限与只读适配器不可用均有不同说明，不把不完整扫描写成全库无结果。
- 旧宿主缺 service 或任何查询失败，明确退化为 loaded-only；不返回底层错误、不保留失败请求的旧历史结果。
- 历史命中现在**不再调用 openSession**，而打开真实 `HistoryHitDialog` + `history-hit` 只读查看：展示实际 Session、分段序号、seq/turn、原始命中文本及同段前后各最多2条可见消息。明确标注「分段历史，不是当前聊天；不激活 Bot」。不发送、编辑、写回或假装定位成功；只有返回搜索和重新读取上下文。
- 点击只发送进程内 opaque hitToken（最多512个、60秒、绑定 actor/实例/快照摘要）；不接受指定任意 Session/seq/path。上下文读取前、native await 后、lease dispose 后与返回前重新核验当前 owner、Session 归属/分段存在、隐藏 turn；原文摘要/快照变化、删除、过期均拒绝，提示重新搜索。
- 实际宿主导航契约 `dsh-client-ui-workspace/lib/types/client/navigation.d.ts:21` 仅 `openSession(SessionTarget)`；`dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:20` 的 target 只有 SessionId/SubagentAddress，无 turn/seq anchor。FlyBot 自身 openSession 又归约为当前 part；原生打开冷历史可能提升为 Agent，故不用它冒充定位。
- 搜索和上下文 hook 均用 AbortController + generation guard。切换命中、已知账号/owner/parts 变化、删除 Bot、卸载时清空旧上下文并取消旧请求；失败不拿搜索 snippet 伪装原始上下文。权限校验保证每次服务端读取/返回的当前权限，不宣称能收回已交付到客户端的内容。

## 未覆盖/缺口

1. 群聊、共享房间的 membership-window 历史、远端 Bot、DSH Agent/子代理、已删除/不在当前 state 的 Bot 尚未历史检索；仍只用已加载大纲，不能宣传「所有聊天历史」。未来群聊应先用 roomHistory(actor) 的窗口过滤，绝不能搜索成员内部 group Session 代替房间可见记录。
2. 非索引扫描会重复读取特定分段。宿主 observation 在返回前会物化单个逻辑 Session；100000事件防护是返回后的防护，**不等于硬性磁盘字节/内存上限**，超大历史读取和阻塞工作可能不能即时响应取消。需宿主提供有权限范围、只读、按转录分页的查询接口才能彻底解决；本轮不越界写新索引。
3. 未验证真实宿主版本差异、真实持久化后端、浏览器点击/焦点/窄屏；全部新测试只用独立内存示例。不会把真实组件/VM测试当浏览器验收。file:// 策略阻断仍有效，未尝试任何替代传输。
4. 不读取密钥/配置文件，也不检索工具结果。正常用户/助手对话文本的内容没有通过额外读取密钥库作全局脱敏；服务不会为了搜索去访问该类私有文件。

## 可执行资源边界（两类只读请求共用并发额度）

- 每 actor 同时1个、实例最多4个，超出直接拒绝；6秒 cooperative signal，浏览器发起端取消同时传到底层 observation。
- Query 最多256 Unicode 字符，并在展开前拒绝超1024 UTF-16长度；空/非法/长 query 有测试。每轮目标最多500分段，每次最多8 observations；最多200读取批次、每批1000候选消息、单源最多100000事件（最后一项是物化后检查）。
- 单消息提取上限262144 UTF-8字节、最多10000 content blocks；每请求扫描文本最多2097152字节。超大消息跳过并标 limited；扫描预算耗尽保留准确的续读位置。
- 搜索最多50条/页；items 的 JSON UTF-8预算65536减1024 envelope reserve，达到预算保留下一命中的位置；客户端最多显示100条。上下文 JSON UTF-8预算24576减64 envelope reserve；命中/邻居文本编码后 JSON 字节各最多8192/2048，考虑反斜线/控制字符转义，明确截断，不把 surrogate pair 截成碎片。
- 这些限制**不是 native cold observation 的硬内存/磁盘字节预算**。宿主先物化整个逻辑 Session，之后我们才检查事件数/提取字节；取消依赖宿主合作，不能抢占同步阻塞。并发4也意味着可同时物化至多4个未知大小 Session，仍可能有明显峰值。没有用文件系统旁路读取或创建索引。
- 根治需要宿主提供按 Session、按权限、只读的 transcript-window / scan-page API，支持创建 observation 前的硬字节上限、分页快照及可中断读取；当前公开契约没有这套能力。本轮不声称解决该宿主差距。

## 测试与证据

- `test/message-history-search.test.js`：25项，新增真实旧分段原文、opaque ticket/actor/实例边界、stale追加/修改/删除/隐藏、await/dispose 撤权、跨权限分页、消息/扫描/响应字节、中文与 Unicode、JSON 转义预算、共享并发与取消。既有未加载历史、错误/空/长 query、只读 channel 认证/白名单测试保留。仅内存示例；fixture.invalid 的 Request 直接交 handler，不发网络。
- `test/history-search-state.test.js` 4项；新增 `test/history-hit-state.test.js` 3项，覆盖取消/切换/账号/owner/parts/删除/错误/retry。复用 `test/history-hook-harness.js` 的 VM hook/effect 约定。
- `test/history-hit-view.test.js` 2项，执行实际组件，验证分段、原文作为 React text（不注入 HTML）、只读控件、截断/加载/失败/删除状态不露旧正文。不是浏览器验收。
- `test/palette-history-ui.test.js` 3项，明确断言历史点击只打开只读组件、不会调用 openSession；四标签、加载/不完整/续页/失败退化保留。
- 本轮 focused **84/84**，0失败/0跳过：`dev/history-hit-review/focused-frozen.log`。
- `npm run build`、`node scripts/build-client.mjs --check`、`npm run lint` 通过（仅既有 warnings）：`build.log`、`build-check.log`、`lint-frozen.log`，均在 `dev/history-hit-review/`。
- 首次完整回归3366/3366通过；再补 Unicode 起始边界及 JSON 转义预算测试后冻结版全量 **3367/3367通过，0失败/0跳过**，见 `dev/history-hit-review/full-frozen.log` 与同目录 progress。未改阈值、未跳过测试。
- 历史基线3351/3351。未测试真实用户历史、未开浏览器、未截图；file:// 拒绝没有被绕过。全部本轮改动/证据留在 `/workspace/flybot-ui-parity`，无提交/推送/部署。
