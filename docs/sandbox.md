# Sandbox and permissions for Bot sessions

Every Bot session runs under a DSH **file policy** (`read-only`, `workspace-write`, `danger-full-access`) and an **approval policy** (`ask` or never, meaning approvals closed). Together they decide what a `bash` call may do and whether it needs a confinement backend on the host. FlyBot does not install or change either; the session does.

## Permission tiers

| File policy | Confinement backend needed | Shell | Writes | Failure mode on a host without a backend |
| --- | --- | --- | --- | --- |
| `read-only` | yes (read-only profile) | runs confined | none | every call refused with `SANDBOX_UNAVAILABLE` |
| `workspace-write` | yes (`bubblewrap` or an enforcing Landlock kernel on Linux; `sandbox-exec` on macOS) | runs confined | the workspace root, a backend temp area, and `/tmp` | every call refused with `SANDBOX_UNAVAILABLE` |
| `danger-full-access` | no backend | runs unconfined | anything the process may write | none — this is the fallback that works without a backend |

Approvals sit on top of the policy:

| Approval policy | Effect |
| --- | --- |
| `ask` (approvals open) | DSH may ask to escalate one call from `workspace-write` to `danger-full-access`; FlyBot shows the card, and a standing approval can answer it for the Bot or the room. |
| never / closed | no escalation: a `workspace-write` call on a host without a backend stays refused. |

The refusal is a structured `SANDBOX_UNAVAILABLE` error, not a command failure: it means the **session** cannot confine commands, not that the command was wrong.

## Preflight

`workspace-write` on a host with no usable backend is a session-level block: the session looks idle while every `bash` call is refused. Run the preflight once at session start, or on the first `SANDBOX_UNAVAILABLE`:

```sh
node .github/scripts/sandbox-preflight.mjs --mode workspace-write   # one line; exit 0 usable, 3 blocked, 4 cannot tell, 2 usage
node .github/scripts/sandbox-preflight.mjs --mode danger-full-access
node .github/scripts/sandbox-preflight.mjs --mode workspace-write --json   # { mode, platform, status, unknown, usable, backends, unlock }
```

The **file policy is a session setting the preflight cannot read back**, so it has to be told which tier to answer for: `--mode <read-only|workspace-write|danger-full-access>` or `FLYBOT_SANDBOX_MODE` (the flag wins). The three answers differ, and only two of the tiers need a backend at all:

| Mode given | Meaning of exit 0 | Exit 3 | Exit 4 |
| --- | --- | --- | --- |
| `danger-full-access` | runs commands; needs no backend, so probes are reported but never decide | — | — |
| `read-only`, `workspace-write` | the probes found a usable backend | no usable backend: every shell call is refused | a backend that would decide cannot be probed here |
| none | a backend was found | — | cannot tell: the policy is unknown |

**Exit 4 is not a block.** It means the preflight could not see the policy (or a probe it needs cannot run here, as with the Windows ACL runner, which reports `unknown` rather than `false`): do not stop shell work on it. A `bash` call refused with `SANDBOX_UNAVAILABLE` is the proof, and only then does the one-line report apply.

On a blocked host it prints one line naming the missing backend and the unlock options, for example:

```text
sandbox-preflight: workspace-write is UNAVAILABLE: no usable sandbox backend (bubblewrap missing or not runnable; Landlock not enabled). Every shell call will be refused with SANDBOX_UNAVAILABLE. Unlock: approve danger-full-access for this turn (or the Bot); install bubblewrap on the host; run a Landlock-enforcing kernel; change the session file policy to danger-full-access.
```

Detection mirrors DSH's local runner chain: Linux probes `bwrap` with the real read-only profile and then checks Landlock in `/sys/kernel/security/lsm`; macOS probes `sandbox-exec`; the Windows ACL runner cannot be probed from inside a Bot shell, so it reports `unknown`, never unavailable, and a Windows session is never called blocked on it.

## What a blocked Bot does

1. Run the preflight once, with `--mode` set to the session's file policy if you know it.
2. On exit 4 (cannot tell) do **not** stop: shell work may well be fine.
3. Report **one** line, `blocked: no usable sandbox backend`, with the unlock it printed, and hand the work to a session or Bot that can run commands, or ask the owner to approve `danger-full-access`.
4. Do not retry shell calls into the same wall, and do not present the block as a failed command. Writing files through the file tools and the GitHub API still works, so code and PR work can continue where it does not need a local shell.

Installing bubblewrap, changing the session policy or approving `danger-full-access` is the owner's decision, not an agent's.
