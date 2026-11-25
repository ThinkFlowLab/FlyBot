# 许可与来源审计（对应 [issue #3](https://github.com/openTeamily/openTeamily/issues/3)）

审计日期：2026-11-16（Asia/Shanghai）。  
本目录是新撰写的审计记录，不是法律意见，也**不构成导入授权**。完整对等总跟踪 [issue #1](https://github.com/openTeamily/openTeamily/issues/1) 不得因此关闭；本 issue 仅在全部适用标准都有证据后方可建议完成，本次**不关闭** #3。

对照政策：[docs/REUSE_POLICY.md](../REUSE_POLICY.md)。先前部署草稿与规划笔记只作线索，结论以本目录对公开仓库固定修订的核对为准。钉扎与哈希见 [pins.json](pins.json)，组件表见 [INVENTORY.md](INVENTORY.md)。

## 导入后勘误（2026-11-16，[PR #20](https://github.com/openTeamily/openTeamily/pull/20) / [PR #21](https://github.com/openTeamily/openTeamily/pull/21) 合入后）

下面「当前结论」仍是 #18 当时的审计记录，不追溯改写。随后发生的导入如下，**不得**把本仓根 MIT 覆盖到这些树上：

- **#20** 已按需把 FlyBot 定制层写入 `runtime/flybot/`（社交插件、docker 辅助脚本与选定文档，保留 Apache-2.0 `LICENSE` / `NOTICE`），把 Bot Social 必要集写入 `services/bot-social/`（保留 MIT 与 Birfy 版权）。未导入 `runtime/flybot/core/`、旧的 `ds-bot.pin.json`、Project / Timeline / tree / workflow 插件，以及未核商标的品牌/演示图。
- **#21** 已把上游 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot) **v0.3.6**（`a66cc737cfb6c3d8a2597e748cded6cab1206dd3`）作为未修改钉扎副本放入 `runtime/ds-bot-upstream/`。`LICENSE` 与 #18 记录的 Apache-2.0 文本相同（sha256 `c71d239d...`）。**`NOTICE` 已变**：v0.3.6 为 sha256 `4c7d3e4e7607f02ed9e4fb940442be7d0d107b57beb54660e1526a7be07c2aad`（15557 字节），不同于 FlyBot / 历史钉扎 `2b10c70` 的 `94f05bc4...`（3835 字节）；新增对更多 DSH 派生文件以及 Simple Icons（CC0）、Context7（MIT）、Playwright（Apache-2.0）等声明。此处只记录哈希与差异，**不是**对新增声明的完整法律重读。
- **上游跟踪（2026-11-17）** 将钉扎更新为 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot) **v0.3.8**（`5e9b7da8882da3b68d8a0624342708c2150a9156`）。LICENSE 哈希未变。NOTICE 现为 sha256 `9950f67d1743a33a420581e44e8f7473e6ab78b69c7e55ea8a84b476c3cf2a39`（15675 字节）；相对 v0.3.6 仅扩展 Agent logos 商标归属（Antigravity、GitHub Copilot、Kimi、MiniMax、Mistral AI）。仍只核哈希与该差异，**不是**完整法律重读。
- 当前运行时钉扎的 DSH 为 **`0.2.2-rc.1`**（见 `runtime/ds-bot-upstream.pin.json`）。#18 只审计了 `dsh-v0.2.1-rc.2`。0.2.2-rc.1 的传递依赖、npm 与 git 标签对应、MPL / 镜像再分发义务仍为 **待核**，#3 不得关闭。

#18 写的「在审计剩余项关闭前不要把源码拷入本仓」已被后续按需导入取代；禁止改标为 MIT、禁止导入无许可证控制面、禁止导入 Teamily 专有资产，这几条仍然有效。

## 已交付修订清单（2026-11-16 晚）

#18 / #23 记录的是导入前与导入后勘误，并不等于「当前仓库和镜像配方里到底有什么」。对**恰好已经交付**的来源、版本与声明许可，见 [SHIPPED.md](SHIPPED.md) 与 [shipped-pins.json](shipped-pins.json)；根目录新增 [NOTICE](../../NOTICE) 指向导入树与镜像义务。该清单核实了 DSH **0.2.2-rc.1** 的 npm integrity、git 标签 `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）上的 LICENSE / THIRD_PARTY_NOTICES，以及 90 个生产直接依赖的声明许可；并记录默认安装会经由 `@deepseek-ai/dsh-skill-office` 带入 MPL-2.0 的 `@deepseek-ai/libreoffice-kit`。在对应源码义务或排除该组件、以及清单中其余未知项解决之前，不得把运行时镜像称为可再分发的公开发行物。相关跟踪仍保持开放：issue 3。

随后已在 [`runtime/third_party/libreoffice-kit/`](../../runtime/third_party/libreoffice-kit/) 放入 0.1.5 的对应源码与通知要约（办公功能保留；未排除 office 技能）。公开 git 仍未找到 0.1.5 对应提交，要约是否满足再分发镜像的 MPL 义务尚未作出法律解释，因此不得把镜像称为可再分发的公开发行物。相关跟踪仍保持开放：issue 3。

构建成品的现场文件/软件包/许可清单由 CI 在已有的 FlyBot runtime image 作业中收集，并作为 `flybot-runtime-image-license-inventory` artifact 上传（不发布镜像）。收集程序和夹具测试见 [`runtime/flybot-image/inventory/`](../../runtime/flybot-image/inventory/)。该 artifact 记录全局 DSH、额外包与 profile 的已安装闭包、Debian 版权哈希与 deb-src 指针、Claude 载荷是否出现及找到的条款文本、字体/OFL 通知，以及 `/opt/licenses` 中的 NOTICE 与商标字样。这是合规收集，不是法律意见，也不是公开发行授权。对照 artifact 的审阅、MPL 3.2/3.3 解释、tarball 与 git 已编译 JS 的对应、Debian 源码要约是否充分等事项仍然开放。相关跟踪仍保持开放：issue 3。

随后已依据 #56 的现场清单，把与镜像中 KaTeX 字体字节对应的上游 MIT LICENSE、`@img/sharp-libvips-linux-x64@1.3.4` 的通知与 libvips 8.18.7 源码指针、以及 `@anthropic-ai/sdk@0.129.0` 在镜像中的 MIT 文本放入 `runtime/third_party/`，并由镜像配方拷到 `/opt/licenses` 及相应载荷旁边。CI 还会按确切安装版本生成 Debian 源码要约清单。对 v0.3.6 NOTICE 的归属审阅及 v0.3.8 商标列表补记见 [DS-BOT-NOTICE-REVIEW.md](DS-BOT-NOTICE-REVIEW.md)。这些是合规收集与阅读记录，不是法律结案，也不是公开发行授权。DSH 已编译 JS 的 tarball 对应仍明确未核实。相关跟踪仍保持开放：issue 3。




## 方法

- 只读公开 GitHub 仓库与 npm 注册表原文；以默认分支或版本标签的**固定 commit / 版本**为准，而不是本机工作树。
- 本机 FlyBot / bot-social 检出仅用于哈希对照，不当作许可证来源。
- 未读取凭证或 `.credentials`，未部署，未运行 Docker，未把上游源码或私有控制面文本复制进本仓库。
- 单一未知或未完成项记为**局部阻塞或待核**，不泛化为「项目完全不能推进」。自写管理面与 fake / stub 基板不被本审计阻塞。
- 未独立生成 DeepSeek Harness 的完整 `pnpm-lock.yaml` 传递闭包，也未安装其 npm 包展开全部传递依赖。对该树，证据是标签 `dsh-v0.2.1-rc.2` 上已提交的 `THIRD_PARTY_NOTICES.md`、CLI 包的直接依赖声明，以及对 FlyBot / Bot Social 锁文件中依赖的 npm `license` 字段核对。

## 当前结论（可复用 / 阻塞）

### 不阻塞

- OpenTeamily 本仓库**新撰写**材料按本仓 MIT 发布；该 MIT **不覆盖**尚未导入的上游。
- 继续实现管理面、`RuntimeBackend` 与自写 stub，不需要先导入 FlyBot 或 Bot Social。

### 有条件可复用（必须保持独立出处，不得改标为本仓 MIT）

1. **FlyBot 源码**（公开仓 [ThinkFlowLab/FlyBot](https://github.com/ThinkFlowLab/FlyBot) `@e26895e737b1218875aafa1f74ab1d3464f287d2`，默认分支 `main`）  
   已核对其 `LICENSE` 为 Apache License 2.0 标准文本（与 GitHub `licenses/apache-2.0` 正文在规范化换行后一致），`NOTICE` 载明 “DS Bot，Copyright 2026 Fei2411 and the DS Bot contributors”。GitHub 仓级 SPDX 为 Apache-2.0。`LICENSE` / `NOTICE` 的 git blob 与上游 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot) `@2b10c70b614e969117b68ddc6fd14e68968272f2`（`ds-bot.pin.json` 所钉；`Fei2411/DeepSeek-Bot` 会解析到同一仓库）相同。  
   再分发或修改须保留 Apache 2.0 文本、`NOTICE`、版权与归属，提供对修改文件的说明，并遵守 NOTICE 中对 DeepSeek Harness 的 MIT 声明。  
   **允许的形态：** 独立仓库或自构建镜像，由管理面编排。  
   **不允许：** 把该源码合并进本仓后当作本仓 MIT 作品。
   **随后导入：** 见上文「导入后勘误」——#20 已按需导入定制层到 `runtime/flybot/`，保留原许可，并未导入 core 旧分叉。

2. **FlyBot 插件**（`plugins/project`、`timeline`、`social`、`tree`、`workflow`）  
   各 `package.json` 的 `license` 字段为 `Apache-2.0`。插件目录**没有**独立 `LICENSE` 文件。它们位于同一公开仓库、受根 `LICENSE` + `NOTICE` 约束，此点已记录。  
   产品取舍（不是用户删除指令，也不是许可证禁止）：Project 不默认进入核心体验，Timeline 作为默认关闭的运维选件；二者不能冒充 Teamily 工作区、记忆待办或 Studio。是否引入仍待产品决策，且须先修静态风险（默认仓库错绑、未注册工具提示、写死时区）后再谈适配。许可上不因该建议而排除用户需求。

3. **Bot Social 源码**（公开仓 [Birfy/bot-social](https://github.com/Birfy/bot-social) `@8706824f53f6cce8212470bc6b442f7271cccd3e`，默认分支 `master`）  
   已核对 `LICENSE` 为 MIT，Copyright (c) 2026 Birfy；`package.json` 与 README 声明一致。GitHub 仓级 SPDX 为 MIT。依赖锁文件中先前缺 `license` 字段的包，已按**钉扎版本**向 npm 查询，结果为 MIT / Apache-2.0 / ISC / BSD-2/3-Clause 等宽松许可，未见 GPL / AGPL / 专有声明。  
   **允许的形态：** 可选的独立服务或协议适配，保留版权与 MIT 声明。  
   **不是**架构必选第三服务。不得改标为本仓原创 MIT。
   **随后导入：** #20 已按需导入到 `services/bot-social/`，保留 MIT 与版权声明。

### 局部阻塞（不阻止项目其余部分）

1. **FlyBot 运行容器 / 官方 Dockerfile 所描述的自构建镜像**  
   Dockerfile 声明「自行构建、没有已发布镜像」，基础镜像 `node:24-bookworm-slim`，并全局安装 `@deepseek-ai/dsh@0.2.1-rc.2` 与 `pnpm@10.34.6`，还安装 Debian 包 `ca-certificates`、`git`、`tini`。  
   - DSH 源码标签 `dsh-v0.2.1-rc.2`（`687f282e8625c6b8d11ff58211a90524be2e4317`）的 `LICENSE` 已核实为 MIT，Copyright (c) 2026 DeepSeek；npm 包 `@deepseek-ai/dsh@0.2.1-rc.2` 声明 MIT。FlyBot `NOTICE` 中的 MIT 条款（去掉缩进后）与该 LICENSE 授权正文一致。  
   - **待核：** npm 注册表元数据未提供 `gitHead`，因此该 npm 包与 git 标签的字节对应关系尚未核实（已记录 tarball integrity）。  
   - **已核实的再分发义务：** CLI 直接依赖 `@deepseek-ai/dsh-skill-office@0.2.1-rc.2`，后者直接依赖 `@deepseek-ai/libreoffice-kit`（DSH `THIRD_PARTY_NOTICES.md` 声明 MPL-2.0，且写明须提供对应源码与通知）。默认按官方 Dockerfile 安装即会带入该组件，除非构建时明确排除。  
   - Web UI 主题包含 Montserrat `.woff2`，并附 `Montserrat-OFL.txt`（SIL Open Font License 1.1）。再分发 UI 须保留 OFL 文本，不得把字体改许可，也不得单独出售字体。  
   - KaTeX 在 DSH 通知中列为 MIT；其字体文件来自 npm 上的 `katex` 发行，本次未逐文件核对其字体 OFL/附属文本（待核）。  
   - `node:24-bookworm-slim` 与镜像内 `git`（GPL-2.0）等系统组件的版权清单与源码提供方式，本次未枚举（待核）。发布镜像前须补齐。  
   - DSH 通知还列出 `@anthropic-ai/claude-agent-sdk`（声明 “SEE LICENSE IN README.md”）及其官方 Claude Code 平台二进制载荷（同样非宽松声明）。在 `@deepseek-ai/dsh@0.2.1-rc.2` **直接依赖包**的直接依赖中**未发现**该 SDK；它是否经更深层传递或可选插件进入默认 `npm install -g`，本次未做完整 lock 安装验证（待核）。在条款核清且确认不会随默认镜像分发之前，不得宣称「完整 DSH 运行时已可再分发」。  
   **安全替代：** 管理面继续用自写 stub / 占位镜像验证生命周期；若采用 FlyBot 容器，先固定源码与 DSH 版本，附带 LICENSE/NOTICE/OFL/DSH 第三方通知，处理 MPL 源码义务，明确排除或合规包含 LibreOffice kit 与任何 Claude 载荷，并完成基础镜像版权清单。

2. **未获许可的控制面实现**（公开仓 [Birfy/flybot-control-plane](https://github.com/Birfy/flybot-control-plane)）  
   仓库公开，但默认树根目录**没有** `LICENSE` / `NOTICE`，GitHub 许可字段为空。公开可见不等于再分发授权。**禁止**复制其源码、结构或实现到本仓。需要同类能力时在本仓按已公开契约重写。

3. **商标与品牌资产**  
   FlyBot 文档中的 logo、微信群二维码，以及 FlyBot / DeepSeek / Bot Social / Teamily 等名称与标识，本次只记录存在，**未**做商标授权核实（待核）。不得把这些资产或 Teamily 专有字体/法律文本导入本仓。

### 明确未完成，因此 #3 不能视为已完成

- DSH 完整传递依赖闭包未在本审计中独立展开（`pnpm licenses list` 未运行）。
- `@deepseek-ai/dsh@0.2.1-rc.2` npm 包与 git 标签的对应关系待核。
- Claude Agent SDK / Claude Code 载荷的实际条款未阅读，默认安装是否拉入待核。
- 基础容器镜像与 Debian/GPL 组件的再分发清单待核。
- KaTeX 字体附件与 Bot Social / FlyBot 图像标识的商标待核。
- 拟实际导入或发布的**精确构建**若不同于上述钉扎，必须对那一修订重做本审计。
- 运行时现已钉扎 `@deepseek-ai/dsh@0.2.2-rc.1`（PR #21）。对该版本尚未做与 #18 同级的传递依赖与再分发审计。
- 上游 DS-Bot v0.3.6 的 `NOTICE` 已比历史钉扎更长，新增第三方声明尚未逐条法律重读。


校验记录的钉扎与哈希：在仓库根目录运行 `python3 scripts/verify-reuse-audit-pins.py`（默认同记录的哈希；加 `--fetch` 时会再次向 GitHub 拉取公开文件并比较）。
