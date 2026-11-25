# Page parity pass (2026-11-19)

One page-by-page pass that compares FlyBot renders with private, read-only
Teamily reference captures and recreates the look with original CSS and inline
SVG. **No Teamily screenshots, logos, icons, fonts or account text are in this
repository.** The reference captures stay on the reviewer's machine; the file
names below only identify which private capture a row was compared against.

Renders were taken at 1280×800 against the synthetic CI fixture
(`python3 scripts/ci_ui_screenshots.py --serve`). This is a visual-parity pass,
**not** an acceptance claim: CI passing is not Teamily + Impeccable acceptance,
and disabled or unconnected controls stay disabled and labelled.

Shared changes (all pages): lighter green-grey ground, darker AA-safe accent
(`#097845`), white rounded main canvas, 14px workspace base size, toned
two-letter avatars/monograms, pill searches with a leading icon, plain-text
category chips with a single green pill, compact 2.5rem list rows, white cards
with a 1px ring instead of heavy shadows.

| Page | Teamily evidence file (private) | OT render | Differences fixed | Remaining differences |
|---|---|---|---|---|
| Chat – conversation | 01a-chat-normal, 01b-chat-message-hover, 01b2-chat-message-context-menu | chat-agent | Session pane is a white panel; pill search with icon; green round “+”; 11–12px section labels; 2.5rem toned avatars; selected row soft green without ring; floating rounded header card with pill text actions and 14px title; mine bubble light green, agent replies white ring cards; per-message actions only on hover/focus (Teamily has no hover toolbar); hint strip above composer; rounded composer with bottom tool row and green pill send. Group headers now stack up to four member/agent monograms. A message attachment renders as a small cover card (kind tint + title + download), not a bare link. | Suggestion chips still need stream data; covers are kind-tints, not thumbnails. |
| Chat – message menu | 01b2-chat-message-context-menu | msg-menu | Right-click on a group/DM message opens a floating menu: reaction row (real reaction API), 回复 (quotes into the composer), 复制, 转发 (multi-select with this message picked), 置顶 / 取消置顶, 选择消息, 撤回 (own messages, existing confirm). | 保存到资料空间, 翻译 and 删除 are shown disabled and tagged 未接通 (no social save/translate/delete API). Agent-conversation messages keep their own save button. |
| Chat – reply states | 13a/13b/13c/13d-bug-agent-* | chat-agent-sent | Header status line under the title (AI 智能体 · 经运行时回复 / 正在回复… / group counts / 单聊 · N 人); a queued or running reply is a white card headed 正在准备回复 / 正在生成回复 with the honest queue detail; agent name instead of a generic label; failed replies are a soft red note. | No token streaming (runtime replies arrive whole); no cold-start timing text. |
| Chat – create menu | 03a-chat-create-menu | chat-new-menu | Floating menu card with original 16px stroke icons per item. | Items Teamily offers that we do not implement are not added. |
| Chat – new group | 03b-new-group-dialog-custom, 03c-new-group-dialog-ai-team-tab | chat-group-create | Centered modal with scrim; full-width segmented tab switch; two-column picker and name layout; pill member search; checkbox rows on one line; footer actions with green submit. | No close “×”, no friends/agents split headers, no 付款方式 row (no payments by design). |
| Chat – search | 01c1-chat-search-empty, 01c2-chat-search-test-results | chat-search | Sidebar search: underline tab strip, section headings, single-line results. In-chat search is now a right-hand panel with a pill field, scope line and rows (avatar, author, time, highlighted snippet). | In-chat search covers messages only — 资料/照片/文件 tabs are stated as 未接通; no thumbnails. |
| Chat – group | 10a/10b-group-chat-view, 10c/10d-group-info-panel-* | chat-group | Same header/bubble/composer language; group agent action is a compact card. New 群信息 header button opens a right-hand panel: monogram, name, “N 位成员 · N 位真人 · N 位智能体”, 搜索聊天记录 (opens in-chat search), 群公告, 视频/语音通话, Agent 主动性 / 自动翻译 / 消息免打扰 / 置顶聊天 switches, 智能体 / 成员 tabs with rows. The in-stream 群内智能体 note and request card now use the same white ring-card language as the group-info panel (text, including the 未接通 line, is unchanged). | 群公告 发布, calls, Agent 主动性, 自动翻译 and 免打扰 are disabled and labelled 未接通; only 置顶聊天 works (existing pin API). No 付费模式 (out of scope). |
| Discover – feed | 2026-11-17 pm discover | discover | Open toolbar (no boxed card), pill search left, 关注/动态 underline tabs right, chip row, cover-first cards with kind badge on the cover, no grey grid container. | Covers are original geometric patterns hashed from the title (still not real thumbnails; no thumbnail service). Author monogram and like count now sit on the card face. |
| Discover – agents | 06a-discover-agents-grid, 06b-discover-creator-dropdown | discover-agents | Pill search with icon, green create pill, plain-text chips with green 全部, 创建者 row, 3-column white cards, toned two-letter monograms, outlined 聊天 pill. | Category chips and 聊天 stay disabled (catalog has no category/chat API); creator dropdown is not a menu. |
| Agents | 06a-discover-agents-grid (same directory language) | agents | Same toolbar, chips and card grid as the directory; monogram avatars; outlined 聊天 link. | Workspace picker and signed-in line kept (self-hosted multi-workspace). |
| Settings hub | 04a-settings-top, 04b-settings-bottom | settings | Centered ~32rem column, 11px group labels, white rounded groups, 2.5rem rows with 16px outline icons and muted chevrons, compact identity card and 成员 pill. | No usage/credits card and no 创作者与奖励 / 套餐 groups (out of scope by design). |
| Settings – language | 09c-settings-language | settings-language | Plain “‹ 语言” back header; label above full-width rounded selects in one white card; checkbox row. | — |
| Settings – Agent API | 09d-settings-agent-access | settings-agent-access | Plain back header, grey empty boxes, accurate note pointing to per-agent API keys on /agents. | Keys are not aggregated on this page; no AI-client authorisation. |
| Settings – connectors / channels | 09f-settings-connectors, 09i-settings-channels | settings-connectors, settings-channels | Plain back header, compact rows, pill actions. | Connectors: real connect/disconnect through the user's own Composio API key (docs/COMPOSIO.md); rows stay disabled and say 未配置 Composio until that key is saved, and apps without a Composio toolkit stay 未接通. Only verified with a fake Composio transport. Channels stay unconnected. |
| Settings – skill configuration | 09e-settings-skill-configuration | settings-skill-configuration | New `/settings/skill-configuration` subpage: “‹ 技能配置” back, green info banner, collapsible “正在编写 Skill?”, “我的密钥” with a green “+ 添加密钥”, empty state “暂无密钥”. Adding a key uses the existing write-only `/v1/skill-secrets` API; values are never echoed. | No in-product Skill-authoring tutorial (the disclosure only restates the name rules). |
| Settings – runtimes | 09g-settings-runtimes-top, 09h-settings-runtimes-bottom | runtimes | `/runtimes` now uses a “‹ 运行时” back header, underline 运行时/连接 tabs, white ring cards with glyphs, a local FlyBot card with numbered three-step setup and zipapp download tiles, and a detected-runtime bar with 检测 / + 连接远程机器. Hosted cloud Agent and hosted computer stay honestly 未提供 / 即将推出. | FlyBot has no hosted cloud Agent, hosted computer, or official desktop app; download tiles point at flybot.pyz and `/download`, not a vendor desktop package. |
| Space (works) | 07a/07b/07c-space-*, 11a–11d | space | Full-height white directory column at the left; scope/filter/layout toolbar across the top of the content; green 新建 pill, pill search, kind list with soft-green current row; centered empty state with tinted CTA rows and round green arrows. Also fixes a nested `<form>` that ended the editor form early (save/back/delete buttons rendered outside the editor). Populated library (11a–11d): grid cards with a kind badge (DOC/WEB/…), ⋯ menu shown on hover, soft kind-tinted cover, title and source line; list view with 名称 / 来源 / 创建时间 / 最近动态 columns from real `created`/`updated`; ⋯ menus — grid 重命名/删除, list 发送到聊天/重命名/删除 — where 重命名 opens the editor on the title and 删除 confirms then calls the existing remove API. Opening a document shows a calm reading column (large borderless title, borderless body). Grid cards now show a bookmark icon (disabled, 未接通). Title/source typography matches the denser recorded cards. | Covers show the kind, not thumbnails. Media items can be sent to a social group or DM through the existing attachment API; documents, websites, boards and slides stay disabled and labelled 未接通 (that API only accepts media). Bookmark is not wired (no favorites API). Documents open in place, not in a new tab. |
| Memory | 05a-memory-overview, 05b-memory-item-hover, 05c-memory-detail | memory | Full-height white directory column; a visible 总览 title; number-column stats (节点 / 连接 / 未连接 / 话题, where 未连接 is nodes with no edge); pill topic search; white dotted graph card; white 话题亮点 card with underline tabs; compact filters and view list. The page editor is a wiki-like column: large borderless title, dashed tag field, borderless body, actions on a top rule. | 全部 and 更新 both carry counts (更新 = pages edited in the last 7 days, since there is no read state); the long comparison note is collapsed into 对照说明. No rich-text toolbar (plain body field). |
| Onboarding | 12a/12a2-onboarding-step1-*, 12b-onboarding-step2-connect-apps, 12c-onboarding-step3-tasks, 12d-onboarding-step4-avatar | onboarding | Four-step wizard with a 4-bar progress strip and 第 N 步，共 4 步: industry cards (toned glyph tiles, ✓ on select) and role cards; app rows with tile, name · 未连接 and a disabled + 连接; 一次性任务 / 例行任务 pick cards; avatar step with live preview and 进入 FlyBot. | Connect buttons are disabled (no third-party OAuth); avatar is an original SVG, not Teamily art. |
| Profile | 08a-profile-loading, 08b-profile-own-posts-tab, 08c-profile-followers-dialog-loading | profile | `/profile` is now the social home: large monogram, visible username, 关注/粉丝/赞与收藏 counts, icon actions, 帖子/收藏/点赞 underline tabs, empty-state copy, and a right-hand 智能体 list (up to five workspace agents, 显示全部 → /agents). 关注/粉丝 open a centered dialog with tabs, a pill search, and an honest empty state. | Counts stay 0: there is no follow/like API. Gift, notification and share actions are disabled and labelled 未接通. Posts, collections and likes have no feed yet. Avatars are monograms, not photos. |
| Profile – edit | 09a-profile-edit-top, 09b-profile-edit-bottom | profile (edit) | `/profile/edit` (pencil on the home, or 账户与资料) is a centered single column: “‹ 编辑资料”, monogram, disabled 更换头像, character counters, full-width fields, 取消/保存 (save stays off until the form is dirty), a private-email row (未设置 when the session has no email) and a disabled 删除账户. Existing `/v1/profile` save and 重新加载 behaviour is unchanged. | No avatar upload. Email is not returned by the session API, so the private row says 未设置 and points at /settings. Account deletion is 未接通. |
| Feature guide | 09j-guide-feature-index | guide | Tighter feature index: outline mark, pill search, compact list/grid toggle, text category rail with count pills, hover-green rows. The catalogue is still FlyBot’s own entries (not Teamily’s 295-item copy). | Count line remains “当前显示 N 条” (CI). Graph/map toggle stays disabled (未核实). |
| About | 09k-about | about | New `/about` article: back/home icons, large title, original cover block, FlyBot copy only. | No marketing video or vendor photography. The settings hub now has a 支持与法律 group with working 功能指引 and 关于 links; 帮助中心 / 服务条款 / 隐私政策 stay disabled and labelled 未接通. |
| Automations | 2026-11-16 inventory (templates previously opened; no dedicated list/editor capture in the later folders) | automations, automations-editor | Individual layout: heading + green 新建 pill, collapsed 对照说明, pill search, underline 我的自动化/工作/生活 tabs, compact 2.5rem rows with monograms and 已启用/未启用 pills, work/life templates as a white ring-card grid, wiki-like editor with a ‹ 自动化 back link and grouped field cards, run history as status cards. Loading shows “正在加载自动化…”, errors replace the empty state instead of leaving a stale list. Inline delete/cancel confirm is not added here — HugoXK #226 is already in flight for that. | No Teamily screenshot of a populated list or editor in the later capture set, so density follows the shared language rather than a pixel-matched list. Real scheduler-to-vendor execution is still unconnected. |
| Members | no standalone Teamily /members capture; density follows settings/list language and the existing inline confirm | members | Compact heading, collapsed 对照说明, workspace + role line, 2.5rem member/invite/request rows with monograms and role pills, add/invite/accept/directory as white ring cards, pill directory search, empty states. Remove / leave / revoke still use the existing in-row confirm. | Role and invite defaults were not compared with a Teamily members page. Public AI-team bundle directory is still this instance’s own listing, not a vendor marketplace. |
| Team wizard | inventory/create-team-step1.png | team | Step 1 matches the recorded page: progress “第 1 / 3 步”, “为团队命名” as the visible heading (the “创建团队” title stays in the document but is not a boxed header), left-aligned full-width fields, mode rows with original icons and a checkmark on the selected mint pill, disabled pill 继续 until name and Team ID are valid. Step-later is unchanged and still honest about missing later-step evidence. The invite step itself is left to HugoXK #250 and is not rewritten here. | Steps 2–3 have no Teamily capture in this pass; convert-workspace picker remains an FlyBot-only control when the account has more than one convertible workspace. |

## Impeccable

`impeccable detect` (v4.9.2) was run on the changed sources and on rendered
snapshots of the main pages (computed DOM with the page CSS inlined) in the
first pass (#240) and again on this follow-up’s changed pages. Fixed earlier:
side-tab accent borders, a 4.48:1 hover contrast (accent `#097845`), cramped
fieldset padding, sub-12px chat text. Remaining advisories from that pass still
apply where the layout follows the reference (nested white canvas, 11px settings
group labels, one settings hover report, a clipped space-directory child).
This follow-up ran `impeccable detect --changed` (v4.9.2) on the branch’s UI
files. About-cover contrast (1:1 on a mixed light-to-dark gradient) was
fixed with white text on a consistently dark green cover, and the about
article uses explicit light colors so it does not inherit dark-scheme
shell tokens. Group-agent fieldset inset was added. Remaining advisories:
nested-card reports on the white ring canvases that follow the Teamily
reference; a cramped memory-center inset; the settings-hub hover contrast
in dark tokens (white on `#a4e3c5`, same advisory as #240); and one
about-link hover under shell dark accent tokens during the file scan.
Those were left in place rather than flattening the reference layout or
changing global dark tokens.


## Follow-up (automations / members / team, 2026-11-19)

A third visual pass, plus functional wiring that already had APIs:

- Settings hub gained a 支持与法律 group and a working `/about` link.
- Space “发送到聊天” is connected for **media** artifacts only (`POST /v1/workspaces/…/social/conversations/…/messages` with `artifact_id`). Other kinds stay 未接通.
- Kind-tint covers use slightly heavier, tracked typography; they are still not thumbnails.
- Unconnected features (OAuth, translate/ask-AI, calls, credits, vendor inference, server push, public Teamily 295-item guide copy, automations delete-confirm already owned by #226, team invite step owned by #250) were left alone or kept labelled 未接通.

`impeccable detect` (v4.9.2) was run on this pass’s changed UI files. Findings: the same nested-card advisories on the white ring canvases (automations, members, team, settings, space) and the settings-hub dark-token hover contrast (white on `#a4e3c5`, 1.5:1) already reported in #240/#249. Those were left in place rather than flattening the reference layout or changing global dark tokens. No new functional checks were weakened.


## Follow-up (logo, composer, covers, 2026-11-19)

A fourth visual and functional pass after #255. Still **not** a Teamily + Impeccable acceptance claim.

- **FlyBot mark:** an original inline SVG (open ring + companion node) replaces the "FB" letters on every workspace rail. Placement, 2.15rem circular size and top-of-rail alignment follow the captured shell. The same mark plus an "FlyBot" wordmark appears in the about header/cover and on the public agent homepage top bar. FlyBot remains in "Built with FlyBot" and in prose. **No Teamily, Google, GitHub or other vendor logos were copied.**
- **Chat composer:** a lower capsule shell with a left-hand “+” sheet (上传 is wired to the existing media-attachment input; 创建 items that already have pages link to `/space`, `/automations` and `/memory`; the rest stay 未接通), icon tools, and a circular arrow send button. Enter-to-send is unchanged.
- **Group chat surface:** the 群内智能体 form is collapsed behind a details summary so the conversation is the main surface; the request/add APIs are unchanged.
- **Discover feed:** 4-column cover cards use hashed geometric patterns and a small dark kind badge; author monogram and like count sit on the meta row. Image works still use the same-origin published file, never invented screenshots.
- **Memory editor:** typography and a markdown toolbar (bold/italic/headings/list/quote/code/link insert into the existing textarea and save through the current API). 做梦 / 分享 / 历史 stay disabled and labelled 未接通. Delete behaviour was not changed (#251 owns confirm).
- **Connectors and channels:** original geometric CSS marks (category-colored tiles with simple strokes). They are not vendor trademarks; a faithful official icon is intentionally not attempted.
- **Settings hub:** scoped dark-theme row hover now uses a dark green surface with light text, instead of white on `#a4e3c5`, without changing the light-theme white-ring canvas.

Unconnected features (translate/ask-AI, OAuth/MCP connect, A/V meetings, credits, vendor inference, server push, public Teamily 295-item guide copy, non-media 发送到聊天, automations delete-confirm owned by #226, team invite step owned by #250, memory delete confirm owned by #251) stay labelled 未接通 or were left alone.

Remaining visual gaps: covers are still not thumbnails; connector marks are original geometrics, not brand icons; the public agent page is a light profile (no Teamily dark marketing capture was available to match); rich text in the memory editor is markdown in a textarea, not a full WYSIWYG; the + sheet is a compact panel, not a pixel-identical Teamily create grid.

`impeccable detect` (v4.9.2) on this pass’s changed UI files: nested-card advisories on the white ring canvases (chat, memory, settings), the previously reported cramped memory-center inset, and two static-token low-contrast advisories (settings dark hover white on `#a4e3c5` from global dark `--ot-accent-hover`, and about `#097845` on `#89d5b5` during the file scan). The settings-hub row hover in dark theme was scoped to a dark green surface with light text. A decorative grid-line cover pattern was replaced with a radial fill. Nested-card and remaining token advisories were left rather than flattening the reference layout or changing global dark tokens. No functional checks were weakened.


## Follow-up (polish 5: thumbnails, WYSIWYG memory, create grid, 2026-11-19)

A fifth visual and functional pass after #257. Still **not** a Teamily + Impeccable acceptance claim, and CI screenshots are a synthetic fixture, not parity evidence.

- **Work covers are thumbnails generated from the work itself.** `artifacts.preview()` builds a small text-only model (document heading and first lines; website title and text with tags/scripts stripped; first slide title, up to 3 bullets and the slide count; sampled whiteboard strokes; up to 4 dashboard widgets). `shell/thumb.mjs` draws it with `textContent` and SVG attributes only, so stored HTML is never interpreted. Space covers use it (image media shows the original file). Discover covers fetch it from `GET /w/<slug>/preview`, which serves only listed works and exposes no more than the public `/w/<slug>` page; the `/v1/discover/works` listing stays a body-free projection. Audio/video show only the kind.
- **Memory editor is WYSIWYG.** A contenteditable surface (`memory/rich.mjs`) renders the stored markdown and serialises edits back (headings, lists, quote, code, rule, bold/italic/strike, inline code, safe links, `[[wiki]]`). The save API and the stored markdown format are unchanged; an untouched page is saved byte-for-byte. A “Markdown” toggle edits the source directly. Paste is plain text. The directory column now stays visible while a page is open, and 添加连接 is one compact row.
- **Composer “+” is a creation grid** aligned to capture 01d: 常用操作 (上传 / 照片 / 视频 narrow the existing attachment picker; disabled with 未接通 in agent DMs, which have no attachment API), 创建 (网站 / 文档 / 幻灯片 / 表格 deep-link to `/space?new=…` and open that editor; 表格 is a dashboard, not a full spreadsheet; 图片 / 视频 / 音乐 / 3D 模型 are disabled and labelled 未接通), 自动化 (four templates deep-link to `/automations?template=…`, which opens the prefilled editor) and 上下文 (记忆 links to `/memory`; 调取 is 未接通). Icons are original stroke SVGs.
- **Impeccable leftovers:** the white canvas uses a hairline outline instead of a card shadow (clears most nested-card reports); the memory overview column has an inset and no second white box; settings accent buttons use `--ot-on-accent` instead of white (dark-theme hover contrast); the about skip link keeps light colours on the about page (the `#097845` on `#89d5b5` report).
- **Density pass:** group-agent tools are one centred collapsible line instead of a card in a card; a message with no reactions no longer grows a row for the hover “+😊”; discover card actions are a quiet footer without the duplicate like count; profile header follows 08b (stats row under the avatar, flat tabs, empty line in the upper third, action icons inside the column).

Wired in this pass: media attach shortcuts, `/space?new=` and `/automations?template=` deep links, public work previews. Still 未接通: image/video/music/3D creation, 调取, attachments in agent DMs, and everything listed in the earlier follow-ups.

Remaining visual gaps: per-message hover actions still sit in flow under the bubble (Teamily floats them); the new-document editor in space is plain; thumbnails are drawn from text, not rendered screenshots; connector marks remain original geometrics.

`impeccable detect` (v4.9.2) on this pass’s changed pages and styles (chat, memory, discover, artifacts, settings, about, profile, automations, shell, thumb.mjs, rich.mjs): 2 findings, down from 11 in the previous pass. Both are nested-card reports for popovers that open inside a card (the session-pane compose menu and the composer’s +/attachment sheets) and were left as detector false positives. The onboarding page (not changed here) still has its pre-existing cramped-padding advisories.

## Functional parity pass 6 (2026-11-19)

This pass starts at `af18ab1a`, reads the existing private reference notes/images and
tracking issues #9/#14/#86/#90/#231/#243/#264, and combines interaction repairs with
real persistence. It is **not all-feature completion**, and no page is declared
accepted merely because CI renders it. Earlier follow-up sections are historical;
this section and `FUNCTIONAL_COMPLETION.md` describe the current boundaries.

| Surface / evidence | Implemented and locally exercised | Still different / unverified |
|---|---|---|
| Chat message hover and menu — 01b/01b2 | Reaction/overflow controls float outside the bubble; hidden legacy edit/pin/retract controls no longer reserve a row. Keyboard overflow entry and Shift-F10 open the same real menu. Editing, reactions, copy, pin, forwarding, selection and author-only retraction retain their existing APIs. | Reference shows an emoji-only hover affordance; our extra keyboard-accessible overflow entry is deliberate. Agent-conversation messages still have a different action surface. Translate / ask-AI / personal delete remain disabled, not simulated. |
| Save a social message — menu in 01b2 | A native dialog explains that **every workspace member can read the copy**, and retraction will not remove it. Explicit confirmation calls a membership-checked, revision-checked, idempotent save endpoint; it creates a versioned document and source record. Cancel sends nothing. Repeated saves return the same artifact. | Only text is copied, not attachments. The reference menu was captured without clicking this operation; its dialog and persistence semantics remain **unverified**. |
| In-conversation search — 01c1/01c2, functional defect #264 | Click/Enter/Space jumps to a loaded message, outlines it briefly, and supports both agent and social message IDs. A hit outside the loaded window explains the limitation without fake navigation. No-hit text is explicit. Closing/Escape restores the pre-search scroll position and entry focus. 390px capture has no horizontal overflow. | No automatic loading of older windows; resource/attachment search tabs and cross-resource thumbnails remain incomplete. Reference hit-click/close behavior was not recorded: **unverified**. |
| Group member operations — 10c/10d, #243 | Removing a group agent now asks in place; cancel sends nothing, confirm calls the existing API, and stale workspace/conversation state cannot issue the removal. #124's explicit selected-agent reply protocol is unchanged. | No captured removal operation; **unverified**. Group announcement, proactive agent policy, auto-translate, mute and A/V remain disabled. |
| Library document — 11d, 05c for editor language only | New/existing documents use a WYSIWYG surface backed by the same markdown/revision/version/export/share APIs. Headings/lists/quote/code/basic emphasis/rules, plain-text paste, source toggle, author/revision metadata and an in-toolbar save action. Untouched source stays byte-for-byte; duplicate concurrent submits are blocked and failures do not show success. Websites still edit HTML source. | 11d records only a plain document view, not rich editing. Rich toolbar operation parity is **unverified**. Supported markdown subset, no collaborative editing, image/table editing or server autosave; opens in place rather than a new tab. |
| Library bookmark — 11a–11c | Per-user, persistent favorite table/API; bookmark state survives reload and the 收藏 scope filters actual server flags. Authorization, CSRF, isolation and idempotency are tested. | Reference shows the icon but not its toggled result; interaction semantics **unverified**. This is separate from Discover public-work collections. |
| Cover fidelity — 11a / previous pass | Document covers preserve the first six actual block shapes (heading, list, code, quote, text), with bounded text; safe DOM rendering only. Other supported cover models remain content-derived. | Not real browser-rendered website/document screenshots. No reference for all populated work kinds; **unverified**. |
| Skill catalogue — no reference skill-library capture | Search is functional; pretend in-memory “已安装” toggles are removed. Install controls are disabled and say 未接通. | Real install/uninstall, skill files, execution and runtime loading are still missing. No claim of persistence or installation. |

### CI investigation (no reruns)

The original main screenshot run `44495861614` had three hard failures:

- `artifacts_document`: a real product race. `loadList()` accepted an older workspace
  response after the picker had moved to another workspace and could replace the
  populated list with an old empty list. A deterministic local delayed-response
  reproduction shows the seeded document missing before the change and present
  after. A generation + workspace check now rejects stale responses (also protects
  search requests). The original seeded-document assertion is retained.
- `runtimes_connect_key_prefix_only` / `runtimes_connect_daemon_after_key` (and soft
  `runtimes_connection`): fixture timing, not missing persistence. The page shows
  `main-panel` before asynchronous key/connection loading completes. Delaying the
  key response reproduces an empty list at panel visibility and the correct seeded
  key afterwards. The screenshot harness now waits on the actual key, connection
  and daemon state before applying the same assertions. No runtime backend changes.
- Management (3.11), run `44495861780`: its log says **476 tests OK**, then “The
  operation was canceled.” It is not evidence of a failing Python assertion; the
  cancellation initiator is unknown. No job was rerun and no product change is
  claimed to repair GitHub cancellation.

### Merge-gate follow-up recommendation

The body-only closing-keyword check misses closing references in older commits
newly entering main. Coordinate a separate gate patch to inspect **every commit in
base..head** (including merged-in commits) plus the PR body, and test mixed-case,
qualified repository references and multiline messages. Fail closed and require a
reviewed exact SHA. This pass neither modifies the shared gate nor rewrites history.

### Evidence and remaining capture needs

Private after-renders live outside the repository under
`2026-11-19-parity-functional6-after/`; targeted shots cover hover/menu, the sharing
warning, search jump/empty/narrow, rich/source document, favorites and honest skills.
Impeccable 4.9.2: two existing nested-card advisories for the compose popovers, plus
one pre-existing repeating-gradient advisory from the original avatar preview's
scanline texture (`look/app.css`). The customizer is unchanged; no new contrast or
cramped-padding finding on the document editor.

Small fresh reference needs (not performed here): (1) a disposable document while
editing a heading/list and after reload, (2) a disposable message's save-to-library
confirmation and resulting document, (3) a library bookmark toggled and 收藏 opened,
(4) search-hit click and close scroll behavior. These operations are not inferred
from static menu screenshots. All tracking/unverified issues remain open.

Initial local validation: 478 Python tests; 339 Node tests across all 26 CI-listed suites;
95 clean-fixture browser screenshots with zero hard/soft failures (including
heading-toolbar editing, source round-trip, saved-message API readback and bookmark
reload). Follow-up targeted chat/artifact tests cover final error-state/access
refinements. Compileall, JavaScript syntax, CLI help, whitespace and quick
secrets/assets/dependency/license review passed. Synthetic local evidence does not
verify real providers, production deployment or Teamily operation equivalence.

## Connected app tool execution (2026-11-19)

The per-user Composio settings flow now has a task-scoped tool broker and an
explicit one-shot approval area on the connectors page. Python FlyBot/zipapp and
container management task loops can feed discovered schemas to an OpenAI-style
model, submit immutable proposals, wait for owner approval and feed results back.
No Composio key is given to the runtime. This is functional in **synthetic/mock
tests only**, not real provider or Teamily parity acceptance. Group/automation/
gateway work and standalone DSH sessions do not receive personal-tool access.
The skill-library install control is now disabled by functional pass 6, not a real installed skill.
Full boundaries, user steps and remaining blockers: [CONNECTED_TOOLS.md](CONNECTED_TOOLS.md).

Ordinary main synchronization: `077cf231` (connected-tools #267) landed during
the first read-only gate and made the earlier head conflict. Both append-only
documentation sections were retained; product code merged without conflict.
Final integrated local validation: **490 Python tests, 344 Node tests in 26
suites, 95 browser screenshots with no hard/soft failures**. No CI job was rerun.

## Visible-functions aggregate, skills first (2026-11-19)

This corrects a real usability defect: the skills library previously had no execution lifecycle. It now has original actual content, persisted scoped bindings, supported-runtime handshake, digest-verified model-context loading and acknowledgement, plus real revocation. See [SKILLS](SKILLS.md) and the [complete visible-function execution inventory](VISIBLE_FUNCTIONS_INVENTORY.md). This is **instruction-skill functionality**, not a Teamily marketplace, executable package manager, or standalone DSH integration.

Other real flows added: private configured-model translate/ask-AI, revisioned group announcements, all-work-kind version-pinned chat send/forward, explicit saved-document/memory insertion, emoji insertion, real skills/tools navigation and persisted rendering preferences. These are not cosmetic enabled buttons or hardcoded model output. Existing #268 rich editor, message hover/search behavior, stale work-list response guard and daemon fixture readiness remain intact.

### Scene evidence boundary

Existing private reference notes and images remain `/workspace/flybot-workspace-review/2026-11-19-parity-capture/notes.md`: 01b/01b2 message hover/menu, 01c1/01c2 search, 10c/10d group information, 11a–11d works/list/menu/detail. Reference comparison is limited to those scenes. Skills lifecycle, translation/ask-AI dialog, announcement editor and their permission/error interactions have **no reference operation capture** and remain unverified for parity; no fresh browser dispatch was attempted. The new original dialogs preserve the shell rather than invent Teamily claims. True page-render thumbnails, full editor fidelity and unsupplied scenes remain gaps.

Private synthetic after evidence: `/workspace/flybot-workspace-review/2026-11-19-visible-functions-after/`. No screenshots, account data, Teamily icons/fonts/logos/prose or secrets are added to this PR. Impeccable 4.9.2 findings and local validation are recorded with the private evidence; CI screenshots are local app evidence only, not parity or real-vendor acceptance.

The prior main `af18ab1a` failure diagnosis and #268 corrections above are retained: artifacts were a real stale-response product race; runtime key-prefix/daemon scenes were fixture readiness/timing defects; cancelled management(3.11) was not proof of a product failure. No CI reruns or empty retrigger commits are used.

### Merge-gate keyword gap (recommendation only)

The gate's PR-body Related-only policy does not stop older commit messages from containing automatic issue-closing keywords. Recommend a separately coordinated gate change that inspects all proposed merge commit messages (with explicit allowlist/review policy for historical inherited text) and tests that issue auto-closure cannot bypass the intended tracking policy. This PR does not rewrite history, edit others' commits, close tracking issues, or change shared gate code. New commits and PR body use Related-only references.

### Local validation for this aggregate (not vendor/parity acceptance)

- 503 Python tests passed; all 27 management Node CI commands passed (372 tests). Additional runtime-image 23, web-slots 16, social-host 26, social-plugin 165 and upstream-pin 4 tests passed. Syntax/compile/CLI entry and diff checks passed. Shared merge-gate regressions: 13 passed; this is not an exact-head merge authorization.
- Final fresh synthetic browser run: **104 screenshots, zero hard or soft failures**, including skill install/reload → real daemon/model context receipt → uninstall, private assistance, announcement reload, resource/emoji draft insertion and dark-action contrast. Screenshots remain private in the `release/` subdirectory of the evidence path above.
- Impeccable **4.9.2** retained 13 static warnings: six contrast, three palette, two nested-card, one dark-glow and one stripe-gradient. They are not declared “all cleared.” Existing dark-theme/nested-shell heuristics require scene judgement. Follow-up actual computed normal/hover light/dark testing found and corrected unsafe new dark modal primary actions; final tested pairs were at least **5.55:1**. Expanded skill cards now align at the top and wrap content/digests at 390px. Full-scene pixel parity is still unverified.
- Local upstream/service suites were attempted without installs: upstream reported 605 passes / 173 failures, with missing esbuild/DSH/undici/transport modules and consequent gateway assertions (not assumed flaky); the TypeScript social service could not load `tsx` (388 failures). Those local runs are **not green**. No package installation, environment/proxy workaround, assertion weakening or vendor changes were made. CI's normal dependency setup and exact push/PR checks are still required; Docker/vendor builds were not claimed locally.
- Private evidence also records two local acceptance-test defects corrected before delivery: async browser predicates could treat a pending Promise as truthy before persisted runtime completion, and resource checks ran before the detail fetch completed. Semantic API polling and modal-close waits now assert actual outcomes. A genuine product race allowing late resource insertion after modal cancellation was fixed and covered by a negative test. These were local reproductions, not CI reruns.

Ordinary main sync incorporated contributor #307 at main `2e3e7de` (help/terms/privacy pages and real menu links); no competing implementation was added. The census now includes these landed surfaces. Earlier local counts above refer to the pre-sync baseline; exact-head validation and CI must include the newly landed docs suites.

Final scene review found a genuine new dark-dialog defect despite the primary-button contrast check: undefined generic surface variables fell back to white while text inherited the dark theme. Assistance/announcement/resource dialogs and document cards now use actual shared theme tokens. Browser regression additionally checks heading/label/helper-text contrast across all four new dialog surfaces; this is not a blanket dark-theme or Teamily parity certification.


## Skills/runtime usability follow-up (not Teamily parity)

Library structure/branding retained; a run-and-proof section below the catalogue adds actual readiness, isolated skill execution, reload-persistent result history, cancellation and explicit document saving. Automation scopes are an original functional extension. No skill-operation reference capture exists, so these scenes are **unverified against Teamily**, even when synthetic CI screenshots pass. CI screenshot acceptance now includes actual UI-run → digest receipt/result → reload → save → real rich editor; no manual account/browser operation or real-vendor claim. Runtime/member/cancellation defects are functional fixes, not cosmetic parity completion. Remaining static design warnings are retained in private Impeccable4.9.2 findings, not waived by CI.


### PR342 substantive repair checkpoint (not parity acceptance)

The first exact-head screenshot runs exposed a genuine HTTP400: the saved-result editor target existed in JavaScript but not the strict HTML query allowlist. The repair permits only a complete lowercase32hex workspace/artifact pair on `/space` and `/artifacts`; duplicate/extra/encoded/traversal/asset queries still fail. Raw HTTP plus restarted-session document reads cover successful navigation, unauthenticated/foreign-workspace/missing-record denial. UI screenshots must still prove actual editor text and uninstall after that step; a saved-document id is not whole-flow acceptance.

The enabled run primary now uses opaque white-on-green normal/hover states in both themes, rather than dark ink inherited from the shared dark gradient. CI measures actual computed contrast/background/opacity for all four states and captures the dark hover scene; no existing assertion or scan finding is suppressed. The result-document link stays together instead of wrapping in half.

Node22 annotation dismissal was a test-ordering defect reproduced with a controlled clock: the old5ms barrier can become due **before** the close timer scheduled after an awaited mock send. An owned, test-only loader overlays only that helper with a causal microtask-then-zero-timer barrier, never a longer sleep. All vendor test bodies/assertions remain identical and the vendor bytes/pin remain unchanged; unexpected upstream source hashes fail closed. Independent tests retain normal/delayed send/dismiss/clear and failed-send cases. This is not an inference/privacy-isolation claim or permission to rerun an old CI job.

Management cancellation was independently diagnosed from its check annotation: `The job has exceeded the maximum execution time of 5m0s`. The full500+ Python cases and28 Node command lists remain required; the job has a bounded10m execution budget. No test is skipped, retried, or loosened. Actual Docker/build and exact-head CI results remain separate acceptance evidence.

The owner's expanded six-category scope is tracked in [FUNCTIONAL_COMPLETION_PLAN.md](FUNCTIONAL_COMPLETION_PLAN.md); none is silently dropped or treated as solely a credentials problem.


#### Cross-realm completion correction
The intermediate314a582 head passed all screenshot/management/build checks, including actual rich-editor opening, reload-persistent uninstall and all four enabled button contrasts (5.55:1 normal,6.69:1 hover), but its host-microtask clock overlay was insufficient for the component's **separate VM Promise realm**. Both Node22/24 still observed dismissal0. This is not treated as flakiness or rerun permission. The corrected owned fixture observes the actual `dismiss` or `reportError` callback and awaits that completion; unresolved sends cannot become completed, and no number of microtasks or milliseconds is assumed. Tests execute the real pinned async-send code in a VM, reproduce BOTH old helper failures and cover delayed/normal/error/pending sends. All original assertion bytes and vendor source remain intact; only test-bench completion/wait wiring changes. Exact-head first-run CI remains mandatory; no old job/head is rerun.

## Functional completion follow-on (t234u/t235u, evidence pending)
Adds actual registration/first-use, private imported instructions/version/revoke, authorised SSE invalidations with draft-aware revision controls, and typed Office/text-PDF downloads. CI scene definitions109–115 exercise real app pages and controlled runtime paths; images are not committed. No capture/contrast/parity success is claimed until exact-head CI artifacts are inspected. Existing342 scenes and race fixes remain. Full CRDT/Office editing, audio/video/media generation, semantic memory, executable/DSH/shared skills and other plan gaps remain.
