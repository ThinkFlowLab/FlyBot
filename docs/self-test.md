# Self-test case catalog

The end-to-end probes' ids, what each one is expected to prove, the areas nothing covers today and
the cases still to be written. Ids are stable, so a case that disappears shows up in review.

Two isolated FlyBot instances on the live Bot Social (`@selftesta2.home` / `@selftestb2.home`,
ports 3096/3097), latest `main`, assertions only through the public API, the plugin state and the
instance's own `state.json`. The `ST-U` family drives the real client in headless Chromium, so a
rendered screen is covered there instead of being a gap.

Ids are stable: never renumber. A retired case keeps its id and moves to **Retired** with the
reason and the issue that replaced it, so a shrinking suite is visible in review.

Expected results are user-visible behaviour unless the row says otherwise.

The case tables below are generated from [`docs/self-test.json`](self-test.json), which is copied
from the catalog the self-test routine generates in its own workspace: edit the JSON (or import a
fresh catalog with `node scripts/self-test-catalog.mjs --import <path>`), then run
`node scripts/self-test-catalog.mjs --write`. Gaps, Planned and Retired are hand-written and the
check verifies their ids instead of rendering them.

<!-- generated:self-test:begin -->

_97 cases + 9 guards in 7 families, rendered from `docs/self-test.json` (`generatedAt` 2026-10-22T14:34:09.412Z). Do not edit: run `node scripts/self-test-catalog.mjs --write`._

## ST-B — baseline — 8 cases, 0 guards (`node run.mjs`)

| id | kind | checks | expected |
| --- | --- | --- | --- |
| ST-B01 | case | both instances start | web ports 3096/3097 and mock ports 8796/8797 answer |
| ST-B02 | case | fixed test homes | A `@selftesta2.home`, B `@selftestb2.home`, no new home created |
| ST-B03 | case | local Chief per home | one main Bot per home, handle matches its home |
| ST-B04 | case | friend list both sides | A shows B's Chief, B shows A's Chief, one row each |
| ST-B05 | case | grants both directions | A and B each hold at least one grant |
| ST-B06 | case | send a line | default policy holds it (card) or auto-sends it, never a silent drop |
| ST-B07 | case | approve the card | card decision is `approved` |
| ST-B08 | case | delivery | peer `social/poll` returns `delivered >= 1` |

## ST-I — invite and authorization — 15 cases, 2 guards (`node run.mjs --flow invite-auth`)

| id | kind | checks | expected |
| --- | --- | --- | --- |
| ST-I01 | case | grant A's Bot to B | B's access list contains A's Bot |
| ST-I02 | case | grant B's Bot to A | A's access list contains B's Bot |
| ST-I03 | case | revoke that grant | revoke succeeds |
| ST-I04 | case | after revoke | grantee's list no longer shows the Bot |
| ST-I05 | case | after revoke | A cannot reach B's Bot (deny) |
| ST-I06 | case | one-way sharing | revoking A's grant leaves B's own direction untouched |
| ST-I07 | case | friendship survives a revoke | friend rows stay on both sides |
| ST-I08 | case | status matches reality | `granted` flag agrees with the grant list |
| ST-I09 | case | send after revoke | denied with a reason |
| ST-I10 | case | invite again | grant restored |
| ST-I11 | case | removal for recovery | `remove_friend` succeeds |
| ST-I12 | case | re-add rebuilds grants | inviter direction has a grant again |
| ST-I13 | case | after recovery | A reaches B's Bot again |
| ST-I14 | case | after recovery | friend lists agree |
| ST-I15 | case | approval still works after recovery | hold → approve → delivered |
| ST-Ig1 | guard | round guard | the round runs and reports; a case cannot pass on a round that never started |
| ST-Ig2 | guard | process and port cleanup | no probe process or bound port (3096/3097, 8796/8797) is left behind |

## ST-F — friends — 22 cases, 3 guards (`node probe-friends.mjs`)

| id | kind | checks | expected |
| --- | --- | --- | --- |
| ST-F01 | case | A's friend list | contains B, exactly one row |
| ST-F02 | case | B's friend list | contains A, exactly one row |
| ST-F03 | case | row carries a relationship id | present |
| ST-F04 | case | row carries handle and display name | both present |
| ST-F05 | case | no duplicate rows | relationship ids unique on both sides |
| ST-F06 | case | no stray pending requests | incoming/outgoing empty |
| ST-F07 | case | `friends` API, A side | B's Bot appears once |
| ST-F08 | case | `friends` API, B side | A's Bot appears once |
| ST-F09 | case | repeat invite while friends | a fresh invite can still be created |
| ST-F10 | case | join while already friends | no error, `alreadyHave` |
| ST-F11 | case | after that join | still one row per side |
| ST-Fg1 | guard | repeat-join guard | the repeat-join scenario reaches its end; a case above cannot pass on a scenario that never ran |
| ST-F12 | case | self-join | refused with an explanation |
| ST-F13 | case | self in own list | absent |
| ST-Fg2 | guard | self-join guard | the self-join scenario reaches its end; a case above cannot pass on a scenario that never ran |
| ST-F14 | case | remove a friend | `remove_friend` succeeds (`revoked`) |
| ST-F15 | case | after removal | both lists empty |
| ST-F16 | case | send right after removal (settled) | denied, never held-and-lost |
| ST-F17 | case | invite again | peer join succeeds |
| ST-F18 | case | after re-add | both lists one row |
| ST-F19 | case | after re-add | inviter direction has a grant (peer side stays 0 by design) |
| ST-F20 | case | re-invite after the removal | a fresh invite is created for the peer home |
| ST-F21 | case | peer send after re-add | deny when the peer shares nothing, hold or send when it does |
| ST-F22 | case | delivery after re-add | peer `social/poll` reports `delivered >= 1` |
| ST-Fg3 | guard | re-add message guard | the re-add message path runs to delivery; a case above cannot pass on a path that never ran |

## ST-S — share and revoke a Bot — 12 cases, 1 guard (`node probe-share.mjs`)

| id | kind | checks | expected |
| --- | --- | --- | --- |
| ST-S01 | case | `list_friends` exposes the peer `bot_id` | a `bot_id` comes back for the friend |
| ST-S02 | case | share before the test | A's Bot already shared with B |
| ST-S03 | case | revoke | A's grant list empties |
| ST-S04 | case | send before the roster refreshes | held or denied, never delivered silently |
| ST-S05 | case | after revoke | B cannot message A's Bot |
| ST-S06 | case | share list | contains the friend again |
| ST-S07 | case | share with the friend `bot_id` | success |
| ST-S08 | case | share by home (fallback) | success |
| ST-S09 | case | after share | A's grant list restored |
| ST-S10 | case | after share | B can message again (not denied) |
| ST-S11 | case | after share | the line is delivered |
| ST-Sg1 | guard | share-path guard | the share path runs to delivery; a case above cannot pass on a path that never ran |
| ST-S12 | case | revoke then share twice | repeatable, pair left healthy |

## ST-A — approval flow — 15 cases, 2 guards (`node probe-approval.mjs`)

| id | kind | checks | expected |
| --- | --- | --- | --- |
| ST-A01 | case | default policy | a new line is held, with an approval id |
| ST-A02 | case | card names the person | `recipientName` is the friend, not a Bot handle |
| ST-A03 | case | reject the card | decision recorded as rejected |
| ST-A04 | case | after reject | the card leaves the pending list |
| ST-A05 | case | after reject | the peer receives nothing |
| ST-Ag1 | guard | reject-path guard | the reject path runs to its end; a case above cannot pass on a path that never ran |
| ST-A06 | case | auto-send on | the line leaves with no card |
| ST-A07 | case | auto-send on | the line actually arrives (open bug #737) |
| ST-A08 | case | auto-send off again | the hold comes back |
| ST-Ag2 | guard | auto-send guard | the auto-send path runs to delivery; a case above cannot pass on a path that never ran |
| ST-A09 | case | approve the held line | delivered, or the card records `failed` with its error (no silent loss, #666) |
| ST-A10 | case | send right after `remove_friend` | deny, or a hold whose approval fails visibly |
| ST-A11 | case | after that probe | the friendship is restorable |
| ST-A12 | case | `#666` removal window, when the probe throws | the exception is reported as a failure of the probe, never swallowed into a green case |
| ST-A13 | case | a pending invite | declining it works |
| ST-A14 | case | after the decline | nothing stays pending |
| ST-A15 | case | pending-invite branch | the pending-invite branch is exercised end to end |

## ST-C — face-to-face room — 17 cases, 1 guard (`node probe-face.mjs`)

| id | kind | checks | expected |
| --- | --- | --- | --- |
| ST-C01 | case | 5-digit code | refused with a readable reason |
| ST-C02 | case | 6-digit code | opens a room |
| ST-C03 | case | same code | peer joins the same room |
| ST-C04 | case | 2 members | both listed, 2 owners |
| ST-C05 | case | temporary second Bot | created in the test home only |
| ST-C06 | case | same code, second Bot | joins the same room |
| ST-C07 | case | 3 members / 2 owners | counts agree (says nothing about cross-owner isolation) |
| ST-C08 | case | B's transcript | all three room lines are present |
| ST-C09 | case | A's transcript | all three room lines are present |
| ST-C10 | case | temporary Bot after the room started | exists in the test home |
| ST-C11 | case | re-join after the room started | refused with a reason |
| ST-C12 | case | re-join attempt | does not mix into the original room |
| ST-C13 | case | re-join after the room started | allowed, and the member count grows |
| ST-C14 | case | re-join after the room started | success with no member added is reported as a silent-failure candidate, not as a pass |
| ST-C15 | case | re-join observations | every re-join result above is recorded with its reason |
| ST-Cg1 | guard | three-member room guard | the three-member room path runs to the end; a case above cannot pass on a path that never ran |
| ST-C16 | case | A side leaves | A is cleaned up; no member or room is left behind |
| ST-C17 | case | B side leaves | B is cleaned up; no member or room is left behind |

## ST-U — web UI — 8 cases, 0 guards (`node probe-ui.mjs`)

| id | kind | checks | expected |
| --- | --- | --- | --- |
| ST-U01 | case | after login | the chat area renders |
| ST-U02 | case | preview notice | it can be dismissed |
| ST-U03 | case | a sent line | it appears in the chat area |
| ST-U04 | case | a held outbound line | an approval card appears |
| ST-U05 | case | the card | it carries an Approve button |
| ST-U06 | case | after Approve | the card stops waiting |
| ST-U07 | case | a rejected line | it shows the reason and Retry |
| ST-U08 | case | the peer's UI | it renders that line |

<!-- generated:self-test:end -->

## Gaps (no case exists today)

| id | area | why nothing runs today |
| --- | --- | --- |
| ST-G01 | group chat turns and @ | each test home has one Bot; no multi-Bot group |
| ST-G02 | timeline export and alerts | test profile does not enable `@flybot/timeline` |
| ST-G04 | cross-owner isolation | only two homes; a third real owner is needed |
| ST-G05 | attachments | not exercised |
| ST-G06 | long text and DLP boundaries | only the "no 13-digit stamp" rule is known |
| ST-G07 | concurrent Bots and approvals | one Bot per home today |
| ST-G08 | face-join rate-limit recovery | one room per round by design |

## Planned cases (not implemented yet)

Each carries at least one user-visible assertion.

| id | area | planned assertion |
| --- | --- | --- |
| ST-N01 | tree prompt refresh (#720) | the second turn's prompt carries the current tree, not the previous one |
| ST-N02 | re-attach after deleting a former root (#726) | children of the deleted root reappear under the new root in `list_children` |
| ST-N03 | timeline alerts persist (#731) | repeated polls keep the same open alert (`since` unchanged); a cleared alert stays `resolved` for one minute |
| ST-N04 | share card and approval dock (#711/#713) | a failed hold reads Not sent with its error; Approve all covers every Bot Social card |
| ST-N05 | narrow-window panes (#721) | compiled `client.js` carries the min-width rule and `index.js` installs it after the shell CSS |
| ST-N06 | 0.2.1-alpha.1 stats dock (#730) | the pill is drawn on shells whose dock id is `activity` and shows N turns / M steps |
| ST-N07 | attachments | a file reaches the peer and the card names the file |
| ST-N08 | group chat and @ | a group line reaches both members and @ names the right Bot |
| ST-N09 | long text and DLP | a line with a 13-digit stamp is reported as blocked, not silently failed |
| ST-N10 | two Bots, one approval queue | both cards appear, decisions stay per card |

## Retired

Ids are never reused or renumbered. A case or a gap that stops being exercised keeps its id here
with the reason, so a shrinking suite is visible in review.

| id | was | why it is here |
| --- | --- | --- |
| ST-G03 | rendered UI and copy (gap) | closed 2026-10-22: SelfTest installed headless Chromium and the `ST-U` family now covers the rendered UI and its copy, so the gap moved out of Gaps and the id stays retired |
