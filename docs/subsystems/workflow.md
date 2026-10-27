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
| `plugins/workflow/index.js` | Plugin entry (`flybot-workflow`). Endpoints, `run_workflow`, `define_workflow`, and the board listener. |
| `plugins/workflow/src/graph.js` | Nodes, edges and positions. A node starts when every predecessor is done. Same-rank nodes run together. A cycle is refused. |
| `plugins/workflow/src/service.js` | The store, template copies, `saveGraph`, `define`, `runNamed`, `ingest`. A spawn hook makes one run Bot per node. |
| `plugins/workflow/src/ephemeral.js` | Builds each node's run Bot from its prompt, role, model and tools, and releases the ids the host returns. |
| `plugins/workflow/src/match.js` | Which open card matches a Workflow or a local Bot. |
| `plugins/workflow/src/template.js` | 发布交付流水线 (a parallel branch) and the weekly report. |
| `plugins/workflow/src/narrate.js` | Progress lines for a step. A join line is only for a rank of more than one node. |
| `plugins/workflow/client.js` | Sidebar section, chat stage, assign dialog, flowchart editor, and Settings → Workflow graphs. The stage and the dialogs portal onto `document.body`; a missing container stays in the section tree. |

## Entry points

- Endpoint `workflow/state` and `workflow/templates` are reads.
- `workflow/create`, `workflow/assign`, `workflow/graph`, `workflow/advance`, `workflow/demo-step`, `workflow/reset`, `workflow/say`, `workflow/ingest` write.
- Tool `run_workflow` starts a named run with a brief. Tool `define_workflow` writes the same graph the canvas edits.
- `flybot.tasks.onWrite` calls `ingest`. A new Bot match returns `{ ownerBotId }`. A Workflow match starts the run inside the plugin and leaves the card's owner to the host.

## Invariants

1. Friends' Bots are not nodes. A `remote` Bot is refused by create, define and the matcher.
2. The canvas and the run share one graph: nodes, edges and positions. A drag commits `workflow/graph`. Status highlighting reads that same graph. Replacing edges does not recompute who is already running.
3. Progress lines stay scripted, and a run does not create a schedule. `scheduleLabel` is display text. When the host can create Bots, starting a run (`assign`, `run_workflow`, `ingest`, or a demo that starts or restarts) spawns one ephemeral Bot per node from that node's prompt, role, model and tools, sends it the step from the Main Bot, and removes every instance when the run finishes, fails for good, or is reset. A `failOnce` retry keeps them. They are hidden and left out of the sidebar. Loading the plugin does not spawn Bots for the seeded fixture run.

   Loading is also the one moment a run the host left behind is noticed: a run still marked `running` is abandoned, so loading releases its instances and records the run as `failed`. Nothing resumes it. A run that already ended keeps its own status (#1388).
4. Auto-assign considers an `open` card only. First hit wins: a `workflow:` token, then `workflowId` / `workflow`, then an assignee that names a workflow, then a `bot:` token, then an assignee that names a local Bot, then the longest trigger contained in the title, note or criteria. A miss returns no route. A second ingest of the same task and target is a no-op, and a live run for that task id is not restarted.
5. The browser draws text only. Names and messages are React text children. The unit renderer asserts a hostile name is not markup.
6. `enabled: false` registers no endpoint, tool or listener and writes nothing.
7. A sidebar click opens the stage or a dialog and leaves the Workflows section in place. The stage and the dialogs portal onto `document.body`. When that container is missing they stay in the section tree; the click does not throw.
8. A node's prompt and the graph are one record. Settings → Workflow graphs, the flowchart's prompt fields, and `define_workflow` all write `workflow/graph`. A run reads that record; it does not define it.

## Tests

`plugins/workflow/test/`: graph advance and join, graph edit, assign and persistence, templates, `define` / `runNamed`, the matcher, ephemeral spawn and cleanup, the client canvas, the settings page, and a sidebar click that leaves the Workflows section in place. Run `npm test` in `plugins/workflow`. The host seam that applies `ownerBotId` is `core/test/task-route.test.js`. The host omission of run Bots is `core/test/flybot.test.js`.
