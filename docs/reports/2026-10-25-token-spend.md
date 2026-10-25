# Token spend per Bot turn

**Skeleton, awaiting a ledger run on a DSH host.** Nothing in this page was read from a usage ledger. `$DSH_HOME/usage.sqlite` has not been copied, and `core/dev/token-report.mjs` has not been run for these tables. Every cell that needs a ledger value is `TBD (ledger)`. Until that run replaces the placeholders, these tables are not a baseline.

This is the rebaseline of [2026-10-23-token-spend.md](2026-10-23-token-spend.md) for [#796](https://github.com/ThinkFlowLab/FlyBot/issues/796). [#799](https://github.com/ThinkFlowLab/FlyBot/issues/799) measured a window that ends at 2026-10-23T02:06:18.388Z. Later that day the prompt shape changed (`9fe5c261`, `9f4aa524`); the comparison section below names that shape. The 10-23 figures stay the previous baseline. This page changes nothing that is sent to a model: no prompt, notice, roster, memory or tool-output edit.

## Sample

| Item | Value | Source |
| --- | --- | --- |
| Ledger snapshot | TBD (ledger) — a copy of `$DSH_HOME/usage.sqlite` (data file plus `-wal` and `-shm`) taken before reading | ledger (pending) |
| Window | TBD (ledger) — earliest and latest `calls.time` in that snapshot after the `--from` cut in Method | ledger (pending) |
| Billed attempts | TBD (ledger) | ledger (pending) |
| Sessions with calls | TBD (ledger) | ledger (pending) |
| Bots (owners) named in the ledger | TBD (ledger) | ledger (pending) |
| Cache writes | TBD (ledger) | ledger (pending) |

Reading a live ledger twice gives two different answers: a Bot's own turn writes rows while the report runs. The snapshot above is a file copy, so the numbers are stable, and they will not equal a later run. The snapshot has not been taken for this page.

## Method

Fresh input, cache read and cache write are never added into one another. `prompt` is their sum and is always its own column, because a cached token and a fresh input token are not the same cost and a saving that only moves tokens between the columns would otherwise look real ([#796](https://github.com/ThinkFlowLab/FlyBot/issues/796)).

Percentiles are nearest-rank: the ascending value at `ceil(p/100 × n) - 1`, so the p99 of a small sample is its maximum. Percentiles are computed per call over every attempt in the window.

Growth is measured inside one Session, between consecutive calls, and only within a run: a smaller prompt means a compaction, a checkpoint or a new part, so that crossing starts a new run and contributes no delta. `resets` counts those boundaries.

The sample has to sit on the prompt shape named in the comparison section. `9f4aa524` landed at 2026-10-23T17:50:56Z, which is 2026-10-24T01:50:56 in `Asia/Shanghai`. `--from 2026-10-24` alone starts at local midnight (2026-10-23T16:00:00Z), which is before both commits, so the commands pass the clock time. `--to` is omitted: the reader then includes every later row in the snapshot. That `--from` instant is the commit time on `main`. A host that was still running the previous build after it kept sending the previous shape; this page does not record when a host restarted.

```sh
# 1. Snapshot the live ledger (read it only after copying all three files).
mkdir -p /tmp/token-report && cp "$DSH_HOME"/usage.sqlite* /tmp/token-report/

# 2. Every table below.
node core/dev/token-report.mjs --db /tmp/token-report/usage.sqlite --tz Asia/Shanghai --from 2026-10-24T01:50:56 --top 10

# 3. The same numbers as JSON.
node core/dev/token-report.mjs --db /tmp/token-report/usage.sqlite --tz Asia/Shanghai --from 2026-10-24T01:50:56 --json
```

A missing `--db` is an error that names the path, never an empty table: an empty report is what a broken path looks like.

## 1. Totals

| Measure | Value | Source |
| --- | --- | --- |
| Calls | TBD (ledger) | ledger (pending) |
| Fresh input | TBD (ledger) | ledger (pending) |
| Cache read | TBD (ledger) | ledger (pending) |
| Cache write | TBD (ledger) | ledger (pending) |
| Output | TBD (ledger) | ledger (pending) |
| Prompt | TBD (ledger) | derived: fresh input + cache read + cache write (pending) |
| Cache read share of prompt | TBD (ledger) | derived: cache read / prompt (pending) |

## 2. Per Bot

Sorted by prompt once the ledger is read. `fresh input` is what was billed as input, not the prompt. The row below is a placeholder: the run replaces it with one row per Bot.

| Bot | Calls | Fresh input | Cache read | Cache write | Output | Prompt | Cache read share | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | ledger (pending) |

## 3. Per-call prompt

Over all TBD (ledger) attempts: p50 **TBD (ledger)**, p90 **TBD (ledger)**, p99 **TBD (ledger)**, max TBD (ledger).

| Statistic | Prompt tokens per call | Source |
| --- | --- | --- |
| p50 | TBD (ledger) | ledger (pending) |
| p90 | TBD (ledger) | ledger (pending) |
| p99 | TBD (ledger) | ledger (pending) |
| max | TBD (ledger) | ledger (pending) |

## 4. Top Sessions by prompt

A Session is a part of one Bot's conversation. The row below is a placeholder: `--top 10` replaces it with the Sessions that carry the most prompt. Session ids are not filled in here.

| Session | Bot | Calls | Prompt | Fresh input | Cache read | Source |
| --- | --- | --- | --- | --- | --- | --- |
| TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | ledger (pending) |

## 5. Per day

Days are in `Asia/Shanghai` (`--tz`), not UTC. The row below is a placeholder: the run replaces it with one row per local day in the window.

| Day | Calls | Fresh input | Cache read | Cache write | Output | Prompt | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | ledger (pending) |

## 6. Prompt growth per Session

Across every Session, between comparable calls: TBD (ledger) deltas, median **TBD (ledger)** tokens, p90 **TBD (ledger)**, with TBD (ledger) compaction or new-part boundaries excluded (`resets`).

| Measure | Deltas | Median delta | p90 delta | Source |
| --- | --- | --- | --- | --- |
| All Sessions, comparable calls | TBD (ledger) | TBD (ledger) | TBD (ledger) | derived: consecutive turn prompts in one Session, split where the prompt falls (pending) |
| Compaction boundaries excluded | TBD (ledger) | not applicable | not applicable | derived: a prompt smaller than the previous call in the same Session (pending) |

The per-Session curve, for the Sessions with the most prompt. The row below is a placeholder.

| Session | Bot | Calls | Deltas | Median delta | p90 delta | Resets | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | TBD (ledger) | derived: consecutive turn prompts in one Session (pending) |

## Comparison to 2026-10-23

The 10-23 column is copied from [2026-10-23-token-spend.md](2026-10-23-token-spend.md) (window 2026-10-20T07:34:24.425Z .. 2026-10-23T02:06:18.388Z, 16,407 attempts). It is not re-derived. The rebaseline column and the delta (this window minus that figure) wait on the ledger run above.

| Measure | 2026-10-23 | This rebaseline | Delta | Source |
| --- | --- | --- | --- | --- |
| p50 prompt tokens per call | 129,242 | TBD (ledger) | TBD (ledger) | prior report; ledger (pending) |
| p90 prompt tokens per call | 210,628 | TBD (ledger) | TBD (ledger) | prior report; ledger (pending) |
| p99 prompt tokens per call | 244,885 | TBD (ledger) | TBD (ledger) | prior report; ledger (pending) |
| Cache read share of prompt | 96.4% | TBD (ledger) | TBD (ledger) | prior report; ledger (pending) |
| Median prompt growth per comparable call | 804 | TBD (ledger) | TBD (ledger) | prior report; ledger (pending) |

### Prompt shape after `9fe5c261` and `9f4aa524`

Both commits are on `main` and both are after the 10-23 window. The sample above is the shape they left.

- `9fe5c261` (2026-10-23 17:42:26Z, [#897](https://github.com/ThinkFlowLab/FlyBot/pull/897), fixes #894). A member's group Session keeps the group's fixed rules in the standing system-prompt section `bot-room` (order 10150): the members line or the face roster, `@Name` calls, the notice, the admin note or the face lead / member note, the face routing rule, and the reply rule. DSH renders that section on every model step and re-projects it after a checkpoint or in a new part. A turn carries the round (earlier lines, this round, references, who is working, speaking order, position), a short routing note on a routed face line, and a one-line reply cue. When the notice changed since that member's last turn, the turn says so in one line. Own chats and the relay Session render no section.
- `9f4aa524` (2026-10-23 17:50:56Z, [#898](https://github.com/ThinkFlowLab/FlyBot/pull/898), fixes #895). A tree coordinator's system prompt no longer carries the child-load block (`Child load right now — …`). Renames, roles and other fixed notes still refresh the tree block, and an unchanged block is not rewritten. The coordinator rule says, in fixed words, to call `list_children` before sending a part that more than one child fits, and to prefer an idle or working child to a busy one. `loadLine` remains a helper; the prompt does not call it.

Those two pull requests each recorded a mock-model character count on a fixture workload. Those counts are not copied into the table above.

## 7. Composition: fixed overhead / history / tool results / task

**Not measured on this host.** The ledger stores the prompt total and its three columns; it does not store the request, so it cannot split the prompt into the group notice, the roster, the memory, the earlier turns, the tool results and the current task. That split needs one dumped request body per sampled turn and one ablated replay per category through `core/dev/llm-tap.mjs` with a real provider call, which needs a provider key and dumped bodies. No number is printed for a category.

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

Where a filled prompt sits among fixed overhead, history, tool results and the task is not known from the ledger. The `bot-room` section and the removed child-load line change which of those categories a later replay would be measuring; they do not supply the split.

## What this report does not say

- It is a skeleton. A `TBD (ledger)` cell is not a measurement, and the tables are not a baseline while any of them remain.
- It proposes no saving. [#796](https://github.com/ThinkFlowLab/FlyBot/issues/796) still owns which saving to accept; this page only reserves the number a later saving can be compared against.
- It does not compare models or providers. The ledger columns that would support that split have not been read.
- Cache read tokens, once filled, are counted at face value, as the ledger stores them. Their price is not applied: the ledger has no cost column, and every provider route prices them differently.
- It does not adopt the mock-model character counts recorded on #897 and #898.

## Provenance

- `ledger (pending)` — the row's ledger cells are placeholders. A column the ledger stores will be summed or listed here after the snapshot in Method is read.
- `derived: <formula> (pending)` — the same formula the 2026-10-23 report names, with inputs not yet read. `not applicable` on the compaction-boundary row is the method: a reset is a boundary, not a delta.
- `prior report; ledger (pending)` — the 2026-10-23 column is copied from that report; the rebaseline column and the delta wait on this ledger.
- `not measured` — no number exists for it in this sample; the row says what would produce one. Composition stays here until `llm-tap` and a provider key exist.

Every row of every table above carries its provenance in the last cell. `core/test/token-report.test.js` checks that rule on `docs/reports/2026-10-23-token-spend.md` (last cell `ledger`, `derived: …`, or `not measured`). This skeleton is a separate file. Its pending labels are the same contract with ` (pending)` added, so a later run can keep the column and drop the pending mark when the numbers are real.
