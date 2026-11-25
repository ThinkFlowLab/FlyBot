# FlyBot Workspace runtime image (first slice)

FlyBot-authored recipe (root MIT). The image it builds **also contains**
the pinned Apache-2.0 DS-Bot runtime and the Apache-2.0
`@flybot/social` plugin; those licenses and NOTICE files are copied into
`/opt/licenses/`. This directory is not part of the vendor snapshot.

## What it is

A container that the already-merged compose manager can run as the `flybot`
service:

- Starts as **UID/GID 1000** (no root entrypoint: no `gosu` / `groupmod` / `chown`).
- Read-only rootfs is supported: Bot workspace is `/data/workspace`; only `/data`
  and tmpfs `/tmp` need to be writable.
- Listens on **8080**, which is the port `flybot-workspace.manager.engine.manifest`
  publishes to `127.0.0.1`.
- Uses Docker Engine 25 or newer to probe the web listener every second during
  startup and every ten seconds once healthy.
- Loads `@flybot-workspace/flybot-runtime`, which calls upstream `createRuntime()`
  and then `applyOnRuntime()` from `runtime/flybot-social-host/` so
  `@flybot/social` injects a `flybot` service. The build verifies and applies
  [the native integration patch](native-ds-bot.patch) to the image copy for
  group membership editing and skill consent. The Git tree remains byte-identical
  to its upstream pin.

The web UI is official `dsh web`. `@flybot-workspace/flybot-web-slots` installs
`globalThis.__flybot__` so `@flybot/social`'s client can register, posts
social calls to `POST /api/flybot`, and bridges settings, session docks and
sidebar entries onto dsh-web-app slots. See `runtime/flybot-web-slots/README.md`.

## Build

From the repository root (context is `runtime/`):

```sh
dsh=$(node -p "require('./runtime/ds-bot-upstream.pin.json').dsh")
docker build -f runtime/flybot-image/Dockerfile \
  --build-arg "DSH_VERSION=$dsh" \
  -t flybot-workspace-flybot:local \
  runtime
```

CI (`.github/workflows/flybot-runtime-image.yml`) builds this image, runs
`test/smoke.mjs`, and uploads a license/package inventory of the built image
as the `flybot-runtime-image-license-inventory` artifact. The image is not
published. That artifact is the live inventory for the build; see
`inventory/README.md`. The recipe also copies KaTeX, Codicon, sharp-libvips, and
Anthropic SDK notices into `/opt/licenses` and beside the matching
payloads (see `../third_party/`). Debian exact-version source-offer text
is generated into the same artifact. None of that is legal clearance.

## What this slice does not claim

- Related tracking remains open: [issue 3](https://github.com/openTeamily/openTeamily/issues/3),
  [issue 1](https://github.com/openTeamily/openTeamily/issues/1), and
  [issue 5](https://github.com/openTeamily/openTeamily/issues/5).
  DeepSeek Harness `0.2.2-rc.1`, the Node/Debian base image, and third-party
  notices still need review before a public image release. The CI inventory
  is evidence collection, not legal clearance.
- Management can inject a validated Bot Social server URL at instance start
  (`docs/BOT_SOCIAL.md`); operators can also set a file or env (see below)
  or use Settings → Bot Social. This is not live third-party proof.
- The official ds-bot web client is not a second profile bundle (createRuntime
  already runs once). Composer `@` mentions and the Bot details drawer stay
  in the FlyBot registry until a later slice.
- Office / computer tool stacks from the official DS-Bot image (Python, ffmpeg,
  build-essential) are not installed in this first recipe.
- The management server still needs an operator-supplied **digest-pinned**
  reference (`image@sha256:…`) after you load this image into the engine.

## Model API config (operator-supplied, not baked in)

FlyBot does not ship a credits/billing proxy and does not enforce usage
limits. A self-host admin sets a platform-default model API; a user may
optionally override it. The management server (lane 2 owns the config API)
resolves those two layers — **user override wins** — and injects one already-
resolved secret when the instance starts. The container does not merge.

The container reads that JSON secret file at start — never from the image layers:

1. `$FLYBOT_WORKSPACE_MODEL_API_FILE` if set (must resolve under `/run/secrets/` or
   `/data/secrets/`)
2. otherwise `/run/secrets/flybot-workspace-model-api.json`
3. otherwise `/data/secrets/model-api.json`

Example file (do not commit real keys):

```json
{
  "provider": "deepseek",
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "api_key": "sk-...",
  "source": "user"
}
```

`source` is optional metadata (`platform` or `user`) saying which layer won;
it is not used to choose a key. The launcher exports `{PROVIDER}_API_KEY`
(for DeepSeek, `DEEPSEEK_API_KEY`) into the process environment for DSH, and
records the non-secret fields as `FLYBOT_WORKSPACE_MODEL_PROVIDER`,
`FLYBOT_WORKSPACE_MODEL_BASE_URL`, `FLYBOT_WORKSPACE_MODEL_NAME`, and
`FLYBOT_WORKSPACE_MODEL_SOURCE`. The key is never written to logs or stdout. Starting
without a file is allowed so CI smoke can boot; that instance cannot call a
model until a secret is mounted. An empty or whitespace-only file is treated
the same as a missing file (the compose manager always bind-mounts a stable
path, and writes an empty file when no key is configured).

The compose manager writes the resolved file to a private path under its
state directory (`secrets/model-api-<instance-id>.json`, mode 0600) and
bind-mounts it read-only at `/run/secrets/flybot-workspace-model-api.json`. The
bind path is frozen in the compose file; only the file contents are updated
before create, start or restart. The key is not placed in compose environment
variables, image layers, user HTTP APIs, claim receipts or operator logs.
Do not put keys in the Dockerfile, in git, or in a world-readable volume.


## Bot Social onboarding (optional, tokens stay on the volume)

If a Bot Social server URL is present, the existing `@flybot/social` plugin
onboards the home and writes connector credentials to
`$DSH_HOME/bot/flybot-social.json` (in this image, `/data/bot/flybot-social.json`),
mode 0600. A second start reuses that file and does not call onboard again.
A torn or unreadable credentials file is refused; it is not replaced by a
new onboard. Tokens are never baked into the image, never committed, and
must not appear in logs.

The wrapper does not force `onboard: false`. The default server URL is
resolved in this order (a user Settings override still wins at runtime):

1. `$FLYBOT_WORKSPACE_BOT_SOCIAL_FILE` if set (must resolve under `/run/secrets/`
   or `/data/secrets/`)
2. otherwise `/run/secrets/flybot-workspace-bot-social.json`
3. otherwise `/data/secrets/bot-social.json`
4. otherwise `$FLYBOT_WORKSPACE_BOT_SOCIAL_SERVER` or `$FLYBOT_SOCIAL_SERVER`

Example file (a URL only; do not put a connector token here):

```json
{
  "server": "https://social.example",
  "displayName": "FlyBot"
}
```

The compose manager writes the resolved URL file to
`secrets/bot-social-<instance-id>.json` (mode 0600) and bind-mounts it
read-only at `/run/secrets/flybot-workspace-bot-social.json`. An empty file is
written when no server is configured. Adding this second bind is a compose
contract change: existing frozen `compose-*.json` files will not match the
new manifest until the instance is recreated. A connector token must not
appear in that file.

CI smokes the onboarding path against an in-container fake Bot Social that
issues only `ot-fake-` tokens. That is not a live third-party Bot Social
and is not by itself management-plane proof.

## Compose manager contract

See `flybot_workspace/manager/engine.py` `manifest()`: service `flybot`, user
`1000:1000`, read-only, volume `/data`, tmpfs `/tmp`, a single read-only bind
of the model API secret at `/run/secrets/flybot-workspace-model-api.json`,
published `127.0.0.1:<port>->8080/tcp`, optional HEALTHCHECK.

## Chat runs on DS-Bot

The runtime plugin sends FlyBot messages to the owner's native DS-Bot sessions.
Its loopback-only OpenAI-compatible proxy listens at
`127.0.0.1:${FLYBOT_WORKSPACE_BRIDGE_PORT:-18731}` and serves DS-Bot's
`flybot-workspace` provider. DS-Bot uses a per-boot token to call the proxy.
The proxy uses the owner's configured model or the platform default.
Provider keys stay out of the DSH environment.

The FlyBot plugin manages attached skills and connected app tools using
DS-Bot capabilities. On first provision, it reads the personal agent bundle
from the mounted provisioning file and imports it into the owner's instance.

Set `FLYBOT_WORKSPACE_DS_BOT_BRIDGE=0` to disable the model proxy and native chat.
