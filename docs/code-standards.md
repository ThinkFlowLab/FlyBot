# FlyBot code standards (agent acceptance)

Short acceptance rules for agents and maintainers. Hard DSH rules stay in [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). Living bite-sized lessons live in [LESSONS.md](../LESSONS.md); promote from there after ≥3 days.

These are Magpie-*style* process habits adapted for FlyBot. Do not treat them as a license to copy another product’s docs or code.

## Verifier honesty

When you report status on a change:

1. **Tip SHA** — name the exact commit under review (`git rev-parse HEAD`).
2. **Ran** — list each command you personally ran at that tip, and pass/fail.
3. **Not run** — list material checks you did **not** run (smoke, Desktop, real-model steward, etc.). Missing evidence is a gap, not PASS.
4. **No borrowed credit** — author claims and stale CI on another SHA are not your Verifier result.
5. **PASS wording** — say only what the Verifier supports (e.g. “unit + lint green at `abc1234`; smoke not run”).

## Fail without change

- A new regression test (or assertion) must **fail on the unbroken tip** before the fix lands, then pass with the fix.
- Prefer a minimal fixture that shows the class of bug (fence reconstitution, forged header), not a one-off sample that only matches one string.

## Fix the class, not the sample

- If review or a test finds one escape path, fix the shared helper and cover sibling markers (`untrusted-message`, `untrusted-file`, trusted headers).
- Same-class reds tighten LESSONS / this file; do not paper over with a special case.

## Security: fences and remote strings

- Untrusted bodies stay inside fences; closing markers must not reconstitute after a single strip.
- Peer-controlled display names, handles, and file names are sanitized before they appear in model-visible trusted text; prefer fencing them.
- See LESSONS (2026-10-14 fence / display names) and issue #9 until promoted fully.

## Merge only a reviewed tip

- Merge (or ask to open a PR for merge) only when:
  - OpenCode implementation and Codex review both **PASS and agree** on the **same tip SHA**, and
  - Required checks in CONTRIBUTING (`npm test`, client `--check`, `npm run lint`; smoke when host changes) are green or honestly listed as not run with a maintainer waiver.
- Do not merge on a newer unreviewed commit; re-run the Verifier on the new tip.

## Architecture docs and owned paths

- Each subsystem under [docs/subsystems/](subsystems/README.md) declares `owned_paths` in YAML front-matter.
- Changing an owned file without updating that subsystem doc fails `npm run arch-docs` (also run at the end of `npm run lint`). Excuse with a `Docs-not-needed:` trailer in the commit message only when the change truly needs no doc update.
- Reviewers: FAIL if an owned-path change ships without a subsystem doc update **and** without a `Docs-not-needed:` trailer. Load the latest `origin/main` rules before each review (`git fetch` + `git show origin/main:.claude/skills/review-pr/SKILL.md` or the equivalent), not a stale local copy.

## Team authority contract (planned)

- The human ↔ Chief ↔ specialist ownership contract lives in [docs/subsystems/team.md](subsystems/team.md). It is a **planned** contract: multi-human is not shipped, and **team mode stays disabled** until that page's authorization gates pass.
- Issue #16 is **resolved (Option B)**: a tree Bot (not only Main/root) may call `create_child_bot` under itself, within `maxChildren` and depth limits. A newly created child is not auto-granted; sharing still needs an independent per-Bot grant. See [AGENTS.md](../AGENTS.md) and [docs/subsystems/tree.md](subsystems/tree.md). Do not re-open Main-only child creation.

## Tiny loops

- One issue (or one tightly coupled pair) per worktree / session.
- Prefer serial security bugs (#9 → #10 → #8) before large feature umbrellas.
- After PASS+agree, stop or take the next issue; do not pile unrelated diffs.
