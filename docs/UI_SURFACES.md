# UI surfaces: which side owns what

Related: #3393. The process is `docs/DEV_PIPELINE.md`; this page answers only "which side owns this
change". Measured on `34a80ca5a1`.

- Page → feature map and the change → what to run table: [UI_SURFACES_MAP.md](UI_SURFACES_MAP.md)
- Cross-side couplings, screenshot duty, what is runnable here: [UI_SURFACES_OPS.md](UI_SURFACES_OPS.md)

## 1. Boundary

**Python side (pages):** `flybot_workspace/static/**` (26 page dirs, `shell/*.mjs`),
`flybot_workspace/*_page.py`, `server.py` (handlers, route allowlists, headers).
**Plugin side:** `runtime/flybot-workspace-web/{index.js,src/,lib/,featurekit/}` (host, API wiring),
`features/*/index.js` (routes/API/tools, no markup), `test/**` (62 files).
Repo level: the screenshot harness (`scripts/ci_ui_screenshots.*`, `scripts/ci-native-ui*.mjs`,
`ui-screenshots.yml`). Vendor `runtime/ds-bot-upstream/**` is never edited.

Pages have one source: `flybot_workspace/static/**`. `index.js:30` is
`pagesDir = config.pagesDir ?? join(HERE, 'pages')` and `pages/` is not in this repo
(`PAGES_NOT_BUNDLED.md`); an image built without
`--build-context flybot-workspace-static=flybot_workspace/static` 404s every page. So
`pages: [...]` in `features/*/index.js` is documentation (`src/features.js:11`), not a route table,
and page markup does not belong under `features/`.
