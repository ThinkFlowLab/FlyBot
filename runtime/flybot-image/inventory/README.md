# Built-image license inventory

`collect.mjs` walks a filesystem root (a running container or a fixture) and
writes `inventory.json`, `inventory.md`, and `summary.json`. It records the
installed npm closures, Debian package copyright hashes and `deb-src`
pointers, a Claude/Anthropic package scan, font and OFL texts, and the
files under `/opt/licenses`.

This is evidence collection, not a legal opinion, and not clearance to
publish a pre-built image. Office conversion stays enabled.

## Offline unit tests (no Docker, no npm install)

From `runtime/flybot-image`:

```sh
node --test test/inventory.test.js
```

The tests run the collector against `testdata/fake-root` and
`testdata/fake-root-with-claude`.

## CI (uses the existing image build)

`.github/workflows/flybot-runtime-image.yml` builds `flybot-workspace-flybot:test`,
smokes it, then runs `run-in-image.sh` and uploads the output as the
`flybot-runtime-image-license-inventory` artifact. The image is not pushed.
The artifact from that job is the live inventory for that build; files in
`docs/reuse-audit/` are not a substitute for it.

Related tracking remains open: issue 1, issue 3, issue 5.

The fixture trees contain tiny `node_modules` stubs. They are tracked via a root `.gitignore` exception; they are not installed packages.

The collector follows directory symlinks (with a realpath cycle guard) so pnpm/`link:` profile packages are included. Fixture trees are excluded from a built-image walk and are omitted from the Docker build context via `runtime/.dockerignore`.
