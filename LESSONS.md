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

- **Seen:** 2× (from PR #2 review → issue #9; #98 non-face room ingest)
- **Trigger:** Remote message or file body, or a peer display name / handle, reaches model-visible text.
- **Wrong:** One-shot `replaceAll('</untrusted-…>', '')`; put peer-controlled names in trusted headers outside the fence.
- **Right:** Neutralize markers until stable (or escape `<` / reject `untrusted-` fragments); share one helper with the client parser. Sanitize remote strings (strip controls/newlines, cap length); fence where possible. Negative tests required (see #9 acceptance).
- **Promote path:** After ≥3 days and green tests → harden as a rule in [docs/code-standards.md](docs/code-standards.md#security-fences-and-remote-strings).

### 2026-10-15 — Generated gates run after the last edit

- **Seen:** 3× (#94, #99, #177) — all caught on packaging only. Dated 2026-10-15, so ≥3 days: promote the merge-gate rule into docs/code-standards.md.
- **Trigger:** any edit to `core/` after the last `ds-bot-patches generate`, or before a `check-arch-docs` run.
- **Wrong:** trusting an earlier green `check`/`arch-docs`; `check-arch-docs` diffs the base...HEAD and answers "0 changed" on uncommitted work.
- **Right:** final `core/` edit → `npm run build` in `core/` when `src/client/` changed → `node scripts/ds-bot-patches.mjs generate` (repo root) → commit → `ARCH_DOCS_BASE=upstream/main npm run verify`. New files under `core/` land whole in `patches/ds-bot/files/` (no `topics.json` row).
- **Promote path:** after ≥3 days → docs/code-standards.md (merge gate section).

### 2026-10-14 — Claim honesty (Verifier)

- **Seen:** 1× (PR #2 review / agent claim patterns)
- **Trigger:** Agent or PR claims “fixed”, “tested”, “secure”, or “ready to merge”.
- **Wrong:** Imply full validation when only part of the suite ran; omit tip SHA; treat author narrative as evidence.
- **Right:** Name the tip SHA. List commands run and their results. List **not run** explicitly. PASS only when OpenCode and Codex agree on that tip. No “faster/safer” without a new Verifier PASS.
- **Promote path:** After ≥3 days → [docs/code-standards.md](docs/code-standards.md#verifier-honesty).
