# Token spend per Bot turn

**本机账本 / this host's live ledger.** Every number below comes from the usage ledger this host writes (`/data/dsh/bot/usage.sqlite`), window `2026-10-24T06:51:39.655Z .. 2026-10-25T09:37:59.208Z`. It changes nothing that is sent to a model: no prompt, notice, roster, memory or tool-output edit. It is **not** a rebaseline of the [2026-10-23 page](2026-10-23-token-spend.md) — the 2026-10-23 page's window ends on 10-23, before this one starts, so no saving, rise or fall is claimed ([Comparison](#comparison-with-the-2026-10-23-page)).

The numbers below are the JSON from one run of `core/dev/token-report.mjs` on the snapshot named in Sample. No cell is estimated.

## Run

- Label: 本机账本 / this host's live ledger
- Host: this workspace host; `DSH_HOME=/data/dsh`, ledger `/data/dsh/bot/usage.sqlite`
- Snapshot: all three files (`usage.sqlite`, `-wal`, `-shm`) copied into `/tmp/token-report/` at 2026-10-25T09:40:23Z before reading; every number below is from that copy, so the live writer cannot move a cell mid-report
- FlyBot: `origin/main` @ `44f3e97d5bf531c7fa0475587ef7c275d7d7f599` (the tree the reader ran from)
- DSH: 0.2.0-rc.2 harness
- Providers: `opencsitool` / `DeepSeek-V4.1-Flash-1017` (499 calls), `volc` / `deepseek-v4-1-flash-economy-261017` (13 calls)
- Bots with calls: 14
- Sessions / billed calls: 40 sessions, 512 calls (373 `memory` rows, 139 `compaction` rows)
- No fixed task set: this is every billed call the team's own rounds produced in the window, not a scripted run. That is also why it cannot be compared call-for-call with the 2026-10-23 page.

## Sample

| Item | Value | Source |
| --- | --- | --- |
| Ledger snapshot | `/tmp/token-report/usage.sqlite` (copied from `/data/dsh/bot/usage.sqlite`) | ledger |
| Window | 2026-10-24T06:51:39.655Z .. 2026-10-25T09:37:59.208Z | derived: earliest first .. latest last among the Sessions in the JSON |
| Billed attempts | 512 | ledger |
| Sessions with calls | 40 | ledger |
| Bots with calls | 14 (Reviewer, Dev2, Dev, Dev3, Dev4, Triage, SelfTest, Reviewer2, Chief, Release, Architect, Data, Backend, Frontend) | ledger |
| Cache writes | 0 | ledger |

`--from 2026-10-24T01:50:56` (Asia/Shanghai, = `2026-10-23T17:50:56Z`) was passed to match the 2026-10-23 page's cut. The ledger has no call before `2026-10-24T06:51:39.655Z`, so the Window row names the first observed call, not the flag. The window ends at the latest call in the snapshot.

## Method

Fresh input, cache read and cache write are never added into one another. `prompt` is their sum and is always its own column, because a cached token and a fresh input token are not the same cost and a saving that only moves tokens between the columns would otherwise look real ([#796](https://github.com/ThinkFlowLab/FlyBot/issues/796)).

Percentiles are nearest-rank: the ascending value at `ceil(p/100 × n) - 1`, so the p99 of a small sample is its maximum. Percentiles are computed per call over every attempt in the window.

Growth is measured inside one Session, between consecutive calls, and only within a run: a smaller prompt means a compaction, a checkpoint or a new part, so that crossing starts a new run and contributes no delta. `resets` counts those boundaries.

Cache-read share is printed to one decimal the way `token-report.mjs` formats it (`(share * 100).toFixed(1)`).

```sh
cp "$DSH_HOME"/bot/usage.sqlite* /tmp/token-report/
cd core && node --experimental-sqlite dev/token-report.mjs \
  --db /tmp/token-report/usage.sqlite --tz Asia/Shanghai --from 2026-10-24T01:50:56 --top 10
```

A missing `--db` is an error that names the path, never an empty table: an empty report is what a broken path looks like.

## 1. Totals

| Measure | Value | Source |
| --- | --- | --- |
| Calls | 512 | ledger |
| Fresh input | 2,799,817 | ledger |
| Cache read | 17,900,416 | ledger |
| Cache write | 0 | ledger |
| Output | 1,028,512 | ledger |
| Prompt | 20,700,233 | derived: fresh input + cache read + cache write |
| Cache read share of prompt | 86.5% | derived: cache read / prompt |

## 2. Per Bot

Sorted by prompt. `fresh input` is what was billed as input, not the prompt.

| Bot | Calls | Fresh input | Cache read | Cache write | Output | Prompt | Cache read share | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Reviewer | 60 | 278,429 | 3,462,656 | 0 | 110,959 | 3,741,085 | 92.6% | ledger |
| Dev2 | 71 | 342,097 | 2,775,680 | 0 | 179,829 | 3,117,777 | 89.0% | ledger |
| Dev | 61 | 378,535 | 2,607,104 | 0 | 147,027 | 2,985,639 | 87.3% | ledger |
| Dev3 | 49 | 281,843 | 2,212,736 | 0 | 90,152 | 2,494,579 | 88.7% | ledger |
| Dev4 | 46 | 278,079 | 2,051,072 | 0 | 86,068 | 2,329,151 | 88.1% | ledger |
| Triage | 55 | 252,014 | 1,644,416 | 0 | 102,934 | 1,896,430 | 86.7% | ledger |
| SelfTest | 41 | 281,686 | 1,281,664 | 0 | 74,571 | 1,563,350 | 82.0% | ledger |
| Reviewer2 | 54 | 312,244 | 1,133,440 | 0 | 146,870 | 1,445,684 | 78.4% | ledger |
| Chief | 37 | 154,163 | 497,536 | 0 | 23,293 | 651,699 | 76.3% | ledger |
| Release | 27 | 216,887 | 219,776 | 0 | 66,462 | 436,663 | 50.3% | ledger |
| Architect | 6 | 10,155 | 10,240 | 0 | 204 | 20,395 | 50.2% | ledger |
| Data | 3 | 6,686 | 4,096 | 0 | 83 | 10,782 | 38.0% | ledger |
| Backend | 1 | 3,513 | 0 | 0 | 22 | 3,513 | 0.0% | ledger |
| Frontend | 1 | 3,486 | 0 | 0 | 38 | 3,486 | 0.0% | ledger |

Cache read share on this table is `derived: cache read / prompt`, printed to one decimal. The source cell `ledger` names the stored columns on the same row.

## 3. Per-call prompt

Over all 512 attempts: p50 **14,446**, p90 **215,677**, p99 **250,455**, max 254,350.

| Statistic | Prompt tokens per call | Source |
| --- | --- | --- |
| p50 | 14,446 | ledger |
| p90 | 215,677 | ledger |
| p99 | 250,455 | ledger |
| max | 254,350 | ledger |

## 4. Top Sessions by prompt

A Session is a part of one Bot's conversation. `--top 10` is why this table is the ten largest of the 40; the other 30 Sessions are inside §1's totals.

| Session | Bot | Calls | Prompt | Fresh input | Cache read | Source |
| --- | --- | --- | --- | --- | --- | --- |
| session-93a0c5df-f868-4e53-9355-3c4de83558d8 | Dev3 | 16 | 1,880,031 | 56,927 | 1,823,104 | ledger |
| session-2413164c-97a8-4b25-90c9-493d473567a1 | Dev2 | 13 | 1,387,238 | 46,694 | 1,340,544 | ledger |
| session-ca773597-05e3-46ac-bd16-6fbf752479d7 | Reviewer | 12 | 1,206,284 | 27,788 | 1,178,496 | ledger |
| session-db2b73be-2390-48e0-86d4-294bcb20214c | Dev2 | 8 | 968,194 | 28,802 | 939,392 | ledger |
| session-871f0ec1-3729-476a-89ce-fd195363b946 | Dev | 8 | 950,157 | 26,509 | 923,648 | ledger |
| session-901eefb6-cd02-4992-a861-28e9c3ee4d72 | Dev2 | 50 | 762,345 | 266,601 | 495,744 | ledger |
| session-9b6da835-e554-45c4-a020-23f50082f3d5 | Dev4 | 6 | 745,658 | 24,250 | 721,408 | ledger |
| session-f42ca099-9e25-46f8-a517-147f38b6bd92 | Reviewer2 | 48 | 742,717 | 291,133 | 451,584 | ledger |
| session-16faf06b-00ba-4be5-88ed-2dc6c9870af4 | Dev4 | 6 | 731,564 | 21,932 | 709,632 | ledger |
| session-d1512a81-8d1c-4a98-82fc-c2cfecf9c725 | Reviewer | 6 | 729,099 | 20,875 | 708,224 | ledger |

## 5. Per day

Days are in `Asia/Shanghai` (`--tz`). The window holds two local days.

| Day | Calls | Fresh input | Cache read | Cache write | Output | Prompt | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-24 | 337 | 1,782,103 | 11,105,280 | 0 | 743,831 | 12,887,383 | ledger |
| 2026-10-25 | 175 | 1,017,714 | 6,795,136 | 0 | 284,681 | 7,812,850 | ledger |

## 6. Prompt growth per Session

Across every Session, between comparable calls: 344 deltas, median **248** tokens, p90 **217,589**, with 128 compaction or new-part boundaries excluded (`resets`).

| Measure | Deltas | Median delta | p90 delta | Source |
| --- | --- | --- | --- | --- |
| All Sessions, comparable calls | 344 | 248 | 217,589 | derived: consecutive turn prompts in one Session, split where the prompt falls |
| Compaction boundaries excluded | 128 | not applicable | not applicable | derived: a prompt smaller than the previous call in the same Session |

The five Sessions in §4, one line each. `--growth 5` is why this table is five and not all 40.

| Session | Bot | Calls | Deltas | Median delta | p90 delta | Resets | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| session-93a0c5df-f868-4e53-9355-3c4de83558d8 | Dev3 | 16 | 8 | 212,841 | 248,787 | 7 | derived: consecutive turn prompts in one Session |
| session-2413164c-97a8-4b25-90c9-493d473567a1 | Dev2 | 13 | 6 | 211,589 | 244,796 | 6 | derived: consecutive turn prompts in one Session |
| session-ca773597-05e3-46ac-bd16-6fbf752479d7 | Reviewer | 12 | 7 | 230,217 | 249,870 | 4 | derived: consecutive turn prompts in one Session |
| session-db2b73be-2390-48e0-86d4-294bcb20214c | Dev2 | 8 | 4 | 219,597 | 244,560 | 3 | derived: consecutive turn prompts in one Session |
| session-871f0ec1-3729-476a-89ce-fd195363b946 | Dev | 8 | 4 | 221,238 | 237,899 | 3 | derived: consecutive turn prompts in one Session |

## Comparison with the 2026-10-23 page

The five measures the two pages share. **Every delta is `not comparable`**, and no percent change is printed.

| Measure | 2026-10-23 | 2026-10-25 (this page) | Delta |
| --- | --- | --- | --- |
| Billed calls | 16,407 | 512 | not comparable |
| p50 prompt per call | 129,242 | 14,446 | not comparable |
| p90 prompt per call | 210,628 | 215,677 | not comparable |
| p99 prompt per call | 244,885 | 250,455 | not comparable |
| Cache read share of prompt | 96.4% | 86.5% | not comparable |

Why, in one place: the two windows do not overlap — the 2026-10-23 page ends at `2026-10-23T17:50:56Z`, and this window's first call is `2026-10-24T06:51:39.655Z`. On this host the p50 of the two windows differs by an order of magnitude (129,242 → 14,446) while p90 and p99 barely move (210,628/244,885 → 215,677/250,455). That shape is a different blend of calls, not fewer tokens per turn: this window is mostly grown team calls with a small tail of first-of-run calls, while the 10-23 page was read on another host with another team mix. Subtracting the two would print a fake saving, so the Delta cell says `not comparable` and no number is given. [`#796`](https://github.com/ThinkFlowLab/FlyBot/issues/796) savings acceptance stays open and is not claimed by these figures.

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

Where this window's prompt sits among fixed overhead, history, tool results and the task is not known from the ledger JSON.

## What this report does not say

- It is this host's own ledger, not a rebaseline: no delta and no percent change against the 2026-10-23 page is stated, and the Comparison rows say `not comparable` with the reason.
- It proposes no saving. [#796](https://github.com/ThinkFlowLab/FlyBot/issues/796) savings acceptance stays open and is not claimed by these figures.
- It does not compare models or providers; it names the two routes the ledger recorded (`opencsitool` / `DeepSeek-V4.1-Flash-1017`, `volc` / `deepseek-v4-1-flash-economy-261017`) and no per-route split.
- Cache read tokens are counted at face value, as the ledger stores them. Their price is not applied: the ledger has no cost column.
- It does not adopt the mock-model character counts recorded on #897 and #898.

## Provenance

- `ledger` — a column of the ledger snapshot, summed or listed here.
- `derived: <formula>` — computed from that snapshot by the formula named in the row. Cache-read shares use one decimal, as `token-report.mjs` prints them. `not applicable` on the compaction-boundary row is the method: a reset is a boundary, not a delta.
- `not comparable` — a cell in the Comparison table where the two windows do not measure the same thing; the reason is in the last column, never a number.
- `not measured` — no number exists for it in this sample; the row says what would produce one.

Every row of every table above carries its provenance in the last cell. `core/test/token-report.test.js` checks that rule on `docs/reports/2026-10-23-token-spend.md`. This file uses the same last-column vocabulary (`ledger`, `derived: …`, `not comparable`, `not measured`).
