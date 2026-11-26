# 开发流水线：从 agent-ready issue 到可合并 PR

Related #3393.

本文写「一条 issue 实际怎么走」，以及每一步的产出、失败怎么处置。目录归属与各侧自检命令在
[UI_SURFACES.md](UI_SURFACES.md)；QA 出证格式在 [qa-evidence-template.md](qa-evidence-template.md)。

## 0. 今天由机器强制什么（不是计划，是现状）

| 事项 | 谁强制 | 现状 |
|---|---|---|
| `tests.yml` 的 7 个 suite job + 汇总门 `FlyBot required checks` | GitHub required check | 唯一 required，名字不得改 |
| `risk-tier`（按 diff 出 T0–T3） | workflow | report-only；未设 required。T3 的 PR 在它这里也绿 |
| `silent-revert`（PR 上查静默回退） | workflow | report-only，finding 恒绿（exit 0），只有脚本自身故障才红 |
| `audit-merges`（main 上查未走队列的提交） | workflow | 只在默认分支按 `schedule` 跑，PR 里不出现 check |
| 同一 (对象, 标记) 只留一条评论 | `comment-guard.mjs` | 脚本在，人工/脚本调用；没有 CI 门 |
| 认领标记 | 约定 | 没有机器校验 |
| 合并决定 | FlyBot Lead | 由 Lead 明示并记录 head 与理由；Tier 只作提示，不是否决项 |

结论：**只有 `FlyBot required checks` 会替你挡住合并**。其余全部是证据与提醒，靠人看。
文档里任何「会拦住」的说法，只有这一条成立。

## 1. 状态机

按顺序执行；每步产出落在 GitHub 上（issue 标签/评论、PR、check），不落私人笔记。

1. **Triage.** 只挑带 `agent-ready` 的 open issue。`hold` 不碰；`needs-human` 停下来汇报等人决定。
   开工前确认没有人既在认领它（有没有 `agent-working`、有没有 open PR 指向它）。
2. **拆切片.** 一个 issue 拆成一个可评审切片：输入、产出、验收标准、涉及目录、跑哪条自检。
   一个 PR 只装一个切片；要两个切片就开两个分支两个 PR。
3. **认领.** 打 `agent-working`；评论写明分支名。分支从 `main` 拉，
   命名 `dev/<issue号>-<短描述>`。
4. **开发.** 按 `UI_SURFACES.md` 的目录边界分派。改完先按那张表的「本地跑什么」自检，再推。
5. **QA 出证.** 由 QA 按 exact head 核（不是作者的工作副本），格式见 `qa-evidence-template.md`。
   新提交即作废旧证据。
6. **评审.** 看四件事：`Related #N`/`Refs #N` 且无 `Fixes`/`Closes`/`Resolves`；结论绑 head SHA；
   一个切片；本地绿与 CI 绿分开报。评审意见落 PR 评论。
7. **风险标注.** `risk-gate.mjs` 的 tier 由脚本输出后以 `risk:T*` 标签落到 PR（不手打）。
   Tier 只作提示，不构成合并闸口：T3 也照常往下走，没有人工批准这一步（2026-11-26 起）。
8. **合.** 由 FlyBot Lead 决定并执行合并：`FlyBot required checks` 全绿、上述证据都在 PR 上，
   合并时写明 head 与理由。Tier 是提示，不是否决项。
   不声称 parity，不声称验收通过。

任一步发现记录与实际不一致（注释说 A、代码做 B），打回重做——这一类是本流水线最常见的打回理由。

## 2. 目录 → 谁做

| 目录 | 成员 | 备注 |
|---|---|---|
| `flybot_workspace/**`（含 `static/**`） | UI Dev（页面）/ Runtime Dev（Python 服务端） | 两侧不独立，见 UI_SURFACES §4 |
| `runtime/flybot-workspace-web/**` | UI Dev | `npm test` |
| `runtime/flybot/**`、`.github/scripts/**`、`.github/workflows/**` | Runtime Dev | 动 workflow 前先核对门名 |
| `services/**`、`deploy/**`、`manager/**` | Services Dev | |
| `tests/**`、出证 | QA Engineer | |
| `docs/DEV_PIPELINE.md`、评审、开 PR | FlyBot Lead | 写操作只由 Lead 或带 token 的脚本执行 |

`runtime/ds-bot-upstream/**` 是 vendor 树，永不手改（`scripts/ds-bot-upstream.mjs check` 会失败）；
要修就落到补丁层 `runtime/flybot/patches/**`。

## 3. 模板

### 3.1 切片（Lead 派活时写）

```
Issue: #<n>  标题：<…>
切片：<一句话，一个可评审的改动>
输入：<要读的现状/缺陷，附代码位置>
产出：<新增/修改哪些文件；分支名 dev/<n>-<短描述>>
验收标准：<可核验条目，逐条>
自检：<命令 + 期望输出>
不做：<明确排除的同源问题，留给下一个切片>
```

### 3.2 认领评论

```
认领 #<n>：<一句话范围>
分支 `dev/<n>-<短描述>`，从 main `<main40>` 拉。
自检计划：<命令>。
```

### 3.3 QA 证据

用 `docs/qa-evidence-template.md`，五节全填，`{{…}}` 不许留。第 5 节「本证据不构成验收通过」不得删。

### 3.4 评审意见

```
评审 <head40>（PR #<n>）
Related/Refs：<有 / 无 Fixes|Closes|Resolves>
切片：<单一切片 / 混了 X>
绑定：结论绑 head <head40>；本地绿 <命令与数字>；CI 绿 <截至 UTC，哪些 success，哪些未跑完>
风险：脚本输出 <T*>，与标签 <risk:T*> 一致（Tier 只作提示，不否决）
打回/放行：<缺什么，需要谁补>
```
