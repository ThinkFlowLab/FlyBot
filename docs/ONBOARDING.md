# Work-context onboarding (industry and role)

Related: [#130](https://github.com/openTeamily/openTeamily/issues/130), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#4](https://github.com/openTeamily/openTeamily/issues/4).

The 2026-11-18 real-account walk captured the full four-step onboarding:

1. **关于你 / 聊聊你的工作** — industry + role.
2. **连接你在用的应用** — Gmail, Outlook, Google Calendar, GitHub, Google Drive, Notion, Google Sheets, Google Docs.
3. **我们能帮你分担些什么？** — one-off tasks and routines derived from the role.
4. **你的 Agent** — Personal Agent look (colour, expression, headwear, glasses, hand item).

Step 1 (industry and role) follows the captured layout. Steps 2–4 are a **functional flow that has not been compared with Teamily** (no comparable layout capture): step 2 lists the eight captured apps as not connected because account authorization is unimplemented; step 3 stores up to six picks from self-written task/routine suggestions (two industry-specific ones for some industries plus four general ones) and saving those picks creates no automation; an optional explicit-create control within the same step can create paused automations (see below); step 4 stores a Personal Agent look (colour, expression, headwear, glasses, hand item; self-written option labels). The saved look is rendered as an original CSS avatar in step 4, the owner's Personal Agent card on `/agents`, and its `/chat` session/header; no bitmap image is generated. The steps appear on `/onboarding` once step 1 is saved or skipped. See [PERSONAL_LOOK.md](PERSONAL_LOOK.md).

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/onboarding/picks` | `{picks: [key…]}` (≤6 unique known keys). Returns `{steps}`. |
| POST | `/v1/onboarding/look` | `{look: {color, expression, headwear, glasses, hand}}`, each from `look_options`. Returns `{steps}`. |

`GET /v1/onboarding` returns `automation_templates` (role-based real automation templates) separately from `steps` (`apps`, `recommendations`, `look_options`, `picks`, `look`, `compared: false`). Additive `user_onboarding_steps` table. There is no forced redirect: `/chat` shows a non-blocking hint when the context is missing.

## API

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/v1/onboarding` | session | `{onboarding}` (or `null`) plus the captured `industries`/`roles` lists. |
| POST | `/v1/onboarding` | session + Origin + CSRF | `{industry, role, completed}`. First save `201`, later `200`; revision increments. |
| GET | `/v1/onboarding/recommendations` | session | Role-based automation recommendations from the existing templates. |
| POST | `/v1/onboarding/automations` | session + Origin + CSRF | `{template_ids:[1–6]}`; creates paused automations in the first owned workspace or `个人空间`. |

`industry` and `role` are ≤40 characters with no control characters; an empty pair is accepted for「暂时跳过」. `completed` must be a boolean. Unknown extra fields are rejected. The saved row is per user; no other account can read it.

## Captured lists

16 industries are returned with the role suggestions captured from the real UI: 科技与软件, 广告与营销, 媒体与娱乐, 金融服务, 教育, 电子商务与零售, 咨询与专业服务, 游戏, 旅游与酒店, 医疗健康, 时尚与服装, 房地产与租赁, 农业与种养, 运输与物流, 建筑与家居服务, 其他. Custom industry and role text are accepted; the lists are suggestions, not hard enums.

## Optional paused automations within main step 3

`GET /v1/onboarding/recommendations` (also exposed as `automation_templates` on the main GET) maps the saved role to 4–5 templates from the
existing `automations.TEMPLATES` (products → deck/task breakdown/industry watch; engineering →
task breakdown/build web; marketing → industry watch/deck/inbox; finance → market research/inbox;
research/education → expert research; generic → daily brief/task breakdown/meeting prep/inbox).

`POST /v1/onboarding/automations` validates 1–6 known templates, reuses the first workspace the
caller owns (or creates `个人空间`), and inserts `automations` + `automation_editors` rows with a
daily 09:00 Asia/Shanghai schedule and the caller as participant. Created automations are
**paused** (`enabled=0`) so they do not start background work before review; the `/automations`
page can enable them. Existing titles/keys are skipped, replaying is idempotent, and capacity
limits still apply (already-existing items do not consume quota again). Requests are serialized in the normal SQLite write transaction.

The four-step main flow is retained, including saved suggestion picks and Personal Agent appearance. Step 3 has a separate, default-unchecked list of actual automation templates: preference keys are not silently reinterpreted as runnable templates. **Only the explicit “创建选中模板（暂停）” button calls the creation API.** Normal save/continue, skip, step navigation and completion never create automations. The button is disabled in-flight; errors are visible, and retries skip existing templates. The UI states the target (an owned workspace, or a new personal space), daily 09:00 Beijing schedule, paused state and need to configure/enable manually. No app connection or background execution is implied.

## Storage

Additive `user_onboarding` table (`user_id` primary key, industry, role, completed, revision, created, updated). Schema `user_version` stays 1.

## Page

`/onboarding` is a same-origin page with the industry select, role chips, custom industry/role inputs, 「保存并继续」 and 「暂时跳过」. Saving work context proceeds to the existing four-step flow; skipping work context goes to `/chat`. `/chat` shows a hint link when the context is not completed. The shared account menu now includes a 「工作背景」 item that opens this page, placed after the recorded 「Agent 渠道」 and 「应用连接器」 links and before 「帮助」, which is the recorded slot for Teamily's 「新手引导」. The four-step flow remains non-blocking and does not force a first-login redirect. The source project contains synthetic review captures; they are not browser acceptance.

## Explicitly not in this slice

- Automatic activation or execution, app connector authorization, or Teamily visual-equivalence acceptance for the optional creation UI.
- A forced first-login redirect or blocking onboarding gate.
- Teamily comparison acceptance. Tests are in-process WSGI + temporary SQLite.

## Current-main integration

The contributor branch incorporates main with an ordinary merge (no rebase or
history rewrite), retaining both onboarding and personal-agent routes/tables and
both chat startup calls. Every shell page, including onboarding, distinguishes
the implemented 功能指引 link from the unimplemented 帮助中心 slot, and the account menu
links 工作背景 to `/onboarding`. Custom industry
and role values are restored after reload. Integration tests cover repeatable v1
initialization, personal mapping plus user context persistence, isolation and
Origin/CSRF. Main's saved picks/look flow is retained; paused automation creation is a separate opt-in action in step 3.
CI shot `86-onboarding-saved-context.png` and save/custom-reopen assertions exercise
the real UI against a throwaway runner app, not a real vendor or Teamily acceptance.
