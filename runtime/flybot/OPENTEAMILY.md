# OpenTeamily notes for the FlyBot customization snapshot

This is a **minimal needed set**, not a full FlyBot checkout, and not the
runtime baseline. Upstream layout is kept for the imported social plugin and
docker helpers. It is not wired to the management server. The container recipe
is OpenTeamily-authored and lives in [`runtime/flybot-image/`](../flybot-image/);
issue #3 still blocks a license-complete public image release.

The OpenTeamily runtime baseline is upstream DS-Bot **v0.3.6**, tracked in
[PR #21](https://github.com/openTeamily/openTeamily/pull/21) (now on `main`). This tree is the
FlyBot customization layer that should later be loaded as a DSH plugin (and
small patches, if needed) on top of that baseline. It does not vendor a second
copy of `core/`.

## Present

- `plugins/social/` — Bot Social plugin (production sources do not import `core/`)
- `docker/` — instance entrypoint / health / profile helpers
- Selected docker and social docs listed in `ORIGIN.md`

## Absent on purpose

- `core/`, `ds-bot.pin.json`, `ds-bot/`, and `patches/` (old v0.1.5 fork)
- `plugins/project`, `plugins/timeline`, `plugins/tree`, `plugins/workflow`
- Official `Dockerfile` and `compose.yaml`
- ThinkFlowLab automation, benches, evals, interop, live-e2e, reports, logos, QR
- Host-integration tests that imported the deleted `core/` (`social.test.js`,
  `social-readonly.test.js`, `web-entry.test.js`, `zh-*.test.js`)

`plugins/social/package.json` still declares a peer on `ds-bot>=0.1.5-flybot.1`.
That peer is historical; the target runtime is upstream v0.3.6. Do not treat
the peer range as a claim that the old fork is present.

The first-slice host adapter lives in [`runtime/flybot-social-host/`](../flybot-social-host/),
outside this snapshot and outside the vendored upstream tree.

## Runnable today vs. blocked

- License and file hashes can be verified offline.
- Bot Social `npm test` (the service) runs in CI after `npm ci`, with no real tokens.
- `@flybot/social` plugin-only tests run with `npm test` in `plugins/social/`
  (no dependencies, no DSH, no `core/`). They do not replace a host-integration
  suite against v0.3.6.
- Docker build / `dsh web` for this snapshot's official FlyBot image stay out
  of scope. The OpenTeamily recipe in `runtime/flybot-image/` is built and
  smoked in CI. PR #21 still proves the upstream baseline's own suite and
  official-image smoke.

See [`docs/upstream/INTEGRATION.md`](../../docs/upstream/INTEGRATION.md) and
[`docs/upstream/GAPS.md`](../../docs/upstream/GAPS.md).
