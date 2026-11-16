# 历史搜索命中闭环进度

2026-11-16，Asia/Shanghai。仅 `/workspace/flybot-ui-parity` 隔离树。

## 已完成

- 调查已安装宿主导航：可接受 SessionId，但没有 seq/turn anchor；现有 FlyBot 会打开当前 part，原生冷 Session 打开可能激活 Agent。故不伪装历史定位，改为真实只读上下文视图。
- `history-hit` API + `HistoryHitDialog` + Palette 点击闭环，原始命中/同段附近最多四条可见文字，明确分段、Session、seq/turn、只读且不是当前聊天。无发送、编辑、写数据、Agent 激活。
- opaque ticket 绑定本实例/actor/分段/快照/原文摘要，60秒、最多512；读取前后和 dispose 后/返回前重验权限与隐藏 turn。stale/撤权/删除/过期拒绝并提示重搜；已知 roster 权限/账号/分段变化清空旧视图，旧异步不能覆盖新视图。
- 加入共享并发1/actor、4/实例、256字符、500分段、扫描文本2MiB、搜索JSON64KiB、上下文JSON24KiB及取消等可执行限制。JSON 转义也计入，Unicode surrogate 边界不截断；超限有 limited/截断/失败说明而非假装全库完成。
- 中文单字/NFKC、未加载历史、错误/空/长 query、四标签/退化及原隔离边界维持。

## 最终验证（不降阈值、不跳过）

- Focused：84/84，通过，0跳过，`focused-frozen.log`。
- 全量 core：3367/3367，通过，0失败/0取消/0跳过，`full-frozen.log`（约52秒）。相对上轮3351新增16项测试。
- `npm run build`：通过，`build.log`。
- `node scripts/build-client.mjs --check`：通过，`build-check.log`。
- `npm run lint`：通过，仅既有 warnings，`lint-frozen.log`。
- 全量前一次3366/3366也通过，随后补边界并重跑；保留 `full.log`。测试只用独立内存示例/VM React harness，未读真实历史，不是浏览器验收。

## 明确缺口 / 风险

- cold observation **仍在返回前物化整个 Session**，100000事件/文本字节检查是之后的限制；最多4个 Session 同时物化仍可能有大峰值。6秒是合作取消，不是可抢占 native 同步工作的硬超时。没有硬磁盘字节/峰值内存预算，也没有声称已经解决；需宿主提供只读分页/窗口与物化前预算。
- 不是精确滚动/高亮当前聊天；查看的是历史原始文本窗口，超长按编码字节截断。不含图片/附件/工具/model replacement，群聊/远程/Agent 仍 loaded-outline-only。
- 服务端每次读取/返回重验；不能收回此前已合法交付到客户端的字节，也未验证原生真实后端/浏览器 UI。
- 没有浏览器 dispatch/file:// 重试、替代端口、截图、网络/防火墙改动、:3320/生产、提交/推送或 GitHub。

## 文档位置

- 主审查：`core/dev/history-search-review.md`。
- 本轮映射：同目录 `replicate-map.md`、`feature-parity.md`。
- 质量回顾：`changelog.d/teamily-integrated-quality-review.fixed.md`。
- 旧 canonical progress/map 位于树外，本轮遵守“只在隔离树改”没有同步；父代理如需汇总，引用本补记，不要误报树外文件已更新。

## PR 交付验证（2026-11-16，Asia/Shanghai）

本轮提交前重新验证 core3367/3367、social721/721、project148/148；build/check/lint通过。与原修复树逐文件核对：社交/项目和schedule测试一致，schedule仅清理未使用localInput，i18n包含全部原新增项。真实组件fixture已改为本目录忽略的dist输出，来源manifest与20项SSR重跑通过，仍未浏览器验收。生成的core/client.js按仓库规范随源提交；依赖、日志、render-check、效果稿/截图不提交。PR仅覆盖已实现部分，关联#3110但不关闭总目标。

PR policy 复查修正：changelog fragments 按 <slug>.<kind>.md 命名；Unicode 损坏检测测试改用等价 `\uFFFD` escape，避免测试源码本身触发仓库 mojibake 守卫。没有移除或放宽断言。

## 已实际交付的 PR（2026-11-16，Asia/Shanghai）

- FlyBot：https://github.com/ThinkFlowLab/FlyBot/pull/3112 ，`pr/teamily-parity-20261116` → `main`。阶段性实现，Related #3110，不关闭总目标。
- Bot Social：https://github.com/Birfy/bot-social/pull/789 ，`pr/grant-friend-regression-20261116` → `master`。同步后发现源码防线已由上游 #778 等落地，因此单独 PR 仅补 HTTP 回归；没有用旧9行补丁覆盖更完整的新实现或改变历史授权语义。45/45相关测试和tsc通过（Node22匹配SQLite ABI）。原脏树未改。
- 最终目标是完整开源 Teamily；缺少的模型/API/运行时仍须补齐。服务端架构明确为管理 server + FlyBot 容器：管理 server 负责账号/工作区/权限/容器生命周期，FlyBot 容器承载 Agent；两部分均开源可自托管。容器分配粒度与编排技术未定，不能擅自当作已决策。本批不临时大重构。
- 下一批建议先交付管理 server 最小控制面及 FlyBot 容器的认证/权限/生命周期适配契约与可运行自托管部署，再以作品/Artifacts 的真实存储与展示作为新能力切片；不能仅画入口。记忆关系边/图谱、技能与MCP、协作同步/调度随后逐项对照验收。
- 本地core3367、social721、project148通过；源码/patch check和canonical、仓库政策检查通过。CI结果应在PR页独立查看，不把本地全绿当GitHub CI已绿。浏览器和真实后端仍未验收。无自动合并/部署。
