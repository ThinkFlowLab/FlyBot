# Feature parity 补记

- 历史搜索：**已实现但范围有限**。当前实例、当前actor拥有的本地Bot own-chat各分段；中文/NFKC字面匹配、有界分页。
- 旧命中闭环：**已实现只读上下文查看**，不是精确 turn 导航。真实宿主没有满足“不激活Agent”的公开精确turn导航路径；不可把当前聊天当旧命中落点。
- 安全/资源：服务端每次授权重验；stale/revoke/delete/跨权限分页有测试。并发/长度/分段/扫描文本/输出JSON/取消受约束，**cold Session物化前的硬字节预算未解决**。
- 浏览器/真实后端：**未验收**；file:// 策略拒绝仍然有效，没有重试或替代输送。
- 测试：focused 84/84、全量3367/3367，build/check/lint通过，无skip/阈值变更。

## PR 交付验证（2026-11-16，Asia/Shanghai）

本轮提交前重新验证 core3367/3367、social721/721、project148/148；build/check/lint通过。与原修复树逐文件核对：社交/项目和schedule测试一致，schedule仅清理未使用localInput，i18n包含全部原新增项。真实组件fixture已改为本目录忽略的dist输出，来源manifest与20项SSR重跑通过，仍未浏览器验收。生成的core/client.js按仓库规范随源提交；依赖、日志、render-check、效果稿/截图不提交。PR仅覆盖已实现部分，关联#3110但不关闭总目标。
