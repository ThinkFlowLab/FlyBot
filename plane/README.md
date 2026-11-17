# @flybot/plane

The FlyBot management plane — first slice of [#3113](https://github.com/ThinkFlowLab/FlyBot/issues/3113) (parent: #3110).

`plane/` is the control plane that owns accounts, workspaces and FlyBot instance records, mints the two credential families, and steers instances through an abstract lifecycle backend. It deliberately runs **no** agent and **no** docker itself: an instance is the existing FlyBot runtime on its own data volume, and the plane only records and steers it.

## Working defaults, not owner decisions

These three are replaceable working defaults chosen for this slice, following the issue's "可替换的工作默认" rule. None of them is settled by the owner:

1. **Granularity: one instance per owner (or per workspace).** Closest to today's "one instance per person" (#352). Adjustable without touching the store: the record keys on `(workspaceId, name)`.
2. **Storage: one JSON file, `plane.json`, under the data dir.** It carries a `version` field so a later migration can tell what it is reading before it reads it. The plane owns this file alone; an instance's own data stays on the instance's volume.
3. **Backend: the compose backend only *materializes* an instance project** (`instances/<id>/compose.yaml` + `control.env`, mode 0600) and never runs docker. The existing repo `compose.yaml` is one self-hosting path, not the only one; `LifecycleBackend` is the seam for others.

Also out of this slice, refusing loudly rather than pretending: `upgrade` and `recycle` throw `NotImplementedError`; no management UI, no external gateway, no real `docker compose up`.

## Credentials

Two families that never open each other's door:

- Operator tokens (`op_…`) speak to `/api/*`. `node plane/bin/plane.mjs token --data-dir <dir> --account <id>` mints one and prints it exactly once.
- Control tokens (`ctl_…`) are what the plane presents to one FlyBot instance. Each instance gets its own; the compose backend writes it into that instance's 0600 `control.env`, never into the compose file.

Only sha256 digests are persisted (`plane.json` has no plaintext). A control token presented to `/api/*` is a 401, an operator token presented as a control credential is refused, and verification uses `timingSafeEqual`. Logs that must name a token go through `redact()`.

## API

`serve()` binds `127.0.0.1` only. `handle()` is the same logic as a pure function — that is what the tests drive, with no socket.

| Route | What it does |
| --- | --- |
| `POST /api/instances` | create (needs `workspaceId`, `name`; unique per workspace; 409 otherwise; hands out the control token once) |
| `GET /api/instances` | list the caller's own instances only |
| `GET /api/instances/:id` | one instance (404 unknown, 403 someone else's) |
| `POST /api/instances/:id/start` | start (idempotent record: state moves to `running`) |
| `POST /api/instances/:id/stop` | stop (state persists as `stopped` across restarts) |

## Test

```sh
npm --prefix plane test
```

No network, no docker, no cloud. The suite (20 cases across 5 files) covers ownership (403/401 boundaries), creation (duplicate, isolation, persistence, 400), the create→start→stop→start loop, credential separation, and the compose backend's file-only contract.
