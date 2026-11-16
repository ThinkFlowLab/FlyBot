# 历史命中闭环对照（本轮补记）

2026-11-16，Asia/Shanghai；路径均相对 `/workspace/flybot-ui-parity/core`。

| 需求 | 真实实现 | 验证/边界 |
|---|---|---|
| 旧分段命中不是打开当前会话 | `src/client/palette.js` → `HistoryHitDialog` / `src/client/history-hit.js` → `history-hit` | palette UI 断言不调用 openSession；组件真实分段/原文/只读标识。不是精准聊天滚动 |
| 只读原始上下文 | `src/host/message-search.js` 的 readHistoryHit；`src/host/channel.js` READS；`src/host/authz.js` | 原始 append transcript，同段前后各最多2可见消息；无 Agent 激活/发送/写回 |
| 权限/过期/删除闭环 | actor+实例 opaque ticket、快照和摘要；读取前后及 dispose 后复检；hook 清空/abort | stale append/modify、Bot/Session删除、part移除、隐藏 turn、await/dispose撤权、跨权限分页测试 |
| 资源控制 | 共享并发、query/目标分段/扫描/字节/TTL cap、native signal | 查询/上下文实际UTF-8 JSON预算，转义与Unicode边界测试；不是物化前硬内存/I/O预算 |
| 四标签/退化不变 | `src/client/history-search.js` + palette | All/Messages检索；Chats/Commands不检索；失败明确loaded-only，其他实例/群聊/Agent不假装覆盖 |

证据：focused 84/84；完整 core 3367/3367；build/check/lint通过，0跳过。日志同目录。无真实数据/浏览器验收/截图/端口/部署/提交。

## PR 交付验证（2026-11-16，Asia/Shanghai）

本轮提交前重新验证 core3367/3367、social721/721、project148/148；build/check/lint通过。与原修复树逐文件核对：社交/项目和schedule测试一致，schedule仅清理未使用localInput，i18n包含全部原新增项。真实组件fixture已改为本目录忽略的dist输出，来源manifest与20项SSR重跑通过，仍未浏览器验收。生成的core/client.js按仓库规范随源提交；依赖、日志、render-check、效果稿/截图不提交。PR仅覆盖已实现部分，关联#3110但不关闭总目标。
