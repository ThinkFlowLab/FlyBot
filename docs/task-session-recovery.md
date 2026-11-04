# Task-role context restoration

A Task-role logicalSessionId survives Attempts and carrier processes. Every execution
still has a separate registered workspace, lease/generation and physical binding.
Changing cwd does not grant another resource, account, profile, model or persona.

## Admission

The host selects the latest trustworthy role context from bindings and worker
history. Missing bindings do not reset the Task. It can pass a newer unstarted
admission only with exact host exit/no-start proof; a started/unknown worker blocks
older-context selection. Pinned definition/resource preference uses that same source.
Current Task/Attempt, role, claim/generation, resource principal, registered workspace
and materialization must match. Actual Git HEAD and clean/retained-draft state are
checked in the resource, then the execution profile is rechecked before the existing
committed spawn/activation fence. Neither a metadata field nor an idle resource
counter alone establishes safe resumption.

## Resumed and reconstructed

Codex SDK/CLI0.166 supports resumeThread(originalId,{workingDirectory:newCwd}). The
host preserves the original ID, checks the actual binary/configuration, and rejects
a different thread returned as a resume. Read-only candidate and scratch/network
constraints remain current, independent of old conversation messages.

When a safe physical move is not used, Claude/native execution starts an explicitly
reconstructed physical Session in the admitted cwd. The private host archive retains
original context, prior conclusions and tool/message evidence, current Task goals,
pending handoffs, handled-input metadata, PR and operation receipts. Hashes and
source/current Session links are audited. Native uses the original DSH history page
API with a bounded read window; old parts remain historical. The new physical header
must actually name the new cwd. A runtime copy in that checkout's own Git metadata
avoids changing the candidate tree. SDK copies stay in its private scratch.

The initial prompt carries a small index and hash, not the full archive. Existing
context limits and model/DSH compaction remain in force; roles read needed bounded
entries. An unavailable/changed/oversized archive refuses startup and preserves its
source. There is no second context controller or synthesized memory PASS. Old input
batch IDs cannot acknowledge a new claim. Host Effects still reconcile PR/publication
or other unknown writes before retry; restoration never grants permission to replay.

## Interfaces and errors

Existing TaskView.execution.contextRestoration distinguishes resumed/reconstructed
and links logical/source/current physical identities, workspace/checkout and archive
hash. Attempt roleSessions and hash-bound attempt.context retain exact source history.
No public arbitrary-path download or force-reset endpoint is added. The resource
runtime receives its own readable archive path; operator artifacts remain private.

bot/context-resume failures retain structured kind/contextPreserved metadata in
admission/worker history for Chief. They never clear bindings or pick a human/Dev
by framework policy. After proven pre-start failure, the existing abort path releases
its reservation. A started or exit-unknown worker keeps the original capacity fence.

## Validation

Unit/contract tests cover all three SDK delivery roles, v2/v3 and missing-binding
recovery, current claim/identity/checkout denial, archived native reconstruction,
source-integrity failures, and pre-start rollback. Actual installed SDK/CLI0.166
checks on host and Docker use a local Responses protocol fixture: same thread,
prior conclusion, actual pwd in the new cwd, denied candidate write, current scratch
permissions. The provider is deterministic, not a paid model. Enable the fixture:

```sh
FLYBOT_TEST_CODEX_EXECUTABLE=/resource/sdk/vendor/bin/codex \
FLYBOT_TEST_CODEX_SDK_URL=file:///resource/node_modules/@openai/codex-sdk/dist/index.js \
TZ=UTC node --test core/test/project-codex-config.test.js
```

Use the executable resolved from that installed SDK, not another global CLI. Native
reconstruction archive/paging tests use explicit history fixtures; paid Claude/native
cwd-move acceptance and any live deployment remain separate. Existing actual DSH
same-cwd return/continuation regression remains required and is not credited as a
native changed-cwd model run.
