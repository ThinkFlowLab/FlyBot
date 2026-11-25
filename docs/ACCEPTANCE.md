# Evidence and acceptance status

Record each result against the tested revision, user role, and environment.

## FlyBot 0.3.0

All 16 jobs passed in the [FlyBot release candidate CI run](https://github.com/ThinkFlowLab/FlyBot/actions/runs/45523580750) for [PR #3377](https://github.com/ThinkFlowLab/FlyBot/pull/3377). The run covered the management API, desktop and mobile Chromium, the pinned DS-Bot suite, Compose lifecycle and retained volumes, gateway isolation, and collaboration between two DS-Bot accounts through Bot Social. The [merge queue run](https://github.com/ThinkFlowLab/FlyBot/actions/runs/45526147080) passed at the squash commit.

The two sections below preserve verification history from the OpenTeamily source repository.

## Verified DS-Bot v0.3.10 upgrade

The [DS-Bot conversation upgrade job](https://github.com/openTeamily/openTeamily/actions/runs/45196194368/job/137767160854) passed on 2026-11-23 for [#566](https://github.com/openTeamily/openTeamily/pull/566) at `9ca6fe1598f5cbb81519aa5d401470e1f19216b4`. It built the v0.3.9 baseline from `3389c421ac3d567e84cee0d30f6507c9591dc4cf` and the v0.3.10 candidate as separate images, then replaced and restarted the runtimes on the same two test volumes. The workflow uploaded Chromium screenshots under `ds-bot-conversation-upgrade-browser`.

| Check | Verified result |
|---|---|
| Per-account routing | Two independent Chromium contexts signed in through the real platform and gateway. Each account reached its own DS-Bot, and the other account's private conversation returned `404`. |
| Upgrade and restart | Both accounts retained their two private conversations and native session roots. The earlier segment stayed in its own conversation, and the separate background task stayed outside the private transcripts. |
| New messages | Both conversations per account accepted new sends and streamed replies through the upgraded DS-Bot. Their messages and history remained available after restart. |

The [runtime image checks](https://github.com/openTeamily/openTeamily/actions/runs/45196194354) also passed on the same PR head. They cover the Compose lifecycle and retained volume, owner-specific gateway routing and two DS-Bots sharing state through Bot Social. The upgrade uses a deterministic local model and disposable accounts. It covers runtime migration and browser behavior on the test volumes. An operator rollout and a Teamily comparison each require their own evidence.

The [source workflow](https://github.com/openTeamily/openTeamily/blob/07e8b6fbd05788e1c4c14cac65f18e392e82f452/.github/workflows/ds-bot-conversation-upgrade.yml) records the original test inputs. See the [test runner](../runtime/flybot-image/test/upgrade/check.py) and [Compose manager](COMPOSE_MANAGER.md) for the runner and deployment details.

## Memory and navigation release

[PR #610](https://github.com/openTeamily/openTeamily/pull/610) was deployed as
`466d7985ca8bf99c2194ab9650fb575855a92b28`. The cutover preserved all 27
existing account volumes. Four previously running containers were healthy
and the other 23 stayed stopped.

| Environment | Checks |
| --- | --- |
| Deployment, signed Chromium at 390 px and 1280 px | Checked a task and edited a table in Memory. The saved page reopened with both changes, including a literal pipe in a cell. The Markdown export matched the stored content. The test removed its temporary note. |
| Signed native test fixture at 390 px and 1280 px | Verified saved private and group message links, Discover detail and adjacent navigation, Team Runs filters and focus restoration, and Memory editing. |
| Release CI | All six workflows passed, including [native Chromium screenshots](https://github.com/openTeamily/openTeamily/actions/runs/45282621412) and [the runtime image checks](https://github.com/openTeamily/openTeamily/actions/runs/45282621491). |

After the rollout, the operator reconciled two accounts that had a personal
agent record and no assigned runtime. Both new DS-Bots reached healthy status
on separate volumes and loaded the platform DeepSeek default. All 29 accounts
then had a distinct Compose binding and volume. No retired execution task was
queued or claimed in the management database.

## Record per check

Preserve these fields even when empty, using `pending-verification` rather than a guessed result:

```json
{
  "check_id": "workspace-create",
  "scope": "product-comparison",
  "flybotWorkspace": {
    "commit_or_image": null, "config": null, "role": null,
    "steps_and_input": [], "actual_result": null, "evidence": [],
    "status": "not-executed"
  },
  "teamily": {
    "page_url": null, "role": null, "steps_and_input": [],
    "actual_result": null, "evidence": [],
    "observed_at_asia_shanghai": null, "status": "pending-verification"
  },
  "comparison_status": "pending-verification",
  "gap_and_followup": "Record both same-role real operation results before accepting parity"
}
```

Do not place secrets, cookie values, personal data or access-bearing URLs into public evidence. A guide-only or unavailable gray rollout stays `pending-verification`; it is not evidence of absence or a parity pass. Independently verify negative/permission/error paths where possible and record differences instead of erasing them.

## Historical PR16 foundation snapshot

PR16 documented the initial 24 management tests. The table below records that slice at the time of its review. See [Compose manager](COMPOSE_MANAGER.md) for the current operator path.

| Check | FlyBot evidence/status | Teamily evidence/status | Overall status |
|---|---|---|---|
| Auth, CSRF, private persistence, owner-only workspace records | 24 executable self-authored in-process WSGI/SQLite tests passed locally; test source in `tests/test_management.py` | Real same-role/page/action/result comparison not performed in this slice; pending-verification | Self-hosting foundation tested, not independent product acceptance |
| Browser signup/login/workspace interaction | No frontend or browser test in this slice; not-executed | pending-verification | pending-verification |
| Lifecycle/manager/volumes/jobs | Not implemented; no fake/runtime test pass claimed | Internal Teamily implementation unknown, not assumed identical | Pending self-hosting implementation and real deployment acceptance |
| Full product scope | Not implemented by this PR | Existing partial inventory cannot replace real operation evidence | Not accepted |

PR16's evidence was limited to local management tests and the development runner's `--help`. Use the linked GitHub job results for newer runtime verification.
