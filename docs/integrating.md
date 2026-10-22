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

## Plugin seams

A plugin is otherwise pure — it reads fields, registers tools and slots, and routes messages. A few things a plugin may need of its own go through a **named, capped seam** the host grants per plugin; all are off unless the host names the plugin in the profile config.

| Seam | What a plugin may do | Host config | Docs |
| --- | --- | --- | --- |
| `flybot.model.ask({ prompt, system?, maxTokens? })` | One short model call (a classification, a title, a one-line summary); resolves `{ ok: true, text }` or `{ ok: false, code }` | `flybot.modelPlugins: [<plugin>, …]`, optional per-plugin default `flybot.modelFor: { <plugin>: <provider/model> }` | [plugin-runtime](subsystems/plugin-runtime.md) |
| `flybot.memory.read(botId)` / `append(botId, text, meta?)` | Read a Bot's own memory entries (capped) and append one through the ordinary path | `flybot.memoryPlugins: [<plugin>, …]` | [plugin-runtime](subsystems/plugin-runtime.md) |

Both seams are metadata-safe: no egress, text only, a short `code` instead of provider text, and refused on a read-only host. A plugin that needs nothing of the sort keeps to the fields and the activity feed (`flybot.on('turn.start' | 'turn.end' | 'tool.start' | 'tool.end' | 'exchange.delivered')`).

## Core vs plugins

| Layer | Owned paths | Edit rule |
| --- | --- | --- |
| ds-bot-core, core-host, core-client | `core/index.js`, `core/src/`, `core/client.js`, `patches/ds-bot/`, … | Change `core/`, regenerate patches. |
| plugin-runtime | `core/src/host/hooks.js`, slots, registry | FlyBot plugin API surface. |
| tree / social | `plugins/tree/`, `plugins/social/` | Independent plugins. |
| install | `core/scripts/`, arch-doc checks | Tooling only. |
