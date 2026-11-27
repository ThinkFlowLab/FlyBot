# UI surfaces: what to run per change

Related: #3393. Part of [UI_SURFACES.md](UI_SURFACES.md). Measured on `34a80ca5a1`.

- `flybot_workspace/static/**` → `node --test tests/*.test.mjs` → CI `Web and compose planner`;
  screenshot if the change is visible.
- `static/shell/system-locale*.mjs` → `node --test tests/system_locale*.test.mjs` → same check.
- `flybot_workspace/**/*.py` → `unittest discover -s tests -v` and `compileall -q` under `python -m`;
  CI `Management API · 3.11` / `3.13`; screenshot only if page output changes.
- `runtime/flybot-workspace-web/**` → `npm test` in that directory → CI `runtime-image / Image recipe
  contract tests`; no screenshot, fixtures are Python side.
- `ci-native-ui*`, `ci_ui_screenshots.*`, `ui-screenshots.yml` → `node --check` → CI `browser /
  screenshots`.
