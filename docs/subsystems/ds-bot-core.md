---
subsystem: ds-bot-core
owned_paths:
  - core/index.js
  - core/src/
  - core/client.js
  - core/web-search.js
  - core/dev/
  - core/types/
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

## Tests

`npm test` in `core/`; smoke test for `index.js` / `src/host/` changes.

## Common mistakes

- Hand-editing `ds-bot/` or `client.js`.
- Forgetting `node scripts/ds-bot-patches.mjs generate && check`.
- Running the bench against `~/.dsh`.
