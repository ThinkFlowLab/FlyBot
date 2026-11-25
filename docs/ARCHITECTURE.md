# Architecture

FlyBot assigns **one isolated DS-Bot instance per user**. The management
plane provisions and routes to that instance by user identity. The runtime keeps
a stable instance ID independent of the user and workspace IDs. Joining or
switching workspaces reuses the same runtime. Workspace membership defines access
to shared data in the dedicated Bot Social service.

## Accepted DSH target

Every user owns a DS-Bot. All FlyBot pages, APIs and execution are the
`@flybot-workspace/web` DSH plugin inside that DS-Bot. The platform only owns identity,
provisioning and authenticated forwarding; cross-user features go through Bot
Social. See the full contract in
[DS-Bot plugin architecture](DSBOT_PLUGIN_ARCHITECTURE.md).

| Boundary | Responsibility |
|---|---|
| Central platform (`flybot_workspace/app.py`, `server.py`) | Accounts, sessions, OIDC, registration, operator admin, runtime provisioning/lifecycle (manager), edge routing (`dsbot_gateway.py`), the Bot Social URL handed to runtimes, and the one-off membership migration CLI (`social_membership_migrate.py`). No model calls, agent loop, scheduler or task queue. |
| User's DS-Bot (`runtime/flybot-image` + `runtime/flybot-workspace-web`) | All execution: private chat, agents, skills and skill runs, automations, memory, meetings, artifacts, search, connectors (Composio, MCP), group-agent replies. The FlyBot UI is a DS-Bot plugin: each page/API is a `features/<name>` module. |
| FlyBot Bot Social (`services/bot-social`) | Shared cross-user state only: workspaces/teams (every workspace is a Social team with a 32-hex `workspace_id`), members, invites, join requests, directory, member messenger, group-agent inbox, discover listings, public pages `/a/<slug>`, `/w/<slug>` and read-only shares `/share/<token>`. Never the old FlyBot Bot Social. |

## Routing

`flybot_workspace/dsbot_routes.json` lists `moved_pages`; the edge nginx rendered by
`python -m flybot_workspace.dsbot_gateway render` returns 418 for those pages and for
every moved `/v1` API (`MOVED_APIS` / `DSBOT_API_LOCATIONS`), which hands the
request to the signed-in owner's DS-Bot after `auth_request`. The browser shim
`flybot_workspace/static/shell/dsbot-api.mjs` maps the same legacy `/v1` calls to
`POST /b/api/flybot-workspace {endpoint: '<feature>/v1'}`.

`/a/`, `/w/` and `/share/` on the site root are proxied, cookie-free, to Bot
Social. `/social/` is Bot Social for DS-Bot connectors.

The platform answers any moved route that still reaches it, and the removed
central execution routes (`/v1/agent/*`, `/v1/gateway/*` on the platform,
`/v1/runtime*`, `/v1/agent-homepages/start`), with `410 moved_to_dsbot`.

The public Agent API at `/v1/gateway/` uses the instance identifier in the key
to find its account. The edge only forwards to that account's assigned DS-Bot,
which verifies the key and runs the agent turn. A preserved older instance
cannot serve these requests after the account has moved to its assigned runtime.

## Credentials

Manager delivers each runtime only `{server, displayName?, source}` for Bot
Social; the connector token stays on the runtime volume. Model keys, Composio
keys and MCP secrets live on the user's DS-Bot. `/data/kms.key` and runtime
seal keys are never rotated by deploys.

## Public homepage conversations

A visitor on `/a/<slug>` can compose a message before sign-in. After sign-in,
`/chat` on the visitor's DS-Bot asks Bot Social to open a thread with the
published agent and restores the draft for the visitor to send. The creator's
DS-Bot answers from its agent inbox.
