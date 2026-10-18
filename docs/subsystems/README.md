# Subsystems

Detail pages for each FlyBot subsystem. Each page lists `owned_paths`, what the subsystem owns, and its invariants.

| Subsystem | Page | Owned paths (summary) |
| --- | --- | --- |
| ds-bot-core | [ds-bot-core.md](ds-bot-core.md) | `core/dev/`, `core/types/`, `ds-bot/`, `ds-bot.pin.json`, `patches/ds-bot/README.md`, `scripts/ds-bot-patches.mjs` (pin, patch format, dev tooling; generated patches are not owned) |
| core-host | [core-host.md](core-host.md) | `core/index.js`, `core/src/host/`, `core/src/shared/`, `core/web-search.js`, host tests |
| core-client | [core-client.md](core-client.md) | `core/src/client/`, `core/client.js` |
| plugin-runtime | [plugin-runtime.md](plugin-runtime.md) | `core/src/host/hooks.js`, `core/src/host/flybot-feed.js`, `core/src/client/flybot-slots.js`, `core/src/client/flybot-registry.js`, `core/types/flybot.d.ts`, flybot tests |
| tree | [tree.md](tree.md) | `plugins/tree/` |
| social | [social.md](social.md) | `plugins/social/` |
| install | [install.md](install.md) | `core/scripts/`, arch-doc tests, `plugins/README.md` |
| team | [team.md](team.md) | `docs/subsystems/team.md` — **planned contract only** (no code paths; multi-human is not shipped) |
| interop | [interop.md](interop.md) | `dev/interop/`, `scripts/lint-interop.mjs` — offline development harness only |
| live-e2e | [live-e2e.md](live-e2e.md) | `dev/live-e2e/`, `scripts/lint-live-e2e.mjs` — real-model browser suite (#204) |

The `team` page is a planning contract: it defines the proposed human ↔ Chief ↔ specialist authority, routing and approval rules **before** schema work. Team mode stays disabled until its authorization gates pass.

The core is three pages so that a change to the browser client, to the server, or to the pin and patch tooling edits only its own page. Longest-match wins when two subsystems claim a path. The arch-doc check (`core/scripts/check-arch-docs.mjs`) fails if an owned file changes without its subsystem doc being updated in the same PR (unless the commit message carries a `Docs-not-needed:` trailer).
