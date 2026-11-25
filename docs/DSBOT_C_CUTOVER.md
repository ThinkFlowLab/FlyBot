# C-page execution cutover

Members, team, messenger and discover pages, including their static assets, are
served by the signed-in account's DS-Bot. The edge and browser shim route C APIs
to that same instance. Bot Social retains shared state and enforces membership;
the runtime retains its own connector token. No central inference fallback.

## Membership migration boundary (not performed by the page cutover)

A platform workspace UUID is NOT proof of ownership. Before these changes a
page GET could call `teams/ensure` and make the first caller the social owner.
This is no longer allowed. Likewise a connector cannot self-claim another
platform user UUID. Native social teams without platform workspace IDs remain
available. Existing mappings must be audited against authoritative platform
state; their prior existence alone is not proof of correct ownership.

Missing workspace mappings return `409 membership_migration_required`, never an
empty substitute team. Legacy workspace/member/conversation data is retained;
no GET creates a team, adds a member, or sends an invitation.

The trusted, idempotent migration is `python -m flybot_workspace.social_membership_migrate`.
It takes a consistent platform snapshot and manager-attested identities:

* platform account UUID -> that account's isolated runtime -> the Social
  owner/home already provisioned on that runtime, probed through manager
  control (`social/identity`). Display names, the first visitor, and a
  pre-existing Social mapping are not authority;
* workspace UUID -> actual platform owner and every membership, role,
  suspension and timestamp; hard-deleted workspaces are absent. Conflicting
  existing Social mappings are refused, never overwritten;
* conversation participants, agents, messages, edits, read cursors and IDs
  are inserted with their recorded ids/sequences/timestamps via
  `ot_legacy_ids`. History is never replayed as new sends;
* invite rows copy the original `token_hash` as `code_hash` and keep
  revoked/frozen/expiry/use counts. Pending or revoked invites do not become
  active membership. Approved join requests cannot create a member who is
  missing from the snapshot;
* receipts are keyed by a canonical SHA-256 digest of `{accounts,workspaces}`.
  The same digest is idempotent; a conflict rolls back the Social transaction.

`GET/POST /v1/workspaces` and `POST /v1/teams` are served by the user's DS-Bot
from Bot Social (`/v1/ot/workspaces`): creating a workspace creates its Social
team with a server-generated `workspace_id`. Unmapped or conflicting workspaces stay
`409 membership_migration_required` or `membership_migration_conflict`.

### Operator procedure (after this SHA is deployed)

Do not generate or rotate KMS / Social volume keys, and do not wipe
`/var/lib/flybot-workspace/bot-social`. Create a migrate key file on the host
(mode 0600, 32+ characters). Mount it into Bot Social only:

  FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE=/run/secrets/flybot-workspace-social-migrate.key

See `deploy/isolated/bot-social.compose.yml` for the commented volume. Recreate
only `bot-social` after mounting. The route is disabled (503) until that file
is present; the process never auto-generates a key.

Every account that a workspace references must already have a healthy running
runtime whose `social/identity` returns `social_owner_id` and `home_id`. Then,
from the management process that owns `/data` (inside `web`,
`--data-dir /data`):

  python -m flybot_workspace.social_membership_migrate plan --data-dir /data
  python -m flybot_workspace.social_membership_migrate apply --data-dir /data \
    --social-url http://bot-social:8787 \
    --key-file /run/secrets/flybot-workspace-social-migrate.key

Use `--workspace <id>` to apply one fixture workspace first. Use
`--identities-file` only for attestations previously collected through
manager control; do not build it from usernames. From the host the Social
loopback is `http://127.0.0.1:18783`. Re-running apply with the same digest
is a no-op. Inspect `blocked`, `conflicts` and `unresolved` before any
broader apply. Missing or conflicting state stays 409; this command never
creates a substitute team.

Proof must use fixture / test accounts only. Do not invite, message, or
publish as birfied or to real people. After a successful fixture apply,
two DS-Bots should see the same members, roles and preserved history;
an outsider stays 404; a revoked invite cannot be accepted; a still-valid
preserved token hash still works; a leftover central group claim remains
`409 moved_to_dsbot`; any unmapped workspace remains
`409 membership_migration_required`.

## Execution fence

For workspaces whose owner has a published healthy DS-Bot, Flask group-reply
requests cannot enqueue another infer. Old central group tasks cannot be polled,
claimed or obtain model access, and reconciliation cannot publish duplicate
replies. Rows remain for audit; in-flight old runtimes must be stopped/recreated
at deployment before testing the new inbox. Native group agents use the per-user
Social inbox and DS-Bot chatTurn, not platform runtime_tasks.
All legacy messenger subroutes (pin, reactions, edit/retract, delete, save,
forward, group agents, manual agent replies) are served by `messenger/v1` on
the DS-Bot. The platform's central group-reply, task queue and scheduler code
has been deleted; old clients get `410 moved_to_dsbot`.

## Deploy and proof

Rebuild web, runtime AND independent Bot Social images; regenerate the edge
configuration and recreate edge/manager after a web restart (shared network
namespace). Preserve all volumes, existing local/transport keys and tokens.
Do not target old FlyBot services. Do not claim completion based on page HTTP200.

Use only fixture accounts/teams. Verify C HTML/assets have the current account's
instance marker; direct /v1 and browser-shim calls go to that same DS-Bot. Missing
mappings must fail409 without writes. After a trusted fixture mapping, prove role
and suspension enforcement with two runtimes plus an outsider: list members,
create/test/revoke fixture invitations, DM/group roundtrip, scoped history and
read state, native agent reply once, repeated polling without central task rows,
and rejected old claim/model-access calls. Test discover query/pagination and
fixture-only publication. Prove unauthenticated Location is relative /register/
(no http or :8081), and verify no DSH cookies/tokens leak. No real-user messages,
invitations or publication are authorized by this cutover.
