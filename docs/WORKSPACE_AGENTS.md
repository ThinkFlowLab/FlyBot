# Workspace agent directory

This is the first FlyBot slice of [issue #6](https://github.com/openTeamily/openTeamily/issues/6): a workspace-scoped directory of FlyBot agents. It is self-written. It does not copy Teamily, FlyBot Project, Bot Social, or DS-Bot source.

`/v1/workspaces/{workspace_id}/agents` is a management-directory API. It is not the runtime-key transport under `/v1/agent/*`. The management process does not run these agents. Mode switching (Auto / Instant / Agentic), embed routes, and inventing Teamily create-flow details are out of this slice because those differences have not been fully observed. Unlisted public homepages are documented in [AGENT_HOMEPAGES.md](AGENT_HOMEPAGES.md). Defaults below are FlyBot choices, not compared behavior.

## Routes

All paths are under `/v1/workspaces/{workspace_id}`. Writes need a session, CSRF, and exact Origin. Outsiders receive `404`. Members may read; only the owner or an admin may create, update, or archive.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/agents` | Non-archived agents, keyset pagination: `limit=1..100` (default 20), optional UUID-hex `cursor`. Owner/admin may pass `include_archived=1`. |
| POST | `/agents` | Create. Body: `name`, optional `summary`, `instructions`, and `category`. Requires `Idempotency-Key` (16–64 `A-Za-z0-9_-`). |
| GET | `/agents/{id}` | Read one record. Archived records are `404` for members and remain readable to owner/admin. |
| POST | `/agents/{id}` | Update. Body must include the current `revision` and at least one of `name`, `summary`, `instructions`, `category`. |
| POST | `/agents/{id}/archive` | Soft-archive. Body must include the current `revision`. Already archived records return the same snapshot. |

A same-origin page is served at `/agents`. Owners and admins choose the category in the create and edit forms (「类目」, default 「未分类」). Selecting a category pill (or opening `/agents?category=<slug>`) narrows the loaded directory in place, together with the search box, without reloading the workspace or closing an open agent; 「全部」 shows every agent including uncategorized ones. An empty category shows「「<label>」类目下还没有智能体。选「全部」查看其余智能体。」, separate from the empty-workspace copy. Category assignment in the forms is an FlyBot addition; the target site's own category-setting flow was not compared. The filter applies to the first 100 agents the page loads, which is above the default 50-agent capacity.

## Record shape and bounds

Responses use `id`, `workspace_id`, `name`, `summary`, `instructions`, `revision`, `created`, `updated`, `created_by`, `archived` (`0` or `1`), `category`, and `homepage`. They never include tokens or secrets except the one-time homepage token documented in [AGENT_HOMEPAGES.md](AGENT_HOMEPAGES.md).

- `name`: 1–80 Unicode characters after trim, no control characters. Names are unique per workspace after casefold, including archived records.
- `summary`: at most 500 characters, no control characters.
- `instructions`: at most 16,000 characters; tabs and newlines are allowed, other controls are not.
- `category`: `null` (uncategorized, the default) or one of the 17 directory slugs in `agents.CATEGORIES`, which mirror the recorded category pills on `/agents` (`content-creation` … `sales`). Unknown values, empty strings and non-strings return `400`. Sending `null` on update clears it. Setting, changing or clearing it bumps `revision` like any other edit. It is stored in the additive `workspace_agent_categories` table (`CREATE TABLE IF NOT EXISTS`); `user_version` stays 1 and existing databases gain the table on next start. A category is supplied in the create payload's idempotency hash only when it is not `null`.
- `revision` starts at 1 and increases on update or archive. A stale `revision` returns `409`.
- Default capacity is 50 agents per workspace, counting archived rows. This is a replaceable operator limit in `Config.max_agents_per_workspace`.

The same owner workspace + idempotency key + payload returns the original record (`200` vs the first `201`), including after restart. A different payload with the same key returns `409`.

## Permissions

- Any workspace member can list and read non-archived agents.
- Owner and admin can create, edit, archive, read archived agents, and list with `include_archived=1`.
- A member who tries to write receives `403`. A caller outside the workspace receives `404` for every route, including writes.

## Explicitly not in this slice

- Embeddable conversations. Public homepages and revocable share links are in [AGENT_HOMEPAGES.md](AGENT_HOMEPAGES.md).
- Auto / Instant / Agentic or any other invented mode field.
- Binding an agent record to a running container, model adapter switch, or automation run. Authorized user/agent conversations now live in [AGENT_CONVERSATIONS.md](AGENT_CONVERSATIONS.md) and reuse runtime infer tasks.
- Teamily comparison or browser end-to-end acceptance. Issue #6 stays open.

## Tests

`tests/test_agents.py`, `tests/test_agents_page.py` and `tests/test_agent_category.py` (which also runs `tests/agents_category_filter.test.mjs` and `tests/agents_categories.test.mjs`) use in-process WSGI and a temporary SQLite file. They are not a live container run, a browser acceptance, or proof of Teamily parity.
