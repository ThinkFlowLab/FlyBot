# Feature parity 补记

- 历史搜索：**已实现但范围有限**。当前实例、当前actor拥有的本地Bot own-chat各分段；中文/NFKC字面匹配、有界分页。
- 旧命中闭环：**已实现只读上下文查看**，不是精确 turn 导航。真实宿主没有满足“不激活Agent”的公开精确turn导航路径；不可把当前聊天当旧命中落点。
- 安全/资源：服务端每次授权重验；stale/revoke/delete/跨权限分页有测试。并发/长度/分段/扫描文本/输出JSON/取消受约束，**cold Session物化前的硬字节预算未解决**。
- 浏览器/真实后端：**未验收**；file:// 策略拒绝仍然有效，没有重试或替代输送。
- 测试：focused 84/84、全量3367/3367，build/check/lint通过，无skip/阈值变更。

## PR 交付验证（2026-11-16，Asia/Shanghai）

本轮提交前重新验证 core3367/3367、social721/721、project148/148；build/check/lint通过。与原修复树逐文件核对：社交/项目和schedule测试一致，schedule仅清理未使用localInput，i18n包含全部原新增项。真实组件fixture已改为本目录忽略的dist输出，来源manifest与20项SSR重跑通过，仍未浏览器验收。生成的core/client.js按仓库规范随源提交；依赖、日志、render-check、效果稿/截图不提交。PR仅覆盖已实现部分，关联#3110但不关闭总目标。

## 已实际交付的 PR（2026-11-16，Asia/Shanghai）

- FlyBot：https://github.com/ThinkFlowLab/FlyBot/pull/3112 ，`pr/teamily-parity-20261116` → `main`。阶段性实现，Related #3110，不关闭总目标。
- Bot Social：https://github.com/Birfy/bot-social/pull/789 ，`pr/grant-friend-regression-20261116` → `master`。同步后发现源码防线已由上游 #778 等落地，因此单独 PR 仅补 HTTP 回归；没有用旧9行补丁覆盖更完整的新实现或改变历史授权语义。45/45相关测试和tsc通过（Node22匹配SQLite ABI）。原脏树未改。
- 最终目标是完整开源 Teamily；缺少的模型/API/运行时仍须补齐。所有 server 功能统一为一个开源可自托管 server、一个对外部署/API，内部模块化适配现有 FlyBot/Bot Social。本批不临时大重构。
- 下一批建议先交付统一 server 的身份/权限/数据/适配契约与可运行部署，再以作品/Artifacts 的真实存储与展示作为新能力切片；不能仅画入口。记忆关系边/图谱、技能与MCP、协作同步/调度随后逐项对照验收。
- 本地core3367、social721、project148通过；源码/patch check和canonical、仓库政策检查通过。CI结果应在PR页独立查看，不把本地全绿当GitHub CI已绿。浏览器和真实后端仍未验收。无自动合并/部署。
