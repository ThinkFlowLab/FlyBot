---
subsystem: plane
owned_paths:
  - plane/
---

# plane (management-plane skeleton)

The first slice of the management server for self-hosted FlyBot (#3113, parent #3110): accounts,
workspaces and instance metadata, the two separated credentials, the create/start/stop/restart
lifecycle, and an abstract lifecycle backend with one compose materializer. It is a skeleton on
purpose: no container is started in this slice.

## Owns

- `plane/`: the `@flybot/plane` package — store, credentials, lifecycle contract, HTTP router,
  CLI, tests and its README. The three replaceable working defaults (granularity, storage,
  backend) are at the top of [plane/README.md](../../plane/README.md).

## Does not own

- The FlyBot runtime inside the instance (Agent, sessions, memory, scheduling) — that stays
  `core/` and the plugins.
- The shipped image, `Dockerfile`, `compose.yaml`, `docker/` and the pack whitelist — this
  package is not in the image and not in `docker/profile.mjs`'s bundles.
- Cross-instance social traffic — Bot Social and `plugins/social`; the plane will configure an
  instance's connection later, not carry messages.
- Upgrade, recycle, backup and recovery implementation — present only as `NotImplementedError`
  on the lifecycle contract.

## Invariants

- The plane never runs an Agent. It records an instance, and a `LifecycleBackend` decides where
  it runs; the first backend writes a compose project and starts nothing.
- Two credentials never interchange: `op_` is accepted on `/api/*` only, `ctl_` is what the
  plane hands an instance. Only sha256 is persisted, and comparison is timing-safe.
- Every instance route checks the operator token first, then `instance.ownerId ===
  token.accountId`; a mismatch is `403`, an unknown id is `404`, no token is `401`.
- `(workspaceId, name)` is unique inside an owner's workspace, never globally; a clash is
  `DuplicateInstanceError` / HTTP 409.
- `plane.json` is written atomically (temporary file + rename), mode 0600, directory 0700, and
  carries `version: 1` for migration.
- `upgrade` and `recycle` fail loudly (`NotImplementedError`) instead of pretending to succeed.

## Tests and gates

`npm --prefix plane test` (20 cases) runs in the L1 `plane` suite registered in
[`docs/testing-layers.json`](../testing-layers.json) and in the `Plane tests` step of
[`.github/actions/flybot-tests/action.yml`](../../.github/actions/flybot-tests/action.yml). Root
`npm run verify` includes it. The suite needs no Docker, network, socket or model.
