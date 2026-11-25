# Personal Agent and built-in roster

Related: [#130](https://github.com/openTeamily/openTeamily/issues/130), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#6](https://github.com/openTeamily/openTeamily/issues/6), [#7](https://github.com/openTeamily/openTeamily/issues/7).

The 2026-11-18 real-account contrast (#130) showed that Teamily signs a user in with a default
`<username>'s Personal Agent`, a built-in assistant roster, and a pinned personal conversation.
This slice adds the same identity and roster on the management side, written for FlyBot. It
does not copy Teamily prompts, marks, or credits, and it is not Teamily parity yet.

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
- Ten built-in assistant records: Teamily Agent, Content Creator, Finance Assistant, Health
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
original CSS avatar. It is owner-only, decorative and not a generated image or a
Teamily art match. See [PERSONAL_LOOK.md](PERSONAL_LOOK.md).

## Explicitly not in this slice

- The observed 4-step onboarding (industry/role and later steps). Only the personal-agent/roster
  effect is implemented; onboarding remains #130.
- A shared "对话 · 9" agent-only group. The current social model requires at least two human
  members, so an agent-only group is not created here.
- Credits, `CREDIT`/`$CASH`, upgrade, pricing, or onboarding rewards (excluded by repository rule).
- Real vendor/container execution; replies still use the existing runtime infer contract and the
  labeled fake-provider tests.
- Browser E2E and Teamily page-by-page comparison. Historical screenshots from the source repository are
  synthetic review material.
