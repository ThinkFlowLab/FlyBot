# features/agents (B2)

Workspace agents live in this DS-Bot (`agents.sqlite3`). Each message is a native DS-Bot turn via
`chatTurn('agent:<agent>:<conversation>', …)` with the persona header of `conversations.compose_prompt`.
`agents/turn` is the in-process contract used by the external API and team runs. Public homepages and
discover stay cross-user (phase C, Bot Social).
## Page adapter and cutover

`/agents/` loads `/shell/dsbot-api.mjs`, which remaps `/v1/workspaces/:id/agents` (directory, archive, conversations, messages) to `agents/v1` and API-key routes to `agent-api/v1`. Homepage, discover and runtime-binding stay on the platform. Core can then add `/agents/` to `moved_pages`.

`migrate(bundle)` accepts either `{agents:[...]}` or the official `flybot-workspace-dsbot-import` v1 bundle (`feature: "agents"`, tables `workspace_agents`, `workspace_agent_categories`, `workspace_agent_quick_starts`, `agent_conversations`, `agent_messages`). Import is idempotent by id. Queued/running imported messages are stored as failed/`migrated` and are not executed. Public homepages are not imported (phase C).
