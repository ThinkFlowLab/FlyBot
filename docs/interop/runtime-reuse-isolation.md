# Runtime reuse and offline deployment boundary (#198 / #221)

This records the P0 review requested in #198 before enabling an external room
participant. It adds no runtime registration, execution authority or live trial.
The acceptance target is one FlyBot room: DSH + DSH, then DSH + OpenCode, using
the same code fixture, independent checks and explicit human acceptance.

The older `opencode-pilot.md` describes the separate cross-owner Bot Social DM
experiment and its offline harness. Its text-only/no-tools/DM scope does not
define the same-room code trial. Preserve the same-owner friendship constraint
and all cross-owner gates. #218 documents this distinction with a thin DSH room
boundary; #220 supplies a scripted host fixture. Neither is live integration.

## Pinned capability audit

Inspected DSH **0.2.0-rc.2**, source commit
`639ed015397290b3745d163aafe02ffee4aa3f84`, and FlyBot base
`40ddca97fbd76f256c4b7dd04cb9cf2bf9b656f2`. These are source/API observations,
not executions of the providers below. No provider process or model was started.

| Existing capability | Reuse and limit |
| --- | --- |
| Cordis context/service, dependency injection, typed events, `effect` and disposers | Use the existing plugin lifecycle for mounting an adapter and cleaning its owned work. Do not introduce a second service registry, plugin framework or event bus. Context/realm separation does not confine filesystem, network or processes. |
| FlyBot room relay, delivery, membership/authorship and turn budgets | Keep the current scheduler and room transcript. A thin participant operation delegates execution; it does not select who may join/speak or own a new conversation scheduler. |
| `ctx.flybot.bot.send`, middleware priorities, grants, approvals, transports | Preserve the existing authorization and outbound path where applicable. A transport or provider being installed is not an execution grant. Send approval and remote tool approval remain distinct decisions. |
| FlyBot task channel | Keep its authoritative requester, state, question ID and final acceptance. There is no public `ctx.flybot.tasks` service in the inspected types. An external plugin needs a reviewed actor-bound seam; it must not call private `rt.taskEndpoint` or borrow the owner's session token. |
| `ctx.subagents` and provider registry | Reuse the public service when the requested semantics match a provider. Discover a mounted service/provider at runtime, inspect supported start options, and reject missing capabilities. Package installation alone does not establish a mounted capability. |
| In-process spawn/fork providers | Implement `prepareContinuable`; the existing continuation manager owns activation, FIFO inbox, identity, recovery and disposal. Spawn begins fresh; fork can seed parent history. The direct-parent/child authority graph is not room membership, and shared in-process services are not OS isolation. Do not automatically fork private history into a room. |
| ACP provider | Fresh process and `newSession` per one-shot run, final result, managed disposal; no optional start-time capabilities or `prepareContinuable`. Intermediate tool/message traffic is outside the parent conversation; permission prompts use configured reject/allow policy, not a human approval UI. It cannot directly satisfy the room's persistent clarification/permission workflow. |
| Codex / Claude Code providers | One-shot external providers, no optional start-time capabilities and no `prepareContinuable` at this pin. Their native SDK features do not automatically become capabilities of this DSH seam. No room continuation or permission bridge is established by their presence. |
| DSH SDK provider | Separate child runtime, one-shot result/disposal; supports `agentOptions` route overrides, but not `prepareContinuable` at this pin. It is not a drop-in persistent room participant. |
| DSH sandbox policy/provider | Reuse documented confinement where appropriate, but `SandboxMode` describes **filesystem effects only**. Network/process visibility are outside it. `partial` enforcement cannot be reported as `full`; a confined request must never silently fall back to unconfined execution. |

The service checks one-shot flags (`agentOptions`, `outputSchema`, `depthLimit`,
`toolFilter`, `persona`) before dispatch. Continuability is separately indicated
by the provider's optional `prepareContinuable` method; it is not inferred from
those flags. A future room adapter must additionally establish persistent
session addressing, observable intermediate/permission events, cancellation
evidence and restart reconciliation. None is inferred from a final-text API.

The internal extraction in #218 is deliberately smaller than a new provider
system: `open / runTurn / snapshot / cancel` wrap the existing DSH path. Generic
permission decisions, capability negotiation and task-specific bindings remain
future seams. Add only what cannot be expressed through existing services, and
do not modify or depend at runtime on DSH installation internals.

## Selected offline probe backend

Use two disposable Linux Docker containers for the **synthetic offline boundary
probe**, with one pinned Node image digest. This selects a backend for the probe,
not a production DSH/OpenCode deployment. A live trial needs its own pinned
runtime images, credentials, provider egress and lifecycle integration before it
can claim this boundary. No default live backend is enabled by this document.

| Concern | Probe policy |
| --- | --- |
| Bot and runtime identity | Separate Writer/verifier container names; do not derive identity or authority from display text. This probe has no FlyBot Bot/session binding. |
| Writable state | Each container mounts only its own disposable workspace. The other workspace, host-private marker, ordinary DSH/OpenCode homes, repository and Docker socket are not mounted. Root is read-only; `/tmp` is a bounded disposable tmpfs. |
| OS execution | Non-root UID/GID 1000, all capabilities dropped, no-new-privileges, default private PID/IPC namespaces, no privileged or host-network mode. Containers share the host kernel: this is not a VM or a general escape-proof boundary. |
| Network and credentials | `--network none`; the Node probe receives only fresh `PATH`/`TZ`, with no ambient variables. It attempts one documentation-range TCP address and must observe `ENETUNREACH`; timeout is not accepted as proof of denial. No real credentials are used. |
| Resource configuration | 128 MiB RAM, one CPU, 64 PIDs, 16 MiB tmpfs; inspect the actual container configuration. This checks configured limits, not exhaustion enforcement or resistance to resource attacks. |
| Handoff | Only `result.json` is copied from Writer to the verifier after Writer exits. Compare identical bytes and record SHA-256. No private marker, history or worker tests are exported. This is a fixed synthetic artifact, not a generic archive/path importer. |
| Ownership and cleanup | The opt-in runner owns uniquely named containers and a temporary root. On success, failure or handled SIGINT/SIGTERM, remove its containers and files. Cleanup failure fails the run. SIGKILL, daemon failure and machine loss still require operator recovery; never claim confirmed cleanup then. |

The probe's host directories contain synthetic data and allow its non-root
container UID to write. They are not a host multi-user confidentiality boundary.
A live deployment must use owner-restricted host paths and an explicit UID or
user-namespace mapping, rather than copying these test directory permissions.
The host Docker daemon and coordinator remain trusted and can access both sides.

Current FlyBot `workDirOf` prioritizes `room.workDir`, then the Bot's directory;
members can therefore share writable state. Separate Sessions or a room folder
must not be described as per-Bot sandboxing. For a live trial, keep independent
workspaces and runtime state, export only the selected artifact, and run verifier
checks in the verifier's execution boundary. Do not share a mutable checkout.

An online trial cannot reuse `--network none` unchanged. It must define a bounded
provider gateway and allowed destinations, separate runtime credentials, tool
permission enforcement and credential removal before running returned code.
Allowing a model endpoint does not authorize arbitrary network or external sends.

## Reproduce the synthetic probe

Docker must be available at the managed local socket. Pull the image explicitly
first; the probe requires it to be present and accepts a digest, never a tag:

```sh
docker pull node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
node dev/interop/isolation/probe.mjs \
  --image node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  > isolation-report.json
```

The runner pins the local daemon socket and clears remote Docker endpoint/TLS
selectors for its client commands; registry and proxy configuration is retained.
Containers get an explicit clean process environment. It prints a safe structured
report with image/engine/Node versions, observations, selected limits, timestamps,
artifact digest and cleanup result. Failure exits nonzero. It does not read or
print credential files, full Docker configuration or the ambient environment.

This command is opt-in and is **not** part of `npm run verify` or required CI.
The ordinary no-network/no-process interop suite only checks argument validation,
confinement settings and cleanup error paths using injected Docker calls.

## Unfinished gates

No real DSH/OpenCode process was confined or connected by this probe. No claim
is made about human approval UI, task/session isolation, closed-room callbacks,
restarts, cancellation generations, durable budgets, adversarial code/archives,
symlink attacks, kernel/container escape, credential exfiltration under online
policy, memory/CPU exhaustion, parallel workloads or performance. Those need
explicit tests at the actual execution seam. Mock cost remains distinct from
unknown real usage. #198 stays open.

## Audit references

All DSH links below are fixed to the inspected commit, not `main`:

- [Cordis context, injection and lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/cordis-primer.md)
- [Subagent public types](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/subagent/subagent/src/types.ts), [provider/continuation contract](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/subsystems/subagent.md)
- [ACP behavior and limitations](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/subagent/subagent-acp/README.md), [DSH SDK capability flags](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/subagent/subagent-dsh-sdk/src/index.ts)
- [Codex provider](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/subagent/subagent-codex/src/index.ts), [Claude Code provider](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/subagent/subagent-claude-code/src/index.ts)
- [Filesystem sandbox guarantee and enforcement levels](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/subsystems/sandbox.md)
- FlyBot: `core/dev/harness/package.json`, `core/src/host/hooks.js`, `core/types/flybot.d.ts`, `core/src/host/folders.js`, `core/src/host/tasks.js` at the base commit above.
