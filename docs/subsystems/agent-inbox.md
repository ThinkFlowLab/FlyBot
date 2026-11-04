---
subsystem: agent-inbox
owned_paths:
  - core/src/host/project-agent-inbox.js
  - core/src/host/project-agent-webhook.js
  - core/src/host/project-private-file.js
  - core/test/project-agent-inbox.test.js
  - core/test/project-agent-webhook.test.js
  - core/test/fixtures/agent-webhook-receiver.mjs
  - dev/demo/agent-inbox-model.mjs
  - docs/agent-inbox.md
---

# One private agent inbox protocol (#2308)

The inbox is an application service over original consultation records in
projectAgentTranscripts, existing personal-agent participation and Effects. It
creates neither a second Task/message truth nor an execution controller. Both
native and external agents use the same list/source-page/claim/renew/complete/fail
contract. A message lease is distinct from Task initiative/Handoff acceptance.
The native adapter uses the existing private Bot/Session; the external adapter
sends signed metadata and the peer pulls through its own scoped FBA credential.
Native in-process tools call the same service instead of looping through HTTP.

Each original receipt may hold one versioned inbox processing state. Claim
generation, current independent principal, source version and expiry fence every
result; state transitions require a committed original Effect proof. Failed
uncommitted saves restore only that receipt's state. Effects recovery supplies
proof after reload; unmodified legacy pending Chief questions acquire a notification
reference on recovery without changing IDs/history. Completed legacy replies are
replayable only against an exact original reply. Outgoing Chief answers may be
acknowledged but cannot become Task input. Source pages use UTF-16 offsets and
SHA256 of the complete source string; list metadata is bounded and never copies
private text. Original history stays in its original store, without automatic GC.

Notifications are hints, not read/processing/business acknowledgement. Native
notifications contain an inbox reference only; the model must claim and submit
through project_agent_inbox (legacy consultation.reply shares that service).
Claim/fail/expiry cannot release a worker. An existing native delegation/activity,
unconfirmed native request or unconfirmed SDK worker exit fences another claim.
Safe suggestions await a human; watch publication uses current human/Task rights;
requiresHuman never becomes proxy approval. Only a real Chief decision resolves a
Task. A reply can wake Chief before a collaboration record exists; actual Chief
admission/revision resolves the previous owner wait within the existing durable
Task transition, restoring it if commit fails. Chief's configured inspection
observes exhausted notification/long wait metadata, without private contents.

Webhook settings are operator-provisioned owner/agent/Project bindings. A signed-in
human may select a connection ID and enable it only after a signed key-possession
challenge. Unverified external descriptors are not outbound authority. Private
key files are absolute, regular, current-UID-owned,0600, bounded, opened without
following symlinks, and never exported into Bot/model/test environments. The
connection binding covers configured endpoint/key reference/revision; changed
configuration requires human re-verification. Rotate the key reference/config
revision explicitly. No URL or credential upload is accepted on the public API.

HTTPS targets reject userinfo/query/fragment, redirects and ambient proxies. DNS
addresses are checked and pinned to the selected connection; private ranges need
an explicit operator IP allowlist. Loopback HTTP is an explicit isolated-test/private
configuration exception. Notifications and responses have4096-byte bounds and10s
transport timeout. HMAC-SHA256 covers timestamp + dot + exact raw body. Receivers
verify freshness and persist eventId deduplication; the authenticated message lease
and domain idempotency remain authoritative after receiver restart. Verification
responses prove HMAC over challenge + dot + nonce. No private question, FBA token,
Owner cookie, key or arbitrary user body is sent by the notifier.

Original Effects handles at-least-once delivery, receipt saves, retry budgets and
unknown outcomes. Enabling a verified connection restages the same pending message
notification under a new generation; it does not create a new message. Runtime
connection disable/replacement is rechecked before/after I/O. Mailbox polling
recovers lost notifications. Private notification/inbox Effects are filtered by
independent agent identity and excluded from shared TaskView effects/public SSE.
leaseMs/attentionMs and per-kind projectEffectRetry are configuration, using the
existing scheduler/Chief scheduled inspection; there is no new business timer.

## Evidence

Shared unit contracts cover both adapters, claims/renewals/results, concurrent
credentials, old generations, save failure, timeout/revocation, unknown native
exit, connection authorization/verification, private metadata and supersession.
Webhook tests verify actual HMAC and a separate receiver process over TCP.
The production-entry HTTP test drives real native DSH Chief/personal Sessions and
a separate FBA receiver process through notification → claim → scoped reply →
original Task input → Chief read/handled acknowledgement and admission, across
restart. The inference driver is explicitly deterministic; it is not live
grok-bot/dots vendor certification, paid-model acceptance or a production rollout.

Written-by: Codex

#2342 fences new incoming consultations by Task/requirements/Attempt/candidate and
operations contact/role. Chief can remind the same current message through the
original Effect after delivery finishes/fails; active claims/native execution and
pending notifications are retained. No reminder repeats the operational repair.
The disposable DSH probe uses the original restricted gateway and an independent
signed receiver, including503, restart and duplicate notification. See
[assistance](../chief-assistance.md).
