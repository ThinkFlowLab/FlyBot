# LESSONS.md

Dated, short lessons from real FlyBot work. Agents read this **before coding**. Humans promote durable rules into [docs/code-standards.md](docs/code-standards.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## How to read and write

1. **Before a change:** skim every open lesson below. Treat them as hard constraints until promoted or retired.
2. **When something bites again:** add or bump a lesson the same day. Date it (`YYYY-MM-DD`). Keep the body to a few lines: trigger → wrong move → right move.
3. **Seen N×:** each recurrence increments `Seen`. First write-up is `Seen 1×`.
4. **Promote after ≥3 days:** if a lesson is still true and has been seen (or stayed relevant) for **at least three calendar days**, move the durable rule into `docs/code-standards.md` (and a one-line pointer in CONTRIBUTING if humans need it). Leave a short “Promoted → …” stub here, or delete the lesson once the standard covers it.
5. **Do not** paste proprietary process text from other products. Write FlyBot-specific facts only.
6. **Security lessons stay hot:** fence / display-name / claim-honesty themes stay in LESSONS until the matching tests and standards land, even after promote.

## Open lessons

### 2026-10-14 — Untrusted fence escape and remote display names

- **Seen:** 1× (from PR #2 review → issue #9)
- **Trigger:** Remote message or file body, or a peer display name / handle, reaches model-visible text.
- **Wrong:** One-shot `replaceAll('</untrusted-…>', '')`; put peer-controlled names in trusted headers outside the fence.
- **Right:** Neutralize markers until stable (or escape `<` / reject `untrusted-` fragments); share one helper with the client parser. Sanitize remote strings (strip controls/newlines, cap length); fence where possible. Negative tests required (see #9 acceptance).
- **Promote path:** After ≥3 days and green tests → harden as a rule in [docs/code-standards.md](docs/code-standards.md#security-fences-and-remote-strings).

### 2026-10-14 — Claim honesty (Verifier)

- **Seen:** 1× (PR #2 review / agent claim patterns)
- **Trigger:** Agent or PR claims “fixed”, “tested”, “secure”, or “ready to merge”.
- **Wrong:** Imply full validation when only part of the suite ran; omit tip SHA; treat author narrative as evidence.
- **Right:** Name the tip SHA. List commands run and their results. List **not run** explicitly. PASS only when OpenCode and Codex agree on that tip. No “faster/safer” without a new Verifier PASS.
- **Promote path:** After ≥3 days → [docs/code-standards.md](docs/code-standards.md#verifier-honesty).
