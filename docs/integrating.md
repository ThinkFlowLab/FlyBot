# Integrating with FlyBot

FlyBot extends DeepSeek Harness (DSH) through the `ds-bot` plugin and optional FlyBot plugins (`@flybot/social`, `@flybot/tree`).

## Plugin model

Every Bot is a DSH Session. The plugin runs in DSH Desktop, DSH Web and the desktop app. Plugins attach through the FlyBot plugin runtime (see [plugin-runtime](subsystems/plugin-runtime.md)).

## Adding a plugin

1. Create `plugins/<name>/` with an `index.js` entry.
2. Declare `@flybot/<name>` in `plugins/README.md`.
3. Wire ownership in [subsystem docs](subsystems/README.md) and run `npm run arch-docs` from `core/`.

## Building on DSH

Use documented plugin APIs only. Never patch DSH or depend on files inside a DSH install. If something is missing in DSH, stop and report it.

## Core vs plugins

| Layer | Owned paths | Edit rule |
| --- | --- | --- |
| ds-bot-core, core-host, core-client | `core/index.js`, `core/src/`, `core/client.js`, `patches/ds-bot/`, … | Change `core/`, regenerate patches. |
| plugin-runtime | `core/src/host/hooks.js`, slots, registry | FlyBot plugin API surface. |
| tree / social | `plugins/tree/`, `plugins/social/` | Independent plugins. |
| install | `core/scripts/`, arch-doc checks | Tooling only. |
