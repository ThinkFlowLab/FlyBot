# Bind Developer Git mutation capability to its isolated clone

Date: 2026-11-05. Status: accepted for the Owner-authorized staged #2483 repair.

The previous resource-clone dispatch grant depended on GitHub App mode. A non-App
Developer could receive writable source but read-only Git metadata, despite being
asked to stage, commit or switch branch. These are workspace capabilities, separate
from forge identity. Reuse the existing writableRoots SDK seam for the current
isolated Developer clone after binding and resource-side metadata checks. Preserve
shared host Git restrictions and read-only policy roles. No new privilege toggle,
automatic reset, authentication mechanism or fixed role workflow is introduced.

Tests cover actual grants, changed binding/symlink/common-directory refusal and
read-only policy. Opt-in actual pinned SDK/CLI fixtures use fresh profile directories
and a deterministic provider; their success does not establish live OpenToday or
private GitHub integration acceptance. See [Harness](../docs/subsystems/project-harness.md).

The full role-policy budget caught growing roadmap chronology during verification.
Archive earlier checkpoint text verbatim and retain current boundaries inline;
keep all required policy sources and the 384000-byte limit unchanged.
