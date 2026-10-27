---
subsystem: workflow
owned_paths:
  - plugins/workflow/
---

# workflow (`@flybot/workflow`)

A group-shaped chat of local Bots, with a flowchart the owner can drag (#1318). The plugin stores the graphs under `$DSH_HOME/bot/flybot-workflow` and answers `flybot/workflow/*`. It lives entirely under `plugins/workflow/`.

This is not the workflow-definition engine. That engine (#1272) stores `workflows/<id>.json` and guards artifacts. This plugin does not read or write those files and does not call that engine.

Settings → Workflows (#1364) is this plugin's list. The page lives in the core client and calls `workflow/state`, `workflow/create` and `workflow/graph`. Factory rows are `templateCatalog()` — id, name, description, triggers, plus the drawable `nodes`, `edges`, `layers` and `chain` — and the owner's rows are the saved workflows. The settings page does not replace the sidebar chat. A sidebar click opens this plugin's stage and leaves the Workflows section in place.

## Owns

Everything in `plugins/workflow/`: the graph rules, the run store, the matcher, the browser chat and the flowchart canvas.

## Does not own

- `flybot.api.handle`, `flybot.tools.register` and `flybot.tasks.onWrite` → [plugin-runtime](plugin-runtime.md).
- The board's own state machine (`task-create`, `task-update`, the task drive) → [core-host](core-host.md). The plugin hears a saved card and may name a local Bot; the host applies that owner.
- Install commands → [install](install.md). `@flybot/workflow` is a default install. `@flybot/timeline` stays opt-in.

## Key files

| File | Role |
| --- | --- |
| `plugins/workflow/index.js` | Plugin entry (`flybot-workflow`). Endpoints, `run_workflow`, `define_workflow`, the board listener, and the reply middleware that reports a step result. |
| `plugins/workflow/src/graph.js` | Nodes, edges, positions, and named inputs and outputs. A node starts when its forward predecessors are settled and a taken edge reaches it. Same-rank nodes run together. A forward cycle is refused. A loop edge is the only cycle. A `when` edge chooses a branch; the other is skipped. A required input with no upstream provider is refused before a run starts. |
| `plugins/workflow/src/service.js` | The store, lanes (active runs, FIFO queue, terminal history), `maxConcurrent`, `rename`, `delete`, `saveGraph`, `define`, `runNamed`, `ingest`, `stepResult`. `rename` updates a workflow's name and optional description; `delete` removes the workflow, releases ephemeral Bots, and cleans logs/runs/routes. Both refuse factory presets. A spawn hook makes one run Bot per node. Disposing the plugin releases every run Bot first and drops those ids from the saved record only once the release has finished, handing the release back as a promise the host awaits, so a shutdown that is cut short cannot leave hidden Bots that no state names (#1387). A released run Bot also gives its runner name back to the allocator instead of keeping it for the lifetime of the process. A dispatch that does not land is not marked handed. |
| `plugins/workflow/src/ephemeral.js` | Builds each node's run Bot from its prompt, role, model and tools, and releases the ids the host returns. `permissionFor` picks `danger-full-access` when the node names a shell, otherwise `workspace-write`. |
| `plugins/workflow/src/match.js` | Which open card matches a Workflow or a local Bot. |
| `plugins/workflow/src/template.js` | 发布交付流水线 (a parallel branch) and the weekly report, each node with the inputs and outputs that edge carries. |
| `plugins/workflow/src/narrate.js` | Progress lines for a step. A live run quotes the Bot reply. The canned delivery copy is the demo player only. A join line is only for a rank of more than one node. |
| `plugins/workflow/client.js` | Sidebar section, chat stage, assign dialog, flowchart editor, and Settings → Workflow graphs. Replay demo is disabled while a live run exists. The stage shows the queue and refreshes state while one is active. The stage and the dialogs portal onto `document.body`; a missing container stays in the section tree. |

## Entry points

- Endpoint `workflow/state` and `workflow/templates` are reads.
- `workflow/create`, `workflow/rename`, `workflow/delete`, `workflow/assign`, `workflow/concurrency`, `workflow/graph`, `workflow/advance`, `workflow/demo-step`, `workflow/reset`, `workflow/say`, `workflow/ingest` write. `workflow/concurrency` sets that workflow's `maxConcurrent` (an integer from 1 to 8). `workflow/rename` updates a workflow's name and optional description; it refuses factory presets and read-only hosts. `workflow/delete` removes a workflow from state, releases its ephemeral Bots if a run exists, cleans logs/runs/routes, and refuses factory presets (#1434).
- Tool `run_workflow` starts a named run with a brief. Tool `define_workflow` writes the same graph the canvas edits.
- `flybot.tasks.onWrite` calls `ingest`. A new Bot match returns `{ ownerBotId }`. A Workflow match starts the run inside the plugin and leaves the card's owner to the host.

## Invariants

1. Friends' Bots are not nodes. A `remote` Bot is refused by create, define and the matcher.
2. The canvas and the run share one graph: nodes, edges and positions. A drag commits `workflow/graph`. Status highlighting reads that same graph. Replacing edges does not recompute who is already running.
3. A live run advances only when its ephemeral Bot replies, and that reply is the chat line. `workflow/demo-step` replays the seeded script and refuses while that workflow has a live run; the stage does not start the replay timer while `activeCount` is greater than 0. A run does not create a schedule. `scheduleLabel` is display text. When the host can create Bots, starting a live run (`assign`, `run_workflow`, `ingest`) spawns one ephemeral Bot per node from that node's prompt, role, model and tools, sends it the step from the Main Bot, and removes every instance when the run finishes, fails for good, or is reset. A `failOnce` retry keeps them. They are hidden and left out of the sidebar. Loading the plugin does not spawn Bots for the seeded fixture. Loading is also the one moment a run the host left behind is noticed: a run still marked `running` is abandoned, so loading releases its instances and records the run as `failed`. Nothing resumes it. A run that already ended keeps its own status (#1388). A dispatch that does not land is not marked handed. The chat names the code, and the next hand-off tries that node again. It is not sent twice in the same hand-off. A reply that says `could not answer your message` or `model call failed` fails that node and does not start its successor. A 429 or rate-limit mention in any other reply does not.
4. Each workflow keeps a FIFO queue and up to `maxConcurrent` live runs (default 2, an integer from 1 to 8 on the record or via `workflow/concurrency`). The host runs at most 6 live runs at once. A task that does not fit is enqueued. When a run finishes, every workflow with a free slot is drained, oldest enqueue first, until the host cap. A new assign on a workflow that already has a queue waits behind it. A task does not replace a running run or release that run's Bots. An old store run is a demo unless it is still `running` and has ephemeral Bot ids. History records a finished or failed run only. Lowering the cap does not stop a run that has already started. Assigning `{ botId }` claims the card for that local Bot and does not enqueue. A remote Bot is refused.
5. A node declares up to eight inputs and eight outputs. A required input is an output of the same name on an ancestor, or `task`, `title`, or `brief` on a root. A start with no provider is refused, and Bots spawned for that attempt are released. On a Bot-backed run a successor stays queued until its required inputs are present. If every forward predecessor is done, failed or skipped and an input is still missing, that node fails and the run stops. The dispatch text carries `Input <name>: <value>`. The Bot reports `OUTPUT <name>: <value>`; a single declared output may be the reply body. Nodes start in edge order.
6. Each node is a real ephemeral Bot for that run, then it is removed. A permanent sidebar Bot (`botId`) is optional and is not required for the step to run. `tools` on the node is what that Bot may use: `github` grants `mcp__github__*` (pull requests, reviews, comments); `bash` or `shell` sets the permission to `danger-full-access` and allows a full-access shell; any other step gets `workspace-write`. A hidden run Bot cannot show an approval card, so a granted tool is allowed and a connector it did not name is refused. The host stores this on the run Bot as `stepTools` and `permission`.
7. A loop edge (`loop: true`, `max` from 1 to 8, default 3, optional `until: { output, eq }`) is the only cycle. The body runs again until `until` matches or `max` runs have finished, and the forward edges wait until then. Restarting the body drops the branch choice made inside it and queues a sibling that the previous pass skipped, so the next pass can take the other side. A `when: { output, eq }` edge is taken only when that output equals `eq`. `when: { else: true }` is taken only when no other `when` matched. A node whose forward edges are all closed is `skipped` and does not block a join. A run cannot spin: every loop has a max. Settings → Workflow graphs can add a link, a condition or a loop.
8. Auto-assign considers an `open` card only. A saved Bot claim beats a workflow trigger. Otherwise first hit wins: a `workflow:` token, then `workflowId` / `workflow`, then an assignee that names a workflow, then a `bot:` token, then an assignee that names a local Bot, then the longest trigger contained in the title, note or criteria. A miss returns no route. A second ingest of the same task and target is a no-op, and a live run for that task id is not restarted.
9. The browser draws text only. Names and messages are React text children. The unit renderer asserts a hostile name is not markup.
10. `enabled: false` registers no endpoint, tool or listener and writes nothing.
11. A sidebar click opens the stage or a dialog and leaves the Workflows section in place. The stage and the dialogs portal onto `document.body`. When that container is missing they stay in the section tree; the click does not throw.
12. A node's prompt and the graph are one record. Settings → Workflow graphs, the flowchart's prompt fields, and `define_workflow` all write `workflow/graph`. A run reads that record; it does not define it. Replay steps the seeded script. After a live run has finished, the stage keeps that run until Replay steps the script. From that step on, the stage shows the demo, including its `nodeStatus`, ahead of the finished `lane.last`. A running live lane still wins. A migrated finished script is the same: it stays done until Replay, and then the presented nodes follow the demo.

## Tests

`plugins/workflow/test/`: graph advance and join, graph edit, assign and persistence, the FIFO queue and concurrency cap, Bot-reply advance, a dispatch that fails without being marked handed, disposing releases the Bots before the record drops their ids and a released runner name is reusable again, assign-to-bot versus assign-to-workflow, inputs and outputs along edges, a loop that breaks and an if/else branch, templates, `define` / `runNamed`, the matcher, ephemeral spawn and cleanup, the reply middleware, the client canvas, the settings page (including a condition and a loop), rename and delete (factory refuse, cleanup on delete, #1434), and a sidebar click that leaves the Workflows section in place. Run `npm test` in `plugins/workflow`. The host seam that applies `ownerBotId` is `core/test/task-route.test.js`. The host omission of run Bots, and the grant of `stepTools` plus the hidden-approval answer, is `core/test/flybot.test.js`. Which connectors a run Bot may call is `core/test/connector-access.test.js`.
