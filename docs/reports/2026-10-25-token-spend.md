# Token spend per Bot turn

**合成样本 / 非线上账本.** This page is a synthetic DeepSeek sample on hk2, not a live production ledger. Do not use it for [#796](https://github.com/ThinkFlowLab/FlyBot/issues/796) savings acceptance against the 2026-10-23 live ledger. It changes nothing that is sent to a model: no prompt, notice, roster, memory or tool-output edit.

The numbers below are the JSON from one run of `core/dev/token-report.mjs` on the snapshot named in Sample. No cell is estimated.

## Run

- Label: 合成样本 / 非线上账本
- Host: hk2 (`infermatrix-hk2-hsliu`), isolated `DSH_HOME=/home/hsliu/experiments/2026-10-25-796-synth/dsh`
- Snapshot directory: `/home/hsliu/experiments/2026-10-25-796-synth/snapshot/`
- FlyBot: `origin/main` @ `44f3e97d5bf531c7fa0475587ef7c275d7d7f599`
- DSH: `639ed015397290b3745d163aafe02ffee4aa3f84` (0.2.0-rc.2)
- Provider: DeepSeek (`llm-deepseek`)
- Model: `deepseek-official/deepseek-flash`
- Team: Chief (Main), Dev, Reviewer; room `交付组`
- Sessions / billed calls: 3 sessions, 11 billed calls (Chief 5, Dev 3, Reviewer 3)
- Wall clock of the settled model turns: about 2.3 minutes (operator note for the run, not a ledger column)

### Fixed task set

1. Pick the model for Chief; create Dev and Reviewer; create room `交付组`.
2. DM Chief to list the team; DM Dev a 3-bullet `hello()` plan; DM Reviewer a 2-sentence review.
3. Group status ask (settled; no extra billed rows).
4. DM Chief a one-line summary.
5. Extra multi-turn growth: Chief ×2, Dev ×2, Reviewer ×2, Chief ×1 wrap-up.

## Sample

| Item | Value | Source |
| --- | --- | --- |
| Ledger snapshot | `/home/hsliu/experiments/2026-10-25-796-synth/snapshot/usage.sqlite` | ledger |
| Window | 2026-10-25T09:25:30.251Z .. 2026-10-25T09:27:55.691Z | derived: earliest session first .. latest session last |
| Billed attempts | 11 | ledger |
| Sessions with calls | 3 | ledger |
| Bots with calls | 3 (Chief, Dev, Reviewer) | ledger |
| Cache writes | 0 | ledger |

The JSON `from` and `to` are null: the reader took the whole snapshot. The window row is the earliest `first` and the latest `last` among the three sessions in that JSON. Reading a live ledger twice can diverge while a Bot is still writing; this page was filled from the snapshot file above.

## Method

Fresh input, cache read and cache write are never added into one another. `prompt` is their sum and is always its own column, because a cached token and a fresh input token are not the same cost and a saving that only moves tokens between the columns would otherwise look real ([#796](https://github.com/ThinkFlowLab/FlyBot/issues/796)).

Percentiles are nearest-rank: the ascending value at `ceil(p/100 × n) - 1`, so the p99 of a small sample is its maximum. Percentiles are computed per call over every attempt in the window.

Growth is measured inside one Session, between consecutive calls, and only within a run: a smaller prompt means a compaction, a checkpoint or a new part, so that crossing starts a new run and contributes no delta. `resets` counts those boundaries.

Cache-read share is printed to one decimal the way `token-report.mjs` formats it (`(share * 100).toFixed(1)`).

```sh
node core/dev/token-report.mjs --db /home/hsliu/experiments/2026-10-25-796-synth/snapshot/usage.sqlite --tz Asia/Shanghai --json
```

A missing `--db` is an error that names the path, never an empty table: an empty report is what a broken path looks like.

## 1. Totals

| Measure | Value | Source |
| --- | --- | --- |
| Calls | 11 | ledger |
| Fresh input | 3,745 | ledger |
| Cache read | 5,760 | ledger |
| Cache write | 0 | ledger |
| Output | 55 | ledger |
| Prompt | 9,505 | derived: fresh input + cache read + cache write |
| Cache read share of prompt | 60.6% | derived: cache read / prompt |

## 2. Per Bot

Sorted by prompt. `fresh input` is what was billed as input, not the prompt.

| Bot | Calls | Fresh input | Cache read | Cache write | Output | Prompt | Cache read share | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chief | 5 | 1,551 | 2,688 | 0 | 25 | 4,239 | 63.4% | ledger |
| Dev | 3 | 1,205 | 1,536 | 0 | 15 | 2,741 | 56.0% | ledger |
| Reviewer | 3 | 989 | 1,536 | 0 | 15 | 2,525 | 60.8% | ledger |

Cache read share on this table is `derived: cache read / prompt`, printed to one decimal. The source cell `ledger` names the stored columns on the same row.

## 3. Per-call prompt

Over all 11 attempts: p50 **857**, p90 **926**, p99 **984**, max 984.

| Statistic | Prompt tokens per call | Source |
| --- | --- | --- |
| p50 | 857 | ledger |
| p90 | 926 | ledger |
| p99 | 984 | ledger |
| max | 984 | ledger |

## 4. Top Sessions by prompt

A Session is a part of one Bot's conversation. The JSON default `top` is 10; this snapshot has 3 sessions, so the table is the whole sample.

| Session | Bot | Calls | Prompt | Fresh input | Cache read | Source |
| --- | --- | --- | --- | --- | --- | --- |
| session-31ca8073-7ae7-456c-90dc-8b4ad1d4ada9 | Chief | 5 | 4,239 | 1,551 | 2,688 | ledger |
| session-bfda7fc5-7b1b-4ba0-88d1-6bf9ef8611c2 | Dev | 3 | 2,741 | 1,205 | 1,536 | ledger |
| session-ae191a24-2ece-4ea3-acfe-65339445db41 | Reviewer | 3 | 2,525 | 989 | 1,536 | ledger |

## 5. Per day

Days are in `Asia/Shanghai` (`--tz`). The snapshot has one local day.

| Day | Calls | Fresh input | Cache read | Cache write | Output | Prompt | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-25 | 11 | 3,745 | 5,760 | 0 | 55 | 9,505 | ledger |

## 6. Prompt growth per Session

Across every Session, between comparable calls: 7 deltas, median **34** tokens, p90 **95**, with 1 compaction or new-part boundary excluded (`resets`).

| Measure | Deltas | Median delta | p90 delta | Source |
| --- | --- | --- | --- | --- |
| All Sessions, comparable calls | 7 | 34 | 95 | derived: consecutive turn prompts in one Session, split where the prompt falls |
| Compaction boundaries excluded | 1 | not applicable | not applicable | derived: a prompt smaller than the previous call in the same Session |

The per-Session curve. The JSON default `growth` is 5; this snapshot has 3 sessions.

| Session | Bot | Calls | Deltas | Median delta | p90 delta | Resets | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| session-31ca8073-7ae7-456c-90dc-8b4ad1d4ada9 | Chief | 5 | 3 | 23 | 61 | 1 | derived: consecutive turn prompts in one Session |
| session-bfda7fc5-7b1b-4ba0-88d1-6bf9ef8611c2 | Dev | 3 | 2 | 58 | 95 | 0 | derived: consecutive turn prompts in one Session |
| session-ae191a24-2ece-4ea3-acfe-65339445db41 | Reviewer | 3 | 2 | 33 | 34 | 0 | derived: consecutive turn prompts in one Session |

## Prompt shape (structure only / not comparable to the 2026-10-23 live ledger)

This section names the prompt shape that landed after the [2026-10-23 live report](2026-10-23-token-spend.md). It is structure only. There is no delta, no percent change, and no rise or fall against that live ledger. A synthetic sample and that live ledger are not the same measurement, and this page does not accept a saving for [#796](https://github.com/ThinkFlowLab/FlyBot/issues/796).

- `9fe5c261` (2026-10-23 17:42:26Z, [#897](https://github.com/ThinkFlowLab/FlyBot/pull/897), fixes #894). A member's group Session keeps the group's fixed rules in the standing system-prompt section `bot-room` (order 10150): the members line or the face roster, `@Name` calls, the notice, the admin note or the face lead / member note, the face routing rule, and the reply rule. DSH renders that section on every model step and re-projects it after a checkpoint or in a new part. A turn carries the round (earlier lines, this round, references, who is working, speaking order, position), a short routing note on a routed face line, and a one-line reply cue. When the notice changed since that member's last turn, the turn says so in one line. Own chats and the relay Session render no section.
- `9f4aa524` (2026-10-23 17:50:56Z, [#898](https://github.com/ThinkFlowLab/FlyBot/pull/898), fixes #895). A tree coordinator's system prompt no longer carries the child-load block (`Child load right now — …`). Renames, roles and other fixed notes still refresh the tree block, and an unchanged block is not rewritten. The coordinator rule says, in fixed words, to call `list_children` before sending a part that more than one child fits, and to prefer an idle or working child to a busy one. `loadLine` remains a helper; the prompt does not call it.

The run recorded FlyBot `origin/main` at `44f3e97d5bf531c7fa0475587ef7c275d7d7f599`. This page does not diff that tree against the 10-23 measurement, and it does not copy the mock-model character counts from those two pull requests.

## 7. Composition: fixed overhead / history / tool results / task

**Not measured.** The ledger JSON stores the prompt total and its three columns. It does not store the request, so it cannot split the prompt into the group notice, the roster, the memory, the earlier turns, the tool results and the current task. That split needs one dumped request body per sampled turn and one ablated replay per category through `core/dev/llm-tap.mjs` with a real provider call. No number is printed for a category.

| Category | What it is | How it would be measured | Source |
| --- | --- | --- | --- |
| Fixed overhead | system prompt, group notice, member roster, speaking order, tree block, injected memory | one replay with the block removed, provider-reported prompt difference | not measured |
| History | every earlier turn of the Session, re-read on each call | one replay with the first half of the turns removed, provider-reported prompt difference | not measured |
| Tool results | GitHub JSON, test logs, file reads carried in the transcript | one replay with tool results truncated to a fixed size, provider-reported prompt difference | not measured |
| Task | the current instruction and its attachments | one replay with the instruction and attachments removed, provider-reported prompt difference | not measured |
| Character share of any category | where the characters sit in one dumped body | count characters per message role in the dumped body | not measured |

What it would take:

```sh
# 1. Run a Session through the tap with bodies saved.
node core/dev/llm-tap.mjs <port> <upstream base URL> /tmp/tap.jsonl /tmp/bodies

# 2. For each category, send the same body once with the category removed and once unchanged.
#    Each variant is a real provider call; the ledger reports its prompt.
```

Where this sample's prompt sits among fixed overhead, history, tool results and the task is not known from the ledger JSON.

## What this report does not say

- It is a synthetic sample (合成样本 / 非线上账本), not a live production ledger and not a rebaseline of the 2026-10-23 host ledger.
- It does not compare rises or falls with the 2026-10-23 live numbers. No delta and no percent change against that report is stated.
- It proposes no saving. [#796](https://github.com/ThinkFlowLab/FlyBot/issues/796) savings acceptance stays open and is not claimed by these figures.
- It does not compare models or providers beyond naming the one route this sample used: DeepSeek (`llm-deepseek`), model `deepseek-official/deepseek-flash`.
- Cache read tokens are counted at face value, as the ledger stores them. Their price is not applied: the ledger has no cost column.
- It does not adopt the mock-model character counts recorded on #897 and #898.

## Provenance

- `ledger` — a column of the synthetic hk2 snapshot, summed or listed here.
- `derived: <formula>` — computed from that snapshot by the formula named in the row. Cache-read shares use one decimal, as `token-report.mjs` prints them. `not applicable` on the compaction-boundary row is the method: a reset is a boundary, not a delta.
- `not measured` — no number exists for it in this sample; the row says what would produce one.

Every row of every table above carries its provenance in the last cell. `core/test/token-report.test.js` checks that rule on `docs/reports/2026-10-23-token-spend.md`. This file uses the same last-column vocabulary (`ledger`, `derived: …`, `not measured`).
