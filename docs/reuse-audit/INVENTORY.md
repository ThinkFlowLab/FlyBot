# 组件清单

状态用语：**已核实**（有固定公开修订与原文哈希或 npm 声明核对）、**待核**（尚未核到原文或闭包）、**禁止导入**、**有条件可适配**（独立出处，不并入本仓 MIT）、**局部阻塞**（只挡住该组件或该发行形态）。  
不得把「可能」写成已核实。钉扎见 [pins.json](pins.json)。

## A. 本仓库与候选运行时源码

本表在 #18 审计时撰写。「是否允许导入本仓」列已按 [PR #20](https://github.com/openTeamily/openTeamily/pull/20) / [PR #21](https://github.com/openTeamily/openTeamily/pull/21) 的实际导入更新；许可结论与待核项未当作已关闭。详见 [README.md](README.md)「导入后勘误」。

| 组件 | 来源 URL | 修订 / 版本 | 路径 | 许可证 | NOTICE / 归属 | 修改与再分发义务 | 是否允许导入本仓 | 阻塞与安全替代 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenTeamily 新材料 | https://github.com/openTeamily/openTeamily | `main` `@6144301a3ece15c708301ec233cd0a747bb5b294`（本审计开始时的公开主干） | 本仓新写文档与代码 | MIT（本仓 `LICENSE`） | Copyright (c) 2026 OpenTeamily contributors | 按 MIT 保留版权与许可声明 | 已是本仓内容 | 不覆盖上游 |
| FlyBot 仓库源码 | https://github.com/ThinkFlowLab/FlyBot （公开） | `main` `@e26895e737b1218875aafa1f74ab1d3464f287d2`（2026-11-16 00:07:14 UTC） | 仓库根；`LICENSE`、`NOTICE`、`core/`、`plugins/`、`Dockerfile` | Apache-2.0。`LICENSE` sha256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`；与 GitHub 官方 Apache-2.0 正文规范化换行后一致。根 `package.json` **无** `license` 字段且 `private: true`（已核实）。仓级 SPDX：Apache-2.0 | `NOTICE` sha256 `94f05bc42e635dee7082583c010dc13fb084b1ed9cdcfed6b9e5246c763027ca`：DS Bot, Copyright 2026 Fei2411 and the DS Bot contributors | 保留 LICENSE 与 NOTICE；标明修改文件；不得再许可为 MIT；NOTICE 中的想法来源（含 AGPL 的 obelisk）声明为「未复制代码」，本次**未**做代码同源核实（待核，不作为已复制或未复制的相反结论） | **#20 已按需导入定制层**到 `runtime/flybot/`（保留 Apache-2.0 LICENSE/NOTICE；不含 `core/`、未选插件与品牌图）。不得改标为本仓 MIT | 有条件已导入。安全替代仍适用于未导入部分与完整容器再分发 |
| DS Bot / `ds-bot/` 与 `core/` | https://github.com/Fei2411/DS-Bot （公开；`ds-bot.pin.json` 写为 Fei2411/DeepSeek-Bot，GitHub 解析到 DS-Bot） | 钉扎 `@2b10c70b614e969117b68ddc6fd14e68968272f2` | FlyBot 的 `ds-bot/`、`core/LICENSE`、`ds-bot/LICENSE` | Apache-2.0。`package.json` `license: Apache-2.0`。`LICENSE` git blob `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64` 与 DS-Bot 及 FlyBot 根 LICENSE **相同**（已核实） | 同上 NOTICE（blob 亦相同） | 同 FlyBot；`ds-bot/` 应按钉扎保持与上游树一致，变更走 `patches/` | **#21 已将 v0.3.6（`a66cc737…`）未修改副本放入** `runtime/ds-bot-upstream/`，不得并入本仓 MIT。历史钉扎 `2b10c70` 的 core 分叉未导入。v0.3.6 `NOTICE` 已更新（见勘误）。当前钉扎为 v0.3.10（`d104d9ca…`）；NOTICE 与 v0.3.9 一致 | 运行时基线已导入；DSH 0.2.2-rc.1 再分发义务仍待核 |
| `@flybot/project` `@flybot/timeline` `@flybot/social` `@flybot/tree` `@flybot/workflow` | 同上 FlyBot 仓 | 同上 `main` 钉扎 | `plugins/*/package.json` | 字段均为 `Apache-2.0`。**无独立 LICENSE 文件**（已核实）。`social` / `timeline` / `workflow` 另有 `private: true` | 受根 NOTICE 约束 | 不得仅凭字段拆包再许可；再分发须带根 LICENSE/NOTICE | **`plugins/social` 已随 #20 导入**；Project / Timeline / tree / workflow 仍未导入，许可上未禁止日后可选适配 | 产品建议（非用户决定、非删除需求）：Project 不默认核心；Timeline 默认关闭运维选件。先修静态风险再谈复用 |
| Bot Social | https://github.com/Birfy/bot-social （公开） | `master` `@8706824f53f6cce8212470bc6b442f7271cccd3e`（2026-11-16 07:41:41 UTC） | 仓库根 `LICENSE`、`package.json` | MIT，Copyright (c) 2026 Birfy。LICENSE sha256 `6f5b168b7397507ec7854d3787079ae4185826ea0a9ade831a269fabe3e737c3`。`package.json` `license: MIT`，`private: true` | 无独立 NOTICE；版权在 LICENSE | 保留版权与 MIT 声明；不得改标为本仓原创 | **#20 已按需导入到** `services/bot-social/`，保留 MIT 与版权；不得改标为本仓原创 | 非必选第三服务。安全替代：管理面 + 多运行实例完成协作 |
| 无许可证的控制面实现 | https://github.com/Birfy/flybot-control-plane （公开） | 默认分支 `main` 树（审计时根树 sha `0369a2e0007cd4ca75474c049e7fe57da1f313a6`） | 仓库根 | **未发现 LICENSE/NOTICE**；GitHub 许可字段为空（已核实「没有许可文件」，不是已授权） | 无 | 再分发权未确立 | **禁止导入** | 按本仓契约重写同类能力 |

公开但不在默认分支上的 FlyBot 提交 `@1969402ce66384281f927b207a298f64541da4c4`：其 `LICENSE`、`NOTICE`、`package.json`、`Dockerfile` 的 sha256 与上述 `main` 钉扎**相同**（已核实）。若将来改用该提交，仍须对其余文件重核。

## B. FlyBot / Bot Social 锁文件中的第三方 npm 依赖

范围：FlyBot `@e26895e` 的 `core/package-lock.json`、`ds-bot/package-lock.json`，以及 Bot Social `@8706824` 的 `package-lock.json`。对这些条目：锁文件已写 `license` 的直接采用；未写的已按 **name@version** 查询 npm 注册表（174 条全部返回声明，0 失败）。

| 集合 | 已声明 / 已查询到的许可 | 复制左或专有 | 结论 |
| --- | --- | --- | --- |
| FlyBot `core` 运行时直接依赖 `@larksuiteoapi/node-sdk@1.76.0` | npm 与锁文件均为 MIT；仓库 https://github.com/larksuite/node-sdk | 未发现 | 有条件随 FlyBot 再分发，保留其 MIT 声明。飞书连接器仍须产品与安全评审，但这是许可之外的问题 |
| FlyBot `core` / `ds-bot` 开发依赖 `esbuild@0.28.2` 及平台可选包 | 锁文件 MIT | 未发现 | 构建工具；NOTICE 亦写明 esbuild 仅构建期使用 |
| FlyBot 根开发依赖 `jpeg-js@0.4.4`、`jsqr@1.4.0`、`pngjs@7.0.0` | npm：BSD-3-Clause、Apache-2.0、MIT（已核实） | 未发现 | 测试/开发期 |
| 上述三份锁文件中的其余唯一包（约 253 个 name@version） | MIT、Apache-2.0、ISC、BSD-2-Clause、BSD-3-Clause，以及 `(MIT OR WTFPL)`、`(BSD-2-Clause OR MIT OR Apache-2.0)` | **未见** GPL、AGPL、LGPL、SSPL、BUSL、专有或 UNLICENSED 声明 | 就**这些锁文件范围**而言，未发现需局部 copyleft 阻塞的声明。这**不是** DSH 运行时树的结论 |

## C. DeepSeek Harness（运行宿主）与镜像构建

| 组件 | 来源 URL | 修订 / 版本 | 路径 | 许可证 | NOTICE / 归属 | 修改与再分发义务 | 是否允许导入本仓 | 阻塞与安全替代 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DeepSeek Harness 源码 | https://github.com/deepseek-ai/deepseek-harness （公开） | 标签 `dsh-v0.2.1-rc.2` `@687f282e8625c6b8d11ff58211a90524be2e4317` | `LICENSE`、`apps/cli/package.json` | MIT，Copyright (c) 2026 DeepSeek。LICENSE sha256 `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be`。`@deepseek-ai/dsh` 该版本 `package.json` `license: MIT` | `THIRD_PARTY_NOTICES.md` sha256 `aeea7aa256ede5349cc7903f56a859d54f10b82a45fba7dcce667eb69916dab0`（生成文件，列出直接运行时依赖与部分载荷） | 保留 MIT 版权与许可；再分发二进制/镜像须同时处理下方局部项 | 不把 DSH 源码并入本仓 MIT 树 | 有条件：作 FlyBot 容器宿主，不改许可 |
| npm `@deepseek-ai/dsh@0.2.1-rc.2` | https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.2.tgz | 0.2.1-rc.2（预发布标签） | npm 包 | 注册表声明 MIT（已核实） | 同上仓库通知 | integrity `sha512-tvY+yhfKRifthbqPe/OK0AYxM5ZkvqfYq/jMYgJcEUxiRRL1Vwra3Ti5TB6AXgSWQdiPHYh/Vp6SJa9yHwMNuw==` 已记录。**`gitHead` 未出现在注册表元数据中**，与 git 标签的字节对应**待核** | 不把 tarball 导入本仓 git | 局部待核：发布镜像前核实包与标签一致 |
| `pnpm@10.34.6` | https://www.npmjs.com/package/pnpm/v/10.34.6 | 10.34.6（FlyBot Dockerfile 钉扎） | 全局安装 | npm 声明 MIT（已核实） | 保留 MIT | 构建/插件管理工具 | 不需要拷入本仓 | 无许可阻塞 |
| `@deepseek-ai/libreoffice-kit`（经由 `@deepseek-ai/dsh-skill-office@0.2.1-rc.2`） | DSH 通知指向 https://github.com/deepseek-ai/dsh-libreoffice-kit | CLI `@deepseek-ai/dsh@0.2.1-rc.2` **直接依赖** `dsh-skill-office`，后者**直接依赖** `libreoffice-kit ^0.1.5`（已对 npm 包声明核实） | 随默认 `npm install -g @deepseek-ai/dsh@0.2.1-rc.2` 进入 | DSH 通知声明 **MPL-2.0**（源码义务） | 通知要求保留引擎与 Node API 的许可证和 NOTICE，并向接收者提供对应源码 | 默认官方 Dockerfile 路径会带入 | **局部阻塞**镜像再分发，直到提供 MPL 对应源码与通知，或在构建中明确排除 office 技能 | 安全替代：排除该组件的精简运行时；或履行 MPL 义务后再发布镜像 |
| Montserrat 字体 | DSH `packages/client/ui-theme/src/styles/` | 同标签 `dsh-v0.2.1-rc.2` | `montserrat-*.woff2` + `Montserrat-OFL.txt`（4400 字节，blob `3344bfd4619241f1a83f6431cb8e5c16ce57d2f2`） | **SIL Open Font License 1.1**（已读 OFL 文本：Copyright 2024 The Montserrat.Git Project Authors） | 必须随字体保留 OFL 文本 | 可随软件捆绑；不得单独出售字体；不得把字体改到其他许可证；注意保留名称限制 | 不把字体改标为 MIT，也不单独拷进本仓冒充原创 | 再分发 `dsh web` UI 时保留 OFL。FlyBot 自身树在钉扎修订中**没有** woff/ttf（已检索路径，已核实） |
| KaTeX 字体 | DSH 通知列出 `katex` 为 MIT；Web 构建脚本引用 `node_modules/katex/dist` 的 WOFF2 | 随 DSH Web/Desktop 构建 | npm `katex` 包内字体 | 包声明 MIT 已核实；**字体附属许可文件未逐一打开**（待核） | 待核 | 发布含公式渲染的 UI 前补核 | 待核，局部 | 安全替代：发布说明中附带 katex 官方字体许可，或确认不发行该 UI 资产 |
| `@anthropic-ai/claude-agent-sdk` 与官方 Claude Code 载荷 | DSH `THIRD_PARTY_NOTICES.md`「Official Claude Code platform payloads」 | 通知记载 SDK 0.3.263 及平台包「SEE LICENSE IN LICENSE.md」；npm 最新包头亦为 “SEE LICENSE IN README.md”（这是注册表**当前**版本，不一定是 DSH 钉扎版本） | 可选平台二进制 | **非宽松、条款未在本次阅读**（待核） | 通知写明项目方授权分发但不把条款归类为宽松许可 | 不得在未核条款时再分发这些载荷 | **局部阻塞**（仅当发行包含该 SDK/载荷时） | 在 `@deepseek-ai/dsh@0.2.1-rc.2` 的 86 个直接依赖包的直接依赖中**未发现**该 SDK（已核实）。是否更深层传递或默认安装拉入：**待核**。安全替代：确认默认镜像不含这些可选依赖，或取得/遵守其条款后再发行 |
| `dompurify` | DSH 运行时通知 | 通知所列 | npm | `(MPL-2.0 OR Apache-2.0)`（已按通知记录） | 可选 Apache-2.0 | 若再分发，按所选许可证保留声明 | 不单独导入本仓 | 可选 Apache-2.0，不构成项目级阻塞 |
| `eslint-plugin-sonarjs`、`lightningcss` | DSH 通知「Development-only」节 | 同标签 | 开发工具 | LGPL-3.0-only、MPL-2.0 | 通知写明**只作开发工具，不链入、不随 Harness 制品分发** | 若只按该声明使用，不进入运行镜像 | 不以开发工具许可否定运行时 | 已记录声明；本次未独立验证制品中确实不包含它们（待核，但不把通知改写成反证） |
| DSH 完整传递闭包、Python wheels 内原生库、Landlock 启动器等 | `pnpm-lock.yaml`、`python/sdk/uv.lock`、通知第 10–11、284 行 | 同标签 | 锁文件 | 通知声明直接依赖为主；**完整闭包未在本次独立展开** | 待核 | 发布完整 DSH 发行前应运行其 `pnpm licenses list` 并归档 | 待核 | 局部待核，不阻止自写基板 |
| `node:24-bookworm-slim` + `git` + `ca-certificates` + `tini` | Docker Official Images / Debian | FlyBot Dockerfile 默认 `NODE_IMAGE=node:24-bookworm-slim` | 镜像层 | 混合：Node 发行与 Debian 包各有许可证；`git` 为 GPL-2.0。本次**未**枚举镜像内 `/usr/share/doc/*/copyright`（待核） | 发布镜像通常需附版权清单，并对 GPL 组件提供对应源码或书面要约 | **局部阻塞**「发布」该镜像，不阻塞开发与仅本地自用 | 安全替代：发布前生成镜像版权清单与源码要约；或只分发不含这些系统包的精简构建说明 |

FlyBot 官方 Dockerfile 原文写明没有已发布的现成镜像、密钥不打进镜像。因此「复用 FlyBot 容器」在当前是指**按该 Dockerfile 自构建**，不是拉取一个已审计的官方发行摘要。

## D. 品牌、字体与其它资产

| 组件 | 来源 | 修订 | 路径 | 许可证 | 结论 |
| --- | --- | --- | --- | --- | --- |
| FlyBot 文档 logo、演示图、微信群二维码 | ThinkFlowLab/FlyBot `@e26895e` | 同上 | `docs/images/*`、`docs/assets/wechat-group.png`（已列出 22 个图像资产，无字体文件） | 作为仓内文件，源码许可为 Apache-2.0；**商标使用权待核** | 不要导入本仓；不要当作 Teamily 或 OpenTeamily 品牌资产 |
| Bot Social 文档 banner/logo SVG 与界面截图 | Birfy/bot-social `@8706824` | 同上 | `docs/assets/banner.svg`、`logo.svg`、若干 PNG | 仓为 MIT；**商标待核** | 不要把标识当作本仓品牌 |
| Teamily 商标、字体、法律文本 | 非本项目 | — | — | 专有，禁止复制 | 保持现状：不导入 |

## E. 与 issue #3 验收的对照

- 书面清单已覆盖 FlyBot（Apache-2.0 + NOTICE）、Bot Social（MIT）、DSH 宿主与镜像构建边界、插件字段、无许可证控制面，以及 Project / Timeline 的静态风险与「先修后复用」。#20 / #21 之后：FlyBot 定制层、Bot Social 必要集与未修改的 DS-Bot v0.3.6 已按原许可进入本仓；Project / Timeline 仍未复制。
- 「允许以适配器接入 / 必须干净重写 / 暂不引入」：已导入的树必须保持独立出处、不得改标 MIT；控制面必须干净重写；DSH+镜像在补齐局部义务前**暂不作为已完成的可再分发行**；自写基板可继续。
- #18 合入时本目录只含新写清单、钉扎哈希与校验脚本。其后 #20 / #21 按需导入了有出处记录的上游树；DSH 0.2.2-rc.1 传递依赖与 v0.3.6 NOTICE 新增声明仍待核。
- 因仍有待核项，**不能**把 #3 标为已完成，也不得关闭 #1。
