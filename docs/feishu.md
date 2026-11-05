# Feishu

Open **Connect apps → Feishu → Connect** in the native client, or **Connections** in the shared workbench. Connect is the single entry for starting or resuming setup. Both surfaces use the same component and existing Feishu channel. Custom bot webhooks remain available for sending to a group.

Only mainland Feishu at `open.feishu.cn` is supported. Lark, encrypted HTTP events, message edits and recalls are unsupported. An application must have the Bot capability and be published to the intended enterprise members.

## Setup

The default long connection has six steps: create an internal app, enter credentials and test, subscribe to message events and card callbacks, publish a version, choose the local handling Bot, and try it in Feishu. The HTTP flow starts with a seventh step to prepare a public HTTPS event address. Resume an unfinished setup from the same connection. Switching receiving methods retains the application, sender list, identity links, Bot selection and conversation handles; switching to the long connection deletes the Verification Token.

App IDs must be `cli_` followed by 16 hexadecimal characters. Credentials are encrypted in the host's dedicated Feishu vault and never returned through the connection view or injected into Bot shell environments. Blank saved credential fields retain their values.

Import the guide's permission JSON through the Feishu developer console's **Permission management → Batch import/export**. It includes the base message, reaction, resource, group and contact scopes plus the selected tool extensions. Set the contact data scope too. After changing permissions, events or callbacks, publish another version and wait for enterprise review where required.

The guide refreshes connection status every three seconds. Wait for **Connected** before saving **Use long connection to receive events** in Feishu. Subscribe to `im.message.receive_v1`. Separately select the matching receiving method under **Callback configuration** and subscribe to `card.action.trigger`. A connection test reads the Bot information; a not-yet-published Bot may be unavailable. Neither a successful connection test nor permission check proves that callbacks are configured. Test an actual card submit button.

For HTTP, forward only the dedicated event listener (container port 3082 by default) through an HTTPS proxy. Its only accepted route is `POST /api/feishu/events/<app-id>`. The listener exposes no console, authentication or Harness API. Set the Verification Token and leave Encrypt Key empty. `FLYBOT_FEISHU_EVENTS_PORT` selects the internal listener port. Configure a separate public FlyBot console URL for attachment fallback links; never use the event listener's URL as the console URL.

## Conversations and access

The existing remote conversation stores each group or private chat's history. A separately selected local Bot handles allowed requests; the remote Bot record is never the reasoning Bot. Group mentions and private messages initiate processing. Other group messages are retained as context without starting the Bot; application-originated messages do not initiate work by default. An explicit setting permits allowed robots to mention this robot, capped at eight consecutive requests per chat until a human speaks. Thread IDs remain attached to requests and replies return to the same thread. Per-chat Bot overrides use the connection's `configure` operation with `chatId` and `botId`.

Sender allow-lists control who may request work. They do not grant a platform identity or approval authority. An authenticated existing platform member may associate their own Feishu account; the Owner may associate another existing member. Links are scoped to the Feishu application and use `open_id`, never display names. No external members or new login accounts are created. A card click from an unlinked account is refused; a meeting cannot borrow a default host. Association is an explicit administrative mapping, not a login credential.

Rich incoming posts become Markdown. Replies use Feishu rich posts with plain-text fallback on a 30 KB limit or explicit API refusal. Images in Markdown remain links, HTML cannot create platform mentions, relative links keep only their text, and Mermaid stays code. Incoming attachments are bounded at 20 MB and admitted to the native attachment store. A single failed attachment does not discard the message's text or other files. The `feishu_file` tool sends a Session-owned image up to 10 MB or file up to 30 MB. A larger attachment fails with a size error, and an upload Feishu refuses fails with its details in the connection diagnostics; FlyBot sends no console links into Feishu. Attachment and formatting diagnostics stay in connection details.

Accepted messages get the `Get` reaction. The application removes its own reaction only after the response is delivered. Failed sends remain in delivery records with explicit retry. Reaction failures have independent backoff; failed additions stop after five attempts and removal retries remain recoverable. Persistent inbox IDs suppress replay, including after restart, before opening a Bot request. Reply outbox records retain a stable Feishu send UUID.

## Cards and tools

`feishu_card` creates a persistent card, or updates the calling Bot's existing card by `cardId`. Blocks support text, fields, lists, progress, tables, charts, collapsible pages, inputs and applet descriptions. Inputs and submit buttons are placed in the final form. Card callbacks bind application, original message, chat, version, action and actual linked clicker. They persist the submission and deliver it to the card's original Bot. They never approve tools. Rejected cards fall back to text directing people to the console. Applets only display their description and console instruction.

`feishu_apps` lists the calling Bot's applications and grants. `feishu_tool` exposes named, fixed-host operations for calendars, documents/wiki, Bitable, spreadsheets, video meetings and tasks. It accepts product-specific IDs, query and body objects, never a caller-supplied URL, host, token or HTTP method. The operation list is in `core/src/host/feishu-tools.js`.

Grant each product separately for each Bot and application: **Disabled** (default), **Read only**, **Read/write, ask before writes**, or **Read/write**. Ask mode uses the existing native approval pipeline before any API write and rechecks grants afterwards. A generic standing approval cannot override ask mode. Deleting the application removes its grants, identities, cards, file mappings, inbox and outbox records.

Calendar operations cover public search/subscription, application-owned shared calendars, events, attendees, ACL members and free/busy. `calendar_share_group` tracks group-derived ACL additions and follows new group members on later messages, at most once per ten minutes, without downgrading existing higher permissions. Stop-sharing removes only tracked unchanged grants. Sharing an existing group's calendar to new members is part of the approved group share; revoking the Bot's calendar grant stops that synchronization. `calendar_share_link` and `calendar_share_card` derive Feishu's calendar link from an existing event. Personal-user OAuth and meeting-room reservation are not provided.

Document creation can share the new document with the actual linked requester. Meetings always use the actual requester's linked `open_id`; user-provided `owner_id` is overwritten. An authenticated native requester or a requester linked in another Feishu company resolves through the existing platform member to the target app's account. Missing or ambiguous target accounts refuse the meeting; the Bot's owner is never a fallback. Feishu still enforces its application scopes and access to each document, wiki, table and calendar.

## Local Docker

Use `docker compose -f compose.yaml -f docker/compose.local.yaml up -d --build`. The override publishes the local console on `0.0.0.0:3080` through a container-side TCP relay, retaining DSH's required loopback bind. It also publishes the event-only listener on `0.0.0.0:3082`. Existing named data volumes are retained; never use `down -v`. Override `FLYBOT_PUBLIC_PORT` and `FLYBOT_FEISHU_PUBLIC_PORT` when those host ports are occupied. Public internet use still requires HTTPS and an explicitly trusted console hostname.
