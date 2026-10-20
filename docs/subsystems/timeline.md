---
subsystem: timeline
owned_paths:
  - plugins/timeline/
---

# timeline (`@flybot/timeline`)

Where time goes across the local Bot team (#241). The plugin records Bot turns, tool calls and Bot-to-Bot deliveries from the core's activity feed, keeps a capped trace on disk, and answers the panel's poll on `flybot/timeline/window`. It lives entirely under `plugins/timeline/`.

## Owns

Everything in `plugins/timeline/`: the recorder, the trace file, the read model behind the endpoint and the browser entry (`client.js`: data layer and the panel).

## Does not own

- The activity feed (`flybot.on('turn.start' | …)`) and `flybot.api.handle` → [plugin-runtime](plugin-runtime.md).
- DSH session events: never read here, never patched.
- Install scripts and doctor → [install](install.md).

## Key files

| File | Role |
| --- | --- |
| `plugins/timeline/index.js` | Plugin entry (`flybot-timeline`, injects `flybot`). |
| `plugins/timeline/src/adapter.js` | The only file that knows the `ctx.flybot` shape. |
| `plugins/timeline/src/recorder.js` | Feed events to compact trace records; rebuilds every field from a strict alphabet. |
| `plugins/timeline/src/store.js` | The trace: single writer, write-tmp + fsync + rename, capped segments. |
| `plugins/timeline/src/window.js` | Pure read model: records to lanes, turns, tools, arrows, edges, utilization. |
| `plugins/timeline/client.js` | Browser entry (`@flybot/timeline`): the 2 s poller exposed as `ctx.flybot.timeline`, the geometry functions (`layoutSwimlanes`, `layoutMap`, `waitRows`, `utilizationRows`) and the panel (swimlanes, who waits on whom, utilization), opened from its `flybot.sidebar.section` row, the only entry (not in the + menu, #269). |
| `plugins/timeline/src/sanitize.js` | The cleaners for ids, labels, codes, times, counts. |

## Entry points

- `plugins/timeline/index.js` — loaded as `@flybot/timeline`.
- Endpoint `timeline/window` (wire name `flybot/timeline/window`), registered `{ read: true }` so a read-only host still answers. Body `{ windowMs?, to? }`; window 30 s to 24 h, default 15 min.

## Invariants

1. Timeline code stays inside `plugins/timeline/`. Events come only from `ctx.flybot` (the activity feed); it never subscribes to DSH `session/event`, never edits `ds-bot/` or `core/src/`. Runtime sources import only this package, Node builtins or `ds-bot` (#153, enforced by `scripts/lint-plugins.mjs`).
2. Metadata only. A trace record holds ids, times, outcomes, tool names, message lengths, cleaned Bot/group names and the model a turn ran on (`te.md`, `provider/model` from the feed's `turn.end.model`, #366). Never message text, tool arguments or tool output; the feed does not carry them and the recorder would not copy them. Tests assert that a secret in any of those never reaches the trace file.
3. Untrusted strings are rebuilt at the plugin's own boundary (`sanitize.js`) on the way in and again on the way out (`window.js`): ids and codes from strict patterns, labels stripped of control and bidi characters, markup brackets and `untrusted` fence markers (also when split or spaced out), and length-capped. An error code is an upper-case word or `UNKNOWN`.
4. Write discipline matches `dev/interop/journal.mjs`: one writer (`writer.lock`, refused again inside one process), a segment is only replaced whole (tmp, fsync, rename, directory fsync). The trace is capped at 3 segments of 2000 records (about 3000 spans) and 24 hours, whichever comes first. A second dsh on the same directory, or an unwritable directory, records in memory only and says so in the response (`trace.persisting`).
5. Honest numbers. "Delivered" is when a message reached the recipient's log; there are no read stamps. "Idle" means no running turn; a Bot waiting on a model call or a slow tool is busy. "Model" time is turn time outside tool calls (queueing and host overhead included), not a measured model latency. A turn an earlier run left open is closed at the last record before the restart and marked `lost`. "You asked" latency is the length of the turn it started.
6. A friend's Bot is a lane of its own, never a Bot of the local team (#248): it shows as a `friend` lane (its chat's name, else its handle) with messages only. The local side of a friend chat runs no model, so its transport turns are not recorded and it has no utilization row; your line to a friend waits until the friend's next line back (`role: 'remote'`), and a friend's request into one of your Bots is answered by that Bot's turn as a typed line is. Lanes never show a raw session id: a gone Bot or group with no remembered name is `Removed Bot` / `Removed group`. Group rooms are the room Session's own turn (the round), with the members' hidden group turns inside it.
7. The browser poller runs only while a panel holds it open, one request in flight, backing off on errors (4 s to 30 s) and keeping the last good window; a reply of another version is an error state, never drawn from. A hidden page loads once (a panel opened in a background tab is never left on Loading…, #259), then stops polling; becoming visible refreshes at once.
8. The panel draws text only: every string is a React text child or an SVG text node, never markup, and is cleaned again in the browser (`safe`). It polls only while open (and refreshes at once when the tab or window comes back, #259, #271), shows the last good data under an error, and says in a note when the trace is shorter than the window, truncated, memory-only or looking back. Its one-line footnote repeats the honesty rules of invariant 5 (delivered is not read, busy is not idle, model time is not a measured latency). The dialog shrinks to its content and hangs from the top (switching tabs moves nothing above the body), the **Live** control is always shown (pressed while following the latest activity, a call to action when looking back), lanes name what they are under the name (`main`, `group`, `friend`, `removed`) with no icon prefix, and the map puts each name beside or under its node, clipped with the full name in a tooltip (#249). A turn bar's tooltip ends with the model the turn ran on (its model id, `· deepseek-v4-pro`); a running turn, or one recorded before #366, names none (#366). A friend's Bot is named as the sidebar names it (`UiA1415's Chief`, `Helper · UiB1415's Bot`, from the feed's `remote.name` / party `name`), so two Bots called Helper stay apart; a wait label that would run past the plot is right-aligned, and one with no room is left to the arrow's tooltip (#255). The window's range is always in view under the header (`Oct 18 · 13:20:05 – 13:35:05 (15 min)`, dates at both ends across midnight, and whether it is live), and the footnote is two short items, not one line (#279).
9. Opt-in (#281): `apply` without `config.enabled === true` subscribes to nothing, writes nothing and registers no endpoint; the browser entry draws no sidebar row unless `config.sidebarSection === true` and its poller only runs while a panel is open. A test asserts the host does nothing by default. Docs and the install doctor's default commands do not present it as part of a standard install.
10. The endpoint reads only. It does not start, stop, send or change anything.

## Tests

`plugins/timeline/test/`: panel (geometry, a small hook renderer for open/close, tabs and poll hold, hostile-name negatives), sanitizers, trace store (rotation, retention, lock, crash-safe replace), recorder (negative tests), read model, and a host test on the real `ctx.flybot` with a mini agent loop on `core/dev/mock-llm.mjs`. Run `npm test` in `plugins/timeline` (CI job `plugins (timeline)`).

## Common mistakes

- Reading raw `session/event` in the plugin. Extend the core feed instead (plugin-runtime).
- Adding a field copied from an event without a cleaner. Every trace field has one.
- Calling idle time "waiting". The core cannot tell a waiting Bot from a busy one.
