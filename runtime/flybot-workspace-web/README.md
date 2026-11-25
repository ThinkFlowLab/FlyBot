# @flybot-workspace/web — FlyBot inside each user's own DS-Bot

DSH plugin loaded in the runtime image's `web` profile next to the
`@flybot-workspace/flybot-runtime` wrapper (which boots unmodified upstream DS-Bot).
Phase A of [docs/DSBOT_PLUGIN_ARCHITECTURE.md](../../docs/DSBOT_PLUGIN_ARCHITECTURE.md).

Routes (exact DSH Fetch routes on the shared `/api` channel; DSH's Host/Origin
fence and browser-session authentication run first):

- `GET /api/flybot-workspace/page?path=/chat/` — the FlyBot pages bundled at
  build time from `flybot_workspace/static` (`--build-context flybot-workspace-static=flybot_workspace/static`).
  Every response carries `x-flybot-workspace-served-by: ds-bot; instance=<id>` and
  HTML pages carry `<meta name="flybot-workspace-instance">`, so CI can prove which
  runtime served a page.
- `POST /api/flybot-workspace` — `{endpoint, payload}` dispatch, same result shape as
  `/api/bot`. Phase A: `shell/identity`. Feature batches add endpoints here.

Identity: `FLYBOT_WORKSPACE_INSTANCE_ID` from the manager, otherwise a random
per-volume id in `/data/flybot-workspace/instance.json`. It is not a credential.

Tests: `npm test` (no install). The two-runtime isolation proof is
`runtime/flybot-image/test/container-gateway-isolation.py`.

## B3 feature kit

`featurekit/` is shared code for the B3 features (meetings, memory, artifacts,
search) built on the stable extension point (`features/<name>/index.js`).
`defineFeature(spec)` opens the feature's own SQLite file under
`host.featureDir()`, applies its migrations, imports pending legacy bundles
(`/data/flybot-workspace/import/*.bundle`, built per user and per feature by
`flybot_workspace/dsbot_bundle.py`), and registers `<name>/v1` (the feature's legacy
`/v1` routes, executed here), `<name>/routes` and `<name>/search`.
Pages served by the DS-Bot load `flybot_workspace/static/shell/dsbot-api.mjs`, which
turns a moved feature's legacy `/v1` calls and download links into
`POST /b/api/flybot-workspace {endpoint: '<name>/v1'}`; on legacy pages it does nothing.

Moved so far: meetings; memory (pages, revisions/restore, export, 做梦, actions, links, graph, profile, preferences; `memory/pages` for chat recall, `memory/personal`); search (messages, resources, search/all); artifacts (studio CRUD, media, boards, slides, dashboards, versions, original and office (docx, xlsx, pdf, pptx) export, authenticated shares, `artifacts/create`, `artifacts/files`, `artifacts/search`; per-user bundle import including media objects).
