# FlyBot 真实组件离线集成 fixture（待浏览器验收）

2026-11-16 14:18 Asia/Shanghai。**不是手写同样 DOM 的效果稿，也不是生产宿主或实机验收。**

## 打开与重建
- `file:///<repo>/core/dev/offline-fixture/dist/index.html#chat`
- `file:///<repo>/core/dev/offline-fixture/dist/index.html#settings`
- `file:///<repo>/core/dev/offline-fixture/dist/index.html#memory`
- `file:///<repo>/core/dev/offline-fixture/dist/index.html#group`
- `file:///<repo>/core/dev/offline-fixture/dist/index.html#search`

将 `<repo>` 替换为本地 checkout 的绝对路径。此前 box browser 在导航前策略拒绝 file://，因此没有点击或截图，也未尝试替代端口/传输；这里仅提供未来获准后可用的重建入口，不声称浏览器验收通过。

源码：`core/dev/offline-fixture/`。构建输出在本目录 `dist/`，不提交输出 bundle、render-check 或 node_modules。
重建：在 core 运行 `node dev/offline-fixture/build.mjs --render-check`；非浏览器渲染检查：`node dev/offline-fixture/check.mjs`。
`fixture.js` 是自包含 classic IIFE，不依赖 dev server、ESM fetch、CDN 或端口。`index.html` 只包含 root、meta 与相对脚本。CSP 禁止 connect、远程脚本/图片与表单提交；没有真实 API transport。`bundle-inputs.json` 是 esbuild 原始来源清单。

运行时依赖是 npm 本地缓存中的 React/react-dom **19.3.1** 与 scheduler 0.28.0，通过 npm --offline --ignore-scripts 安装；没有联网下载。生产宿主 peer React 版本可能不同，不能据此确认宿主兼容性。重建依赖本目录 node_modules；在本目录运行 `npm ci --ignore-scripts`（已有缓存时可加 `--offline`），package.json/lock 记录来源。源码、bundle 均无账号数据。

## 实际组件来源（均位于 core/src/client）
| 范围 | 直接 bundle 的源码 |
|---|---|
| 设置 | settings.js: SettingsDialog / GeneralPage（GeneralPage 不是复制实现） |
| 发送快捷键 | composer.js: installSendShortcut；appearance.js 快捷键/插入换行与主题辅助函数 |
| 长文折叠、卡片、侧栏 | message-fold.js: FoldedContent / DocumentCard / DocumentPane；shared/message-fold.js |
| 记忆目录/搜索 | memory-panel.js: MemoryDialog |
| 建群 | group-settings.js: NewGroupForm |
| 会话筛选/未读列表 | sidebar.js: TeamSidebar（包含真实 SessionFilter、BotRow、RoomRow） |
| 搜索 | palette.js: CommandPalette |
| 未读/置顶顶栏入口 | header.js: HeaderPill / SessionOverflow；shared/session-unread.js / session-pin.js |
| 消息右键/悬停菜单 | message-tools.js: MessageTools / onMessageContextMenu |
| 外观 | styles.js / sidebar.js / group-settings.js / mobile.js 原 CSS |
| 中文 | i18n.js 原 DICTIONARY 与 installLocale |

构建会断言这些源码存在于输入清单、真实 api.js 不在 bundle、浏览器输出无外部 import。

## Mock 边界（务必保留）
- React 正常 hooks/portal；不是单测的伪 React。现有 `test/harness-resolve.mjs` 仍用于整批单测；它的 VM hook harness 不适合直接充当浏览器 React DOM。
- **仅 fixture 控制条、外层布局、模拟输入框、示例消息容器和操作日志是 harness 自写。** 并未宣称它们是宿主 composer 或 Bubbles/UserMessage 的完整装配。
- host.js 替代真实 api.js；不支持的调用明确 reject。设置 prefs、手动未读、置顶、建群只写 React 内存，刷新即清空；不触碰真实 roster、文件或网络。fixture 没有重新实现 host 偏好校验。
- 模拟输入框带宿主 selector，与真实 installSendShortcut 接线（含 getSnapshot）。发送只增加计数，引用只填到这个框。无法验证真实宿主 textarea/contenteditable DOM、真实消息发送或模型运行。
- 示例 A/B/C 和一组群；B 初始有手动未读，C 有固定 completionUnread。打开会话只清 mock 手动未读，不确认真实系统状态；系统状态保持，便于验证手动清除不等于系统确认。
- DSH primitives 缺失：**MarkdownText 替为显式 data-fixture-mock 的 pre 纯文本**；FishLogo 替为标记符。可验卡片/折叠切换/侧栏内容传递，**不能验真实 Markdown、代码高亮、链接、脚注、附件或真实 logo 的视觉**。不把替代物当正式 UI。
- 记忆读取返回固定示例，ask/forget 明确拒绝，不编造模型回答或持久化。建群只增加模拟 room，不邀请、不分享。
- session 行右键菜单、宿主详情抽屉、inbox/连接器/更新不在此 fixture；会显示 mock 边界日志。未读与置顶请通过实际顶栏菜单验证。
- 剪贴板和下载使用实际 MessageTools 的浏览器能力，未伪造成功；file:// 下剪贴板可能被拒绝，应看到失败说明。下载会创建本地 blob 文件，只有人工/父代理验证时才会触发。
- streaming checkbox 仅切换实际组件的 streaming prop，不模拟 token transport；主题只接真实辅助函数，不接 index.js 的宿主主题生命周期、分钟计时和 streaming 延迟调度。
- 目前非浏览器检查为 5 路由 × 中英 × 只读/可写的 **20 个服务器渲染**，不是点击、effects、布局、焦点验收。React 19 发现既有 inbox StatusIcon 缺少 key 警告，未隐去，留作后续专项。

## 交给父代理的操作验收清单（尚未执行）
1. 默认页明确显示示例/MOCK HOST；file:// 无模块/CSP 错误，无网络请求。若浏览器拒绝 file: script，报告具体限制；不要改端口、防火墙、代理或拿手写 HTML 替代。
2. settings：General 切换 light/dark/auto/system、中英、Enter/Shift+Enter、紧凑/标准/不折叠和文档卡；退出后仍在同一次页面 session 中反映。只读只展示设置；刷新重置。
3. chat：按当前快捷键测试发送计数/换行，输入中文 IME 不误发送；只读不发送。注意这个计数不代表真实消息。
4. 折叠：卡片内显示/隐藏全文、侧栏打开/关闭；关卡片后紧凑/标准折叠；none 显示全文；勾 streaming 不折叠不显示消息菜单。
5. memory：等待 mock read effect 后目录/条数、主题、搜索和无匹配；询问/删除拒绝应明确；只读隐藏写操作。
6. group：无选中禁创建，筛选成员、至少本地管理员+另一成员才可创建；移除/切管理员；创建只新增内存 room；只读不创建。
7. sidebar：全部/群聊/单聊/未读真实筛选；B 手动未读、C 系统未读。切到 A 顶栏标未读→未读筛选有 A→清除手动标记→A 消失，C 仍存在；pin/unpin 改列表排序。
8. search：四个真实标签、空态、输入绝无匹配词、输入 kiwi 查已加载示例消息；切标签与方向键；Esc/关闭按钮；不宣称搜索全部宿主历史。
9. 消息悬停/右键：表情本地反馈、引用完整原文到模拟输入框；菜单方向键/Esc/关闭后立即重开；复制成功或真实权限失败；人工允许时下载 .md；只读没有引用入口。
10. 宽屏与 390px：设置、记忆、建群、菜单不溢出；Tab/Shift+Tab、可读标签、焦点与中文换行。记录真实浏览器 console 和截图，不能拿本目录 render-check 当已通过。

旧手写 HTML 效果稿继续仅为 HAND-AUTHORED MOCKUP，不入本 fixture，也不作为真实截图。

最终补记（2026-11-16 14:19（Asia/Shanghai））：完整 core **3330/3330 通过，0 失败，0 跳过**（历史验证记录）；bench-preflight **8/8**；client build / --check / lint 通过。fixture source manifest / 无真实 transport / 无外部 imports 断言通过，20 个 SSR smoke 通过。**无浏览器验收、无新增截图。**

PR 交付补记：当前 core 完整回归为3367项；fixture 重建仅写本地忽略的 dist/。这份 fixture 未 mock 新历史搜索服务，搜索路线仅验证 loaded-outline 与明确退化状态，不能用它验收真实历史搜索/权限/后端。
