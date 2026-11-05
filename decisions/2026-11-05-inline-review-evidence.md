# Deliver sealed host logs directly to SDK Reviewer

## Date
2026-11-05 (Asia/Shanghai).

## Decision
Implement #2519 using its accepted inline-evidence alternative. Pass the complete
current UTF-8 host-test log in reviewEvidence, within the existing2MiB artifact cap
and configured execution context preflight. Preserve candidate/hash/current rights
checks and keep durable worker metadata free of copied content. Do not add sandbox
grants, a retrieval framework, fixed workflow or deployment.

## Class
Major documentation record for the Owner-required memory/architecture update;
existing authority, context limits and delivery gates remain unchanged.

## Evidence
Owner explicitly requested “2519开发”. Issue #2519 permits readable scratch or
sealed inline evidence; its current workaround manually embeds the log. The current
source provides only path/provenance, so the alternate channel is missing. A real
isolated SDK/CLI hidden-scratch probe passed, which does not reproduce or disprove
the reported onsite denial. The implementation addresses the missing channel.

## Participants
The fork Owner authorizes the issue in the working conversation. Codex implements
and records the narrow alternative; no independent Review PASS is claimed.

## Dissent
No new Owner objection. Keep Agent autonomy and maintenance cost constraints:
reuse the current execution input and evidence checks, without another mechanism.

## Status
Accepted for source delivery to delivery/ai-centric-development-service. Tests and
actual SDK fixture transport are separate from live model/instance acceptance.

## Links
- https://github.com/ThinkFlowLab/FlyBot/issues/2519
- [Harness architecture](../docs/subsystems/project-harness.md)

Written-by: Codex
