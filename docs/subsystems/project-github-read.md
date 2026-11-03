---
subsystem: project-github-read
owned_paths:
  - core/src/host/project-github-read.js
  - core/test/project-github-read.test.js
---

# Scoped Project GitHub reads

`project-github-read {projectId,operation,number?,scope?}` supports issues, pulls,
pull details, reviews and checks. The host derives the repository from the current
Project, never a model URL/repository. Lists are bounded to the first 20 entries
and explicitly report incomplete pagination. Details and checks name the full PR
head SHA; summaries include source URLs, read time and executor identity.

Shared reads select only explicitly provisioned Project automation credentials;
explicit personal reads select exactly the current human/Project profile. There
is no ambient or cross-human fallback. The selected login is verified; current
Project/platform authority is checked before external operations and after data
returns. Credentials and raw connection responses are never returned to models.
These are read operations and grant no write/merge/release capability.

Native agents use `project_agent_github`. SDK Chief can request bounded host reads
with `github_read` actions; host-confirmed results are appended separately from the
model narrative. A model action or prose is not evidence that a read or write ran.

S4 adds `thread-events` with a validated issue/pull kind, number and independent
page cursors. It returns comments/edits, submitted Reviews and inline replies,
checks and head/state facts through the same credential and authority broker.
Canonical repository/thread checks and a second PR-head read reject moved inputs;
pending private Review drafts are omitted. Lists rotate20-entry pages and report
their observation limits, including unseen intermediate edits. See
[Source subscriptions](project-sources.md); these facts grant no write or verdict.


Repair R5 (#38): Watch reads validate their current persistent
actor instead of requiring a browser cookie. Personal credential selection remains
exactly human/Project scoped. See [delegation contract](project-delegations.md).

Repair R6 allows bound Chief coordination actors to read current Project facts
through the same scoped repository broker and current authority validation.

S4's scheduled Source adapter uses a host-only background read port, bound by an
unforgeable in-process actor identity to the current Project/principal. It requires
current configure rights and background principal proof before/after reads, retains
delegation/Chief binding checks, and selects only Project automation credentials.
Ordinary JSON flags cannot obtain it; personal reads still require their original
human/watch authority. Browser-cookie expiry does not disable configured polling.
Repository identity is captured by value before asynchronous credential selection,
so a mutable Project cannot retarget an in-flight read to another repository.

## Development service (S1)

The compact task execution status projection now delegates to the shared development TaskView. Its regression fixture carries actual Project/Task/Attempt/active-claim bindings instead of an unscoped worker status stub. See [service contract](project-development-service.md).

## GitHub App credential adaptation — #2311

Project reads use the selected gh-cli/App connection and operation-specific installation permissions, verify current authorization before every request and withhold results after scope changes. Personal reads reject App credentials. Responses include sanitized actual provider identity; see [GitHub providers](project-github-automation.md).
