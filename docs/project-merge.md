# Reviewed candidate to host merge

A Reviewer approves the exact candidate SHA in its original host-bound role
Session. After publication, FlyBot commits `github.merge` in the original Effects
store. No per-PR Chief/Owner permission click is added inside an explicitly
configured scope. Chief separately judges whole-Task acceptance after merge.
Reviewer approval alone remains neither a signed forge Review PASS nor GitHub
approval, a merge receipt, a release or a deployment authorization.

## Configure the authorized scope

An operator configures the associated repository and its existing selected
`gh-cli`/GitHub App connection. No key, host path or new identity goes to role tools.
Automatic merge is disabled when `mergePolicy` is absent or explicitly disabled.

```json
{
  "projectRepositories": {
    "org/repo": {
      "mergePolicy": {
        "enabled": true,
        "branches": ["delivery/ai-centric-development-service"],
        "method": "squash",
        "requiredChecks": ["tests-ok"],
        "requireGithubReview": false,
        "pollIntervalMs": 30000,
        "maxWaitMs": 86400000
      }
    }
  }
}
```

This fragment supplements existing repository path/test/GitHub provisioning. The
Project's current associated default branch must be allowed; models cannot choose
another base. `method` is explicitly squash/merge/rebase. At most20 branches and50
required check names are allowed. A check can instead be `{ "name":"tests-ok",
"appId":12345 }` to pin its GitHub App. Required configured checks must report
success for the exact head; a newer pending/failing run cannot borrow old green.
A private repository with no configured CI may explicitly choose `requiredChecks:[]`;
it still needs matching host tests/Review and actual repository merge gates.

`requireGithubReview` adds an explicit GitHub-review requirement. Actual branch
protection/review rules still apply when it is false; it does not waive them.
No generic FlyBot main-branch signed-review requirement is imposed on other
projects. Conversely this setting does not waive any repository-specific contract.
GitHub App connections need contents/pull_requests write and checks read; the same
installation/repository and publisher identity are reverified per operation.

`pollIntervalMs` is5000–3600000; `maxWaitMs` is at least that interval and at most7
days. Waiting uses the existing Effect scheduler with a bounded retry hint. There
is no new polling controller. A configured exhausted wait is failed and can use
existing authorized `effect.retry`; this renews its time budget only after current
scope/evidence checks. Cancelled/revoked scope is not automatically revived.

## Preconditions and transitions

The host binds the intent to Project/Task/Attempt, candidate, original publication
marker/branch/creator, selected credential identity, test log, immutable Reviewer
result and current merge policy. It verifies the actual SDK/native role execution,
pinned policy, completed claim and all prior worker/lease exits. A Developer result
or an arbitrary approve string cannot create a legitimate Reviewer execution.
Unhandled current Task feedback defers merge until it is actually handled; arrival
or transport is not an acknowledgement.

The normal transition is approved publication → Draft ready → current checks and
required reviews → merge or queue → provider-confirmed merge commit. `hold`,
conflicts, changed head/base/repository/creator/marker, revoked rights or changed
configuration stop old writes. Missing/pending CI waits; failed CI/review/conflict
has a visible blocking reason and is reconciled within the configured wait budget.
A queue uses GitHub's expected-head enqueue with no jump. Direct merge uses
expected-head CAS. No admin bypass, gate/ruleset edit, forced push or fabricated
forge approval is requested. GitHub's APIs do not expose an atomic expected-base
parameter: the host checks current base binding/observed SHA and relies on actual
server protection/queue enforcement for concurrent base changes.

Before a provider write, the host commits its exact write intent and rechecks
current scope. A lost response is unknown, not success: the next pass first reads
the same PR/queue/merge state. Ready, queue entry, merge request and actual merged
commit are distinct facts. Duplicate callbacks and host restart retain the same
intent; they do not rerun code/tests/Review or create another PR. At most8 recent
observation metadata records stay inline. History remains in the original Effect
and immutable role evidence, not Chief long-term memory.

`attempt.merge` and Task views expose status/reason, expected candidate, actual
merge commit and next check. `attempt.context` with `section:"merge"` pages the
full bounded source; `effects`/`effect.retry` retain their existing authorization.
`github.connection` reports safe merge-policy metadata, never credentials. Role
contexts receive that metadata as facts, not additional tool rights. The final
merge evidence records actual PR/repository/base/commit and original test/Review
bindings. A completed merge wakes the existing Chief inspection; it does not close
the Task, Project, publish a release or deploy a service.

Validation separates deterministic role/Effect tests, actual selected GitHub
transport and paid-model semantic review. App transport fixtures are not a live
App installation acceptance. Contributor PRs to FlyBot itself still follow their
own authorized branch/review/CI gates; this runtime capability grants no permission
to merge arbitrary repository PRs.

Provider API references: [GraphQL pull request operations](https://docs.github.com/en/graphql/reference/pulls),
[merge queues](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue).

Opt-in real transport verification (writes and removes unique test branches only
in the authenticated user's own repository; leaves the merged test PR as evidence):

```sh
node dev/demo/github-merge.mjs --repository USER/OWN_FORK --gh-config-dir /absolute/private/gh-profile --expected-login USER
```

Push the exact source commit to that fork first. This runs a real local content
assertion, publishes a Draft through the production broker, verifies a pending
host-generated status prevents merge, marks that status successful, observes the
actual remote merge commit and verifies target content. The status is explicitly
host fixture evidence, not GitHub Actions or an independent Reviewer. App/queue
fixtures remain separate from live installation and paid-provider acceptance.
