# Agent conversations

This slice adds a persistent, authorized conversation between a workspace member and a workspace agent record from [WORKSPACE_AGENTS.md](WORKSPACE_AGENTS.md). It is self-written for FlyBot. It does not copy Teamily, FlyBot Project, Bot Social, or DS-Bot source.

The management process does not call a model provider. A send composes a prompt from the agent name, summary, instructions, and prior succeeded turns, then queues an existing runtime `infer` task. If the agent is bound to a usable FlyBot container instance (see [AGENT_RUNTIME.md](AGENT_RUNTIME.md)), the task is assigned to that instance connection; otherwise the **calling user's** own-machine connection is used as a fallback. Model-API resolution stays on that task path (workspace, then the workspace owner account, then the platform default). Tests that finish a reply with a fake OpenAI-compatible server are labeled as such; they are not a real vendor or a live container run.

`/v1/agent/*` remains the runtime-key transport. These routes are management conversation APIs.

## Routes

All paths are under `/v1/workspaces/{workspace_id}/agents/{agent_id}`. Writes need a session, CSRF, and exact Origin. Callers outside the workspace receive `404`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/conversations` | The current user's conversations with this agent. Keyset pagination: `limit=1..100` (default 20), optional UUID-hex `cursor`. Each item includes a last-message `preview`. |
| POST | `/conversations` | Create. Body: optional `title` (default `新对话`). Requires `Idempotency-Key` (16–64 `A-Za-z0-9_-`). |
| GET | `/conversations/{id}` | Conversation snapshot plus up to 200 messages. Reconciles queued or running replies first, including a retry when a previous send had `no_agent` and a connection is now online. |
| GET | `/conversations/{id}/messages` | Message list. `limit=1..200` (default 50), optional `cursor`. Also reconciles. |
| POST | `/conversations/{id}/messages` | Send. Body: `body` (1–4000 characters). Requires `Idempotency-Key`. Returns the user message and a queued assistant reply. |
| POST | `/conversations/{id}/messages/{id}/artifact` | Save a succeeded message as a document in the works library, with provenance and per-message idempotency. Optional `title`. |

The same-origin page at `/agents` includes the conversation panel.

## Record shape and bounds

Conversations: `id`, `workspace_id`, `agent_id`, `user_id`, `title`, `created`, `updated`, and `preview`. `preview` is a whitespace-collapsed snippet of the latest non-empty message the caller can already read, at most 160 characters plus an ellipsis if truncated. Empty conversations have an empty `preview`. A conversation is owned by the user who created it. Other members, including workspace admins, receive `404`. Full message bodies remain only on message endpoints.

Messages: `id`, `conversation_id`, `workspace_id`, `agent_id`, `user_id`, `role` (`user` or `assistant`), `body`, `status` (`queued`, `running`, `succeeded`, `failed`, `cancelled`), `task_id`, `error_code`, `agent_revision`, `created`, `updated`.

- `title`: 1–80 characters after trim, no control characters. The first send replaces the default `新对话` with a title taken from the user text.
- `body`: 1–4000 characters for a send; tabs and newlines are allowed, other controls are not.
- The composed infer prompt is at most 4000 characters and reuses `runtime_connect` validation.
- Default capacity is 50 conversations per user per workspace, and 200 messages per conversation. These are replaceable operator limits in `Config.max_conversations_per_user` and `Config.max_messages_per_conversation`.
- Only one assistant reply may be queued or running at a time in a conversation (`409` otherwise).
- Archived agents cannot start a conversation or accept a new send (`409`). Existing history remains readable.
- If the user has no online runtime connection, the assistant message stays `queued` with `error_code=no_agent`. A later GET retries dispatch.

The same workspace + idempotency key + payload returns the original conversation or message (`200` vs the first `201`), including after restart and after the reply has been reconciled. A different payload with the same key returns `409`.

## Agent configuration binding

Each conversation stores `agent_id`. Each send records the current `workspace_agents.revision` on both the user and assistant messages, and composes the prompt from the live name, summary, and instructions at send time.

## Message-to-library

`POST .../messages/{id}/artifact` stores a succeeded message as a document. Provenance is `source.kind=agent_message` with `id` (the message), `conversation_id`, and `agent_id`. Repeating the request returns the same artifact (`200`). Saving does not create a share.

## Explicitly not in this slice

- Embeddable conversations. Public homepages and revocable share links are in [AGENT_HOMEPAGES.md](AGENT_HOMEPAGES.md).
- Auto / Instant / Agentic or any other invented mode field.
- A second chat engine inside the management process.
- Messaging a third-party vendor from these tests.
- Teamily comparison or browser end-to-end acceptance. Issues #6, #8, #9, and #1 stay open.

## Tests

`tests/test_agent_chat.py` covers persistence, permissions, isolation, idempotency, archived agents, `no_agent` queuing, and message-to-library. `tests/test_agent_chat_infer.py` uses a clearly labeled fake OpenAI-compatible provider to finish an infer task and read the assistant text back; that is not a real vendor. Neither suite is a live container run, a browser acceptance, or proof of Teamily parity.
