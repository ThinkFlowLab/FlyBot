# Historical upstream Project inventory

Preserved verbatim from the explicitly historical portion of PROJECT.md. Current fork authorization and implementation status remain in active memory. Automation boundaries remain active in PROJECT.md without alteration.

## Mission

FlyBot is a local team of long-lived AI Bots that runs on DeepSeek Harness (DSH), in your own
browser, with your own model keys. One person talks to one Bot — the **Chief** — and the team takes
the request apart and comes back with one answer. The Bots keep their own memory, working folder,
model and schedules between turns, so work outlives a single chat.

The project's mission is to keep that team reliable and inspectable: every Bot acts on evidence,
stays inside its goal, and its result can be checked by a person afterwards. The product is the app
in this repository plus the patches that pin it to upstream `ds-bot`; it is not a hosting service.

`AGENTS.md` states the two halves the code is built from: pristine upstream `ds-bot/` (never edited),
and `core/` — `ds-bot/` plus FlyBot's ordered patches — which is what ships and what the tests run.
The shipped features are the DSH plugin in `core/` and the peer plugins `plugins/social`,
`plugins/tree`, `plugins/timeline` and `plugins/workflow`.

## Owner and maintainer roles

Today the project has one owner and a small number of human maintainers; the Bots work under the
owner's delegation. This is the state of the repository as of 2026-10-29, not the target model of
[#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550).

| Role | Who | Decides |
| --- | --- | --- |
| **Owner** | Danyang, GitHub [`Birfy`](https://github.com/Birfy) (repository admin) | Mission, governance policy, roles and membership, project Bots, compute and resources, budgets, autonomy boundaries, and every matter reserved to the owner in [docs/governance.md](docs/governance.md) |
| **Maintainer** (human) | People with repository write access — today the owner and [`hsliuustc0106`](https://github.com/hsliuustc0106) | Major decisions under [docs/governance.md](docs/governance.md): roadmap and architecture changes, changes to the governing documents, multi-subsystem contracts. Records a verdict through the review policy, never through an admin merge |
| **Chief** (AI) | The owner's Main Bot, writing as `Birfy` | Plans and routes work, splits a request into role tasks, **classifies** each decision as ordinary / major / severe with its rationale, convenes a discussion when one is needed, and escalates to the owner. Not the ultimate authority and not the owner |
| **Routine Bots** (AI) | `Triage`, `Dev`, `Dev2`–`Dev4`, `Reviewer`, `Reviewer2`, `Release`, `SelfTest`, `Docs`, `Maintainer` — the names in [`writers`](.github/agent/review-policy.json) | Only their routine's job: see [Routines](AGENTS.md#routines). A Bot records a conclusion only where its routine owns that conclusion, and the implementer never writes the verdict on its own change |
| **Contributors** (human) | Anyone who opens an issue or a pull request | Proposals, bug reports, code. No default approval right; a contribution merges only through the gates in [AGENTS.md](AGENTS.md) |

Deliberately **not** claimed here, because it is not shipped: a Maintainer console, a Member role, a
Project Assistant, per-person GitHub attribution for Bots, and the multi-human authority contract in
[docs/subsystems/team.md](docs/subsystems/team.md) (planned; team mode stays disabled until its
authorization gates pass). Every Bot still writes as the one shared `Birfy` identity, so a
`Written-by:` line is a claim the gates can check for presence and name, not a signature.

## Resources covered

- **This repository** — `https://github.com/ThinkFlowLab/FlyBot`, the source of record. `main` is
  the live branch; pull requests merge into it only through the merge queue.
- **Code** — `core/` (shipped plugin, source of truth), `patches/ds-bot/` and `core/client.js`
  (generated from `core/`), `plugins/*` (peer plugins), `scripts/` and `core/scripts/`.
- **Rules and knowledge** — `AGENTS.md` (operating contract), `CONTRIBUTING.md`, `LESSONS.md`
  (observed failures and promotion to standards), `docs/` (architecture, standards, runbooks),
  `decisions/` (dated decisions), `PROJECT.md` and `ROADMAP.md` (this page and the plan).
- **Automation** — `.github/workflows/` and `.github/scripts/` (CI, risk tier, review gate, merge
  gate, enqueue guard), `.github/agent/` (risk rules and the review policy).
- **Authoritative runtime state elsewhere** — GitHub issues, pull requests and CI runs are the
  authority for work state; task boards, approvals and per-Bot memory live in FlyBot's own storage,
  never in this repository. `docs/` pages are informative only where a source above decides
  something.
- **Not in this repository** — the upstream `ds-bot` project (pinned in `ds-bot.pin.json`, read-only
  here) and the self-hosted Bot Social server used by the social plugin. The fork
  `Birfy/FlyBot` is an archive: nothing merges into it.

End of preserved historical inventory. Active governing and automation boundaries remain in PROJECT.md.
