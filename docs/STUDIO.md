# Studio: slide decks and dashboards in the works library

Related: [#90](https://github.com/openTeamily/openTeamily/issues/90), [#9](https://github.com/openTeamily/openTeamily/issues/9), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This is the first Studio slice: editable **slide decks** and structured **dashboards** in the works library (`/space`, `/artifacts`). It is self-written for FlyBot. It is **not** Teamily Studio parity: there is no real-time collaboration, rich text, animation, speaker mode, external data source, or template catalogue, and the dashboard is a static widget list rather than a data-connected builder.

## Deck format

```json
{"schema": "flybot-workspace.slides.v1", "slides": [
  {"title": "目标", "bullets": ["统一入口", "更快的回复"]},
  {"title": "下一步", "bullets": ["接入运行时"]}
]}
```

- 1–30 slides; each slide has a title (≤120 chars) and 0–10 bullets (≤200 chars each).
- A slide with neither a title nor bullets is rejected.
- The serialized deck is at most 65536 bytes.
- Text is escaped on render; scripted HTML is not accepted.

## Dashboard format

```json
{"schema": "flybot-workspace.dashboard.v1", "widgets": [
  {"type": "metric", "title": "预算", "value": "2400 元", "note": "三人两天"},
  {"type": "table", "title": "行程", "columns": ["时间", "安排"], "rows": [["周六上午", "西湖"]]},
  {"type": "bar", "title": "花费", "labels": ["住宿", "餐饮"], "values": [1200, 600]}
]}
```

- 1–20 widgets; each needs a non-empty title (≤120 chars).
- `metric`: string `value` (≤120) and optional `note` (≤200).
- `table`: 1–6 columns, ≤50 rows, cells ≤200; every row must match the column count.
- `bar`: 1–12 labels (≤200 each) with the same number of non-negative numeric values.
- The serialized dashboard is at most 65536 bytes.

## API

The routes are the existing artifact routes; slides and dashboards are new kinds.

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/workspaces/{id}/artifacts` | `{title, kind:"slides"\|"dashboard", slides\|dashboard}` + `Idempotency-Key` → `201` |
| GET | `/v1/workspaces/{id}/artifacts/{id}` | Returns `kind:"slides"` and the `slides` deck |
| POST | `/v1/workspaces/{id}/artifacts/{id}` | `{revision, changes:{title?, slides?\|dashboard?}}` |
| GET | `.../preview` | Sandboxed HTML deck |
| GET | `.../export` and `.../versions/{revision}/export` | HTML deck attachment |
| GET | `.../versions` / `.../versions/{revision}` | History; slide snapshots report `kind:"slides"` |
| POST | `.../restore` | Restores a deck as a new revision; identical content does not bump |
| GET/POST | `.../shares` | The existing revocable read-only share renders the deck |

Permissions, title uniqueness, quota and revision conflicts are unchanged: members may read and create; the author, owner or admin may edit; outsiders get `404`.

## Storage

Additive `artifact_slides` (`artifact_id`, `deck`) and `artifact_dashboards` (`artifact_id`, `dashboard`) side tables keep schema `user_version` 1. `artifacts.kind` and `artifact_versions.kind` are unchanged. A slide or dashboard snapshot is recorded in the existing version table as a `document` whose body is the JSON envelope; `version_view` recognises the schema and presents it as `slides` or `dashboard`, and restore writes it back to the matching side table.

## UI

The works-library「新建」menu adds「幻灯片」and「看板」. The slide editor renders one card per page with a title field and a newline-per-bullet textarea, plus add/remove controls. The dashboard editor renders one card per widget with a type switch (指标 / 表格 / 条形图), type-specific fields, and add/remove controls. The list, filter (`幻灯片`), preview, export, history and share flows reuse the existing artifact UI. The source project contains synthetic Playwright captures for review; they are not browser E2E acceptance.

## Explicitly not in this slice

- Data-connected widgets, live queries, or chart libraries beyond the static bar list.
- Real-time/OT/CRDT collaboration, comments, speaker notes, animation, or present mode.
- Slide templates, import from DOCX/PDF, or a public gallery.
- Teamily page-by-page comparison. Tests are in-process WSGI + temporary SQLite plus pure Node helpers.
