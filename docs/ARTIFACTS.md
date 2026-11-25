# Artifacts (documents, slides, dashboards, media, whiteboards, and shares)

Related: [#9](https://github.com/openTeamily/openTeamily/issues/9), [#1](https://github.com/openTeamily/openTeamily/issues/1). Those tracking issues stay open.

This slice stores workspace-scoped **documents**, **slide decks**, **dashboards**, **static websites**, **media files**, and **whiteboards**. See [STUDIO.md](STUDIO.md) for the slide-deck slice. Automation or agent results can be saved as documents with provenance. Each save keeps a revision snapshot that can be listed, exported, or restored as a new revision (history is not rewritten). Read-only share links are created only when someone asks, and they can be revoked. It is self-written and is **not** Teamily works-library parity.

Completed messages in an authorized user/agent conversation can be saved as documents with provenance (`source.kind=agent_message`, plus `id`, `conversation_id`, optional `agent_id`, and `conversation_title` when the conversation still has a title) and are idempotent per message. The works-library filter lists those titles under「来源会话」instead of raw conversation ids. Scripted web apps are not enabled on the management origin.

## Supported operations

| Kind | Create | Read | Edit | Notes |
|---|---|---|---|---|
| document | JSON `{title, body}` | body | revisioned title/body | Existing behavior |
| website | JSON `{title, body, kind: website}` | sanitized HTML preview | revisioned source | CSP `sandbox`, no scripts |
| media | `multipart/form-data` with `title` and `file` | metadata; `GET .../file` for bytes | title via JSON; replace file via `POST .../file` with revision | MIME is sniffed from magic bytes; SVG/HTML/JS rejected; filename is sanitized and not used as a path |
| whiteboard | JSON `{title, kind: whiteboard, board}` | `board` plus SVG preview | `{revision, changes: {title, board}}` or `{operations: [{op: add\|remove\|replace, ...}]}` | Strokes are paths, rectangles, ellipses, or escaped text |
| slides | JSON `{title, kind: slides, slides}` | `slides` deck plus HTML preview | `{revision, changes: {title, slides}}` | Deck schema `flybot-workspace.slides.v1`; 1–30 slides, ≤120-char title, ≤10 bullets of ≤200 chars each |
| dashboard | JSON `{title, kind: dashboard, dashboard}` | `dashboard` widgets plus HTML preview | `{revision, changes: {title, dashboard}}` | Schema `flybot-workspace.dashboard.v1`; 1–20 metric/table/bar widgets |

## Routes (session + CSRF unless noted)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces/{id}/artifacts` | Lists items (no document body; media metadata only) |
| POST | `/v1/workspaces/{id}/artifacts` | JSON create, or multipart media upload. Requires an Idempotency-Key |
| GET | `/v1/workspaces/{id}/artifacts/{id}` | One item, including body, board, or media metadata |
| POST | `/v1/workspaces/{id}/artifacts/{id}` | Revisioned title/body/board/operations/slides/dashboard |
| GET | `/v1/workspaces/{id}/artifacts/{id}/file` | Media bytes for members |
| POST | `/v1/workspaces/{id}/artifacts/{id}/file` | Replace media (`revision` form field) |
| GET | `/v1/workspaces/{id}/artifacts/{id}/preview` | Sandboxed HTML render (media previews are a text/html wrapper, not a scripted player) |
| GET/POST | `/v1/workspaces/{id}/artifacts/{id}/shares` and `.../revoke` | Explicit, revocable, read-only shares |
| GET | `/v1/workspaces/{id}/artifacts/{id}/versions` | Revision history (metadata only, newest first) |
| GET | `/v1/workspaces/{id}/artifacts/{id}/versions/{revision}` | One snapshot, including body, board, or media metadata |
| GET | `/v1/workspaces/{id}/artifacts/{id}/export` and `.../versions/{revision}/export` | Download the current or a historical snapshot as an attachment |
| POST | `/v1/workspaces/{id}/artifacts/{id}/restore` | `{revision, to}` restores snapshot `to` as a new revision. Same-content restore does not bump. Author, owner or admin only |
| GET | `/share/{token}` | Public read-only render or media bytes. Invalid or revoked tokens are `404` |

Media files are at most 2 MiB. Allowed sniffed types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `video/mp4`, `video/webm`. Objects are stored under the private data directory as `{workspace_id}/{sha256}`, never under a user-supplied path. Whiteboard JSON is at most 65536 bytes, with at most 200 strokes. Slide deck and dashboard JSON are each at most 65536 bytes. Slide history is stored as a document snapshot whose body is the deck JSON; version reads present it as kind `slides`, and restore writes it back to the `artifact_slides` side table.

Title is unique per workspace. Default cap is 50 items and 100 stored revisions per item. Tables are additive; `user_version` stays 1. Creating or saving an item does not publish a share. Each successful create, edit, media replace, or restore writes a snapshot. Existing items without history are backfilled from the current row on the first history read.

Exports use `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. Documents are `text/plain`, websites, slide decks and dashboards are sanitized HTML, whiteboards are SVG, and media is the original sniffed bytes. Share links do not gain an export route in this slice.

## Permissions

Workspace members may list, read and create items. The author, an owner or an admin may edit, replace media, remove, or create/revoke shares. A member cannot change or share someone else's item (`403`). Callers who cannot see the workspace receive `404`.

## Rendering and safety

Documents are escaped text. Websites and whiteboards are sanitized and served with a CSP `sandbox` that does not allow scripts. Media is served with the sniffed MIME type, `X-Content-Type-Options: nosniff`, and `Content-Disposition: inline`. The management page does not insert unsanitized HTML. This is a CSP/sandbox and MIME-sniffing boundary on the management host, not a separate browser origin.

## Works-library directory chrome

The `/space` left directory now follows the recorded empty-library layout: the heading is「资料空间」,「+ 新建」shows a dropdown caret, type rows include icons, and the top layout control is the recorded「网格视图」/「列表视图」tablist. 「收起侧边栏」hides the directory for the current page view only and leaves an「展开侧边栏」control; that collapsed layout was not recaptured, is not persisted, and is not a contrast claim. A populated grid is still not invented.

The `/space?view=meetings` page now also exposes the recorded heading「我的会议」and a wave-form empty icon above the existing empty copy. Captions and「我参加的」/「全部」tabs are unchanged, still without a meetings API or invented recordings. The workspace picker stays visible for FlyBot multi-workspace use. The existing disabled「通知」control is an original bell icon with the accessible name「通知」; there is still no notifications API.

## Removing an artifact

「删除」 asks before it deletes. The question is built in the page as an inline `role="alertdialog"` (`删除「<title>」？`, falling back to `删除这个作品？` when the title is empty) with「取消」and「确认」；opening it sends no request, focus starts on「取消」, and `Escape` closes it and returns focus to「删除」. Only「确认」sends the single `POST …/remove`. The page does not use `window.confirm`, and `static/artifacts/index.html` is unchanged.

## Not claimed

No public homepage, no scripted web apps, no meeting-notes ingest, no Teamily comparison, no browser E2E. This issue stays open until those are done and compared.

### Version-pinned work sharing into chat

All saved work kinds (document, website, whiteboard, slides, dashboard, media) can be sent to an authorized workspace social conversation. An optional `artifact_revision` must match the saved current revision for a new send. Metadata and export link are pinned in `social_artifact_versions`; forwarding copies this metadata, and later work edits do not silently change the sent version. Replaying the same idempotency key returns the original message even after a later edit. Sending does not publish a public share. Source deletion can make the reference unavailable; it does not erase the historical chat text. Exports keep their existing supported formats, not native Office/PDF promises.
