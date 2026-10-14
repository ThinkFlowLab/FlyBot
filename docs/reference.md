# Reference

Quick pointers into the tree. For ownership and invariants, see [architecture.md](architecture.md) and [subsystems/](subsystems/README.md).

## Key entry points

| Area | Entry | Notes |
| --- | --- | --- |
| Core server | `core/index.js` | Roster, store, tools, turns. |
| Plugin runtime | `core/src/host/hooks.js` | FlyBot plugin hooks. |
| Tree plugin | `plugins/tree/index.js` | `@flybot/tree`. |
| Social plugin | `plugins/social/index.js` | `@flybot/social`. |
| Arch-doc check | `core/scripts/check-arch-docs.mjs` | Enforces owned_paths ↔ docs. |

## Commands (in `core/`)

```sh
npm ci
npm run harness          # once: DSH packages for tests
npm run build            # src/client → client.js
npm test
npm run lint
npm run arch-docs        # owned file changes need a subsystem doc
```

## Pin and patches

- Pin: `ds-bot.pin.json`
- Patches: `patches/ds-bot/` (ordered topics; see `patches/ds-bot/README.md`)
- Regenerate: `node scripts/ds-bot-patches.mjs generate` then `check`
