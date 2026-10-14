---
subsystem: team
owned_paths:
  - docs/subsystems/team.md
---

# team (planned authority contract)

Proposed ownership and authority contract for multi-human FlyBot: **human owner ↔ designated Chief ↔ specialists** (tree children).

> **Status: planned, not shipped.** Multi-human ("team mode") does not exist in FlyBot today. This page is a contract for the remaining team work (#48+), written so role and data-boundary decisions are explicit *before* code. The #47 **schema foundation has landed** in the core store — data records only (see [Schema foundation](#schema-foundation-landed-47)). **Team mode stays DISABLED until the [team mode gate](#team-mode-gate) passes.** No API, tool, config key or env var enables it — do not invent one.

Shipped behavior stays what [core/README.md](../../core/README.md) (roles: You / Main Bot / group admin / member) and [plugins/tree/README.md](../../plugins/tree/README.md) (Chief as tree root) already document.

## Owns

- This page and the authority/ownership contract it states (identity, routing matrix, approval rules, team-mode gate).
- `docs/subsystems/team.md` only.

## Does not own

- Tree shape, root adoption, `maxChildren`/depth limits → [tree](tree.md).
- Core runtime, shipped single-human roles and tools → [ds-bot-core](ds-bot-core.md) (`core/README.md`).
- Plugin runtime surface → [plugin-runtime](plugin-runtime.md).
- The open `create_child_bot` decision itself → issue #16 (this page only records it as open).

## Key concepts

| Term | Meaning | Status |
| --- | --- | --- |
| Human owner | The human of a pilot seat. Today: the single person behind a team (`You` — "Everything" in the core role table). In team mode: one of several humans, each with an **owner scope**. | Owner scope is planned; single human is shipped. |
| Owner scope | Everything one owner is authoritative over: their private rooms, their Bots, their files and memory, and their approvals. | Planned. |
| Designated Chief | The owner's Main Bot — the Bot that holds Main rights in that owner's scope. Defaults to name `Chief` / role `Chief of Staff`, and is adopted as the tree root (`treeRole: 'root'`). | Main Bot + tree root shipped; *designated per owner* planned. |
| Specialist | A non-root tree Bot (child of the Chief or of another specialist). Does the work, reports upward. | Shipped as tree members; owner-scoped rights planned. |
| Team administration | Management of **shared** team surfaces (e.g. group chats, team memory) — a distinct, narrower grant than private owner authority. | Distinction planned. |
| Private owner authority | Rights over one owner's **private** scope. Never implied by team administration. | Planned. |
| Approval | A human owner's consent for an action that spends that owner's authority. | Planned. |
| Team mode | Multi-human operation: several owners in one deployment, cross-owner traffic, per-owner scoping. | **Disabled** (see gate). |

## Schema foundation (landed, #47)

Shipped by the core store (`core/src/host/store.js`, owned by [ds-bot-core](ds-bot-core.md)) as **data records only**. It replaces implicit single-user ownership with explicit stable identities while the product stays single-human:

- The saved team (`state.json`) is **version 2**. `members` holds records with an immutable `id`, `createdAt`, and `designatedChiefId`; every Bot carries an `ownerId` binding.
- Loading a legacy **version-1** team runs one migration: it creates the single initial owner (`owner-1`), binds every existing Bot to it, sets the designated Chief from the **first Main Bot** (the shipped Main role — no name matching, no new Main rules), and writes version 2. Bot ids, Session parts and private histories are preserved. The pre-migration file is backed up once as `state.json.v1` before the first version-2 write; if a backup already exists it counts only when it is a readable file holding a parseable version-1 state — a directory, an empty or truncated file, or anything else there fails the load closed instead of migrating.
- Malformed ownership **fails closed**: a Bot owner that names no member, duplicate or mismatched member ids, or a designated Chief that is not a Bot of its member makes the file read-only — it is never repaired by guessing. An older binary already refuses a newer version read-only, so it cannot overwrite the schema.
- This is **not team mode**: there is no auth, no sign-in, no server-side owner scoping, no cross-owner routing, and no flag/config/env for any of them. The gates below are unchanged and unsatisfied. The schema resolves nothing about `create_child_bot` (#16 stays open) and defines no API, tool, config key or env var.

## Identity model

| Relation | Rule |
| --- | --- |
| Human owner → designated Chief | Exactly **one designated Chief per pilot member** (owner). Several humans never share one Chief, and one human designates one Chief. The shipped product allows more than one Main Bot per team; the pilot contract pins one per owner. |
| Designated Chief → specialists | The Chief is the root of its owner's tree; specialists are its children (or descendants). Specialists inherit their scope only from their Chief's owner. |
| Specialist → owner | A specialist belongs to exactly one owner's tree. There are no ownerless or shared specialists. |
| Authority follows the human | Ownership is an assignment to a person, not to a Bot name. Renaming, replacing or disabling a Bot never transfers authority by itself. |
| Chief ↔ Chief | The only legal cross-owner hop. Each Chief remains accountable to its own owner. |

## Room visibility (planned)

| Room | Who may see it |
| --- | --- |
| Owner's private rooms (their 1:1 chats with their Chief and specialists) | That owner, their designated Chief, their specialists. Everyone else — including another owner's Chief — is outside the scope. |
| Shared rooms (group chats both sides belong to) | Their members under the shipped group rules (member speaks, group admin manages). Team administration manages the shared room only; it never opens another owner's private rooms. |
| Cross-owner exchange | Stays at Chief level (invariant 4): each Chief sees the exchange and reports to its **own** owner; nothing lands in a specialist of the other side, and no shared room is repurposed as a back door. |

Shipped room privacy (a group never reads a Bot's private chat) is unchanged; this table only adds the second human boundary on top of it.

## Invariants

1. **Owner scope is the unit of authority.** A human's rights stop at their own scope. Team administration over shared surfaces never grants another owner's private scope.
2. **One designated Chief per owner.** Specialists carry Chief-derived rights only; a specialist's authority is never its own.
3. **Specialists are owner-private.** No specialist may read or write another owner's rooms, Bots, memory, files or approvals — including "just to look" or "just to relay".
4. **Chief-only cross-owner traffic.** Cross-owner requests terminate at a designated Chief on each side; a Chief never forwards them downward into another owner's specialist as if they were its own owner's request.
5. **No forwarding to owner approval.** No route may turn another human's request into owner approval by forwarding it. An approval is created only by the owner whose authority is spent, for the exact action; receipt, relay, or a Chief's word never becomes approval.
6. **Approval authority stays with the human.** A Chief may ask its own owner, present options, and act on an approval it actually received from that owner. It cannot mint an approval, replay another owner's approval, or treat silence as consent.
7. **Team mode is disabled** until every gate below passes.
8. **#16 is open.** Neither option may be assumed by schema or implementation work (see [Open decisions](#open-decisions-16-unresolved)).
9. **Contract honesty.** Nothing on this page describes shipped behavior; shipped behavior is [core/README.md](../../core/README.md) and [plugins/tree/README.md](../../plugins/tree/README.md).

## Routing matrix

Planned rules for team mode. Default is **deny**: a route is allowed only if a row below allows it.

### Who may route to whom

| Actor | Own Chief | Own specialist (same tree) | Other owner's Chief | Other owner's specialist | Other owner's human | Shared team surfaces |
| --- | --- | --- | --- | --- | --- | --- |
| Human owner | Allowed — directs its Chief | Allowed — directs its specialists | Not directly; goes Chief → Chief | Forbidden | Forbidden | Allowed as team admin (shared only; never another owner's private scope) |
| Designated Chief | — (it is the Chief) | Allowed — delegate, aggregate, report down | Allowed — Chief ↔ Chief only, both sides stay accountable to their own owners | Forbidden | Forbidden — may present to *its own* owner only | Allowed as team admin within shared surfaces only |
| Specialist | Allowed — report upward | Allowed — parent ↔ direct child (existing tree rule) | Forbidden | Forbidden | Forbidden | Speak only where its Chief placed it; no admin rights, no cross-owner relay |

### Worked examples

| # | Scenario | Verdict | Rule |
| --- | --- | --- | --- |
| a | Owner A asks Chief A to split a task and hand parts to Specialist A1 and A2 | **Allowed** — same-owner delegation | Invariants 1–2; owner may route inside its own scope, Chief delegates downward to its own specialists. |
| b | Chief A sends a collaboration request to Chief B; both report back to their own owners | **Allowed** — Chief-to-Chief | Invariant 4; the hop stays Chief-level and each side keeps its own owner's data boundaries. |
| c | Specialist A1 asks to read Owner B's private room (or Owner B's specialist passes it content) | **Forbidden** — cross-owner specialist access | Invariants 3–4; specialists never touch another owner's private data, in either direction. |
| d | Chief A, holding team administration of a shared group, edits Owner B's private Bot settings | **Forbidden** — team admin ≠ private owner authority | Invariant 1; shared-surface admin never extends into another owner's private scope. |
| e | Specialist B forwards "Owner B approved this" to Chief A, which then spends Owner A's authority | **Forbidden** — forwarding cannot escalate | Invariants 5–6; approval only comes from the owner whose authority is spent, for that exact action — a relayed request or forwarded approval is never approval. |
| f | Owner A disables their Chief | Owner scope fails closed | See [Ownership changes](#ownership-changes-disabled--replaced-chiefs); no specialist auto-promotes. |
| g | Owner A's seat is transferred to Owner C | Whole scope moves with the person | Identity model: *authority follows the human*, not the Bot name. |

### Approval authority

| Action class | Who may approve | Chief's part |
| --- | --- | --- |
| Action inside one owner's private scope | That owner, human | Request approval, present options, act only on the approval actually received from its own owner. |
| Action on shared team surfaces | Owner(s) the shared surface belongs to, via team administration | Administers per its grant; never converts that grant into another owner's private approval. |
| Action touching a second owner's scope | Each affected owner, for their own scope only | Chief → Chief may negotiate; neither Chief can approve for the other's owner. |
| Anything forwarded from another human | Nobody, by forwarding alone | Reject the forwarded "approval"; it is a request, not consent. |

## Open decisions (#16, unresolved)

Issue **#16** (who may call `create_child_bot`) is an **OPEN maintainer decision** since the PR #2 review. Both options, recorded without preference:

| Option | Statement |
| --- | --- |
| **A** | Restrict `create_child_bot` to the root/Main/Chief Bots (or require owner approval for each creation). |
| **B** | Amend AGENTS.md so specialists / tree Bots may create children under themselves within owner limits (`maxChildren`, depth limits). |

- Status: **open** — this contract picks neither side.
- Schema and team-mode work (#47+) **must not assume either answer**, and no test may encode one.
- The gate below requires #16 to be *resolved* before team mode can be enabled; resolving it is a maintainer act outside this page.

## Team mode gate

**Team mode remains DISABLED until all authorization gates pass.** There is currently no flag, config key, env var or API that enables it — do not invent one, and do not build a workaround around the gate.

1. **Owner identity enforced server-side** on every management call (create/update/delete Bot, group administration, memory writes) — not prompt-level, not client-side only.
2. **Room/Bot scoping enforced server-side**: a request from outside an owner's scope fails closed, for reads and writes alike.
3. **Approval binding**: an approval names the owner whose authority is spent and the exact action; forwarded or replayed approvals never satisfy it (invariant 5).
4. **#16 resolved** by a maintainer, with a test asserting who may create Bots.
5. **Chief lifecycle fails closed**: a disabled, missing or replaced Chief leaves no path for specialists to reach cross-owner traffic or approvals (next section).

Until every gate passes, team mode is off and the shipped single-human model is the only supported one.

## Ownership changes, disabled / replaced Chiefs

Planned rules (fail closed by default):

- **Ownership change** moves the owner's whole scope — rooms, Bots, memory, open approvals — with the human assignment. Derived authority (the Chief's) moves with it; nothing transfers because of a Bot name.
- **Disabled Chief**: the owner's tree stops at the root. Specialists go inert for cross-owner traffic and approvals; no specialist auto-promotes to Chief, and an ownerless specialist is never a fallback Chief.
- **Replaced Chief**: only the owner designates a replacement. The old Chief's Main rights are removed at handover, the tree re-anchors to the new designated Chief under the tree plugin's existing adoption rules (this contract changes none of them), and approvals issued through the old Chief die with it — the owner must re-grant them.
- **No Chief, no cross-owner**: cross-owner traffic requires a live designated Chief on *both* sides; a gap on either side fails closed rather than degrading to specialist-level routing.

## Common mistakes

- Reading this page as shipped behavior — multi-human is planned; team mode is disabled.
- Reading the version-2 identity schema (`members`, `ownerId`, `designatedChiefId`) as team mode — it is data-record foundation; the gates below are unchanged, and nothing enforces them yet.
- Treating team administration (shared groups, team memory) as private owner authority, or vice versa.
- Letting a specialist "just relay" across owners — relaying is routing, and it is forbidden.
- Treating a forwarded request or forwarded "approval" as owner approval.
- Assuming #16 Option A or Option B has been decided, in schema drafts, code or tests.
- Adding a team-mode flag, config key or env var before the gates pass.
- Rewriting tree ownership here instead of in [tree](tree.md).

## Tests

**Schema foundation (#47)** has store-level tests in `core/test/identity.test.js`: a fresh team and a representative legacy team load, migration idempotence and restart-safety, the `state.json.v1` backup (created once; a directory or a truncated/unusable file in its place fails closed), and malformed-ownership fail-closed cases (unknown owner, duplicate member ids, bad Chief references, version-1 files carrying ownership fields). They assert data records only — no routing, scoping or approvals, and no multi-human behavior.

The routing-matrix rows above remain untested because the behavior is not shipped. When enforcement work starts (#48+), each row becomes a test first, per [fail-without-change](../code-standards.md): same-owner delegation allowed (a), Chief-to-Chief allowed (b), cross-owner specialist denied (c), team-admin vs private-owner denied (d), forwarded approval rejected (e). Each must fail on the unbroken tip before implementation lands.
