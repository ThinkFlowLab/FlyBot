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
- `workspace.members` is the only source of membership: `owner / admin / member`, and the
  creating account becomes the only `owner`. An older `plane.json` is read with its owner
  seeded as the only member, never rejected.
- `GET` / `POST /api/workspaces/:id/members` verify the token, then pick the workspace by the
  caller's role: two owners' same-named `ws-1` never mix. Non-member `403`, unknown id `404`,
  duplicate member `409`, unknown role `400`. A role does not reach the instance routes yet —
  those still answer to `instance.ownerId` alone, so an `admin` adds members and nothing more.
  A workspace id is still owner-scoped, so one account invited into two owners' `ws-1` resolves
  to the first one stored; scoping the workspace key is the next slice.
- `plane.json` is written atomically (temporary file + rename), mode 0600, directory 0700, and
  carries `version: 1` for migration.
- `upgrade` and `recycle` fail loudly (`NotImplementedError`) instead of pretending to succeed.

## Tests and gates

`npm --prefix plane test` (25 cases) runs in the L1 `plane` suite registered in
[`docs/testing-layers.json`](../testing-layers.json) and in the `Plane tests` step of
[`.github/actions/flybot-tests/action.yml`](../../.github/actions/flybot-tests/action.yml). Root
`npm run verify` includes it. The suite needs no Docker, network, socket or model.
