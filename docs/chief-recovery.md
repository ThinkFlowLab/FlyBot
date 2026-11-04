# Chief inspection and interrupted delivery recovery

`chief.state` reports the configured policy separately from actual inspection
health. `lastSuccessAt` is a validated successful inspection; a configured/enabled
schedule, queued request, partial judgement or failed delivery is not success.
`lastAppliedDecisionAt` identifies applied non-defer actions, not necessarily a
verified artifact checkpoint. `health.active` includes isolated old invocations,
waiting reason, recovery issue, stop budget and `nextRecoveryAt` (null when there
is no scheduled retry). `lastMeaningfulProgressAt` uses the existing deduplicated candidate/test checkpoints;
repeated tests of the same SHA and message churn do not advance it.

Use the existing `project-development/v1` commands and queries. A current
Owner/Maintainer can configure `chief.configure` with:

```json
{
  "inspection": {
    "when": {"kind": "every", "seconds": 1800},
    "lifecycle": {
      "queueTimeoutMs": 600000,
      "runTimeoutMs": 900000,
      "recoveryDelayMs": 5000,
      "maxRecoveries": 2,
      "stopTimeoutMs": 10000,
      "maxStopAttempts": 3,
      "overdueMs": 3600000
    }
  }
}
```

Timing still belongs to the original scheduled-task service. Durations are1–86400000
ms, maxRecoveries0–4, maxStopAttempts0–10. Timeouts are not exit proof. Technical
retries preserve the Run/occurrence and recheck current policy, schedule revision,
principal, Task snapshot and invocation token. A stop intent commits before stop
transport; attempts are bounded. Exhaustion retains the actual wait and evidence
for Chief/operator judgement, without choosing a business role or human fallback.
Revocation cancels authority but retains the old execution barrier until exit is
confirmed. Cleanup may observe/stop old execution; it cannot restore old authority.

## Unmanaged and supervised host restart

Systemd control-group evidence remains valid only for its matching manager
boundary. Unmanaged recovery distinguishes native Chief from independent execution:

- A native Chief invocation records its exact carrier/Session, invocation,
  allocation identity and host process birth (boot ID, PID namespace, PID and start
  ticks). Matching host-process exit can end that in-process invocation. Any
  associated native-turn leases must match the same Project/invocation/exchange.
- SDK/container workers and resource preparation are independent. Host death,
  an empty controller map, PID disappearance alone or timeout never releases them.
  Exact existing worker/lease stop and exit evidence is still required. A failed
  SDK admission with no registered allocation can record never-dispatched evidence;
  started/ambiguous execution cannot use that path.
- Old callbacks must match the current invocation and active token. A recovered
  Run cannot apply a response through its older invocation. Resume/cancel/stop
  reconciliation is idempotent and preserves history.

Pre-namespace unmanaged records lack enough information to compare process birth
safely across PID namespaces. They remain visible as unproven, rather than guessed
exited. An operator who can establish that a particular old native host used the
current PID namespace may configure one exact corroboration:

```yaml
projectChiefRecovery:
  legacyNativeScopes:
    - runId: chief-run-EXACT-ID
      invocation: 1
      scopeSha256: EXACT_SHA256_OF_JSON_STRINGIFY_ORIGINAL_PROCESS_SCOPE
      pidNamespace: "pid:[EXACT_PREVIOUS_HOST_NAMESPACE]"
```

This operator setting is not model/API input. It allows at most20 entries and binds
one Run, invocation and original scope digest. It supplies only the missing
namespace fact; the host must still prove the old process exited, and the native
execution/lease checks still apply. It cannot confirm unknown SDK/container exit.
Do not fill it by guessing the old namespace or editing Task/binding/lease state.
New invocations record namespace identity automatically.

## Continue a sealed interrupted Attempt

Chief independently selects `route`, `return` or `request-tests`. Protocol preflight
runs before Task generation changes, proposals or routing effects. An unsupported
route returns structured facts to the same Chief correction mechanism, including
current Attempt/candidate and the missing conditions; the host selects no role.

`route` to Tester can resume a failed/interrupted current code Attempt when its
requirements/repository binding and clean host-sealed candidate remain valid.
Reviewer additionally requires passing tests for that SHA and current configured
command, with the unchanged immutable test log. Every old worker and lease must
have confirmed exit. Unknown execution, cancelled/superseded Attempts, changed
requirements/candidates or stale evidence refuse continuation. An unsealed draft
uses the existing Developer recovery path; an explicit `return` requests rework.

Successful verification recovery keeps Task, Attempt, candidate and role context.
It records a successor execution Run and an immutable resumption entry; normal
Task-role admission still enforces resource/persona/profile and context restoration
(#2346). `attempt.context` with `section:"resumptions"` pages full history;
Attempt summaries return at most5 recent metadata entries and a source reference.
This is not passing tests, PR merge or Task acceptance.

Validation includes a real unmanaged DSH process killed during inspection, with
the same resident Session recovered and a later original scheduled occurrence
completed without manual inspect. Inference is deterministic, not paid-model
acceptance. Known SDK exit and unknown worker/container boundaries have separate
contract tests. No live project or service is modified by the demonstration:
`node dev/demo/run.mjs --chief-restart` uses disposable data and removes it on success.
