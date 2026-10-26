# One turn's input, split by part

**This host, 2026-10-26.** [#796](https://github.com/ThinkFlowLab/FlyBot/issues/796) asked where a turn's input tokens go: the fixed prompt, the history, the tool results, the task. The [2026-10-25 page](2026-10-25-token-spend.md) answered the ledger questions and said the composition was **not measured**, because the ledger's own JSON holds the prompt total and no request. This page measures it: the DSH Session logs carry the exact surface each call sent (the surviving system prompt, the `request/header` tool list, every message and every `tool/result`) together with the provider's own `usage` for that call, so the split can be read per call without a replay.

Nothing here changes what is sent to a model. No prompt, notice, roster, memory or tool output was edited to produce these numbers.

## Run

- Label: one real turn, this host's own Session logs
- Host: `DSH_HOME=/data/dsh`; logs under `/data/dsh/sessions/--data-dsh-bot-workspace--/`
- FlyBot: this PR's head on `dev/796-turn-input-split`, on base `d04712bbb3cc48b09cf1645341adcb687631d6d0` — the tree the reader ran from is **this PR's head**, not the base: `core/dev/turn-split.mjs` does not exist on `d04712bb`.
- DSH: 0.2.0-rc.2 harness (`@deepseek-ai/dsh` 0.2.1-rc.2)
- Route: `opencsitool` / `DeepSeek-V4.1-Flash-1017`
- Sample: 165 Session artifacts, `2026-10-20T07:34:24Z .. 2026-10-26T05:05Z`; 137 of them carry enough calls for a fixed-block fit

## Method

Every Session log records, per settled call, the provider's `usage` chunk (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`) and the surface that call sent. Fresh input, cache read and cache write are never added into one another: `prompt` is their sum and stays its own column.

The four parts:

| Part | What it is | Source |
| --- | --- | --- |
| Fixed block | the surviving `system/message` plus the `request/header` tool list | measured: the intercept of one Session's fit, `prompt = fixed + k × messageChars`, over its own provider-reported prompts |
| History | earlier assistant text and every user message of earlier turns | derived: its character share of what is left after the fixed block |
| Tool results | every `tool/result` content on the surface | derived: its character share of what is left after the fixed block |
| Task | the user/runtime/time messages admitted when the turn opened | derived: its character share of what is left after the fixed block |

The intercept is the fixed block because it is constant for every call of one Session while the message characters vary. Across the 137 fitted Sessions the fit explains the data well (R² p50 **0.986**, p10 0.921), so the split is anchored on measured prompts, not on a characters-per-token guess. A character count is printed as a character count; a per-part token figure is `derived` and says so.

```sh
# the day table and the fixed block, one line per local day
node core/dev/turn-split.mjs --sessions /data/dsh/sessions --tz Asia/Shanghai --days

# one real turn, and the surface of its last call
node core/dev/turn-split.mjs --sessions /data/dsh/sessions \
  --session session-2413164c --turn 62 --top 1
```

The same fold is what `core/dev/turn-split.mjs` implements; `core/test/turn-split.test.js` pins the four rules that matter (a tool result is never history, a turn's own messages are its task, the fit recovers a known intercept, a split never claims the fixed block twice).

On this host the usage ledger (`/data/dsh/bot/usage.sqlite`) holds only the calls made outside a Session — 944 rows, all `memory`, `compaction` or `image` — so the per-turn numbers come from the logs' provider usage, which is the same source the ledger folds Session calls from.

## 1. The days

`--days`, zone `Asia/Shanghai`, every Session artifact on this host. Fresh input, cache read and output are the provider's own columns; the fixed share is `Σ fixed / Σ prompt` with each call's fixed block from its Session's fit.

That share is a **lower bound**: a Session with no usable fit (fewer than eight calls, or no variation in its message characters — 137 of the 165 artifacts here have one) contributes every call to `prompt` and **0** to `fixed`, so the share can only be understated by the Sessions the fit does not reach.

| Day | Calls | Prompt | Fresh input | Cache read | Cache write | Output | Fixed share | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-20 | 453 | 41,165,813 | 2,292,597 | 38,873,216 | 0 | 287,983 | 34.4% | provider usage |
| 2026-10-21 | 4,993 | 640,046,030 | 33,714,382 | 606,331,648 | 0 | 3,111,678 | 36.0% | provider usage |
| 2026-10-22 | 10,031 | 1,411,115,770 | 40,504,954 | 1,370,610,816 | 0 | 5,649,482 | 35.5% | provider usage |
| 2026-10-23 | 10,747 | 1,591,205,919 | 28,640,799 | 1,562,565,120 | 0 | 6,233,105 | 34.6% | provider usage |
| 2026-10-24 | 8,946 | 1,304,251,151 | 22,564,495 | 1,281,686,656 | 0 | 5,086,165 | 35.9% | provider usage |
| 2026-10-25 | 11,131 | 1,645,130,705 | 26,546,513 | 1,618,584,192 | 0 | 5,869,633 | 36.5% | provider usage |
| 2026-10-26 (partial) | 5,881 | 877,351,671 | 18,430,071 | 858,921,600 | 0 | 3,447,510 | 35.3% | provider usage |

A working day is **~1.6 billion prompt tokens**, of which **~36%** is the same fixed block re-sent on every call. Cache reads are 98% of it: the block is cheap per token, but it is paid on every call of every turn.

## 2. The fixed block, per call

137 Sessions fit; the block is the intercept of each one.

| Statistic | p10 | p50 | p90 | Source |
| --- | --- | --- | --- | --- |
| Fixed tokens per call | 34,210 | 48,583 | 56,239 | derived: intercept of the Session's prompt fit |
| Fixed characters per call | 125,377 | 132,270 | 142,655 | measured: system prompt + tool schemas on the surface |
| Message characters per token | 2.85 | 3.32 | 3.62 | derived: 1 / slope of the same fit |
| Fit R² | 0.921 | 0.986 | 0.995 | derived: least squares over the Session's calls |

The fixed block is dense — 2.7 characters per token against 3.32 for the messages — because it is mostly a JSON tool schema plus a Chinese system prompt: no prose padding to average out.

## 3. One real turn

Turn 62 of `session-2413164c` (Dev2, group **FlyBot 交付组**), `2026-10-25T10:01:33.511Z .. 10:14:17.073Z` — 12.7 minutes, 125 tool calls (117 `bash`), opened by a 225-character `[Continue task]` card.

| Measure | Value | Source |
| --- | --- | --- |
| Calls | 124 | provider usage |
| Prompt, whole turn | 17,538,593 | provider usage |
| Prompt per call | 141,440 | derived: prompt / calls |
| Output, whole turn | 49,804 | provider usage |
| First call prompt | 215,263 | provider usage |
| Largest call prompt | 248,706 (call 30) | provider usage |
| Last call prompt | 156,754 | provider usage |

The turn's own split:

| Part | Tokens | Share | Source |
| --- | --- | --- | --- |
| Fixed block | 7,184,620 | 41.0% | derived: 57,940 × 124 calls (fit intercept) |
| History | 5,087,027 | 29.0% | derived: character share of prompt − fixed |
| Tool results | 4,222,042 | 24.1% | derived: character share of prompt − fixed |
| Task | 1,044,904 | 6.0% | derived: character share of prompt − fixed |
| Sum | 17,538,593 | 100.0% | provider usage |

On the largest call (248,706 tokens) the split is fixed **57,940** (23.3%), history **121,005** (48.6%), tool results **69,694** (28.0%), task **66** (0.03%). The bigger the call, the smaller the fixed block's share — and the larger the price of everything the turn has already read.

## 4. What the fixed block is made of

The same turn's surface, last call. Characters are measured; the token column splits the measured fixed block (57,940 tokens) by character share.

| Piece | Characters | Tokens (derived) | Source |
| --- | --- | --- | --- |
| Tool schemas (113 tools) | 115,020 | 45,596 | measured: characters on the surface |
| System prompt, total | 31,138 | 12,344 | measured: characters on the surface |
| — How your Bot team works | 8,980 | 3,560 | measured: characters on the surface |
| — Team memory (`team/MEMORY.md`) | 6,891 | 2,732 | measured: characters on the surface |
| — MCP resource servers (tool docs) | 4,636 | 1,838 | measured: characters on the surface |
| — `MEMORY.md` | 3,992 | 1,583 | measured: characters on the surface |
| — This group chat (notice, roster, order) | 2,588 | 1,026 | measured: characters on the surface |
| — Your memory (header and rules) | 2,168 | 859 | measured: characters on the surface |
| — Your identity | 1,763 | 699 | measured: characters on the surface |
| — preamble | 121 | 48 | measured: characters on the surface |

The tool schemas are **79%** of the fixed block's characters. The group notice plus roster plus speaking order is 2,588 characters — 8% of the system prompt and 1.8% of the whole fixed block. The part people assume is expensive is the small part. Memory (own + team) is 13,051 characters, 42% of the system prompt.

## 5. Tool results

| Measure | Value | Source |
| --- | --- | --- |
| Tool results in the turn | 125 | measured: `tool/result` count |
| Characters added across the turn | 228,571 | measured: sum of `tool/result` content |
| Still on the last call's surface | 160,307 | measured: the checkpoint dropped the rest |
| Largest single result | 25,541 | measured: one `bash` output |
| Share of `bash` | 98.5% | derived: 225,095 / 228,571 |
| Carried in the turn's prompts | 4,222,042 tokens | derived: character share of prompt − fixed |

One 25,541-character `bash` result is re-read on every later call of the turn. The turn ran 117 shell commands; that is where the 24% of prompt tokens under "tool results" comes from, not from the GitHub connector (2,278 characters in this turn).

## 6. Growth and the checkpoint

Same turn, prompt per call (every 10th call, plus the checkpoint):

| Call | Prompt | Source |
| --- | --- | --- |
| 1 | 215,263 | provider usage |
| 10 | 225,840 | provider usage |
| 20 | 239,531 | provider usage |
| 30 | 248,706 | provider usage |
| 31 (checkpoint) | 58,844 | provider usage |
| 61 | 103,339 | provider usage |
| 91 | 119,876 | provider usage |
| 124 | 156,754 | provider usage |

Growth is +33,443 tokens over the first 29 calls (+1,153 per call); the checkpoint at call 31 cuts it by 76.3%, and the surface then grows back at +1,053 per call. Host-wide, the 165 Sessions hold 233 checkpoint boundaries:

| Measure | Value | Source |
| --- | --- | --- |
| Checkpoint boundaries with a call on each side | 233 | measured: `compaction/end` between two calls |
| Prompt before, median | 235,992 | provider usage |
| Prompt after, median | 55,208 | provider usage |
| Drop, median | 76.4% | derived: 1 − after / before |

A checkpoint buys back roughly twenty minutes of growth at this rate; the fixed block is not affected by it at all.

## 7. Fan-out in the group

FlyBot 交付组, 2026-10-25, 511 user messages in the room (one per `turn/start` of the room's own relay Session):

| Measure | p50 | p90 | max | Source |
| --- | --- | --- | --- | --- |
| Member Bots that started a turn within 10 minutes | 6 | 9 | 13 | measured: member Sessions whose log names the room |
| Member turns started within 10 minutes | 13 | 27 | 92 | measured: `turn/start` in those Sessions |
| Calls in the room's member Sessions, whole day | 11,082 | — | — | provider usage |
| Prompt in those calls, whole day | 1,638,385,969 | — | — | provider usage |
| Fixed block in those calls, whole day | 600,005,904 (36.6%) | — | — | derived: Σ fit intercept |
| Fixed block per user message | 1,174,180 | — | — | derived: 600,005,904 / 511 |

One message in the delivery group costs its members **21.7 calls** and **1.17 million fixed-block tokens** on average, before any of them reads the message. The window is 10 minutes and a round can run longer, so the p90 rows over-count overlapping rounds; the day totals do not.

## 8. Retries and repeated work

| Measure | 2026-10-25 | 2026-10-26 (partial) | Source |
| --- | --- | --- | --- |
| `llm/retry` events | 290 | 553 | measured: log events |
| Attempts carrying a non-zero usage chunk | 0 | 0 | measured: `assistant/attempt` usage chunks |
| Attempt records, all days | 2,932 | — | measured: `assistant/attempt` events |

The logs keep one `usage` row per settled call, and an `assistant/attempt` record does carry a usage chunk — with every field zero. Zero usage is what an attempt that never reached the provider reports, so the tokens a retried attempt spent are not reconstructable from this sample; the retry counts are, and they are not zero. The row counts the non-zero chunks, which is why it reads 0.

## What this report does not say

- It proposes no saving. Which of #796's candidates to take is the owner's decision, and every one of them changes what every Bot is sent.
- It is not a price. The logs have no cost column, and a cache read is counted at face value.
- It does not compare with the 2026-10-23 or 2026-10-25 pages: those read `usage.sqlite` over other windows, this reads Session logs; no delta is printed.
- The per-part token split inside a call is `derived` from character share, not an ablated replay. An ablation through `core/dev/llm-tap.mjs` per category remains the only way to price a part without the character model, and it costs one real provider call per variant.
- It does not measure the memory-review or checkpoint model calls (`memory` / `compaction` rows in the ledger); they are outside a Session and outside this sample.

## Provenance

- `provider usage` — a `usage` chunk the provider reported for that call, summed or listed here.
- `measured: <what>` — counted directly in the log (events, characters, tool results); no model involved.
- `derived: <formula>` — computed from the rows by the formula in the cell. Every per-part token figure is derived this way.
- `not measured` — no number exists in this sample for it.

Every row of every table above carries its provenance in the last cell.
