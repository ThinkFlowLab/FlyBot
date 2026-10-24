# Release runbook: the release pull request merges upstream, and the tag follows it

Every version is one pull request on `ThinkFlowLab/FlyBot`, opened from a branch on the current
`main`, and it lands the way every other pull request lands: through the merge queue. The tag goes on
that pull request's **merge commit**, and pushing the tag starts the `Release` workflow there, which
publishes the release and its four assets. Nothing is published from the fork, and nothing requires
the protection on `main` to be switched off for a moment: there is no window in this flow.

This page is the sequence, written down so a run does not depend on the Bot that ran it last.
`#1004` (v0.2.6, 2026-10-24) is the worked example of all of it: a release PR opened upstream, merged
through the queue, tagged on its merge commit.

**The token.** Every command below reads `$TOKEN`, opened once as:

```sh
export TOKEN=${DSH_SECRET_GITHUB_TOKEN:-$GITHUB_TOKEN}
```

On a Bot box `GITHUB_TOKEN` is unset and the secret is `DSH_SECRET_GITHUB_TOKEN`; a `Bearer
$GITHUB_TOKEN` there sends an empty string and every read answers 401. Whichever variable answers has
to carry write access to **contents and pull requests on `ThinkFlowLab/FlyBot`** — that is what
creates the branch, the pull request and the tag. The ruleset is never touched, so no admin scope is
needed.

**The tools.** This box has `node` and no `curl` and no `jq` (`command -v curl jq` is empty), and
`git push` to `github.com:443` dies with `GnuTLS recv error (-110)`. So the branch, the pull request
and the tag are written through `api.github.com` with `node --input-type=module -e` snippets, not
`git` and not `curl`: copy-paste has to work on the machine the runbook is for. `gh` may not be
installed, or may die on a certificate it does not know; where a command below names `gh`, the API
call beside it is the same request.

## The six steps, in this order

1. Cut the version on a branch from the current `main`: `CHANGELOG.md`, `core/package.json`,
   `core/package-lock.json`, the version patch under `patches/ds-bot/`, and the `changelog.d/`
   fragments that went into the section, deleted. Push the branch through the API and open the pull
   request **upstream** with its `Owner:` / `Reviewer:` lines and a `Fixes #<n>` line.
2. A Reviewer reads the tip and writes one conclusion, `Verdict: PASS at <tip>`. The mechanical
   release exception (below) covers the approval, but not this line: `enqueue-guard` refuses a head
   with no `Verdict:` naming it.
3. **Release enqueues its own pull request.** `node .github/scripts/enqueue-guard.mjs --pr <n>`
   re-reads the live head and prints the command, already pinned to the tip it read:
   `gh pr merge --auto --squash --match-head-commit <tip>`. Where `gh` is not usable, the queue is
   entered through the GraphQL `enqueuePullRequest` mutation pinned to the same tip — the call
   `#1004`, `#1009`, `#1010` and `#1011` all went in through, each read back as `state: QUEUED`; the
   snippet is [below](#the-enqueue-call-without-gh). `main` requires the merge queue, so a merge
   requested by hand does not land the pull request — do not retry it, and do not push a ref to
   `main` (the ruleset refuses that too).
4. Read back that it entered: `isInMergeQueue` on the pull request, and a `merge_group` run on the
   entry. Three checks are required on the entry — `ubuntu-latest · Node 24 · DSH 0.2.0-rc.2`,
   `tests-ok` and `merge-gate` — and `enqueue-guard` runs there too, though it is not on the
   required list.
5. When it merges, read the **merge commit** `C` from the pull request (`merge_commit_sha`). The tag
   goes on `C`, never on the tip.
6. Tag `C` and let the workflow publish:

```sh
export TOKEN=${DSH_SECRET_GITHUB_TOKEN:-$GITHUB_TOKEN}
TOKEN="$TOKEN" VERSION=0.2.6 COMMIT="$C" node --input-type=module -e '
const h = { authorization: `Bearer ${process.env.TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json" }
const body = { ref: `refs/tags/v${process.env.VERSION}`, sha: process.env.COMMIT }
const r = await fetch("https://api.github.com/repos/ThinkFlowLab/FlyBot/git/refs", { method: "POST", headers: h, body: JSON.stringify(body) })
console.log("tag ->", r.status, (await r.json().catch(() => ({}))).ref)
if (r.status !== 201) process.exit(1)
'
```

Pushing the tag starts `release.yml` on that commit. It waits for a green `Test` run on the tagged
commit, checks the tag against `core/package.json` (`check-release-version.mjs`), packs the four
assets, and creates the release from the `CHANGELOG.md` section for that version. Read it back before
reporting: the tag's commit is `C`, four assets are attached, `latest` is this version, and
`core/package.json` on `main` carries it.

A tag on a later `main` would publish different bytes under the same version number — the same
version twice, with two answers, which is worse than a missing release. That is why the tag target is
the merge commit of the release pull request and nothing else, and why `check-release-version.mjs`
reads the tag's own commit instead of the branch head: never tag a tip that is not the release commit.

### The enqueue call, without `gh`

```sh
export TOKEN=${DSH_SECRET_GITHUB_TOKEN:-$GITHUB_TOKEN}
TOKEN="$TOKEN" PR=1004 TIP=<tip> node --input-type=module -e '
const call = async (query, variables) => {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const id = await call(
  `query($owner: String!, $name: String!, $n: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $n) { id } }
  }`,
  { owner: "ThinkFlowLab", name: "FlyBot", n: Number(process.env.PR) },
)
const pullRequestId = id.json?.data?.repository?.pullRequest?.id
if (!pullRequestId) { console.error("cannot read the pull request", JSON.stringify(id.json)); process.exit(1) }
const out = await call(
  `mutation($input: EnqueuePullRequestInput!) {
    enqueuePullRequest(input: $input) { mergeQueueEntry { position state } }
  }`,
  { input: { pullRequestId, expectedHeadOid: process.env.TIP } },
)
const entry = out.json?.data?.enqueuePullRequest?.mergeQueueEntry
console.log("enqueue ->", JSON.stringify(entry ?? out.json))
if (!entry) process.exit(1)
'
```

`expectedHeadOid` is the tip the `Verdict:` names, so the entry is built from the commit that was
reviewed. If the head moved after the verdict, stop and take a new one; do not enqueue a commit
nobody read.

## The mechanical release exception, as it works now

The release pull request is mechanical (#1004 is the shape): `CHANGELOG.md`, `core/package.json`,
`core/package-lock.json`, `patches/ds-bot/0007-version-and-tooling.patch`, and the deletion of the
`changelog.d/` fragments that moved into the new section. Nothing else — no source, no docs, no
workflow.

For that shape there is no human approval to wait for: the controller's `risk:T3` is covered by the
standing approval in `AGENTS.md`, and the gate is the same as any other pull request's — every
required check green on the tip plus **one** `Verdict:` naming that tip. **Release enqueues its own
pull request** (step 3), reads the entry back, and after the merge tags the merge commit (step 6)
instead of a tip. If a file outside that list changes, it is not a mechanical release and takes the
ordinary path.

## When the queue kicks the entry, or refuses it

The merge is the failure surface this flow has: the queue builds a `merge_group` entry and can fail a
check there that was green on the tip, in which case the entry is dropped and the pull request stays
open.

1. Read which check failed on the **entry** (`merge_group` run on the queue branch), not on the tip.
   A known timing-flaky test is not a defect of this pull request: `#1004` lost its first entry to
   `core/test/follow-through.test.js` (`settle` reported `condition not reached`), and the same head
   passed after a re-enqueue.
2. Re-enqueue the same head once, and read the entry back. Do not push a new tip to "fix" a queue
   failure the tip does not have — a new tip voids the `Verdict:` and costs a second full review.
3. If the entry is refused instead of failed (`merge-gate` names the reason: an unknown issue
   reference, no `Owner:`/`Reviewer:` lines in the first 20 lines, a missing `agent-pr`, a `hold`, a
   stale conclusion), fix the pull request, not the queue.
4. If the same entry fails twice on a real check, stop and report to the Chief with the run url and
   the failing job — a release that cannot merge is not fixed by a third enqueue.

There is no restore step and no clock: nothing was switched off, so a failed merge leaves `main`
exactly as protected as it was. A ref push to `main` cannot happen any more either — the queue
ruleset requires the merge queue — so a fast-forward is not an operation this flow has. Do not
disable the ruleset to get a release out; the tag step does not need it.

## Reading the two red runs

Pushing the tag starts `release.yml` upstream. Under the billing lock, both the tag run and `main`'s
`Test` are **zero-step, 4-second failures** — that is the lock, not a failed release, and there is
nothing to cancel. Check the steps: a run whose job was never assigned has no steps and no runner
name, which is the lock; a run that failed a step is a release problem. `cancel` acts on runs still
in progress, so it does nothing for either of these. Both stay red until the lock lifts; re-run them
then, and do not delete a release or a tag to make the picture look clean.

## Historical: the fork published before v0.2.5

Until `v0.2.5` a version was published twice: the fork `Birfy/FlyBot` cut it, and upstream was
fast-forwarded to the fork's `main` inside a short ruleset window (one window per version), then
released upstream with the same four assets. That flow needed the protection on `main` switched off
and a read-back proving the restore; `node .github/scripts/upstream-sync.mjs --check` and
`--commits` were its dry run, and `Birfy/FlyBot` was the publishing step rather than an archive.

It is **not** part of publishing today: no step disables a ruleset, no ref push to `main` happens,
and `upstream-sync.mjs` is no longer part of the routine. Nothing in this file instructs a window;
if `upstream-sync.mjs` is still in the tree, it is dead code for whoever removes it, not a step to
run.
