**Settings → Workflow graphs** is now canvas-first with a per-node inspector panel. Select a node to edit its system prompt, role, and tools — no more wall of textareas.

**Workflow stage chat** reuses the normal FlyBot conversation UI (same message bubbles and spacing as Bot/group chats), replacing the previous pipeline-log card style.

**Sidebar Workflows list, Hand-a-task modal, and flowchart drawer** now show visual mini-flowcharts instead of text chains like "Planner → Writer → Coder", with a unified visual language across all surfaces.

**Hand-a-task modal** overflow fixed: content scrolls, Cancel/Confirm footer is sticky and always visible.

**Flowchart drawer** defaults to showing the graph collapsed; system prompts expand only when a node is selected.

**Workflow runs** now advance only along graph edges when ephemeral Bots finish — no timer-based demo-step bypass for live runs. The `workflow/demo-step` endpoint remains for replaying canned demos only and refuses while a live run exists.
