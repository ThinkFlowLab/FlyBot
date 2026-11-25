# Signed-in home / workspace welcome page

Related: [#1](https://github.com/openTeamily/openTeamily/issues/1), [#14](https://github.com/openTeamily/openTeamily/issues/14), [#130](https://github.com/openTeamily/openTeamily/issues/130).

## Why this slice

Before this change the management app had no real entry page:

- `/` was not a served page; the app rail's mark and all sign-in flows pointed at `/chat`.
- OIDC sign-in redirected to `/settings`.
- A signed-in user landed in a conversation list, with no single place that showed the
  Personal Agent, recent work, meetings and workspace totals together.

The 2026-11-18 real-account walk recorded the Personal Agent as Teamily's default
conversation. This home keeps that Personal Agent as the primary object, but gives
FlyBot a real signed-in entry that also surfaces the user's own workspace
summaries. It is an FlyBot product choice, **not** a Teamily page-by-page
comparison or a claim that Teamily has this exact layout.

## What renders

`/` (and the `/home` alias) serves the shared app shell. Signed out, it shows the
same login form as the other pages; a successful login stays on the home. Signed in:

- greeting with the current username and a workspace picker;
- optional onboarding banner when the work context is incomplete;
- unread-notification banner when the workspace has unread mentions/replies;
- **Personal Agent hero**: saved look avatar, name, summary, stored industry/role,
  and a `继续对话` link to the Personal Agent conversation;
- real workspace totals for agents, artifacts, meetings and automations;
- quick actions for chat, agents, automations, works, meetings, skills and discover;
- three recent columns: conversations, artifacts and meetings, with honest empty
  states and links into the existing pages.

The workspace picker changes the summaries for that workspace and writes
`#workspace=<id>` to the address, so a reload keeps the selection. The Personal
Agent hero stays the owner's own agent.

## API

New read-only endpoint:

`GET /v1/workspaces/{wid}/overview?limit=1..10` (default 5), session + workspace
membership required; outsiders get `404`. It returns:

```json
{
  "workspace": {"id": "...", "name": "...", "kind": "workspace"},
  "counts": {"agents": 11, "artifacts": 4, "meetings": 2, "automations": 3},
  "recent_conversations": [
    {"source": "agent", "id": "...", "agent_id": "...", "agent_name": "...",
     "title": "...", "preview": "...", "updated": 0, "unread_count": 0},
    {"source": "social", "id": "...", "kind": "group", "title": "...",
     "members": [], "preview": "...", "updated": 0, "unread_count": 0}
  ],
  "recent_artifacts": [{"id": "...", "title": "...", "kind": "document"}],
  "recent_meetings": [{"id": "...", "title": "...", "action_count": 0, "done_count": 0}],
  "unread_notifications": 0,
  "limit": 5
}
```

Counts are real SQLite counts. Recent artifact/meeting records use their existing
list projections: no document body, meeting transcript, summary or action-item
text is returned. Conversation rows are limited to the caller's own agent
conversations and social conversations they are a member of; no prompts or full
messages are returned. There is no new table and `user_version` stays 1.

## Entry points

- Every shell rail now has a `首页` link to `/`; the FlyBot mark also links to `/`.
- OIDC sign-in redirects to `/` instead of `/settings`.
- Password sign-in from the home form stays on the home; other pages keep their
  own current-page login behavior.

## Design notes

The page follows the interaction principles used in the review, not copied UI:

- **Visibility of system status** and **recognition rather than recall**: the current
  workspace, greeting, totals and recent items are visible without opening menus.
- **Aesthetic and minimalist design**: one hero (the Personal Agent), one action row,
  then quiet lists; no decorative metrics, fake recommendations or invented trends.
- **Consistency and standards**: same rail, typography, surfaces, focus rings and
  dark/light tokens as the rest of the app; cards use existing CSS variables.
- **User control**: every summary links to the page that owns the full list; the
  workspace picker and hash make the current scope explicit.
- **Error prevention / recovery**: missing data becomes an honest empty state; a
  failed overview request reports a message without hiding the shell.
- Narrow layouts stack the hero and columns; `prefers-reduced-motion` disables the
  small hover transitions.

Reference points used for the product review were public interaction guidance
(Nielsen Norman Group's heuristics) and the calm, dense information architecture
of current AI workspace products such as Linear and Notion. No vendor screens,
marks, copy or assets are reproduced.

## Explicitly not in this slice

- A Teamily side-by-side or Impeccable acceptance claim.
- Recommendations, ranking, generated greetings, usage/credit cards or activity
  that the instance does not actually have.
- Live push updates on the home; it loads on entry and when the workspace changes.
- Sending a prompt from the home; `继续对话` opens the existing chat.
- Any billable model call, OAuth/connector connection or new background worker.

## Screenshot

The source project contains synthetic light, dark and 390×844 mobile captures with one seeded account.
They are review material, not browser E2E or Teamily comparison.

## Tests

`tests/test_home.py` serves `/` and `/home`, checks the strict headers and rejection
paths, and exercises the overview endpoint's membership isolation, counts, recent
items and body/transcript redaction. `tests/home_page.test.mjs` checks the title,
time, kind and meeting-label helpers. `tests/test_shell_help_entry.py` and
`tests/test_oidc.py` cover the new shell page and the `/` sign-in redirect.
These are in-process/unit tests, not browser E2E or Teamily comparison.
