# FlyBot Architecture

FlyBot is a team of long-lived Bots built on DeepSeek Harness (DSH). Two parts ship: the `ds-bot` plugin (patched upstream) and the desktop app.

## Layout

| Path | What it is |
| --- | --- |
| `ds-bot/` | Pristine upstream pin (Fei2411/DeepSeek-Bot). Never edit. |
| `patches/ds-bot/` | Ordered FlyBot patches on the pin. |
| `core/` | `ds-bot/` + patches. Ships; all tests run here. |
| `plugins/social/` | `@flybot/social` — social posting plugin. |
| `plugins/tree/` | `@flybot/tree` — knowledge-tree plugin. |
| `app/` | Desktop app (Windows/macOS) for the DSH + plugin. |

## Subsystems

Each subsystem has a detail page under [docs/subsystems/](subsystems/README.md) with owned paths, invariants and tests:

- [ds-bot-core](subsystems/ds-bot-core.md) — patched core runtime
- [plugin-runtime](subsystems/plugin-runtime.md) — FlyBot plugin hooks
- [tree](subsystems/tree.md) — `@flybot/tree`
- [social](subsystems/social.md) — `@flybot/social`
- [install](subsystems/install.md) — scripts and install doctor

## Integrating

See [docs/integrating.md](integrating.md) for how to add a plugin or integrate with DSH.

## Reference

See [docs/reference.md](reference.md) for API and CLI reference material.
