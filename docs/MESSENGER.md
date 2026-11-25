# Workspace messenger: human direct messages and groups

Related: [#86](https://github.com/openTeamily/openTeamily/issues/86), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#7](https://github.com/openTeamily/openTeamily/issues/7).

This is a first **human-to-human** messaging slice in the management plane, written for FlyBot. It adds workspace-scoped direct messages and named group chats next to the existing user↔agent conversations ([AGENT_CONVERSATIONS.md](AGENT_CONVERSATIONS.md)). It is **not** Teamily messenger parity: notifications, reactions, typing indicators and cross-workspace delivery remain pending. Social unread counts, media attachments, edits, retractions and personal conversation pins are implemented as documented below. Stored agent participants and one-shot explicit runtime replies are described below. Those remain the follow-up issues noted below.

The management process only stores messages. It does not call a model provider or a runtime.

## Routes (session + exact Origin + CSRF on writes)

All paths are under `/v1/workspaces/{workspace_id}/social/conversations`. Callers outside the workspace receive `404`; non-members of a conversation also receive `404`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | Conversations the caller belongs to. Keyset pagination: `limit=1..100` (default 20), optional UUID-hex `cursor`. Each item includes its member list and a last-message `preview`. |
| POST | `/` | Create `{kind:"dm"\|"group", member_ids:[...], title?}`. Requires `Idempotency-Key` (16–64 `A-Za-z0-9_-`). |
| GET | `/{conversation_id}` | Snapshot plus up to 100 messages and the member list. |
| GET | `/{conversation_id}/messages` | Messages: `limit=1..100` (default 20), optional UUID-hex `cursor`. |
| POST | `/{conversation_id}/messages` | `{body}`. Requires `Idempotency-Key`. |

`member_ids` are 32-hex user ids; the creator is added implicitly. Every listed id must belong to the same workspace. A `dm` has exactly two distinct members and is deduplicated per workspace: creating the same pair again returns the existing conversation (`200`) even under a different idempotency key. A `group` needs at least two members and may be named (default `群聊`).

## Record shape and bounds

Conversations: `id`, `workspace_id`, `kind` (`dm` or `group`), `title`, `created`, `updated`, `members` (`user_id`, `username`, `created`), and `preview`. `preview` is a whitespace-collapsed snippet of the latest message the caller can already read, at most 160 characters plus an ellipsis if truncated. Empty conversations have an empty `preview`. Full message bodies remain only on message endpoints.

Messages: `id`, `conversation_id`, `workspace_id`, `user_id`, `body`, `created`.

- `title`: 1–80 characters after trim, no control characters. A DM without a title is named after the other member.
- `body`: 1–4000 characters; tabs and newlines are allowed, other controls are not.
- Operator limits (replaceable `Config` fields): 200 conversations per workspace, 500 messages per conversation, 50 members per conversation.
- Same workspace + idempotency key + payload returns the original conversation or message (`200` vs the first `201`), including after restart. A different payload with the same key returns `409`.

## Storage

Additive `social_conversations`, `social_members` and `social_messages` tables (`CREATE TABLE IF NOT EXISTS`) in the existing private management database. Schema `user_version` stays 1; existing v1 databases gain the tables on next start. Direct-message deduplication uses a sorted-pair digest in `dm_key` with a workspace-scoped unique constraint.

## Page

The management UI for these conversations lives on the unified `/chat` page, together with user↔agent conversations. `/messenger` redirects to `/chat`. The recorded list toolbar is 筛选, then 搜索, then +. 筛选 opens real local all/group/DM/social read/unread/pinned filters over the loaded conversation list. The main header shows a letter avatar from the current conversation or agent name; there is no verified-badge field. Starting a direct message uses「添加联系人」; starting a group uses「新建群组」. The first group screen shows the intro 「添加名称，然后邀请好友并添加 AI 智能体。」, a 「自定义群组」 / 「AI 智能体团队」 switch (custom is the default), an optional 「群组名称」 field, a member search with a 「已选」 count, and Create disabled until at least one member is selected. 「AI 智能体团队」 stays visible but unconnected: there is no template list, no invented members, and create in that mode is disabled. Paid-team options are not shown. An omitted custom-group title still uses the existing create API, which defaults the stored title to「群聊」. It is not browser E2E evidence, and it is not Teamily messenger parity.

## Explicitly not in this slice

- `@Agent` mentions, automatic agent replies and task delegation in a group ([#89](https://github.com/openTeamily/openTeamily/issues/89)).
- Workspace-wide authorized message search ([#88](https://github.com/openTeamily/openTeamily/issues/88)).
- Notification center, recipient read receipts, reactions, typing indicators and user-agent unread state; see the implemented social capabilities below.
- Cross-workspace or federated delivery, Bot Social transport, and any Teamily comparison.
- Browser acceptance. Tests are in-process WSGI with a temporary SQLite file and are not a live server or vendor run.

## Stored agent participants (Related #89 #86 #7 #1)

Custom groups accept optional `agent_ids` (0–49 unique UUID-hex ids) on the existing
social-conversation create endpoint. Every selected agent must be active and belong
to the same workspace; unknown, archived and foreign ids return `400 invalid`.
DMs cannot have agent participants. The creator is still a human participant and
at least one other workspace human is required; agent-only selections do not
satisfy that rule. The configured total member cap counts humans and agents.
Idempotency includes sorted agent ids when nonempty, preserving prior human-only
request hashes. Agents grant no extra human access to conversations.

An additive `social_agent_members` table keeps schema `user_version` 1. Create,
GET and list return `agent_members` with `agent_id`, `name`, `archived`, `created`;
existing `members` remains human-only. Archived agents remain visible on existing
groups, but cannot be newly invited. Existing-group membership-edit endpoints are described below.

The custom-group picker labels people and existing workspace agents separately;
search and the selected count include both. Contact creation remains human-only.
After creation/reload the saved agent names appear above the conversation with an
explicit unconnected notice. Stored membership does not imply automatic execution. The explicit one-shot reply
path below is separate; no group auto-reply, `@Agent`, task handoff or team-template
flow is implemented.
The AI-team switch remains unconnected; no billing or credits are introduced.
This is not Teamily/Impeccable acceptance. All related tracking issues stay open.

## Explicit one-shot group agent reply (Related #89 #86 #7 #6 #1)

This original UI supplement has not been compared with Teamily. A human group
member may select an active, saved same-workspace agent and submit `agent_id` and
`prompt` (1–4000 characters) to `POST .../social/conversations/{id}/agent-replies`.
Session, Origin, CSRF and a 16–64 character Idempotency-Key are required. Outsiders,
including workspace members who are not group members, get 404. DMs reject this
action. At most one group request runs at a time; a different concurrent request
returns 409. A replay reuses the same request/task, and a changed payload or requester
under that key returns 409. Capacity counts pending and completed replies as messages;
request history is also bounded by the configured social-message cap.

Only this explicit prompt and the selected agent's configuration are composed; group
history is not forwarded. The Web process uses `queue_infer_task`, never a model
HTTP call. Existing routing uses a usable bound container connection, otherwise the
requesting human's personal connection. Model access follows existing workspace /
workspace-owner account / platform resolution and one-use runtime model-access.
No connection is a persisted `failed/no_agent` request, not a queued success.

The additive `social_agent_replies` table keeps schema user_version 1. Group GET
returns `agent_replies` with request identity, agent identity, prompt, task id,
queued/running/succeeded/failed/cancelled status and fixed errors. Authorized group
GET/list/message reads reconcile task results/deadlines. A successful nonempty
response becomes an agent-authored item in the same paginated message stream with
`role=agent`, `agent_id`, snapshotted `agent_name`, `source=runtime_infer`, and no
human `user_id`. It contributes to the group preview. Human messages are unchanged.
Persisted successful agent reply bodies are included in authorized workspace/current-conversation message search (see [SEARCH.md](SEARCH.md)); request prompts and non-success bodies are excluded.

Timeouts, cancelled/failed/missing tasks and empty results never become successful
messages. There is no automatic retry or redispatch on read; after failure a human
must explicitly submit a new request/key. Existing dispatched tasks use their
captured configuration even if the agent is subsequently archived. The UI polls
pending requests, shows fixed errors, and labels runtime-authored replies. It never
triggers on human messages, agent messages or GET, and does not implement recursive
agents, @mentions, handoff, automatic group replies or AI-team templates.

Tests exercise actual loopback HTTP claim → one-use model-access → result, calling
a labeled local fake OpenAI-compatible provider outside the Web process, followed
by group persistence/read/pagination and idempotent replay. CI Playwright uses the
same fake-provider runtime fixture for shots 81/82. This is not real-vendor,
production/container deployment, or Teamily/Impeccable acceptance.

## Edit agent participants of an existing group (Related #89 #86 #7 #1)

This backend-only slice adapts the unique existing-group membership capability
proposed in PR #125 to the owner-selected PR #124 reply protocol. It does **not**
import PR #125/#126's competing message tables or multi-recipient dispatch.
There is no new management UI; use the authenticated same-origin API with the
normal session cookie, Origin and CSRF headers. The existing `/chat` header and
one-shot agent selector reflect saved membership on reload.

| Method | Relative to `/v1/workspaces/{workspace_id}/social/conversations/{id}` | Body |
| --- | --- | --- |
| POST | `/agents` | `{agent_ids:[...]}`: 1–49 unique active same-workspace agent ids. Adds to the saved roster. |
| POST | `/agents/{agent_id}/remove` | `{}`: removes this same-workspace agent, including an archived one. |

Both operations require **both** actual human group membership and workspace
owner/admin role, following workspace-agent management permissions. A workspace
admin cannot discover or edit a private group they have not joined (`404`). An
ordinary group member receives `403 forbidden`. DMs reject edits (`400 invalid`);
unknown/foreign ids, invalid bodies, duplicate ids and archived invitations
return `400 invalid`. All ids are validated before any batch mutation. Existing
human membership and the minimum two-human creation rule remain unchanged.

Both return `200 {conversation: ...}` with the current saved snapshot, including
`agent_members`. These are idempotent **set operations**, not queued commands;
repeating an add/remove without an intervening opposite edit is a no-op. No
Idempotency-Key is required, no infer task or success message is created, and no
new schema/table is needed (`user_version` remains 1). The existing total-member
structural capacity counts humans plus agents, including archived roster entries;
a batch exceeding it returns `429 quota` without partial writes. No billing,
credits or model-usage limits are introduced.

Removing an agent with a queued/running request returns `409 conflict`. Finish or
wait for that existing task to fail/expire, then remove; this endpoint does not
pretend to cancel a runtime already executing. Authorized removal reconciles
terminal results first. Completed messages, agent identity and request history
are retained, and original conversation-create replays never re-add a removed
member. New explicit reply requests for an uninvited agent are rejected; replays
of already accepted requests retain their existing semantics. Re-adding an agent
does not erase history. Requests still use only PR #124's one-agent explicit
`/agent-replies` endpoint; no group history, automatic replies, @mentions, handoff,
AI-team mode or multi-agent orchestration is connected.

Tests exercise persist/reopen/list, owner/admin plus group membership, isolation,
CSRF/Origin, batch atomicity, archive, repeat/no-op, capacity, active-task removal
and retained messages. An actual HTTP claim → model-access → result integration
starts with an empty group, invites the agent via this API, invokes a labeled
local fake provider in a separate process, and verifies persisted reply/history
through removal and re-addition. This is not a real-vendor/container or
Teamily/Impeccable acceptance. Existing CI screenshots only show the unchanged
UI baseline; they are not evidence of a new membership-edit UI.


## Per-user unread state

Social DM/group list and snapshot responses include `unread_count`, counting incoming human
messages and successful runtime agent replies after this user's durable read cursor. Own
human sends do not count. GET never acknowledges messages. A member can POST
`/{conversation_id}/read` with `{message_id}` (Origin + CSRF required); the cursor advances
monotonically only through that message in that conversation. Cross-conversation ids and
non-members are rejected. The visible chat acknowledges only the last message actually
rendered; newer messages beyond the snapshot remain unread. Hidden tabs do not acknowledge.
The session list shows a numeric badge and only clears it after a successful acknowledgement.

This is not a notification center, @mention/push/email notification, another member's read
receipt, unread user-agent conversations, or live background delivery. Refresh/reopen loads
updated counts. The additive `social_reads` table retains state across restarts without a
schema version change. Teamily + Impeccable acceptance remains pending.

The same chat slice fixes pending message-search queries across tab switches and prevents
stale search responses replacing newer queries (the CI chat_search_messages race).

## Consolidated functional delivery

- Social conversation rows include per-user `unread_count` and `pinned`. Existing snapshot-bounded
  read acknowledgement never marks unseen newer messages read; GET does not acknowledge anything.
- `POST /{id}/preferences {pinned:boolean}` stores a private per-user pin. Pins sort before recency in
  the loaded list. UI filters all/groups/DMs/social-unread/social-read/pinned honestly omit unsupported
  agent unread state. Pins/filtering cover loaded pages, not an invented global total or group model.
- `POST /{id}/messages/{message_id}/edit {revision,body}` and `/retract {revision}` are author-only
  human-message operations. Group membership is required before author checks; stale revisions or
  already-retracted messages return 409. Retraction clears stored message text and hides its
  attachment from message projection; it does not delete an independently uploaded library work.
  Message search no longer returns the old body. There is no model regeneration or automatic reply.
- `POST /{id}/messages` additionally accepts optional `artifact_id` referencing existing same-workspace
  media. The browser uploads through the existing MIME-sniffed/size-bounded artifact API, then sends
  the reference with normal idempotency. Image/audio/video only, not arbitrary documents. Downloads
  reuse authenticated artifact `/file`; the UI warns that uploaded media belongs to the WORKSPACE
  library, not a DM-private vault. Failed send may leave an uploaded library item and says so.
- The header's **会话内搜索** opens a separate paged panel using the existing authorized
  conversation-scoped message API. Sidebar search remains independent; switching workspace or
  conversation clears stale panel state. No duplicate backend message corpus or new reply protocol.

Mounted Node tests exercise pins/filters, independent scoped search pagination, author edit and
confirmed retraction; temporary-DB HTTP tests verify permissions, revisions, search erasure and media
upload/reference/download. This is not Teamily + Impeccable acceptance or real-vendor inference.
See [FUNCTIONAL_COMPLETION.md](FUNCTIONAL_COMPLETION.md) for the full remaining-work matrix.
