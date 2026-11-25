# Personal Agent and built-in roster

FlyBot provisions a Personal Agent, built-in assistants, and a welcome conversation in each user's personal workspace. When an account has a native DS-Bot runtime, its Personal Agent is bound to that runtime's Chief bot.

## API

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/personal-agent` | Current mapping, or `{personal_agent:null}`. Session only. |
| POST | `/v1/personal-agent` | Idempotently create the personal space, agent, built-in roster and welcome conversation. Session + exact Origin + CSRF. `201` on first call, `200` after. |

Response:

```json
{
  "personal_agent": {
    "workspace": {"id": "...", "name": "个人空间", "kind": "personal"},
    "agent": {"id": "...", "name": "<username>'s Personal Agent", "summary": "Your Cross-context Super AI Agent."}
  },
  "builtin_agents": [{"key": "travel-planner", "agent": {"id": "...", "name": "Travel Planner"}}]
}
```

`GET` never creates anything. `POST` is the only creation path; it requires the same CSRF/Origin
rules as every other authenticated write. If the user already has the maximum number of
workspaces the call returns `429 quota` and creates nothing.

## What is created (once per user)

- A `个人空间` workspace owned by the user.
- `<username>'s Personal Agent` with the summary `Your Cross-context Super AI Agent.` and an
  original instruction prompt.
- Ten built-in assistant records: FlyBot Assistant, Content Creator, Finance Assistant, Health
  Assistant, AI Stock Assistant, Market Research, Travel Planner, Accounting Assistant, Slides
  Assistant, Webpage Developer. Summaries and instructions are FlyBot-authored, not copied.
- One welcome conversation titled `Personal Agent` with a single succeeded assistant message
  `你们已经是好友了，可以开始聊天啦！`.

The `/chat` page calls `POST /v1/personal-agent` after a signed-in session and selects the personal
workspace on a first visit, so the personal welcome conversation is the default session. The agents
also appear in the normal `/agents` directory.

## Storage

Additive `personal_agents` and `builtin_agents` tables (`CREATE TABLE IF NOT EXISTS`). Schema
`user_version` stays 1. No existing table or CHECK constraint changes. The personal mapping is
keyed by `user_id`; the roster is keyed by `(workspace_id, builtin_key)` so a rerun cannot duplicate
records.

## Personal Agent look

If the user saved onboarding step 4, `GET`/`POST /v1/personal-agent` also returns
`personal_agent.look` and the owner's Personal Agent card/session renders it as an
owner-only decorative CSS avatar. See [Personal Agent appearance](PERSONAL_LOOK.md).

## Verification

See [onboarding](ONBOARDING.md) for the setup flow, [DS-Bot plugin architecture](DSBOT_PLUGIN_ARCHITECTURE.md) for native execution, and [acceptance records](ACCEPTANCE.md) for the checked environments.
