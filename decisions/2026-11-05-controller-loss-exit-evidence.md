# Reconcile SDK exit after losing the in-memory controller

Date: 2026-11-05. Status: accepted by the Owner's explicit continuation of #2483,
targeting delivery/ai-centric-development-service in this foreground session.

The original release required a process-local controller even after a resource worker
had stopped. Reproduce the failure at7e79762d7 and reuse the original SDK stop/exit
contract with a small resource-side receipt. Bind it to worker/lease/generation and
actual process birth; store outside model-write roots. A settled acknowledgement plus
verified process exit is physical evidence, not code correctness or Task acceptance.
Explicit release can request controlled SIGTERM through a verified pidfd. Background
reconciliation observes only; it chooses no role or escalation. No new coordinator,
timer or Effect kind is introduced.

Existing trusted host stop/exit records can repair historical partial releases. Old
records lacking actual proof remain unknown; no metadata migration fabricates exit.
The selected resource runtime needs the receipt-aware worker for future recovery.
Linux/Python pidfd support is needed for a lost-controller stop request; ordinary
connected-controller behavior and conservative unsupported-platform handling remain.

Unit/integration tests cover actual worker transport and process exit, generation/PID
mismatch, missing acknowledgement and partial release states. Opt-in actual pinned
Codex SDK/CLI tests hold a local fixture provider, disconnect controller pipes and
verify SDK/worker exit on host and isolated Docker. These incur no paid inference and
do not constitute live OpenToday/private App acceptance or deployment.

Verification caught accumulated policy text exceeding its existing budget. Preserve
earlier PROJECT chronology verbatim in history, retain current constraints inline
and keep every mandatory source and the384000-byte cap unchanged.
