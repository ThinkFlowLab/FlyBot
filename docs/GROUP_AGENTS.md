# Group agent roster and multi-agent requests

Related: [#158](https://github.com/openTeamily/openTeamily/issues/158), [#125](https://github.com/openTeamily/openTeamily/pull/125), [#126](https://github.com/openTeamily/openTeamily/pull/126), [#150](https://github.com/openTeamily/openTeamily/pull/150).

`main` already contains Birfy's merged group agent work: agents are stored when a group is created,
there are authorized add/remove routes, and a single-agent `agent-replies` request. This slice
reuses the intent of the conflicting old PRs without redoing that work:

- **Roster UI**: the `/chat` group view shows agent chips with remove controls and an add picker
  for other active workspace agents. It calls the existing `POST .../agents` and
  `.../agents/{agent_id}/remove` routes; no new membership semantics.
- **Multi-agent requests**: `POST .../agent-replies` now accepts `agent_ids` (1–5) as well as the
  legacy `agent_id`. Each selected agent gets its own `social_agent_replies` row and its own
  per-agent idempotency key; a replay returns the same rows, a changed payload under the same key is
  `409`. A selected agent with an active queued/running reply is `409`; different agents can run
  concurrently.
- The composer shows checkboxes for group agents (active ones disabled), one request textarea, and
  the existing per-agent status list.
- Prompt composition is unchanged: only the explicit request text is sent; no group history, no
  automatic replies, no agent-to-agent delegation.

## API

`POST /v1/workspaces/{id}/social/conversations/{conversation_id}/agent-replies`

```json
{"agent_ids": ["<32-hex>", "<32-hex>"], "prompt": "各用一句话总结。"}
```

- Session + exact Origin + CSRF; `Idempotency-Key` 16–64 chars.
- Each id must be an active agent member of this group; non-members `400`, outsiders `404`.
- Capacity uses the existing `max_social_messages_per_conversation`; excess `429`.
- Response: `{reply, replies}`; `201` when at least one row was created, `200` on full replay.
- `agent_id` remains supported for old clients.

## Storage

No schema change. Replies continue to use `social_agent_replies`; membership uses
`social_agent_members`.

## Explicitly not in this slice

- Autonomous agent-to-agent delegation, team goals, or background triggering.
- Forwarding group history into the prompt.
- Birfy/Bot Social or control-plane behavior.
- Browser E2E; tests are in-process WSGI plus synthetic screenshots.


