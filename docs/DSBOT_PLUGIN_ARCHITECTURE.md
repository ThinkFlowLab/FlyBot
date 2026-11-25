# DS-Bot plugin architecture

FlyBot runs each account's AI work in one DS-Bot container. An account
reuses its assigned container across workspaces. The Compose manager provisions
the container, the edge routes authenticated traffic, and Bot Social maintains
shared state between accounts.

[Architecture overview](ARCHITECTURE.md) · [Operator setup](COMPOSE_MANAGER.md) · [Acceptance records](ACCEPTANCE.md)

## 1. Runtime boundaries

| Component | Responsibility |
| --- | --- |
| Management service and Compose manager | Accounts, sessions, personal runtime provisioning, lifecycle, and authenticated forwarding. The web service uses the manager contract for Docker operations. |
| Account DS-Bot | Native sessions, model calls, agent and group replies, skills, scheduled jobs, team runs, memory, meetings, and work editing and export. |
| FlyBot plugin | Product pages and APIs in the account container. It calls DS-Bot and DSH services in process. |
| Bot Social plugin and shared service | The plugin connects each account runtime to the service. The service coordinates teams, membership, direct messages between people, groups, public listings, and shares. |

An active Compose binding is unique per owner. Each instance uses its own named
volume. The account, instance, and workspace identifiers serve different
purposes. The instance identifies the runtime to the gateway, while the
workspace identifies the scope for access and data. A group reply runs on the
selected agent owner's runtime. The shared service delivers the request and
publishes the resulting message.

The [runtime pin](../runtime/ds-bot-upstream.pin.json) records the exact DS-Bot
and DSH versions. The [image recipe](../runtime/flybot-image/Dockerfile) installs
the DS-Bot wrapper, FlyBot plugin, and Bot Social integration together.

## 2. Plugin entry points

The image's [DSH wrapper](../runtime/flybot-image/plugin/index.js) creates the
DS-Bot runtime once and attaches it to the FlyBot host. The
[plugin entry](../runtime/flybot-workspace-web/index.js) registers the following
authenticated routes in that DSH process.

| Method and path inside DSH | Use |
| --- | --- |
| `GET /api/flybot-workspace/page?path=…` | Serve product pages and approved assets with the runtime identity marker. |
| `POST /api/flybot-workspace` | Dispatch a JSON request containing an `endpoint` and `payload`. |
| `GET /api/flybot-workspace/reply-stream` | Stream the private reply identified by a native receipt. |
| `GET, HEAD, POST, PUT, or DELETE /api/flybot-workspace/legacy` | Adapt mapped product `/v1` requests to the corresponding feature. |
| `GET or POST /api/flybot-workspace/gateway` | Dispatch the public Agent API to the owner runtime for key verification and execution. |

### 2.1 Feature extension point

A feature lives in `runtime/flybot-workspace-web/features/<name>/index.js`. Its
default export is a factory that receives a host and returns an object with an
`endpoints` map. An endpoint named `list` in feature `example` is dispatched
as `example/list`. A feature may declare additional configuration and run
initialization in its factory.

- `host.identity` identifies the instance. `host.featureDir()` creates a private
  directory under `/data/flybot-workspace/features/<name>` on its volume.
- `host.runtime()` waits for the attached native runtime and exposes DS-Bot and
  DSH services. `host.currentRuntime()` reads the attachment without waiting.
- `host.call(endpoint, payload)` calls another feature in process. An absent
  endpoint returns the typed `flybot-workspace/not-found` error.
- The loader registers Settings and the Chat directory dependencies early.
  Other features load independently. Registration failures are reported by
  the loader and the affected feature can return an unavailable response.

Use native sessions for agent turns and native DSH scheduling for automations.
Persist user-owned state in the owning volume. Use Bot Social for shared
records with account-scoped authorization. Add a feature test and cover the
user-visible flow against the native runtime when it changes.

See the [feature loader](../runtime/flybot-workspace-web/src/features.js),
[runtime attachment](../runtime/flybot-workspace-web/src/host.js), and
[agent implementation](../runtime/flybot-workspace-web/features/agents/index.js).

## 3. Browser routing and API keys

The [route manifest](../flybot_workspace/dsbot_routes.json) and
[gateway implementation](../flybot_workspace/dsbot_gateway.py) declare the current
product routes. The edge resolves a browser session to the caller's own active,
healthy DS-Bot. The workspace scope is checked by the destination feature.
The browser's workspace selection cannot choose a different account runtime.

| Public route | Destination |
| --- | --- |
| `/login`, `/register`, `/v1/auth/*` | Management service. |
| `/b/*` and signed-in product pages such as `/chat` and `/memory` | The browser session owner's DS-Bot. |
| Mapped product `/v1` calls | The corresponding native feature. Browser code uses the [API adapter](../flybot_workspace/static/shell/dsbot-api.mjs). |
| `/v1/gateway/*` | The currently assigned owner runtime identified by the bearer key. The runtime validates the key. |
| `/a/<slug>`, `/w/<slug>`, `/share/<token>` | Bot Social public routes. |

The edge checks origin for unsafe requests and WebSocket upgrades, exchanges
the platform session for runtime authentication server-side, and forwards the
request using the runtime's private address. Protected runtime credentials
stay behind the edge. The manager reports a runtime address and credentials
for its current process. Use the rendered nginx configuration and the
[Compose manager contract](COMPOSE_MANAGER.md) when deploying.

## 4. State, migrations, and rollout

The manager preserves the named volume when it replaces a container. Plugin
state lives under `/data/flybot-workspace` and native DS-Bot state lives on the same
account volume. Model, connector, and skill credentials are scoped to that
runtime. An account can override the [operator's model default](MODEL_API.md)
in Settings.

The legacy membership migration utility reconciles shared state with Bot Social
using manager-attested owner identities and replay receipts. Use the
[membership migration procedure](../deploy/isolated/BOT_SOCIAL_DEPLOY.md) for
an existing deployment. Private migration bundles are validated against the
destination instance and imported idempotently. See the
[bundle format](../flybot_workspace/dsbot_bundle.py) and [runtime import
implementation](../runtime/flybot-workspace-web/src/pending-import.js).

For each rollout, record the released revision, checked volume mappings, health
of running containers, and browser results. Confirm owner isolation and
unchanged access across workspace switches. Keep migrated data paired with
the runtime and database versions needed to restore it.

## 5. Verification

- [Two-account runtime and gateway test](../runtime/flybot-image/test/container-gateway-isolation.py)
  checks signed owner routing, pinned native runtimes, and cross-account access.
- [Chromium checks](../scripts/ci-native-ui-screenshots.mjs) sign in and drive
  product pages backed by the native feature implementations.
- [Plugin tests](../runtime/flybot-workspace-web/test/) cover native stores, receipts,
  execution, and routing contracts.
- [Acceptance records](ACCEPTANCE.md) describe the tested release,
  environments, and limits of the evidence.

The original phased migration plan remains available in the
[previous version of this document](https://github.com/openTeamily/openTeamily/blob/05edb5f7c49218aa73fc198baa4c4097b1e12cec/docs/DSBOT_PLUGIN_ARCHITECTURE.md).
