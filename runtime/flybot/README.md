# FlyBot customization layer (OpenTeamily snapshot)

> This tree is a **minimal import** of selected files from
> [ThinkFlowLab/FlyBot@e26895e](https://github.com/ThinkFlowLab/FlyBot/commit/e26895e737b1218875aafa1f74ab1d3464f287d2).
> It is **not** a whole-repository copy and does **not** include FlyBot `core/`
> (the old DS-Bot v0.1.5 fork). OpenTeamily tracks upstream DS-Bot **v0.3.6** as
> the runtime baseline (see [openTeamily PR #21](https://github.com/openTeamily/openTeamily/pull/21)).
> License: Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
> This tree is not covered by the repository-root MIT license. Provenance:
> [ORIGIN.md](ORIGIN.md), [docs/upstream/SELECTION.md](../../docs/upstream/SELECTION.md).

## What is here

- `plugins/social/` — `@flybot/social`, the FlyBot-side client for Bot Social
- `docker/` — instance entrypoint, health check, profile linker, and loopback bind patch
- `docs/docker.md`, `docs/docker.zh.md`, `docs/subsystems/social.md` — docs for those paths

## What is not here

- `core/`, `ds-bot/`, `patches/`, and `ds-bot.pin.json` (the v0.1.5-based fork)
- `plugins/{project,timeline,tree,workflow}`
- Official `Dockerfile` / `compose.yaml`, brand images, and upstream process files

Host-integration tests that imported the deleted `core/` were removed. Plugin-only
tests under `plugins/social/test/` can be run with `node --test` via the package
`test` script. They do not install DeepSeek Harness.
