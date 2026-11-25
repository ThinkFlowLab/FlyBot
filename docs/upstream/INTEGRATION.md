# Management integration (explicitly not done in this import)

Target architecture, unchanged: one **management server** plus **FlyBot
containers**. Bot Social functionality should later be configured, authorized,
and bounded by that management plane. It must not be shipped as a required
extra control plane that operators have to run and secure by hand as a
separate product.

## Current state

| Layer | In tree | Integrated with `openteamily/` / `manager/`? |
| --- | --- | --- |
| Management auth, workspaces, instance jobs, fake/simulated runtime | Yes (already on `main`) | n/a |
| FlyBot customization source | `runtime/flybot/plugins/social`, `docker/` helpers, `runtime/flybot-image/` | **Image + compose start.** Lifecycle jobs can start the digest-pinned image through the compose executor, including the model-API secret bind. |
| Bot Social source | `services/bot-social` | **Server URL is configured in management.** The runtime can onboard to the injected or otherwise configured server (including a CI fake). Connector tokens stay on the instance volume; management does not store them. |
| `@flybot/social` | `runtime/flybot/plugins/social` | **Host + live onboard path.** `runtime/flybot-social-host/` attaches a `flybot` façade to the unmodified v0.3.6 `createRuntime()` host (group rooms use the 0.3.5+ write-ahead ledger). When a server URL is set (management injection, file, env, or Settings → Bot Social), the plugin onboards and stores the connector token on the instance volume. CI proves this against a fake server with `ot-fake-` tokens only. Management injects only the validated URL; it does not handle connector tokens. |

Keeping the snapshots as **optional modules** is intentional.

## Later integration sketch (not implemented)

1. **FlyBot container:** an allowlisted manager starts a compose project using
   a digest-pinned build of `runtime/flybot-image/` (unmodified v0.3.6 +
   `@flybot/social` via the social host). Do not revive the official upstream
   Dockerfile that packs excluded plugins. Web/API still must not mount the
   Docker socket or accept arbitrary images, commands, or mounts. Publishing
   a redistributable image remains blocked on the DSH/base-image gaps in
   [GAPS.md](GAPS.md).
2. **Instance login** stays the instance's own session, not a management-DB
   plaintext token.
3. **Bot Social:** management records an optional collaboration endpoint
   (platform default, optional workspace override) and injects the already-
   resolved URL at instance start. Connector tokens remain on the instance
   volume. Operators should not have to log into a second admin UI as a
   hard dependency. A same-origin settings UI is still later work.
4. **Tree / workflow / project / timeline:** only after a dedicated import as
   in [OPTIONAL-PLUGINS.md](OPTIONAL-PLUGINS.md).

Until the #3 audit lands, do not describe OpenTeamily as shipping a
license-complete public FlyBot image. URL injection is not live third-party
Bot Social collaboration or a Teamily comparison. CI image smoke is not
that claim.
