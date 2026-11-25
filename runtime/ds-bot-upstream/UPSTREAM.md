# Upstream DS Bot (tracked, unmodified)

This directory holds a **byte-identical copy** of selected paths from
[Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot), pinned in
[`../ds-bot-upstream.pin.json`](../ds-bot-upstream.pin.json). The current pin is the release
**v0.3.10**, commit `d104d9ca18d69a35460f14e15dff4d553181433a`, ds-bot package `0.3.10`. Its tests
expect DeepSeek Harness (DSH) `0.2.2-rc.1`.

This file is the only OpenTeamily-authored file in this directory. Every other file is upstream's,
and `node scripts/ds-bot-upstream.mjs check` (run in CI) fails if any of them differs from the git
object ids the pin records, or if an unpinned file appears here.

## License

- Upstream code here is **Apache License 2.0**. See [`LICENSE`](LICENSE), which is upstream's root
  `LICENSE`, and [`NOTICE`](NOTICE), upstream's root `NOTICE`. `ds-bot/LICENSE` is the same text.
  Redistribution must keep `LICENSE` and `NOTICE`.
- The repository's root MIT license **does not** cover this directory.
- The complete transitive npm dependency license audit of `ds-bot/package-lock.json`,
  `link/package-lock.json` and the DSH packages that CI installs is still open (#3). CI installs
  those packages to test them and does not commit them.

## What is taken, and why

| Upstream path | Why OpenTeamily needs it |
| --- | --- |
| `ds-bot/` (whole) | The DSH plugin that is the Bot runtime: host (`src/host`), web client bundle (`client.js`), its unit tests, the DSH test-harness pin (`dev/harness`), and the mock LLM used by its smoke test. The whole directory is taken so its single tree id proves the copy. |
| `link/` (whole) | ds-bot's tests import `link/server`, and `ds-bot/link.js` is built from `link/src`. It is needed to run upstream's suite unchanged. The phone app itself is not an OpenTeamily target; see below. |
| `app/ui/src/`, `app/package.json` | Desktop UI source for the DS-Bot frontend assertions and its upstream module boundary. |
| `mobile/src/team/gated.ts`, `start.ps1` | Source read by upstream mobile access-control and Windows launcher tests. |
| `docker/Dockerfile`, `docker/entrypoint.sh`, `docker/docker.patch.yml` | Upstream's image: DSH `0.2.2-rc.1` plus the packed plugin, served by `dsh web` on port 3080. |
| `docker/test.mjs` | Upstream's container startup test. It builds no network (`--network none`), migrates data ownership, starts `dsh web`, logs in with the printed token, and asserts that the DS Bot `/api/bot` `state` endpoint answers. CI uses it as the runtime smoke test. |
| `LICENSE`, `NOTICE` | Binding license and attribution. |

**Not taken:** the rest of the Electron desktop and Android apps, `browser-plugins/`, `docs/`,
upstream `scripts/`, `docker/Dockerfile.dev`, the dev compose files, `.github/`, and the upstream
git history (`sync` fetches one commit at depth 1 and copies trees; no upstream commits enter
this repository's history).

## Updating

```sh
node scripts/ds-bot-upstream.mjs latest            # newest upstream vX.Y.Z tag
node scripts/ds-bot-upstream.mjs sync v0.3.10      # replace the tree + pin, staged
node scripts/ds-bot-upstream.mjs check
```

The scheduled workflow `.github/workflows/ds-bot-upstream-track.yml` does this daily and on demand.
It runs the full suite on the new version and opens a pull request with the results. It never
merges anything.

## OpenTeamily changes go on top, not in here

FlyBot (ThinkFlowLab/FlyBot) forked ds-bot at v0.1.5. Its customizations (social, rooms,
membership, branding, the API host) became a 131k-line patch series. Re-applying that series to
v0.3.6 gives about 600 conflict hunks in about 104 source files, so OpenTeamily does **not** fork
again. The plan is:

1. **Upstream as is** (this directory). It is updated with `sync`, and its own tests stay green
   in CI.
2. **OpenTeamily features as separate DSH plugins** next to ds-bot in the same profile, as FlyBot's
   `plugins/social` already is. A plugin reaches ds-bot only through its exported runtime and
   HTTP API.
3. **Small, ordered patches** (a later `runtime/ds-bot-patches/`, applied at image build, each with
   a test and an upstream-issue link) only where a plugin cannot reach a seam. Every patch is a
   candidate for an upstream pull request, so the series shrinks over time.
4. **Group chat:** upstream 0.3.5 moved group rounds onto a write-ahead ledger (`src/host/ledger.js`).
   OpenTeamily adopts upstream's ledger model. FlyBot's room and social model (Bot Social remote
   rooms, membership and seats) is to be re-implemented as an adapter on that ledger. Anything
   that cannot be adapted is tracked as an open decision in the pull request, not patched into
   the vendor tree.
