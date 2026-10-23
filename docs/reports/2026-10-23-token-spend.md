# Token spend per Bot turn

Measured 2026-10-23 from this host's usage ledger, for [#799](https://github.com/ThinkFlowLab/FlyBot/issues/799) — the measuring half of [#796](https://github.com/ThinkFlowLab/FlyBot/issues/796). This report changes nothing that is sent to a model: no prompt, notice, roster, memory or tool-output edit. Its purpose is a number that a later saving can be compared against.

The ledger already existed (`core/src/host/usage.js`, one row per billed attempt at `$DSH_HOME/usage.sqlite`). What was missing was a reader outside the Usage page; that is `core/dev/token-report.mjs`, and the commands below reproduce every table.

## Sample

| Item | Value | Source |
| --- | --- | --- |
| Ledger snapshot | a copy of `$DSH_HOME/usage.sqlite` (data file plus `-wal` and `-shm`) taken before reading | ledger |
| Window | 2026-10-20T07:34:24.425Z .. 2026-10-23T02:06:18.388Z | ledger |
| Billed attempts | 16,407 | ledger |
| Sessions with calls | 71 | ledger |
| Bots (owners) named in the ledger | 79, of which 26 have calls in the window | ledger |
| Cache writes | 0 in every row — this provider reports none, so that column proves nothing here | ledger |

Reading a live ledger twice gives two different answers: a Bot's own turn writes rows while the report runs. The snapshot above is a file copy, so the numbers are stable, and they will not equal a later run.

## Method

Fresh input, cache read and cache write are never added into one another. `prompt` is their sum and is always its own column, because a cached token and a fresh input token are not the same cost and a saving that only moves tokens between the columns would otherwise look real ([#796](https://github.com/ThinkFlowLab/FlyBot/issues/796)).

Percentiles are nearest-rank: the ascending value at `ceil(p/100 × n) - 1`, so the p99 of a small sample is its maximum. Percentiles are computed per call over every attempt in the window.

Growth is measured inside one Session, between consecutive calls, and only within a run: a smaller prompt means a compaction, a checkpoint or a new part, so that crossing starts a new run and contributes no delta. `resets` counts those boundaries.

```sh
# 1. Snapshot the live ledger (read it only after copying all three files).
mkdir -p /tmp/token-report && cp "$DSH_HOME"/usage.sqlite* /tmp/token-report/

# 2. Every table below.
node core/dev/token-report.mjs --db /tmp/token-report/usage.sqlite --tz Asia/Shanghai --top 10

# 3. The same numbers as JSON, which is what the committed test asserts against a fixture.
node core/dev/token-report.mjs --db /tmp/token-report/usage.sqlite --tz Asia/Shanghai --json
```

A missing `--db` is an error that names the path, never an empty table: an empty report is what a broken path looks like.

## 1. Totals

| Measure | Value | Source |
| --- | --- | --- |
| Calls | 16,407 | ledger |
| Fresh input | 77,271,661 | ledger |
| Cache read | 2,040,613,888 | ledger |
| Cache write | 0 | ledger |
| Output | 9,387,044 | ledger |
| Prompt | 2,117,885,549 | derived: fresh input + cache read + cache write |
| Cache read share of prompt | 96.4% | derived: cache read / prompt |

## 2. Per Bot

Sorted by prompt. `fresh input` is what was billed as input, not the prompt.

| Bot | Calls | Fresh input | Cache read | Cache write | Output | Prompt | Cache read share | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dev | 3,183 | 8,787,133 | 430,347,136 | 0 | 1,688,487 | 439,134,269 | 98.0% | ledger |
| Reviewer | 2,860 | 9,573,425 | 379,113,088 | 0 | 1,650,023 | 388,686,513 | 97.5% | ledger |
| Chief | 1,964 | 13,328,314 | 223,369,344 | 0 | 1,302,937 | 236,697,658 | 94.4% | ledger |
| Dev2 | 1,315 | 4,287,480 | 188,972,416 | 0 | 727,043 | 193,259,896 | 97.8% | ledger |
| Maintainer | 1,415 | 2,932,025 | 180,925,184 | 0 | 797,996 | 183,857,209 | 98.4% | ledger |
| Dev4 | 1,042 | 3,501,801 | 145,925,120 | 0 | 548,749 | 149,426,921 | 97.7% | ledger |
| Dev3 | 1,012 | 2,711,898 | 138,261,632 | 0 | 558,353 | 140,973,530 | 98.1% | ledger |
| Triage | 1,122 | 6,168,230 | 123,720,320 | 0 | 778,220 | 129,888,550 | 95.3% | ledger |
| SelfTest | 623 | 3,042,507 | 67,570,560 | 0 | 410,561 | 70,613,067 | 95.7% | ledger |
| Backend | 610 | 13,655,841 | 51,881,216 | 0 | 262,757 | 65,537,057 | 79.2% | ledger |
| FlyBot 实现 Lead | 485 | 5,504,028 | 41,257,728 | 0 | 229,462 | 46,761,756 | 88.2% | ledger |
| Reviewer2 | 304 | 875,004 | 41,567,872 | 0 | 160,956 | 42,442,876 | 97.9% | ledger |
| Release | 141 | 1,018,807 | 10,018,304 | 0 | 83,230 | 11,037,111 | 90.8% | ledger |
| Ops | 111 | 469,060 | 7,176,192 | 0 | 47,229 | 7,645,252 | 93.9% | ledger |
| Docs | 74 | 253,671 | 4,759,040 | 0 | 62,428 | 5,012,711 | 94.9% | ledger |
| QA | 95 | 727,859 | 3,807,104 | 0 | 45,222 | 4,534,963 | 84.0% | ledger |
| Inbox | 15 | 136,289 | 1,116,672 | 0 | 20,257 | 1,252,961 | 89.1% | ledger |
| Reviewer Lead | 13 | 71,253 | 586,496 | 0 | 8,106 | 657,749 | 89.2% | ledger |
| Architect | 12 | 101,114 | 206,976 | 0 | 3,681 | 308,090 | 67.2% | ledger |
| UI | 5 | 16,773 | 31,488 | 0 | 526 | 48,261 | 65.2% | ledger |
| Research Lead | 1 | 32,767 | 0 | 0 | 16 | 32,767 | 0.0% | ledger |
| Frontend | 1 | 15,303 | 0 | 0 | 263 | 15,303 | 0.0% | ledger |
| Security | 1 | 15,274 | 0 | 0 | 58 | 15,274 | 0.0% | ledger |
| Scout | 1 | 15,273 | 0 | 0 | 84 | 15,273 | 0.0% | ledger |
| Data | 1 | 15,266 | 0 | 0 | 200 | 15,266 | 0.0% | ledger |
| Performance | 1 | 15,266 | 0 | 0 | 200 | 15,266 | 0.0% | ledger |

The Bots with one or five calls are freshly created tree members: their Sessions have not yet grown, which is why their cache read share is zero or small rather than a property of how they work.

## 3. Per-call prompt

Over all 16,407 attempts: p50 **129,242**, p90 **210,628**, p99 **244,885**, max 282,000.

| Statistic | Prompt tokens per call | Source |
| --- | --- | --- |
| p50 | 129,242 | ledger |
| p90 | 210,628 | ledger |
| p99 | 244,885 | ledger |
| max | 282,000 | ledger |

## 4. Top Sessions by prompt

A Session is a part of one Bot's conversation; the top ones are the long-running chats, not the ones with the most calls per unit of time.

| Session | Bot | Calls | Prompt | Fresh input | Cache read | Source |
| --- | --- | --- | --- | --- | --- | --- |
| session-a7e7bb0b-e497-46ff-aeee-c23b8ceaf7fb | Chief | 1,495 | 182,599,188 | 8,045,460 | 174,553,728 | ledger |
| session-8e806e1f-a606-485e-96b6-696b8d6ddcf5 | Dev | 953 | 142,729,431 | 2,474,967 | 140,254,464 | ledger |
| session-7c0d0937-9ca9-44c4-9bdd-f8324b0d8814 | Reviewer | 932 | 136,893,497 | 1,732,921 | 135,160,576 | ledger |
| session-c8657b99-1f73-40e2-bec5-0461b541122c | Dev2 | 837 | 125,441,718 | 3,462,966 | 121,978,752 | ledger |
| session-5bfa0d6a-bcfb-4d77-90fa-522eeec31de4 | Dev4 | 838 | 121,480,013 | 3,194,189 | 118,285,824 | ledger |
| session-172bbf6c-5e9b-410f-b726-359e917f9086 | Maintainer | 733 | 99,600,738 | 1,519,074 | 98,081,664 | ledger |
| session-8bb2d67d-78dc-41a2-a911-aaae21dc6049 | Dev | 619 | 87,689,234 | 1,607,698 | 86,081,536 | ledger |
| session-ecb1913f-13ee-41de-a5bb-42cab93d5241 | Dev3 | 590 | 80,668,216 | 1,788,600 | 78,879,616 | ledger |
| session-efe31685-4244-4431-b4ac-a338dd4d5ef9 | Dev | 583 | 80,128,667 | 1,987,739 | 78,140,928 | ledger |
| session-282f65cb-759c-40cd-bb8b-7691aa8d38d0 | Dev2 | 477 | 67,783,503 | 789,839 | 66,993,664 | ledger |

## 5. Per day

Days are in `Asia/Shanghai` (`--tz`), not UTC. 2026-10-20 starts at 15:34 local, which is why it has 486 calls.

| Day | Calls | Fresh input | Cache read | Cache write | Output | Prompt | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-20 | 486 | 2,341,141 | 39,095,680 | 0 | 302,233 | 41,436,821 | ledger |
| 2026-10-21 | 5,595 | 33,897,488 | 614,389,504 | 0 | 3,203,008 | 648,286,992 | ledger |
| 2026-10-22 | 10,295 | 40,987,551 | 1,385,137,024 | 0 | 5,864,278 | 1,426,124,575 | ledger |
| 2026-10-23 | 31 | 45,481 | 1,991,680 | 0 | 17,525 | 2,037,161 | ledger |

The 2026-10-23 row is 2 hours long; it is the start of the day, not a drop in spend.

## 6. Prompt growth per Session

Across every Session, between comparable calls: 15,653 deltas, median **+804** tokens, p90 **+3,021**, with 683 compaction or new-part boundaries excluded (`resets`).

| Measure | Deltas | Median delta | p90 delta | Source |
| --- | --- | --- | --- | --- |
| All Sessions, comparable calls | 15,653 | 804 | 3,021 | derived: consecutive turn prompts in one Session, split where the prompt falls |
| Compaction boundaries excluded | 683 | not applicable | not applicable | derived: a prompt smaller than the previous call in the same Session |

The per-Session curve, for the Sessions with the most prompt:

| Session | Bot | Calls | Deltas | Median delta | p90 delta | Resets | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| session-a7e7bb0b-e497-46ff-aeee-c23b8ceaf7fb | Chief | 1,495 | 1,382 | 1,142 | 3,426 | 112 | derived: consecutive turn prompts in one Session |
| session-8e806e1f-a606-485e-96b6-696b8d6ddcf5 | Dev | 953 | 935 | 754 | 2,738 | 17 | derived: consecutive turn prompts in one Session |
| session-7c0d0937-9ca9-44c4-9bdd-f8324b0d8814 | Reviewer | 932 | 916 | 872 | 2,603 | 15 | derived: consecutive turn prompts in one Session |
| session-c8657b99-1f73-40e2-bec5-0461b541122c | Dev2 | 837 | 825 | 687 | 2,348 | 11 | derived: consecutive turn prompts in one Session |
| session-5bfa0d6a-bcfb-4d77-90fa-522eeec31de4 | Dev4 | 838 | 828 | 711 | 2,577 | 9 | derived: consecutive turn prompts in one Session |
| session-172bbf6c-5e9b-410f-b726-359e917f9086 | Maintainer | 733 | 715 | 740 | 2,416 | 17 | derived: consecutive turn prompts in one Session |
| session-8bb2d67d-78dc-41a2-a911-aaae21dc6049 | Dev | 619 | 611 | 752 | 2,424 | 7 | derived: consecutive turn prompts in one Session |
| session-ecb1913f-13ee-41de-a5bb-42cab93d5241 | Dev3 | 590 | 582 | 660 | 2,364 | 7 | derived: consecutive turn prompts in one Session |

Each delta is the prompt growth of one turn, so a median of ~800 tokens per turn against a p50 prompt of ~129,000 tokens says where the spend is: a turn costs its whole history again, not the ~800 tokens it adds. Whether a given saving helps is a question about the other ~128,000.

## 7. Composition: fixed overhead / history / tool results / task

**Not measured on this host.** The ledger stores the prompt total and its three columns; it does not store the request, so it cannot split the prompt into the group notice, the roster, the memory, the earlier turns, the tool results and the current task. That split needs one dumped request body per sampled turn and one ablated replay per category through `core/dev/llm-tap.mjs` with a real provider call, which needs a provider key and dumped bodies — neither exists on this host (no `llm-tap` log or body directory, and the provider key is not readable by this Bot). No number is printed for a category rather than showing an estimate as if it were measured.

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

Until that exists, the safest reading of the measured columns is that history re-read is 96.4% of the prompt and therefore the largest single thing being paid for; where the remaining 3.6% sits among fixed overhead, tool results and the task is not known from this ledger.

## What this report does not say

- It proposes no saving. `#796` owns the decision about which saving to take; this issue owns the number to compare it against.
- It does not compare models or providers. The 20 Bots moved from `volc` to `opencsitool` during the window, so a per-model split would compare two partial samples, not two policies.
- Cache read tokens are counted at face value, as the ledger stores them. Their price is not applied: the ledger has no cost column, and every provider route prices them differently.

## Provenance

- `ledger` — a column the ledger stores, summed or listed here.
- `derived: <formula>` — computed from ledger columns by the formula named in the row.
- `not measured` — no number exists for it in this sample; the row says what would produce one.

Every row of every table above carries its provenance, and `core/test/token-report.test.js` fails if a row stops carrying it.
