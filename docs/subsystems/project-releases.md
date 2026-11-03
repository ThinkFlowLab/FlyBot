---
subsystem: project-releases
owned_paths:
  - core/src/host/project-releases.js
  - core/src/host/project-release-github.js
  - core/test/project-releases.test.js
  - core/test/project-release-github.test.js
---

# Release Tasks and external proof

Release state is an additive field on the original Attempt, with the existing
transactional Store, command receipts and Effects. It is not another executor or
workflow. Bot output and Chief completion never authorize publication.

## Configuration and operation

The selected Task repository must be associated and operator-provisioned as usual.
Enable `projectRepositories[repository].release = {provider:'github',enabled:true}`
and select its existing `github` credential (`credential:'gh-cli'`, absolute private
`configDir`, expected `login`). No ambient token fallback, new login or credential
copy is introduced. No configuration or external release is enabled by installation.

`release.request` is an Owner/Maintainer command over the normal v1 service:

```json
{"version":"project-development/v1","kind":"command","name":"release.request","projectId":"PROJECT_ID","requestId":"release-1","payload":{"attemptId":"ATTEMPT_ID","mode":"publish","tag":"v1.0.0","sha":"FULL_PINNED_BASE_SHA","name":"Version 1","notes":"Public release notes"}}
```

The Task must already be Chief-admitted, kind=release, and its current Attempt
running. SHA must equal the Attempt's pinned base commit. Mode defaults to `observe`
(read-only adoption of an existing published release); `publish` is an explicit
request to create a real non-draft GitHub release. This operation does not merge a
PR, deploy a service, upload assets or prove build/test quality. Publishing needs
the external repository's actual write permission as well as current Project rights.
Current full watch delegation can exercise the human's existing permissions; safe
agents and the Project Chief cannot mint release authorization.

`release.status` is a Project-read query with `{attemptId}`. It returns bounded
status/target/proof and never invokes a model or external publisher. It distinguishes
authorized, submitting, observed, awaiting-artifact, unknown, failed and revoked.
Native compatibility routes are `project-release-request`,
`project-release-reconcile`, and `project-release-status` with the same payloads.

`release.reconcile` is a manager command with `{attemptId}` and a new envelope
requestId. It only observes the existing request; it cannot repeat publication.
Repeated requestIds retain their original command/Effect identities.

## Durability and authority

Authorization pins the target, requirement revision, configuration hash and actual
human/delegation references. The release.execute intent commits with the Attempt
before any external call. Background principal/current rights and association are
rechecked, including after credential resolution and before POST. Request text
cannot select an adapter, host path, endpoint or credential.

Before POST the host commits submissionStarted. Recovery always inspects first;
once submission started, absence or a lost response is unknown and never permission
for a blind second POST. Explicit reconciliation observes the artifact later.
Known provider rejection remains failed. Existing unrelated releases are not
overwritten; observe mode may explicitly adopt an exact matching published target.
Providers retain generic errors, not response secrets or authentication output.

The GitHub adapter checks published release ID/tag and resolves lightweight or
annotated tag objects to an exact commit. It rejects draft/wrong-target evidence,
and publish mode additionally requires its persisted request marker. It refuses
an existing unchecked annotated or mismatched tag before creating a release.
External tag changes are not transactional with GitHub release creation; final
observation catches divergence and never accepts it. Configure repository tag
protections when publication requires stronger external immutability.

## Chief completion

An observed proof is hashed and tied to a committed completed Effect. Chief closure
re-reads the external release, checks exact target/identity, current authority and
requirements, then uses the original non-code completion path. It never falls
through the code-PR gate or declares a release complete from model text alone.
Task closure still checks ordinary handled inputs, acceptance rules and Chief
authority. Requirement/association/permission changes require explicit recovery.

## Validation limits

Regressions exercise real command routing, Store acknowledgements/Effects, current
authority, unknown outcomes, idempotency, reconciliation and Chief artifact gates.
Provider HTTP is mocked; no real release is created by tests. Actual publication,
real-provider role execution, artifact uploads and deployment remain separate
authorized operational acceptance. A unit fixture isolates Chief identity/input
callbacks; the existing dedicated suites retain those authorization checks.

## GitHub App credential adaptation — #2311

Release adapters use the selected App or gh-cli provider and report typed external identity proofs. App logical identity, not short-lived Token or private key path, fences authorized requests; gh-cli policy hashes remain compatible. Authorization retains human/agent and Task/Attempt attribution. See [GitHub providers](project-github-automation.md).
