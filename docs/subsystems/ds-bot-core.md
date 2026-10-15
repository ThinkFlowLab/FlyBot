---
subsystem: ds-bot-core
owned_paths:
  - core/dev/
  - core/types/
  - ds-bot/
  - ds-bot.pin.json
  - patches/ds-bot/README.md
  - scripts/ds-bot-patches.mjs
---

# ds-bot-core

Patched upstream `ds-bot` that ships as `core/`. Never edit `ds-bot/` by hand; change `core/` and regenerate patches.

This page covers the pin, the patch format and the core's dev tooling. The generated output (`patches/ds-bot/*.patch`, `files/`, `topics.json`) is not owned: it follows from `core/`, so a core change need not edit this page for it; `patches/ds-bot/README.md` (the format) and `scripts/ds-bot-patches.mjs` are owned. The code itself is described by two pages: [core-host](core-host.md) (server: `core/index.js`, `core/src/host/`, `core/src/shared/`, `core/web-search.js`) and [core-client](core-client.md) (browser: `core/src/client/`, `core/client.js`).

## Owns

- `core/dev/` — harness packages, mock model, test bench, smoke test.
- Pin (`ds-bot.pin.json`), ordered patches and whole added files (`patches/ds-bot/`).

## Does not own

- Server and browser code of the core → [core-host](core-host.md), [core-client](core-client.md).
- FlyBot plugin API surface → [plugin-runtime](plugin-runtime.md) (except `core/types/` which this page claims for now).
- `plugins/tree/`, `plugins/social/` → their own pages.
- `core/scripts/`, arch-doc checks → [install](install.md).

## Key files

| File | Role |
| --- | --- |
| `ds-bot.pin.json` | Upstream pin. |
| `patches/ds-bot/` | Ordered patch topics. |
| `scripts/ds-bot-patches.mjs` | generate / check patches. |

## Entry points

- `core/index.js` — plugin server.
- `core/client.js` — built browser bundle (generated; never hand-edit).
- `dev/bench.sh`, `dev/smoke.mjs` — test bench.

## Invariants

1. `ds-bot/` stays pristine; CI fails if it differs from the pin.
2. `core/` == `ds-bot/` + `patches/ds-bot/files/` + `patches/ds-bot/*.patch`; regenerate after every `core/` change. A new file under `core/` (for example `test/new-chat.test.js`) is stored whole in `patches/ds-bot/files/` by `generate` and needs no `topics.json` entry; an upstream file edited for the first time must be listed in `patches/ds-bot/topics.json`. Otherwise `scripts/ds-bot-patches.mjs check` fails with “committed but not produced by the patches”. The format has no `index` lines or cross-hunk line numbers so parallel PRs merge cleanly (see `patches/ds-bot/README.md`).
3. `client.js` matches `core/src/client/`; `npm run build` + `--check`.
4. Never touch the user's `~/.dsh`.

## Tests

`npm test` in `core/`; smoke test for `index.js` / `src/host/` changes.

## Common mistakes

- Hand-editing `ds-bot/` or `client.js`.
- Forgetting `node scripts/ds-bot-patches.mjs generate && check`.
- Running the bench against `~/.dsh`.
