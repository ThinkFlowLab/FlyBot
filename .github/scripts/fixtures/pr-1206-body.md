Owner: Dev
Reviewer: Reviewer
Base: 4f164e04edb66b6768f93fbf4226c6095451f3b7
Tip SHA: e719e9fbf7444d0159b8e27ce803d1c1a8ef7617
Fixes #1201
Docs-not-needed: docs/subsystems/core-host.md already states this model for the window (wall clock, a task's due time read in its own zone, compared as instants, :378-381) and names core/src/shared/quiet-hours.js in the file table (:46). This PR only brings the module header in line with the page; the page text does not change.

## What changed

`core/src/shared/quiet-hours.js` line 1 opened with "A window in the team's own clock" — the exact claim `#1199` removed from `docs/subsystems/core-host.md:378`. The window's `from`/`to` are wall-clock strings with no zone; a task's due time is read in **that task's own zone** (`core-host.md:381`), so the two are compared as instants. A reader of the module met the old, wrong model first.

Before (4 lines) / after (5 lines), same facts kept (not a mute, no pre-delivery hook, an existing task keeps firing):

```
- // Team quiet hours (#1166, the E half of #645). A window in the team's own clock that
- // refuses a new or edited task whose time lands inside it. It is not a mute: nothing here
+ // Team quiet hours (#1166, the E half of #645). A window in wall-clock time that refuses a
+ // new or edited task whose time lands inside it; a due time is read in that task's own zone,
+ // so the two are compared as instants (#1199). It is not a mute: nothing here runs when a
```

Nothing else in the file changes (the half-open `[from, to)` paragraph and the code below are byte-identical). `patches/ds-bot/files/src/shared/quiet-hours.js` is the mirror of this FlyBot-added file and moves with it, byte for byte.

## Verification at the tip

Tip SHA: e719e9fbf7444d0159b8e27ce803d1c1a8ef7617

Ran (`TZ=UTC`, `DSH_HARNESS` at the local DSH install, tree extracted from main `4f164e04`):
```
node scripts/ds-bot-patches.mjs check   -> skipped pin (no git); ok 10 patches apply cleanly in order; ok core/ equals ds-bot/ + patches/ds-bot/   [exit 0]
cd core && node --import ./test/harness-resolve.mjs --test --test-concurrency=1 test/quiet-hours.test.js
                                        -> 9 pass / 0 fail
grep -c "team's own clock" core/src/shared/quiet-hours.js -> 0
diff vs main: core/src/shared/quiet-hours.js +5/-4, patches/ds-bot/files/src/shared/quiet-hours.js +5/-4, nothing else
```

Knife (measured, not assumed): with `core/` keeping the new header, restoring main's copy into `patches/ds-bot/files/src/shared/quiet-hours.js` makes `check` exit 1 — `core/src/shared/quiet-hours.js: differs from ds-bot/ + patches`. Restoring the mirror gives exit 0 again. That is the load-bearing step of this card (the mirror is what `package` rebuilds from).

Not run (and why):
- No test can red for a comment: there is no behavior to assert. The mirror knife above is the red/green this card actually has.
- `core/scripts/build-client.mjs --check` is not needed: this module is host-only (`core/src/host/schedules.js:27`, `core/src/host/channel.js:8`); `grep -c "Team quiet hours" core/client.js` is 0, so the bundle cannot carry the comment.
- No changelog fragment: no user-visible behavior changes, and the wording it aligns to already shipped in `#1199` with its own fragment.

## Checkpoint
<!-- flybot:checkpoint -->
```json
{
  "pr": 1206,
  "claim": "Dev",
  "issue": 1201,
  "summary": "The header comment in core/src/shared/quiet-hours.js called the window \"the team's own clock\". It now states the model core/subsystems/core-host.md already carried: wall clock, a task's due time read in its own zone, compared as instants. The mirror under patches/ds-bot/files/ moved with it, byte for byte. Nothing else in the file changed.",
  "files": [
    "core/src/shared/quiet-hours.js",
    "patches/ds-bot/files/src/shared/quiet-hours.js"
  ],
  "checks": {
    "ran": "node scripts/ds-bot-patches.mjs check; quiet-hours.test.js",
    "result": "green",
    "at": "e719e9fbf7444d0159b8e27ce803d1c1a8ef7617"
  },
  "next": "none — ready for review"
}
```
<!-- /flybot:checkpoint -->
