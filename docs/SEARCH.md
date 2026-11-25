# Workspace message search

Related: [#88](https://github.com/openTeamily/openTeamily/issues/88), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#4](https://github.com/openTeamily/openTeamily/issues/4).

This slice adds a **server-side, authorization-scoped** message search across the messages a caller may already read, written for FlyBot. It is a bounded substring scan, **not** a full-text index, ranking model, semantic/vector search, or Teamily search parity. It does not add a cross-workspace/global search.

## Route

`GET /v1/workspaces/{workspace_id}/search/messages?q=&kind=all|agent|social&limit=&cursor=&conversation_id=`

- Requires a session. The caller must belong to the workspace; outsiders get `404`.
- `q`: 1–80 characters, no control characters. Required.
- `limit`: `1..50` (default 20).
- `cursor`: optional 32-hex message id; keyset order is creation time, then message id (oldest hit first), so paging follows the conversation's history instead of uuid order. The cursor is the last returned message id and the next page resumes after that message's `(created, id)` position; a cursor for a message the caller may not read, or for one that no longer exists, restarts from the first page.
- Only `GET`; a query on `POST` is already rejected by the API-wide rule.

Returns `{items:[{kind, conversation_id, message_id, title, snippet, created}], cursor}`.

## Authorization

- `kind=agent`: only the caller's own user↔agent conversations (`agent_conversations.user_id` = caller). Workspace admins do **not** gain access to other members' private agent conversations.
- `kind=social`: only social conversations the caller is a member of (`social_members`).
- `kind=all`: the union of the two.

The workspace id is also part of every query, so a caller cannot search another workspace's rows even with a foreign conversation id.

## Bounds and safety

- Results are snippets capped at 160 characters; newlines/whitespace are collapsed.
- No token, API key, cookie or secret is selected by the query.
- The scan is bounded by the page size and the internal per-table limit; there is no timeout-based cancellation or background indexing. Operators may add a future deduplicated full-text index without changing the response shape.

## Page wiring

The unified `/chat` sidebar message tab calls this endpoint and can open authorized agent or social conversations from results. The file/link tabs use the authorized resource endpoint below; other tabs use existing workspace data. This is workspace-authorized search, not an instance-wide index. Results remain bounded to the requested page.

## Explicitly not in this slice

- Full-text/`FTS5` index, ranking, highlights beyond a plain snippet, semantic/vector search.
- Global (cross-workspace) search, cross-instance federation, Bot Social transport.
- Teamily comparison and a separate, uncaptured search-dialog layout. Authorization tests use in-process WSGI + temporary SQLite; fixture-only browser checks cover global and current-conversation search.


## Conversation-header search

The `/chat` header search reuses the existing message panel with an explicit
“仅搜索当前对话” scope. The left sidebar search remains workspace-wide; switching
to a non-message tab or closing the panel clears the conversation scope.
`conversation_id` is optional, exactly 32 lowercase hex characters when present.
It narrows both authorized agent/social queries **before** cursor pagination;
it never replaces user, membership or workspace checks. A nonexistent or
inaccessible conversation produces no results, not a permission bypass.

This is a functional scope correction based on the recorded conversation-header
search action, not a claim about an uncaptured separate search-dialog layout.
The original scoped sidebar remains; a separate functional panel is now documented below. No Teamily writes were performed.

## Persisted group-agent replies (Related #88 #89 #7 #1)

`kind=social` (and `kind=all`) now searches the same success-only message projection
used by group GET/pagination: human messages plus persisted `succeeded` group-agent
replies from the owner-selected one-shot protocol. It does not search prompts,
tasks, pending/running/failed/cancelled request bodies or diagnostics. Search is
read-only: it never dispatches, retries or reconciles runtime tasks; a successful
task becomes searchable after an authorized group/list read has persisted its
reply, as in the existing reply lifecycle.

Agent-authored group hits remain `kind=social`, so the existing `/chat` workspace
and current-conversation message searches open the same group without a new UI.
Those hits add `role:"agent"`, `agent_id`, snapshotted `agent_name` and
`source:"runtime_infer"`; human and private-agent hit shapes remain unchanged.
The optional conversation restriction, UUID cursor ordering, mixed-source
pagination, literal substring matching and 160-character snippet bound apply
before the page is returned. The author metadata is a stored reply identity,
not a new provider execution or verification claim.

Actual human group membership and workspace scope remain mandatory, including
for workspace admins. Removing/archiving an agent does not erase the group's
already readable history. This extends the existing scan; it is not a full-text
index, new search-dialog layout or Teamily/Impeccable acceptance. The new CI shot
`85-chat-group-agent-search.png` shows an existing scoped search finding a labeled
fake-provider reply and opening its saved group. Tests include actual HTTP
claim/model-access/result plus a separate-process local fake-provider call before
search/reopen, and negative isolation/state, literal matching and mixed pagination
coverage. No real vendor credentials or Teamily write operations are involved.

## Independent panel and file/link resource search

The chat header now has an independent, cursor-paged conversation search panel; sidebar searches
remain separate. It uses the same membership-authorized message corpus, including successful
runtime group replies, not pending requests. Switching conversations/workspaces invalidates results.

`GET /v1/workspaces/{id}/search/resources?kind=files|links&q=&limit=&cursor=` requires workspace
membership. `q` is at most 80 characters, `limit` is 1–50. The 文件/链接 sidebar tabs call this API.
Files search workspace media title/filename and link to the existing authenticated download route.
They are workspace library resources, not DM-only attachments. Links search only messages the caller
can read and project the first HTTP(S) URL; private conversations remain private. No URLs are fetched
by the server. Link cursors advance through authorized scanned messages, so a page may contain zero
links while still having a next cursor. Other schemes are never emitted. Retraction erases searchable
text. No document-body indexing or arbitrary binary extraction is claimed.

See [FUNCTIONAL_COMPLETION.md](FUNCTIONAL_COMPLETION.md) for delivered and pending scope.
