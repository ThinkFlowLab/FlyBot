# App connectors through Composio (per-user key)

FlyBot connects third-party apps (GitHub, Notion, Slack, …) through
[Composio](https://composio.dev) Connect Links. **Every user brings their own
Composio API key.** There is no platform or administrator default key and no
`COMPOSIO_API_KEY` environment fallback: each Composio request made for a user
uses only that user's own key, and one user's key is never used for another.

Status: implemented and covered by unit tests with a fake Composio HTTP
transport. It has **not yet been verified against a real Composio project**.

## User setup

1. Create a free account at composio.dev and open (or create) a project.
2. In the project settings, copy the project API key. A full-access project key
   works. For a scoped key, enable at least *Session management → Write*,
   *Connected accounts → Read and Write* (write is needed for disconnect).
3. In FlyBot, open **设置 › 应用连接器** (`/settings/connectors`), paste the
   key into the **Composio API key** card and press **保存**. The key is stored
   wrapped in the instance's private data directory and is never shown again;
   the page only shows a masked hint such as `••••abcd`.
4. Press **+ 连接** on an app. A Composio authorization tab opens. After you
   approve, Composio sends the browser to `/v1/composio/callback`, which bounces
   back to the connectors page. The row changes 连接中… → 已连接 (or 连接失败 with
   Composio's reason). The page polls every 3 s while a connection is pending.
5. **断开** deletes the connected account in your Composio project. **移除**
   deletes your key from FlyBot and clears local connection records; it
   does not delete accounts in Composio. Replacing the key also clears local
   records, because they belong to the old project.

No operator configuration is needed. The instance only needs outbound HTTPS to
`backend.composio.dev`. The callback URL is derived from the configured
`--origin`, so the origin must be the URL users actually open.

## Row states on `/settings/connectors`

| State | When | Button |
| --- | --- | --- |
| 未配置 Composio | the signed-in user has not saved a key | disabled |
| 未接通 | the catalog app has no Composio toolkit (Netlify, Zapier, DeepWiki, Context7, Microsoft Learn, Cloudflare Docs, Amap, Mailbox) | disabled |
| 需自建 auth config | Composio has no managed OAuth app (PayPal, Vercel, Neon, Webflow, Wix); this page does not create custom auth configs yet | disabled |
| 未连接 | key saved, no connection | + 连接 |
| 连接中… | Composio status INITIALIZING / INITIATED | 取消 |
| 已连接 | Composio status ACTIVE | 断开 |
| 连接失败 / 未激活 | FAILED, EXPIRED, REVOKED / INACTIVE | 重试 |

The FlyBot → Composio toolkit mapping lives in `flybot_workspace/composio.py`
(`CATALOG`) and was checked against the public toolkit table at
docs.composio.dev/toolkits on 2026-11-19. Composio logos are never fetched or
shown; the rows keep FlyBot's original geometric marks.

## API (signed-in session, CSRF on POST)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/composio` | `{composio: {configured, key_hint, revision}, catalog}` |
| POST | `/v1/composio/key` | `{api_key: "<key>"}` saves/replaces, `{api_key: null}` removes |
| GET | `/v1/composio/toolkits?search=&cursor=` | Composio toolkit list (no logos) |
| GET | `/v1/composio/connections` | sync and list this user's connections |
| POST | `/v1/composio/connections` | `{toolkit}` → `{connection, redirect_url}` |
| GET | `/v1/composio/connections/{id}` | poll one connection's real status |
| POST | `/v1/composio/connections/{id}/disconnect` | delete it in Composio and locally |
| GET | `/v1/composio/callback` | unauthenticated bounce page; changes nothing, ignores its query |

Without a key the Composio routes answer `409 composio_not_configured` and make
no upstream request. Upstream failures answer `502` with
`composio_key_rejected`, `composio_unreachable`, `composio_rate_limited`,
`composio_not_found` or `composio_failed`; error bodies never include the key.

Upstream calls (Composio REST v3.1, `x-api-key` header):
`POST /tool_router/session` with `user_id = "flybot-workspace-<account id>"`, then
`POST /tool_router/session/{id}/link` with the callback URL; `GET` and `DELETE
/connected_accounts/{id}`; `GET /connected_accounts?user_ids=…`; `GET /toolkits`.
The Composio `user_id` is derived on the server from the session, never from the
browser, and connection records are scoped to the FlyBot account.

## Follow-ups

- Connected tool execution is now available for management-dispatched personal
  tasks via the credential-isolated approval broker: see [CONNECTED_TOOLS.md](CONNECTED_TOOLS.md).
  Real Composio/model verification, group/automation/gateway tools and standalone
  DSH session integration remain follow-ups.
- Custom auth configs for toolkits without a Composio-managed OAuth app.
- Optional callback identity verification (`complete_auth`) for projects that
  enable it.
- Channel rows (`/settings/channels`) are still 未接通.
