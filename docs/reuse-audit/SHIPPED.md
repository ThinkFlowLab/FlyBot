# 已交付修订的来源与许可清单

审计日期：2026-11-16（Asia/Shanghai）。  
NOTICE 的文件内容和哈希与 v0.3.9 一致。

对照提交：`openTeamily/openTeamily` `origin/main` `e67e712f9f8389f842c33d204e6c6e6a0014df73`，外加本目录本次新增的清单与根 `NOTICE`。  
本文件是对**当前仓库实际交付内容**和**运行时镜像配方会安装的组件**的书面清单，不是法律意见，也不构成再分发授权。根 MIT **不**覆盖导入树，也**不**覆盖镜像配方在构建时从 npm / Debian 拉入的第三方包。相关跟踪仍保持开放：issue 1、issue 3、issue 5。在下文「发布前的阻塞项」解决之前，**不得**把本仓镜像配方宣称为已审计的可再分发公开发行物。

机器可读钉扎见 [shipped-pins.json](shipped-pins.json)。#18 对既有来源的审计记录仍在 [README.md](README.md) 与 [pins.json](pins.json)；本文件不追溯改写那些结论。Project / Timeline 的静态风险仍以 #18 记录为准，这两个插件**未被导入**；若日后复用须先修那些风险。

方法：只读本仓库已提交文件、公开 npm 注册表元数据，以及通过 GitHub 读取的 `deepseek-ai/deepseek-harness` 标签 `dsh-v0.2.2-rc.1`（提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）上的 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和 `Montserrat-OFL.txt`。未执行本机 `npm install`，也未在本文件中内嵌构建成品清单。源码侧记录仍以仓库文件和公开注册表为准。CI 的 FlyBot runtime image 作业会在已经构建的 `openteamily-flybot:test` 上运行 `runtime/flybot-image/inventory/collect.mjs`，并把实际安装闭包、Debian 版权哈希与 deb-src 指针、Claude/Anthropic 扫描、字体/OFL 文本以及 `/opt/licenses` 中的 NOTICE 与归属文件作为 `flybot-runtime-image-license-inventory` artifact 上传（不推送镜像）。该 artifact 才是对应构建的现场清单；本文件不是它的替身。npm 的 `license` 字段不能代替逐文件阅读上游 LICENSE。

## 1. 本仓库内的许可文本

| 路径 | 许可 | sha256 | 字节 |
| --- | --- | --- | --- |
| [`LICENSE`](../../LICENSE)（仅覆盖新撰写的 OpenTeamily 材料） | MIT，Copyright (c) 2026 OpenTeamily contributors | `096841e8f7eceada5cbb435b01e60cedc2b458717c2065131ad64e1d7bebad6a` | 1081 |
| [`NOTICE`](../../NOTICE)（根说明，指向下列树与镜像义务） | 说明文件 | 以仓库当前文件为准 | — |
| [`runtime/flybot/LICENSE`](../../runtime/flybot/LICENSE) + [`NOTICE`](../../runtime/flybot/NOTICE) | Apache-2.0 + NOTICE | LICENSE `c71d239d…0ab4`（11357）；NOTICE `94f05bc4…27ca`（3835） | 与 #18 ThinkFlowLab/FlyBot `@e26895e7` 记录一致 |
| [`runtime/ds-bot-upstream/LICENSE`](../../runtime/ds-bot-upstream/LICENSE) + [`NOTICE`](../../runtime/ds-bot-upstream/NOTICE) | Apache-2.0 + NOTICE；未修改的 Fei2411/DS-Bot v0.3.10（`d104d9ca18d69a35460f14e15dff4d553181433a`） | LICENSE 与上项相同；NOTICE `7183b18ec5bd153cb7b207c0c0d8c9c8d83dc5f0add15c116f13027b5dd95050`（15883） | 与 v0.3.9 使用同一 NOTICE 文件。 |
| [`services/bot-social/LICENSE`](../../services/bot-social/LICENSE) | MIT，Copyright (c) 2026 Birfy | `6f5b168b7397507ec7854d3787079ae4185826ea0a9ade831a269fabe3e737c3` | 1062 |

新撰写且声明 MIT 的运行时包：`runtime/flybot-image`、`runtime/flybot-image/plugin`、`runtime/flybot-social-host`、`runtime/flybot-web-slots`、`runtime/flybot-web-slots/social-web`（均 `license: MIT`）。`manager/compose-planner/package.json` 没有 `license` 字段，按根 MIT 覆盖的新撰写材料处理，除非日后证明另有来源。`ORIGIN.md` / `OPENTEAMILY.md` / `UPSTREAM.md` 是 OpenTeamily 文档覆层，适用根 MIT，不改变相邻上游文件的许可。

管理面（`openteamily/`）为 Python 3 标准库实现，本仓库没有 Python 第三方 `requirements` 锁。CI 使用钉扎的 GitHub Actions：`actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803`（v6）、`actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`（v4.4.0）以及部分工作流中的 `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1`（v7.1.0）、`actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1`（v6）、`actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9`（v7.0.2，仅用于上传镜像许可清单 artifact）。这些是 CI 用软件，不是运行时镜像内容。

未获许可的 [Birfy/flybot-control-plane](https://github.com/Birfy/flybot-control-plane) **仍禁止导入**（根目录无 LICENSE）。商标与品牌资产仍待核，不得把 Teamily 专有资产或未核商标的标识导入本仓。

## 2. 已纳入仓库的 npm 锁（会随 `npm ci` 进入镜像或服务）

这些锁文件在仓库中；`node_modules` 不在仓库中。许可结论如下。

### `runtime/ds-bot-upstream/ds-bot/package-lock.json`

锁版本 3，93 个包，**全部带有** `license` 字段：MIT 77、Apache-2.0 4、BSD-2-Clause 5、BSD-3-Clause 2、ISC 3、MIT-0 1、`(MIT OR EUPL-1.1+)` 1。未见 GPL / AGPL / MPL。

双许可项：`@zone-eu/mailsplit@5.4.29` 声明 `(MIT OR EUPL-1.1+)`，integrity `sha512-CCUNycmUjrV5M0wNf23waWAt9eOHczhjLbUQS7k0FNJvR0py9VSqHFt+tSl/D0+XI73VLG0U+PwYtq9R0zsm9Q==`。再分发者可以选择 MIT；本清单不把它写成「仅 MIT」。

`runtime/ds-bot-upstream/link/package-lock.json`：16 个包，MIT 15、Apache-2.0 1，无缺失字段，未见 copyleft。

### `services/bot-social/package-lock.json`

锁版本 3，227 个条目、223 个唯一 `name@version`。该锁**本身没有** `license` 字段。2026-11-16 按唯一版本向 `registry.npmjs.org` 查询声明许可，结果：MIT 178、Apache-2.0 24、ISC 12、BSD-3-Clause 6、BSD-2-Clause 1、`(MIT OR WTFPL)` 1（`expand-template@2.0.3`）、`(BSD-2-Clause OR MIT OR Apache-2.0)` 1（`rc@1.2.8`）。无查询失败，未见 GPL / AGPL / MPL / “SEE LICENSE”。这是注册表字段，不是对每个包 LICENSE 文件的逐一阅读。完整表在 `shipped-pins.json`。

Bot Social 是可选适配，不是架构必选第三服务。

## 3. 运行时镜像配方会安装、但未全部钉在本仓中的组件

配方：[`runtime/flybot-image/Dockerfile`](../../runtime/flybot-image/Dockerfile)。基础镜像 `node:24-bookworm-slim`。构建阶段安装 `python3`、`make`、`g++`；运行阶段安装 `ca-certificates`、`git`、`curl`。然后全局安装 `@deepseek-ai/dsh@0.2.2-rc.1`，在已供应商的 ds-bot 树上执行 `npm ci`，并再安装 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-web`（均为 `0.2.2-rc.1`）。配方还允许若干原生包的 install scripts（含 `node-pty`、`koffi`、`@google/genai` 等）；`@google/genai` **不是** `@deepseek-ai/dsh@0.2.2-rc.1` 的生产直接依赖，它是否进入默认安装闭包未在本次用锁展开证明。

### 3.1 `@deepseek-ai/dsh@0.2.2-rc.1`

| 项 | 记录 |
| --- | --- |
| npm 声明许可 | MIT |
| tarball | https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-rc.1.tgz |
| integrity | `sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==` |
| shasum | `95d1cf510061a57c97b4a68d43336658bcec6af1` |
| 注册表 `gitHead` | **无** |
| 对应 git 标签 | `dsh-v0.2.2-rc.1` → 提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`（2026-11-04T07:54:45Z） |
| tarball 与 git 标签的字节对应 | **未核实** |
| 该标签上 `LICENSE` | sha256 `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be`（1065 字节），与 #18 所核 `dsh-v0.2.1-rc.2` 的 LICENSE 相同 |
| 该标签上 `THIRD_PARTY_NOTICES.md` | sha256 `4bd8832885ca31daf3e480fb950b9e849446438c0089b05fab67d6c2673fa2ef`（26763 字节），**不同于** #18 的 `aeea7aa2…`（25003 字节） |
| 该标签上 `Montserrat-OFL.txt` | sha256 `861d64229728cd65a98d119612c12769582574d1a092f0b63c8b0fd474e7065f`（4400 字节），SIL Open Font License 1.1。若再分发包含该字体的 UI，须保留 OFL 文本，不得改许可，也不得单独出售字体。字体文件是否进入默认镜像，以对应 CI 构建上传的 `flybot-runtime-image-license-inventory` artifact 为准，不在本文件内嵌现场清单。 |

该 CLI 包有 **90** 个生产直接依赖。向 npm 查询后，这 90 个在已声明的确切版本或（8 个范围声明的）满足范围的候选版本上，**全部声明 MIT**。8 个范围为：`@deepseek-ai/cordis@~4.1.0`（候选 4.1.0）、`cordis-plugin-include@~1.1.0`、`cordis-plugin-loader@~1.1.0`、`cordis-plugin-timer@~1.2.0`、`schemastery@~3.19.0`、`commander@^15.0.0`（候选 15.1.0）、`js-yaml@^4.3.2`（候选 4.3.2，不是 5.x）、`node-addon-require-builtin@^0.1.9`（候选 0.1.9）。这些候选是 2026-11-16 注册表上满足范围的版本，**不是**锁文件钉扎。完整表见 `shipped-pins.json`。已解析的 `@deepseek-ai/*@0.2.2-rc.1` 包同样没有 `gitHead`。

### 3.2 MPL-2.0：`@deepseek-ai/libreoffice-kit`（发布阻塞）

`@deepseek-ai/dsh-skill-office@0.2.2-rc.1`（MIT）是上述 90 个生产直接依赖之一，并依赖 `@deepseek-ai/libreoffice-kit@^0.1.5`。`^0.1.5` 的候选版本 `0.1.5` 声明 **MPL-2.0**，integrity `sha512-H12xtUsAyl70zFeQ5pk5GGRc3N1+6zn+DVAcqwlguI6EvqopBGP3xkUmePU7g5f6ydYlDZLWedHT9lTSL7zLxA==`。其直接依赖为 `koffi@3.1.1`、`saxes@6.0.0`、`fflate@0.8.2`、`fontkit@2.0.4`（`fontkit` 声明 MIT）。注册表上另有 `0.2.3`（亦为 MPL-2.0），但不在 `^0.1.5` 范围内。

DSH `dsh-v0.2.2-rc.1` 的 `THIRD_PARTY_NOTICES.md` 写明该 kit 及其平台包声明 MPL-2.0，且「Recipients must have access to those corresponding sources and notices。」默认执行配方中的 `npm install -g @deepseek-ai/dsh@0.2.2-rc.1` 就会经由 office 技能带入该组件。本仓库**保留**该办公转换能力，不借排除组件来回避义务。已在 [`runtime/third_party/libreoffice-kit/`](../../runtime/third_party/libreoffice-kit/) 放入 0.1.5 入口包的完整 npm 内容（含经验证的 MPL-2.0 `LICENSE` 与 `NOTICE` 文本），以及 Linux 可选引擎 `@deepseek-ai/libreoffice-kit-wasm@0.1.5` 包内自带的 `licenses/` 与 `sources/`（含 LibreOffice/core 修订 `bce0998afefdbc355585ca324285661a2170ba77` 的声明）。未把 `soffice.wasm` 等引擎二进制纳入本仓。公开 git 默认分支目前是 0.1.3，**未找到** 0.1.5 的公开标签或提交，因此该确切修订的 TypeScript 首选形式尚未钉到公开 git 对象。本要约是否满足 MPL 对再分发镜像的要求，属于**尚未作出的法律解释**。在该点以及清单中其余未知项解决之前，仍不得把运行时镜像称为可再分发的公开发行物。

### 3.3 Claude / Anthropic 载荷（以 CI 构建成品扫描为准）

`@anthropic-ai/claude-agent-sdk` **不是** `@deepseek-ai/dsh@0.2.2-rc.1` 的生产直接依赖。CLI 包的 `devDependencies` 含 `@deepseek-ai/dsh-hooks-claude-code@0.2.2-rc.1`（声明 MIT，其直接依赖只有 `schemastery`）。按通常的 `npm install -g` 行为，devDependencies 不会被安装，但这不是对完整闭包的证明。

同一标签的 `THIRD_PARTY_NOTICES.md` 仍列出官方 `@anthropic-ai/claude-agent-sdk`（声明 “SEE LICENSE IN README.md”）及其 0.3.263 平台可选包（声明 “SEE LICENSE IN LICENSE.md”），并写明这套条款不被当作宽松许可。

#56 构建成品扫描在已安装的 npm 树中**没有**找到 `claude-agent-sdk` 或官方 Claude Code 平台包。扫描到的是 `@anthropic-ai/sdk@0.129.0`，`package.json` 声明 MIT，镜像内 `LICENSE` 为标准 MIT 授权（Copyright 2023 Anthropic, PBC），sha256 `8bf96984ff8bcfae7e48cae76a529e8a25317ba9e02abf7fd3cc64fdf95657a6`（1056 字节）。该文本已放入 [`runtime/third_party/anthropic-sdk/`](../../runtime/third_party/anthropic-sdk/)，并由镜像配方拷到 `/opt/licenses/anthropic-sdk/`。这是该 SDK 的 MIT 文本，**不是**官方 Claude Code / agent-sdk 条款，二者不得混为一谈。扫描只覆盖当时镜像中的 npm 树，不能证明启动后不会再下载其它载荷。现场结论仍以对应构建的 CI artifact 为准。

### 3.4 构建成品现场清单（CI artifact）

收集程序见 [`runtime/flybot-image/inventory/`](../../runtime/flybot-image/inventory/)。单元测试用夹具离线运行，不依赖 Docker，也不在本机执行 `npm install`。CI 在已有的镜像构建作业中对 `openteamily-flybot:test` 收集并上传 artifact，不发布镜像。

下载对应构建的 `flybot-runtime-image-license-inventory` 后，可以核对：全局 DSH、ds-bot 前缀和 web profile 的已安装 npm 闭包与声明许可、Debian 包版权文件哈希与 deb-src 指针、Claude/Anthropic 扫描结果、字体与 OFL/附属文本，以及 `/opt/licenses` 中的 NOTICE 与商标字样出现记录。这是合规收集任务，不是法律解释，也不是公开发行授权。

### 3.5 依据 #56 artifact 已做的通知与源码收集（仍非法律结论）

- **KaTeX 字体：** #56 镜像在 `@deepseek-ai/dsh-web-frontend@0.2.2-rc.1` 的 `dist/assets/fonts/` 中有 19 个 `KaTeX_*.woff2`，当时旁边没有 KaTeX 许可文本（同目录已有 `Montserrat-OFL.txt`，sha256 `861d64229728…7065f`，与 DSH 标签钉扎一致）。这些 woff2 与 `katex@0.18.7`（以及抽查的 `katex@0.16.47`）包内字体字节相同。`katex@0.18.7` 与 git 标签 `v0.18.7` 只随附 MIT `LICENSE`，没有 `OFL.txt`。本仓把该 MIT 文本放在 [`runtime/third_party/font-notices/katex/`](../../runtime/third_party/font-notices/katex/)，镜像配方会把它拷到 `/opt/licenses/font-notices/katex/` 以及含有 `KaTeX_*.woff2` 的目录（`KaTeX-LICENSE.txt`）。本仓不内嵌字体二进制。是否另有 SIL OFL 适用于更早祖先字体，此处不作结论。
- **sharp-libvips：** 镜像含 `@img/sharp-libvips-linux-x64@1.3.4`（声明 LGPL-3.0-or-later）。其 npm tarball **没有** LICENSE / THIRD-PARTY-NOTICES 文件。通知、LGPL-2.1 / LGPL-3 文本、版本表和 libvips 8.18.7 源码指针见 [`runtime/third_party/sharp-libvips/`](../../runtime/third_party/sharp-libvips/)。公式配方把它们拷到 `/opt/licenses/sharp-libvips/` 和该 npm 包目录；清单收集器会按包内路径把这些通知记入 `license_files`，并由 `--expect-image` 校验。`.so` 不纳入本仓。`build/posix.sh` 在 npm `gitHead` `ebb95f8…` 上对 LGPL 组件和 cairo 1.18.6 使用的确切下载 URL 见 [`CORRESPONDING-SOURCE.md`](../../runtime/third_party/sharp-libvips/CORRESPONDING-SOURCE.md)。本仓只核验了 libvips 8.18.7 tarball 的 sha256；其余 tarball/补丁哈希与 `.so` 的可复现对应仍明确未核实。这些指针是否构成充分对应源码或 MPL 要约，属于法律解释。
- **Playwright Codicon：** #60 镜像中 3 个 `codicon*.ttf`（sha256 `0f1d5219…2889c9`，80340 字节）与 `playwright-core@1.64.1` npm 包及 git 标签 `v1.64.1`（`cfe490d941f992655948eee8fd4fd94e1c4234bf`）里 `packages/web/src/third_party/vscode/codicon.ttf` 字节相同。该目录唯一的许可文件是 MIT `LICENSE.txt`（1087 字节，sha256 `20535828…de54`，Copyright 2015-present Microsoft Corporation）。npm 包在字体旁没有这份文本。本仓把它放在 [`runtime/third_party/font-notices/codicon/`](../../runtime/third_party/font-notices/codicon/)，配方会拷到 `/opt/licenses/font-notices/codicon/` 以及字体旁的 `Codicon-LICENSE.txt`。本仓不内嵌字体二进制。是否另有 vscode-codicons 的 Creative Commons 条款，此处不作结论（该修订的 Playwright 目录中没有这份文本）。
- **Debian：** `scripts/debian-source-offer.py` 根据现场 `inventory.json` 生成带有确切 `source_package=source_version` 的 `debian-source-offer.md`，并由 CI 随 artifact 上传。本仓仍不托管 Debian 源码。#56 构建为 bookworm，116 个二进制包；`git` 为 `1:2.39.5-0+deb12u3`。要约是否充分属于法律解释。
- **DS-Bot NOTICE：** 已对 v0.3.6 NOTICE 正文做归属审阅，见 [DS-BOT-NOTICE-REVIEW.md](DS-BOT-NOTICE-REVIEW.md)。这是对通知文件的阅读记录，不是对其中每个上游项目的许可结案。
- **DSH tarball 与 git 已编译 JS：** 仍然明确为未核实。没有 `gitHead`，也没有在本轮重现字节级对应；不编造已经对齐的结论。

### 3.6 仍待完成的审阅与解释

- LibreOffice kit 的 MPL 3.2/3.3 解释，以及 0.1.5 首选形式的公开 git 对象，仍然开放。
- sharp-libvips 中除 libvips 以外的 LGPL 组件，以及 cairo 的 MPL-1.1：构建脚本 URL 已按确切版本记录，但其余 tarball/补丁 sha256 与 `.so` 可复现对应仍未核实；要约是否充分仍然开放。
- Debian 源码要约是否充分，仍然开放。
- KaTeX 字体是否另受 OFL 约束，仍然开放（上游包本身未附 OFL 文本）。
- Playwright Codicon 已按 v1.64.1 源码目录中的 MIT `LICENSE.txt` 收集；是否另有 vscode-codicons CC 条款，仍然开放。
- 商标授权待核。

## 4. 建议动作

| 对象 | 建议 |
| --- | --- |
| 本仓新撰写材料、管理面、自写 stub | 可按根 MIT 再分发源码；保留根 LICENSE 与 NOTICE，并附带导入树的许可文本。 |
| 已导入的 FlyBot / DS-Bot / Bot Social 树 | 保持原许可与 NOTICE / 版权，不得改标为本仓 MIT。 |
| 自托管构建本镜像供自己运行 | 可以按配方构建；CI 已证明镜像能构建并启动。这不等于已取得公开发行授权。 |
| 公开发布预构建运行时镜像或其它发行物 | **先不要做。** 至少需要：对 LibreOffice kit 与 sharp-libvips（含 cairo MPL-1.1）的对应源码要约是否满足再分发镜像义务作出法律解释；判断 Debian 源码要约是否充分；按需完成 KaTeX 字体 OFL、Codicon 是否另有 CC 条款，以及商标审阅。`@anthropic-ai/sdk` 的 MIT 文本已经按镜像所载记录，不得写成 Claude Code 条款已核清。DSH 已编译 JS 的 tarball 与 git 对应仍明确未核实。办公与图像处理功能保留，不靠排除组件回避。 |
| Project / Timeline 插件 | 现在不复制；若复用须先修 #18 记录的静态风险。 |
| Birfy/flybot-control-plane | 禁止导入。 |

## 5. 因此 issue 3 仍保持开放的原因

书面清单已经覆盖当前仓库交付的主要来源、版本、声明许可、已知限制和建议动作，并记录了 #18 的 Project / Timeline 风险。下列事项仍然未知或未解决，因此不能把 issue 3 写成已经完成，也不能把本仓镜像称为可再分发的公开发行物：

1. MPL-2.0 LibreOffice kit 仍会随默认 DSH 安装进入镜像（办公功能保留）。本仓已提供 0.1.5 的源码与通知要约，但公开 git 没有找到 0.1.5 对应提交，且该要约是否满足再分发镜像的 MPL 义务尚未作出法律解释。
2. `@deepseek-ai/dsh@0.2.2-rc.1` 的 npm tarball 与 git 标签 `dsh-v0.2.2-rc.1` 的已编译 JS **仍然明确未核实**；本轮未重现字节级对应，也不宣称已经对齐。
3. Debian 源码要约已按确切安装版本生成流程与 CI 输出，本仓仍不托管 Debian 源码。该要约是否充分属于法律解释。
4. `@img/sharp-libvips-linux-x64@1.3.4` 的通知与 libvips 8.18.7 源码指针已放入本仓并拷入镜像。同一 `.so` 中其它 LGPL 组件以及 cairo 的 MPL-1.1，已记录 `build/posix.sh` 使用的确切源码 URL；除 libvips 外的 tarball/补丁 sha256 与可复现重建仍明确未核实。这些指针是否充分属于法律解释。
5. `#56` 扫描到的 `@anthropic-ai/sdk@0.129.0` MIT 文本已按镜像所载记录。官方 Claude Code / `claude-agent-sdk` 条款未在该扫描中出现，也不得用这份 MIT 文本替代。扫描不能覆盖启动后的可选下载。
6. KaTeX 字体已附上与字节对应的上游 MIT LICENSE。是否另有 OFL 义务，仍然开放。Playwright Codicon 已按 v1.64.1 源码目录中的 MIT 文本收集；是否另有 CC 条款，仍然开放。商标授权仍待审阅。DS-Bot v0.3.6 NOTICE 已做归属阅读记录，不是对其中每个上游的结案。

校验：在仓库根目录运行 `python3 scripts/verify-reuse-audit-pins.py`（离线检查历史钉扎与本清单哈希）。`python3 -m unittest tests.test_shipped_licenses` 检查根 NOTICE / 导入树许可文件是否存在，且磁盘哈希与 `shipped-pins.json` 一致。
