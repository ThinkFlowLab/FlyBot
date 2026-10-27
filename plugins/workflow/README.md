# @flybot/workflow

A Workflow is a group-shaped chat of local Bots. The sidebar row opens the run: a pill header, progress, bubbles, a composer, and a flowchart. The same graph is what a drag-drop edit saves and what a run highlights.

This is not the Settings workflow-definition engine (`workflows/<id>.json`, #1272). This plugin does not read or write those files.

## What you can do

- Open a template. **发布交付流水线** is Planner → Writer → Coder → (Reviewer ‖ Tester) → Deployer. **每周报告** is a short chain with a Friday label.
- Create or edit a graph in the flowchart. Drag a local Bot onto the canvas, move a node, draw or drop an edge. The host stores nodes, edges and positions.
- Hand a board task to a Workflow, or to one local Bot, from the assign dialog.
- Let an open card assign itself. The matcher is `src/match.js`, first hit, and only while the card is `open`:
  1. a `workflow:<id or name>` token in the title, note, criteria or tags
  2. `workflowId` or `workflow`
  3. `assignee` naming a workflow
  4. a `bot:<id or name>` token
  5. `assignee` naming a local Bot (a remote Bot never matches)
  6. a workflow trigger contained in the title, note or criteria (longest trigger wins)
- A miss stays unassigned for the manual picker. A Bot match sets that Bot as the card's owner so the task drive can wake it. A Workflow match starts the scripted run and posts progress in the Workflow chat.

## Tools

A local Bot uses the same store:

- `run_workflow` — `workflow` (id or exact name) and `brief` (the task). Optional `task` id.
- `define_workflow` — `name`, `nodes` (`{ id, name, botId?, x?, y? }`), `edges` (`{ from, to }`). Pass `workflow` to replace one. A friend's Bot is refused.

v1 does not call each Bot's model. A step posts a progress line and moves the node.

## Install

Default, with the core, social and tree:

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/workflow"
```

`enabled: false` registers nothing.

## Develop

```sh
npm test
```

Endpoints, all under `flybot/workflow/`: `state`, `templates` (read), `create`, `assign`, `advance`, `demo-step`, `reset`, `say`, `graph`, `ingest`.
