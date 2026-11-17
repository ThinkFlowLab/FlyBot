---
subsystem: plane
owned_paths:
  - plane/
---

# plane (`@flybot/plane`)

The management-plane control plane — first slice of #3113 (parent #3110). It owns accounts, workspaces and FlyBot instance metadata, the two credential families, and the lifecycle seam; it runs no agent and no docker itself.

`plane/` is a top-level package, not a core plugin: the management plane must not run inside the agent container, and `core/` is ds-bot + patches (changing it means regenerating `patches/ds-bot/`). It is also not under `/opt/flybot/packages` in the image, so `docker/profile.mjs` never bundles it — this slice ships no image and no compose changes.

Records live in one `plane.json` under the data dir (`version` at the top for migration), written temp-file-plus-rename at 0600 in a 0700 dir, the `core/src/host/private-files.js` shape. An instance name is unique inside a workspace, never across owners. The state the plane records (`stopped` stays `stopped` across a process restart) is the plane's own bookkeeping; an instance's data stays on the instance's volume.

Credentials are two non-interchangeable families: operator tokens (`op_…`) for `/api/*` and per-instance control tokens (`ctl_…`) for the plane→instance direction. Only sha256 digests are stored; verification is `timingSafeEqual`; `redact()` is what a log line may show.

The lifecycle is the `LifecycleBackend` contract (`create/start/stop/upgrade/recycle`). `MemoryBackend` moves state only; `ComposeBackend` materializes `instances/<id>/compose.yaml` plus a 0600 `control.env` — host networking and a loopback `FLYBOT_PORT`, mirroring the repo's own `compose.yaml` — and never spawns docker. `upgrade` and `recycle` throw `NotImplementedError` by design: the seam exists, the second slice fills it.

`handle()` is the pure routing function (every route verifies an operator token, then the instance routes compare `instance.ownerId`); `serve()` is the `node:http` adapter bound to `127.0.0.1`; `plane/bin/plane.mjs` is the CLI (`token`, `serve`). The suite is `npm --prefix plane test` — no network, no docker — registered in `docs/testing-layers.json` as suite `plane` (L1).
