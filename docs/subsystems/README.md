# Subsystems

Detail pages for each FlyBot subsystem. Each page lists `owned_paths`, what the subsystem owns, and its invariants.

| Subsystem | Page | Owned paths (summary) |
| --- | --- | --- |
| ds-bot-core | [ds-bot-core.md](ds-bot-core.md) | `core/index.js`, `core/src/`, `core/client.js`, `core/web-search.js`, `core/dev/`, `ds-bot/`, `ds-bot.pin.json`, `patches/ds-bot/`, `scripts/ds-bot-patches.mjs` |
| plugin-runtime | [plugin-runtime.md](plugin-runtime.md) | `core/src/host/hooks.js`, `core/src/client/flybot-slots.js`, `core/src/client/flybot-registry.js`, `core/types/flybot.d.ts`, flybot tests |
| tree | [tree.md](tree.md) | `plugins/tree/` |
| social | [social.md](social.md) | `plugins/social/` |
| install | [install.md](install.md) | `core/scripts/`, arch-doc tests, `plugins/README.md` |
| team | [team.md](team.md) | `docs/subsystems/team.md` — **planned contract only** (no code paths; multi-human is not shipped) |

The `team` page is a planning contract: it defines the proposed human ↔ Chief ↔ specialist authority, routing and approval rules **before** schema work. Team mode stays disabled until its authorization gates pass.

Longest-match wins when two subsystems claim a path. The arch-doc check (`core/scripts/check-arch-docs.mjs`) fails if an owned file changes without its subsystem doc being updated in the same PR (unless the commit message carries a `Docs-not-needed:` trailer).
