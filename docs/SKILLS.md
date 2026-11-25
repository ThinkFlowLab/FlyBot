# Real instruction-skill lifecycle

Related: #231, #10, #1, #14.

The user's DS-Bot loads instruction skills for native execution. This document records the original management task protocol. The [current skills feature](../runtime/flybot-workspace-web/features/skills/index.js) defines today's bindings and execution.

`/skills` now installs **real, original, instruction-only packages**, not an in-memory installed set or a boolean claiming execution. A binding is not an execution receipt: the page separately reports “waiting for next task” and historical runtime loading acknowledgement. No claim of Teamily skill-operation parity or real-vendor acceptance.

## Content and source

`flybot_workspace/skill_packages.py` bundles ten original SKILL.md-style definitions, each with bounded instructions, input boundaries, a useful procedure and output contract. The authenticated catalogue returns `id`, `name`, semantic `version`, full `content`, SHA-256 `digest`, `permissions: [model_context]`, `format: flybot-workspace.prompt-skill.v1`, and `source: bundled-original`.

The content is actually added to a model request. It does not itself fetch a URL, send email, generate a file, run code, grant a connector, or authorize an external action. Such claims are explicitly prohibited in the package instructions without separate tool evidence. The catalogue is not a mock remote marketplace and contains no copied Teamily prose/assets/account data.

Upstream reuse investigation inspected `ds-bot/src/host/office-skills.js` and `goal-skills.js` in the pinned DS-Bot source: they register description/content providers using SKILL.md material with `ctx.skills`. The original management inference loop ran separately from standalone DSH sessions. This implementation reuses the **declarative content contract**, not a pretend DSH filesystem install. It deliberately does not unpack archives, execute package hooks or write arbitrary runtime paths.

## Install, bind, load, revoke

1. Inspect real content/version/digest, choose account or `workspace:agent` scope, and explicitly permit model-context loading.
2. POST `/v1/skills/bindings` with `skill_id`, current `version`/`digest`, `scope`, boolean `enabled`, and exact `permissions`. Session/CSRF and per-user ownership apply. Agent installation requires active agent and workspace owner/admin membership. Bindings persist in SQLite across refresh and management restart/new login; max 200/user.
3. A supported inference task records its initiating skill owner only when it uses that same user's runtime. Account bindings and that task's agent bindings are deduplicated. Version/digest and active agent/role are rechecked at materialization. Another user's bindings are never injected into a shared runtime.
4. The claimed runtime requests one-time model access advertising `skill_format: flybot-workspace.prompt-skill.v1`. When bindings exist, a legacy runtime without that handshake receives `409 runtime_upgrade_required` **before model credentials/material are issued**. Existing tasks with no skills retain compatibility.
5. Both Python daemon/zipapp and container JS validate exact allowed fields, bounds, semantic version, ID, format, source, permissions and SHA-256. They load the full real content into the prompt, then POST `/v1/agent/tasks/:id/skills/ack` with the exact digest list **before** calling the actual configured model API. A task cannot report success without the required acknowledgement. Errors identify the safe failing stage without echoing credentials.
6. GET `/v1/skills/bindings` includes `last_loaded_task` only from stored acknowledgements matching the package digest/scope. This is a historical loading receipt, not proof that every later task used the skill or that provider output obeyed it.
7. Uninstall deletes only the current user's binding. It stays possible after agent archival or permission loss; the UI retains a revocable scope option. Version-changed bindings are labelled stale, not active. Already-issued tasks losing their last applicable binding are cancelled; stale acknowledgements fail. Subsequent tasks omit the removed content. Content already sent to a model cannot be recalled.

No archive upload/extraction, scripts, filesystem paths, shell permission, credential material, or arbitrary package fields are accepted. Traversal IDs/scopes, injected archive/files/path/script/user ownership, version/digest mismatch, unknown permissions and cross-task/runtime access fail closed. A runtime is still a trusted holder of its user's model access; acknowledgement is protocol evidence, not cryptographic attestation of an untrusted daemon.

## Supported execution boundary

Covered: personal management inference/private agent chat and agent-scoped management tasks dispatched onto the initiating user's own upgraded runtime; private message-assistance tasks can use account skills without gaining any connected-tool grant. The model remains platform default + user override. Composio remains user-supplied and its existing approval broker is unchanged.

**Not implemented:** a third-party registry, package uploads/downloads, signatures/upgrades/migrations for arbitrary packages, executable/filesystem skills, dynamic SDK tools, standalone upstream DSH session loading, delegated/shared-runtime grants. A skill that asks for an external action does not authorize one. Real inference still requires an operator-configured model and online runtime; a persisted binding alone cannot manufacture those dependencies.

## 「我的技能库」标记（per-account library）

`/skills` 的每张卡片除了「安装 / 卸载」绑定按钮，还有一个「加入我的技能库 / 移出我的技能库」按钮。它写的是 `flybot_workspace/skill_installs.py` 的 `skill_installs(user_id, skill_id, installed)` 表，接口是 `GET/POST/DELETE /v1/skills/installed`，按账号保存，刷新或换设备后仍然保留。

它**不是**绑定：只记录这个账号把哪些技能放进了自己的库，不让技能内容进入模型上下文，也不创建任何凭据。真正决定运行时能加载什么的是上面那条版本/摘要绑定的生命周期。未登录写入被拒绝，允许的 id 必须与 `skill_packages.catalogue()` 完全一致（`tests/test_skills_page.py` 断言）。本仓库早期一版 `/skills` 的页面本地目录与「安装状态」文案已被真实目录与绑定生命周期取代。

## Verification

- `tests/test_skill_packages.py`: actual synthetic provider request contains exact installed content; subsequent request omits it after uninstall; SQLite restart/new login; account/agent isolation; archived-agent revocation; explicit permission; CSRF; version/digest/field/traversal/archive injection; compatibility handshake; tampered/missing acknowledgement; cancel-on-revoke.
- `tests/test_skills_page.py`: 页面/账号库清单与严格响应头、`/v1/skills/installed` 往返与重新登录、CSRF/未知技能拒绝。
- `tests/skills_page.test.mjs`: server catalogue/digests, permission gate, persisted synthetic service reload/uninstall and refusal without invented success. This service stub is labelled synthetic, not provider acceptance.
- `scripts/ci_ui_screenshots.mjs`: real local page → SQLite install/reload → actual daemon → local synthetic model → loading receipt → uninstall/reload, with content and 390px captures. Python tests separately inspect provider request content.

Private after screenshots live outside the repository. Historical demo screenshots from the source project, are historical UI-only evidence and must not be used as lifecycle acceptance. No Teamily skill installation/execution reference scene exists; that parity is **unverified**.


## Skills/runtime completion follow-up

The library now offers real readiness diagnosis and an explicit **使用技能** flow. `/v1/skills/scopes` lists only accessible active administrative scopes; old bindings remain revocable after access is lost. `/v1/skills/readiness?scope=…` distinguishes offline, legacy runtime, delegated runtime, missing model, unsupported provider and ready. Runtime capability advertisements are persisted and reset on a legacy reconnect; they are not inference proof. Download `/install/flybot.pyz`, stop the old daemon, and restart with its existing private key-file. No automatic host install, restart, key discovery or package execution occurs.

`POST /v1/skills/runs` requires CSRF, a 16–64-character Idempotency-Key, an exact current installed skill, scope and 1–4000-character input. It pins **only the selected content/version/digest**, not all installed instructions, creates a real runtime task and grants no connected tools. Stable replay returns the original task; different input with the same key is rejected. GET returns the user's latest50 persisted run records and exact selected versions. A successful task, nonempty model result and exact material acknowledgement are all required for `verified`; acknowledgement alone is not success or quality acceptance. Cancel and explicit save-to-workspace use existing authorized runtime-task APIs. Saving makes the result visible to members; the returned link selects the actual workspace/document editor. No external sends or public shares occur.

### Explicit scheduled skills

Install into an `automation:<workspace-id>:<automation-id>` scope to opt that existing automation into skill loading. It requires active workspace administration and has one installing owner at a time. The scheduler uses **that owner's own compatible personal runtime only**, with no fallback to another member and no inherited private account skills. It pins the complete installed automation manifest, uses the existing workspace model-resolution policy, and records the actual task/result/receipt in the same history. Missing runtime queues with `no_agent`; incompatible runtime fails with `runtime_upgrade_required`; role loss/version mismatch fails closed. Uninstall cancels selected active tasks even before first model access. Already-sent provider input cannot be recalled. Revoke all bindings before transferring ownership. No Composio grants were added to automation.

Two actual usability defects are corrected: regular workspace members' account-installed skills can reach their own runtime in agent conversations (without granting admin-only agent bindings), and task-local claim/result404/409 races no longer kill either Python or container poller. Auth/network errors remain errors; inference is never automatically replayed.

Still absent: third-party registry/upload/archive/signature distribution, arbitrary filesystem or executable packages, standalone DSH session loading, delegated/shared-runtime grants, real-vendor quality acceptance, and Teamily skill-operation reference evidence. These are not all credential blockers: the first five need additional engineering/protocol work. Controlled local provider tests assert real model-request material and post-uninstall absence, not real-vendor acceptance.
