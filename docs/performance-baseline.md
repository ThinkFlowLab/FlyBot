# Performance baseline (#356)

Numbers for how smooth FlyBot is, so a later regression has something to be compared against.
This is a **baseline, not a gate**: nothing here is a threshold, and no check reads it.

It measures the plugin on the **mock bench** (`core/dev/bench.sh` + the scripted model), not a
real model and not a person's machine. The container numbers answer "did the plugin get slower
at its own work"; they do not describe how long a real reply takes, because the model's time is
not in them.

## What is measured

| metric | unit | definition |
| --- | --- | --- |
| turn end-to-end | ms | A message POST to that turn's `turn/end`, read from the same Session events the activity feed folds. It includes the mock delay (`MOCK_DELAY_MS`, 300 ms by default), which is constant, so a change in the number is the plugin's. |
| tool-call latency | ms | `tool/call` to its `tool/result`, per call, in the same events. |
| resident RSS | MB | `VmRSS` of the `dsh` web process started by the bench (`web.pid`, plus its children — the pid is the `pnpm` that starts `dsh`), sampled after ready, during each turn and at the end; the row reports the **peak**. |
| plugin load time | ms | Process start to the `dsh web: http` line in `web.log`, which is the same line `bench.sh` waits on, so it covers every plugin's install. `web.log` is truncated right before the boot, so its birth time is the start; the ready line's moment is the file's mtime, which makes this number an **upper bound**, not an exact figure. |

Samples: 3 warm-up turns and 20 measured turns. Percentiles are nearest rank (`ceil(p/100·n)`,
clamped), so every reported number is a real sample and no interpolation is invented.

The manual items from the issue — scroll feel, background-tab recovery, a 500+ message session —
are **not** measured by the script and are not claimed here. They need a person in front of the
page; this script does not pretend to see them.

## How to run

```sh
cd core
MOCK_DELAY_MS=300 dev/bench.sh perf 3097 8797 reset
node dev/perf-baseline.mjs perf 3097 --out /tmp/perf.json
dev/bench.sh perf 3097 8797 stop
```

Requirements: the bench must stay up (see `docs/sandbox.md`), Node 22+, and a `deepseek-harness`
checkout for `bench.sh` (`DSH_HARNESS` or `../deepseek-harness`). The script exits non-zero when
the bench is down, when a turn times out, or when no turn produced a tool call, and it starts no
process of its own; it only reads the bench and writes the `--out` file.

`--turns` (default 20), `--warmup` (3), `--timeout` (120000 ms) and `--message` (the prompt that
the scripted model answers with one tool call) are overridable. `PERF_COMMIT=<sha>` pins the
commit line when the bench checkout has no `.git` (the bench host runs without git).

## Output

`--out` is JSON and the same table is printed:

```json
{
  "machine": "Linux ...; <CPU>; 8 cores; 31.3 GB RAM",
  "commit": "<40-character sha>",
  "node": "v22.23.3",
  "date": "2026-11-06T16:20:00Z",
  "scenarios": [
    { "metric": "turn end-to-end", "unit": "ms", "samples": 20, "p50": 0, "p95": 0, "peak": 0 }
  ]
}
```

Scenario rows are `turn end-to-end` (ms), `tool-call latency` (ms), `resident RSS` (MB) and
`plugin load time` (ms). Two runs diff cleanly: same keys, same order, one decimal.

## First baseline on the maintenance box

**Not measured yet.** The delivery workflow that wrote this page runs on a host with neither a
`deepseek-harness` checkout nor `pnpm`, so `core/dev/bench.sh` cannot boot a bench there and the
four rows would be invented rather than measured. Recording invented numbers would be worse than
an empty table: the point of this page is that a later run can be compared with it.

The command above is the run to do, and the commit to record is the one that added
`core/dev/perf-baseline.mjs`. The table to fill is:

<!-- Replace this block with the printed table, and keep the machine line it prints. -->

| metric | unit | samples | p50 | p95 | peak |
| --- | --- | --- | --- | --- | --- |
| turn end-to-end | ms | — | — | — | — |
| tool-call latency | ms | — | — | — | — |
| resident RSS | MB | — | — | — | — |
| plugin load time | ms | — | — | — | — |

Machine: —. Commit: —. Node: —. Date: —.

## Metrics to record on each daily tag (#351)

Four numbers, the ones above — they are cheap to produce and each one moves for a different
reason:

1. **turn end-to-end p50/p95** — the plugin's own work per turn, with the mock delay constant.
2. **tool-call latency p50/p95** — the tool plumbing, which is where a slow permission check or a
   blocking file read would show up first.
3. **resident RSS peak** — memory that grows across turns even though the Session was reset.
4. **plugin load time** — every plugin's install bundled into one number, the cost a user pays
   once per launch.

No thresholds: the daily tag records the numbers, and a person decides when a move is a
regression.
