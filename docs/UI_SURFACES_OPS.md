# UI surfaces: couplings, screenshots, and what runs here

Related: #3393. Part 2 of [UI_SURFACES.md](UI_SURFACES.md); the boundary, the page → feature map and
the dispatch table are there. Measured on `34a80ca5a1`.

## 4. The sides are not independent

- `tests/system_locale.test.mjs:7`, `tests/system_locale_chat.test.mjs:5` import
  `../runtime/flybot-workspace-web/src/pages.js` — editing it reds `Web and compose planner`.
- `tests/test_dsh_architecture.py:16-17,55` asserts the plugin's `features/` and `lib/c/` — a plugin
  restructure reds `Management API`.
- `flybot_workspace/dsbot_bundle.py` depends on the bytes of `src/features/importer.js`.
- Settings pages come from `SettingsPage.ASSETS` (`settings_page.py`); a new page needs the Python
  entry plus the static dir. `/settings/message-folding` is still listed though that page folded in.

## 5. Screenshot duty

- Visible UI change: attach screenshots. No UI surface: say "no UI surface / 无 UI 面".
- Both harnesses drive the Python-served pages, never the plugin (`ci_ui_screenshots.mjs` via
  `ci_ui_screenshots.py --serve`; `ci-native-ui-screenshots.mjs` → `ci-native-ui.mjs`, which boots
  `flybot_workspace.app`). Both need `python3`.

## 6. What actually runs on this machine

No `python3`, no `python` (`command -v python3 python` → rc=1), no Playwright. Green here:

- `node --test tests/settings_page.test.mjs tests/guide_page.test.mjs tests/onboarding_step2.test.mjs`
  → `tests 62 / pass 62 / fail 0`; `node --check flybot_workspace/static/guide/app.mjs` → clean.
- Plugin `node --test test/features.test.js` → `tests 6 / pass 6 / fail 0`.

Not runnable here — environment, not product:

- Full `node --test tests/*.test.mjs` aborts after 656 passing subtests (`uv_thread_create`
  assertion, no exit line). Harness crash, not a test failure.
- Full plugin `npm test`: `Failed to load CA certificates off thread …`, then
  `Personal agent bootstrap target mismatch` (`test/b4-settings.test.js test/chat.test.js`).
- Every Python command in §3: no interpreter.

Both full suites are judged on CI: `34a80ca5a1` has 33/33 check-runs success, including every check
in §3. A local harness crash is neither evidence of red nor licence to call it green.
