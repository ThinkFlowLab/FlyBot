# Decisions

Dated records of decisions the project has actually taken. One decision per file. This directory is
the durable memory of *why* the repository looks the way it does; the rules it applies are in
[docs/governance.md](../docs/governance.md), and the operating contract stays in
[AGENTS.md](../AGENTS.md).

The rest of the repository records what the code does. Only this directory records what was decided,
by whom, on what evidence, against what objection.

## When a record is required

- **Always** for a decision [docs/governance.md](../docs/governance.md) classes **major** or
  **severe**: scope or stage changes, roadmap and architecture changes, changes to a governing
  document, and anything the owner reserved.
- **When the answer would otherwise be lost** for an ordinary decision: a behaviour a future reader
  would call a bug, a rejected approach that will be proposed again, a rule that only exists because
  something went wrong once.
- **Never** for a routine action whose outcome is already visible: a merged pull request, a release,
  a triage label. Those are their own record.

## File name

`YYYY-MM-DD-<short-slug>.md`, with the date the decision was **concluded** (not the date work
started), for example `2026-10-29-stage-1-approved.md`. One decision per file. Two decisions on one
day get two files with different slugs — append to a file only with a new dated line, never by
rewriting the conclusion.

## Required fields

Every record carries these, in this order, so a reader can stop at the one they need:

| Field | Content |
| --- | --- |
| **Date** | The date the decision was concluded, and its time zone when the hour matters |
| **Decision** | One paragraph in the imperative or the past tense: what was decided, stated so it can be acted on |
| **Class** | `ordinary`, `major` or `severe`, as [docs/governance.md](../docs/governance.md) defines them |
| **Evidence** | Links and facts the decision rests on — the issue, the comments, the run, the measurement. No adjective without a source |
| **Participants** | Who took part, in which role, and who concluded it. Silence is not participation |
| **Dissent** | Objections raised, verbatim and attributed. `none recorded` is a real answer and the honest one when nobody objected |
| **Status** | `proposed`, `accepted`, `rejected`, `superseded by <file>` or `withdrawn` |
| **Links** | The issues, pull requests and tasks the decision produced, and the earlier records it relies on or replaces |

A short `Consequences` or `Open questions` section may follow when the decision leaves work behind;
keep it to what a reader must act on.

## Rules

1. **Write it once, at the conclusion.** A record written before the decision is a proposal, and
   proposals live on their issue.
2. **Not a summary of the discussion.** The record states the decision, the evidence it rests on and
   the dissent; the thread keeps the argument.
3. **Corrections are new text.** A later decision supersedes an earlier one with a new file and
   `Status: superseded by …`. Nobody edits another writer's conclusion to change what it said; a
   factual correction is a new dated line with its `Written-by:`.
4. **A record never overrides the gates.** A decision to change code still travels through
   `tests-ok`, the tier and the merge queue exactly as [AGENTS.md](../AGENTS.md) requires.
5. **`Written-by:` names the author.** Every state-changing write says who wrote it
   ([AGENTS.md](../AGENTS.md#every-state-changing-write-says-who-wrote-it-627)); a record's author
   line goes at the end, or under the title, and is never omitted.

## Records

| Date | Decision | Class | Status |
| --- | --- | --- | --- |
| 2026-10-29 | [Stage 1 approved, five-stage direction adopted](2026-10-29-stage-1-approved.md) | major | accepted |
