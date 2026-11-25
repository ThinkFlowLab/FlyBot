# Origin

This directory is a **minimal, file-selected snapshot** of public
[ThinkFlowLab/FlyBot](https://github.com/ThinkFlowLab/FlyBot) commit
[`e26895e737b1218875aafa1f74ab1d3464f287d2`](https://github.com/ThinkFlowLab/FlyBot/commit/e26895e737b1218875aafa1f74ab1d3464f287d2)
(2026-11-16 00:07:14 UTC). It is **not** a whole-repository copy, and it is
**not** the OpenTeamily runtime baseline.

- **License:** Apache License 2.0 — [`LICENSE`](LICENSE).
- **NOTICE:** [`NOTICE`](NOTICE) (DS Bot, Copyright 2026 Fei2411 and the DS Bot contributors). Redistribution must keep both files.
- **This tree is not MIT-licensed** because it lives in openTeamily/openTeamily. The root MIT license covers only new OpenTeamily-authored material.
- **Provenance:** every *unmodified* imported upstream file has `sha256` and git blob SHA in [`docs/upstream/flybot-files.json`](../../docs/upstream/flybot-files.json). Documented modifications (and their original hashes) are in [`docs/upstream/migration-manifest.json`](../../docs/upstream/migration-manifest.json) under `modified_files`. Selection and exclusions: [`docs/upstream/SELECTION.md`](../../docs/upstream/SELECTION.md).
- **OpenTeamily overlays:** this file and [`OPENTEAMILY.md`](OPENTEAMILY.md).
- **Runtime baseline:** OpenTeamily tracks upstream DS-Bot **v0.3.6** in [PR #21](https://github.com/openTeamily/openTeamily/pull/21) (now on `main`). This snapshot does **not** contain `core/` or `ds-bot.pin.json` (the old v0.1.5 fork). The historical FlyBot core pin `2b10c70b614e969117b68ddc6fd14e68968272f2` equals upstream `0f130e7d134bf63e8988b2d53fd6846138ac3d73` (ds-bot tree `5834c00d9c21b972e4b32ad90489443da2a10324`); see [`docs/upstream/ds-bot-pin-equivalence.json`](../../docs/upstream/ds-bot-pin-equivalence.json).

## Imported paths

| Path in this tree (upstream path is the same) | Source | Purpose | Related issues (does not close them) |
| --- | --- | --- | --- |
| `LICENSE`, `NOTICE` | FlyBot `@e26895e737b1218875aafa1f74ab1d3464f287d2` | Binding Apache-2.0 text and NOTICE | #3 |
| `README.md`, `README.zh.md` | same commit, **modified** | Snapshot overview of the customization layer; the upstream full-product README (logo and excluded-plugin links) was replaced | #2 |
| `.gitignore`, `.dockerignore` | same commit | Ignore rules for the package tree | #2 |
| `plugins/social/` | `plugins/social/` @ same commit | `@flybot/social`: FlyBot-side client for Bot Social onboard, invite, approval, rooms | #5 |
| `plugins/social/test/look.test.js`, `test/resolve.mjs` | same paths, **modified** | Plugin-only look tests; optional test resolver that no longer requires a FlyBot `core/` checkout | #5 |
| `docker/entrypoint.mjs`, `docker/healthcheck.mjs`, `docker/profile.mjs`, `docker/web.patch.yml` | `docker/` @ same commit | Instance start, health, profile linking, loopback bind patch. Official root `Dockerfile` / `compose.yaml` are not imported. | #2 |
| `docs/docker.md`, `docs/docker.zh.md`, `docs/subsystems/social.md` | same paths, **modified** | Docs for the imported docker helpers and social plugin (snapshot headers; broken links to excluded paths rewritten) | #2, #5 |

`core/`, `ds-bot.pin.json`, `ds-bot/`, and `patches/` are **not imported**. Host-integration tests under `plugins/social/test/` that hard-imported `../../../core/` were removed and will need to be rewritten against the v0.3.6 baseline. See [`docs/upstream/SELECTION.md`](../../docs/upstream/SELECTION.md) and [`docs/upstream/OPTIONAL-PLUGINS.md`](../../docs/upstream/OPTIONAL-PLUGINS.md).
