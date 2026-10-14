---
subsystem: ds-bot-core
owned_paths:
  - core/index.js
  - core/src/
  - core/client.js
  - core/web-search.js
  - core/dev/
  - core/types/
  - core/test/identity.test.js
  - ds-bot/
  - ds-bot.pin.json
  - patches/ds-bot/
  - scripts/ds-bot-patches.mjs
---

# ds-bot-core

Patched upstream `ds-bot` that ships as `core/`. Never edit `ds-bot/` by hand; change `core/` and regenerate patches.

## Owns

- Core server: roster/store, tools, turns/delivery, groups, conversation parts, search index, images, browser bridge, `api/bot` channel.
- Browser client: sidebar, chat, panels, themes, characters, Bot browser panel (`core/client.js` generated from `core/src/client/`).
- `core/web-search.js` — standalone `auto` web-search provider.
- `core/dev/` — harness packages, mock model, test bench, smoke test.
- `core/test/identity.test.js` — the state identity schema tests (store `state.json` v2, #47).
- Pin (`ds-bot.pin.json`) and ordered patches (`patches/ds-bot/`).

## Does not own

- FlyBot plugin API surface → [plugin-runtime](plugin-runtime.md) (except `core/types/` which this page claims for now).
- `plugins/tree/`, `plugins/social/` → their own pages.
- `core/scripts/`, arch-doc checks → [install](install.md).

## Key files

| File | Role |
| --- | --- |
| `core/index.js` | Server entry. |
| `core/src/client/` | Client sources → build to `core/client.js`. |
| `core/src/host/` | Host-side helpers (non-hooks). |
| `ds-bot.pin.json` | Upstream pin. |
| `patches/ds-bot/` | Ordered patch topics. |
| `scripts/ds-bot-patches.mjs` | generate / check patches. |

## Entry points

- `core/index.js` — plugin server.
- `core/client.js` — built browser bundle (generated; never hand-edit).
- `dev/bench.sh`, `dev/smoke.mjs` — test bench.

## Invariants

1. `ds-bot/` stays pristine; CI fails if it differs from the pin.
2. `core/` == `ds-bot/` + `patches/ds-bot/`; regenerate after every `core/` change.
3. `client.js` matches `core/src/client/`; `npm run build` + `--check`.
4. Never touch the user's `~/.dsh`.
5. The saved team (`state.json`) is versioned. Version 2 (#47) carries the identity schema — `members` records, a per-Bot `ownerId`, the owner's `designatedChiefId`. A legacy version-1 file is migrated on load with a one-time `state.json.v1` backup; an existing backup counts only when it is a readable file holding a parseable version-1 state, and anything else (or any malformed ownership) fails closed (read-only). An older binary refuses a newer version read-only. This is schema foundation only — team mode stays disabled, see [team](team.md).
6. Host diagnostics never depend on `ctx.logger`: DSH may export no logger, and a test or plugin-local host may carry one without `warn`. `rt.warn` still writes stderr and the diagnostics log in that case (`src/host/diagnostics.js`).

## Tests

`npm test` in `core/`; smoke test for `index.js` / `src/host/` changes.

## Common mistakes

- Hand-editing `ds-bot/` or `client.js`.
- Forgetting `node scripts/ds-bot-patches.mjs generate && check`.
- Running the bench against `~/.dsh`.
