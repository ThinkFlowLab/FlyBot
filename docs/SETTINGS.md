# Account settings API (issue #4, slice 1)

Related: [#4](https://github.com/openTeamily/openTeamily/issues/4) (settings, chat shell and message tools — **not completed**), [#14](https://github.com/openTeamily/openTeamily/issues/14) (browser acceptance), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice adds server-side persistence for per-account interface preferences in the management API. It is self-written; no FlyBot, Bot Social, DS-Bot or Teamily source was used.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/settings` | Current account only. Returns `{settings:{values,revision}}`; `revision` 0 means nothing stored yet and `values` are defaults |
| POST | `/v1/settings` | `{revision, changes}`; session + exact Origin + CSRF required. Partial update of known keys. Stale `revision` → `409 conflict` with `error.current` (no write). Unchanged values → 200 without bumping `revision` |

Unknown keys, wrong types, unsupported values or an empty `changes` object are refused with 400 and nothing is written. There is no cross-account read or write path; the owner is always the session user.

## Keys (FlyBot defaults — not yet Teamily-verified)

| Key | Allowed | Default |
|---|---|---|
| `appearance` | `system`, `light`, `dark`, `auto` | `system` |
| `appearance_schedule` | `sunset_sunrise`, `custom` | `sunset_sunrise` |
| `appearance_start` / `appearance_end` | `HH:MM` 24-hour | `18:00` / `07:00` |
| `language` | 18 recaptured system languages, mapped to BCP-47 (see below) | `zh-CN` |
| `chat_language` | `auto` or the 17 recaptured chat languages | `auto` |
| `auto_translate` | boolean | `false` |
| `send_shortcut` | `enter`, `mod_enter` | `enter` |
| `message_folding` | `compact`, `standard`, `none` | `standard` |
| `document_cards` | boolean | `false` |
| `link_previews` | boolean | `true` |
| `task_completion_reminders` | boolean | `true` |
| `likes_visible` / `favorites_visible` | boolean | `true` |

Option semantics follow the 2026-11-16 round-1 and round-2 Teamily contrasts. System languages (18) and chat languages (17) use our BCP-47 mappings because Teamily does not expose codes: system `en,fa,fr,de,es,it,pt-BR,ru,id,ms,hi,bn,th,ja,ko,zh-HK,zh-TW,zh-CN`; chat adds `auto` plus `en,fa,fr,de,es,pt,it,ru,id,vi,bn,th,ar,ja,ko,zh-Hant,zh-CN`. Privacy is two default-on checkboxes (allow others to see likes / favorites). The retired `likes_visibility`/`favorites_visibility` values `everyone`/`private` are accepted on write and migrated on read. Custom appearance period fields were **not captured**; `appearance_start`/`appearance_end` as `HH:MM` remain unverified. This is still not settings parity.

## Storage

An additive `user_settings` table (`CREATE TABLE IF NOT EXISTS`) in the existing private management database. Schema `user_version` stays 1; existing v1 databases gain the table on next start. Stored documents are re-validated on read: unknown or invalid stored keys fall back to defaults rather than being returned.

## Settings page (slice 2)

The same-origin page at `/settings` reads and writes `/v1/settings` and lists write-only skill secrets at `/v1/skill-secrets` (name `A-Z` then `A-Z0-9_`, value stored wrapped, never returned). Custom appearance times were not fully captured in the first contrast pass; start/end use `HH:MM`.

The page also has a model API section for an optional personal override. The platform default is shown as the effective configuration when no override is set. Keys are write-only. See [MODEL_API.md](MODEL_API.md). This is not Teamily credits or billing.

The page is not browser E2E evidence. Acceptance against Teamily's real settings pages remains [#14](https://github.com/openTeamily/openTeamily/issues/14).

## Not in this slice

No chat shell, no keyboard handling in the chat input, no translation catalogue, no runtime/instance propagation. Browser acceptance is not claimed.

## Settings pages (channels, Agent API, connectors)

Related: [#4](https://github.com/openTeamily/openTeamily/issues/4), [#10](https://github.com/openTeamily/openTeamily/issues/10), [#11](https://github.com/openTeamily/openTeamily/issues/11), [#14](https://github.com/openTeamily/openTeamily/issues/14). These issues stay open.

`/settings/channels`, `/settings/agent-access`, `/settings/connectors`, and `/settings/skill-configuration` serve the same settings document as `/settings` (no-store, unknown subpath 404, query rejected 400). The hub in「AI 与智能体设置」links to them in the recorded order, keeping the FlyBot model API row. Visible copy uses 「Agent 渠道」 rather than a trademarked product title. The shared account menu also links to these two existing pages, placed after 「创建团队」 and before 「工作背景」, which is the recorded slot after the skipped credit/plan rows. The entries only navigate; connector account linking stays unconnected on the settings page. The hub row labelled「技能配置」opens `/settings/skill-configuration`, a dedicated skill-secret subpage (empty state「暂无密钥」). The write-only `/v1/skill-secrets` API is unchanged. The app rail also has a separate `技能` entry to `/skills`, a read-only catalogue with in-page install toggles; it does not install or execute anything (see [SKILLS.md](SKILLS.md)).

The signed-in `/settings` hub does not present credits, plans, upgrade, rewards, or usage-cap surfaces, even as disabled chrome. That is an explicit FlyBot product rule, not Teamily typography parity: the usage card, disabled「升级」control, and the「创作者与奖励」and「套餐、账单与用量」groups were removed after they landed from a recorded-layout slice. The model API row and page still say the platform default plus optional user override does not use credits. Uncaptured support/legal or about sections are not invented, and there are still no subscription, credits, or pricing routes. This is not Teamily or Impeccable comparison acceptance.

This slice only lays out the recorded page structure. Connect / authorize controls stay disabled. On `/settings/connectors`,「添加 MCP 服务器」opens the recorded instruction dialog (title, three steps, and「知道了」). 「知道了」closes the explanation only; it does not add or connect an MCP server, and there is still no MCP API.

`/settings/connectors` also lists a browsable catalog skeleton of 39 apps taken from the in-repo DS-Bot baseline `CATALOG` (public fields only: id, name, category, and the original one-line `about`). Official product names stay in English. The page uses letter placeholders instead of third-party marks, and every row is shown as 未连接. The recorded search box filters this list on the client by name, about, or id, and shows an empty state when nothing matches. 「连接」now goes through Composio with each user's own Composio API key (see [COMPOSIO.md](COMPOSIO.md)); until the user saves a key every row stays disabled and says 未配置 Composio, and apps without a Composio toolkit stay 未接通. Category filters, a connected sort, and real account state were not recorded here and are not invented. The Teamily recapture's larger third-party list and already-connected states are not reproduced. There is still no channel, Agent API, or connector backend. This is not Teamily or Impeccable comparison acceptance.


## Chat composer shortcuts

The unified `/chat` composer reads `send_shortcut` from `GET /v1/settings`. The
default `enter` sends on Enter and keeps Shift+Enter as a newline, matching the
recorded shortcuts page. `mod_enter` sends on Ctrl or Cmd+Enter and leaves a
plain Enter as a newline. IME composition does not send. A missing, invalid, or
unreadable setting falls back to `enter` and does not block the chat page.
Message folding, auto-translate and link-preview rendering are not applied in
the transcript here because those result layouts were not recaptured. This is
not Teamily or Impeccable acceptance.

## Chat language reaches the prompt (issue #319)

`chat_language` used to be stored and never read outside the settings page, so
choosing English still got Chinese replies. The `/chat` composer now reads the
stored value from `GET /v1/settings` and sends it with the message request as
`chat_language` (`auto` sends no field, so the model keeps its own default).
`POST /v1/workspaces/{ws}/agents/{agent}/conversations/{id}/messages` accepts
that one extra field, validates it against the same `CHAT_LANGUAGES` list the
settings API uses (unsupported value → `400 invalid`, never silently ignored)
and appends a single `Reply in <language>.` line to the prompt through
`conversations.compose_prompt(..., reply_language=...)`. A client that does not
send the field falls back to the account's stored value, so the preference does
not depend on an upgraded page. `compose_prompt` without `reply_language`
produces byte-for-byte the previous prompt. Language codes stay in the
database; the prompt gets the language name from `settings.CHAT_LANGUAGE_NAMES`.
This is not a translation catalogue: only the reply language is stated.
