# Workspace invite links (issue #5, slice 1)

Related: [#5](https://github.com/openTeamily/openTeamily/issues/5) (share, invite, approval and freeze — **not completed**), [#7](https://github.com/openTeamily/openTeamily/issues/7), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice lets an owner or admin mint a workspace invite link that an already signed-in account can accept. It is self-written; no FlyBot, Bot Social, DS-Bot or Teamily source was used.

Teamily evidence used here is limited. Pricing for Team plan mentioned joining by email or invite link, and a chat-bar “邀请” entry was visible. **No invite was created or accepted**, and team-wizard steps 2/3 were not opened. The credits-center “邀请码” is a referral/promo flow and is **not** this API. Defaults below (single-use, 7-day expiry, existing accounts only, no mailer) are FlyBot choices. Do not describe this slice as invite-flow parity, and do not treat unit tests as a real two-user collaboration acceptance.

## Routes

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/workspaces/{id}/invites` | `{role}` plus optional `expires_in` (60–2592000 seconds, default 7 days) and `max_uses` (1–50, default 1). Owner or admin. The raw `token` is returned **once**. Session + exact Origin + CSRF required |
| GET | `/v1/workspaces/{id}/invites` | Owner or admin. Metadata only; the token is never listed |
| POST | `/v1/workspaces/{id}/invites/{id}/revoke` | `{}`. Owner or admin |
| POST | `/v1/invites/accept` | `{token}`. Signed-in caller joins the workspace at the invite role |

Tokens are 32–128 URL-safe characters. Only `sha256` hashes are stored. Invalid, expired, revoked or exhausted tokens all return `404` `Invite not found`. Admin may only mint `member` invites. Already-a-member accepts with the same role are idempotent (`200`) and do not consume another use. There is no email delivery, no registration-by-invite, and no approval queue in this slice.

Default cap is 20 active (unrevoked, unexpired) invites per workspace.

## Also in this slice

`POST /v1/workspaces/{id}/members` no longer returns a distinct `User not found` message for an unknown username. It uses `404` `Member could not be added`, so an owner/admin cannot tell from the message whether the username is unregistered.

## Not in this slice

A same-origin page at `/members` can mint, list, revoke and accept these links. The raw token is shown once in the page and is never listed afterwards. No share-to-chat flow, no approval/freeze semantics, no mailer, no credits/referral codes. Browser acceptance is not claimed.
