# Self-test case catalog

The end-to-end probes' ids, what each one is expected to prove, the areas nothing covers today and
the cases still to be written. Ids are stable, so a case that disappears shows up in review.

Two isolated FlyBot instances on the live Bot Social (`@selftesta2.home` / `@selftestb2.home`,
ports 3096/3097), latest `main`, assertions only through the public API, the plugin state and the
instance's own `state.json`. No browser: anything that needs a rendered screen is listed as a gap,
not as covered.

Ids are stable: never renumber. A retired case keeps its id and moves to **Retired** with the
reason and the issue that replaced it, so a shrinking suite is visible in review.

Expected results are user-visible behaviour unless the row says otherwise.

## ST-B — baseline (`node run.mjs`)

| id | checks | expected |
| --- | --- | --- |
| ST-B01 | both instances start | web 3096/3097 and mock 8796/8797 answer |
| ST-B02 | fixed test homes | A `@selftesta2.home`, B `@selftestb2.home`, no new home created |
| ST-B03 | local Chief per home | one main Bot per home, handle matches its home |
| ST-B04 | friend list both sides | A shows B's Chief, B shows A's Chief, one row each |
| ST-B05 | grants both directions | A and B each hold at least one grant |
| ST-B06 | send a line | default policy holds it (card) or auto-sends it, never a silent drop |
| ST-B07 | approve the card | card decision is `approved` |
| ST-B08 | delivery | peer `social/poll` returns `delivered >= 1` |

## ST-I — invite and authorization (`node run.mjs --flow invite-auth`)

| id | checks | expected |
| --- | --- | --- |
| ST-I01 | grant A's Bot to B | B's access list contains A's Bot |
| ST-I02 | grant B's Bot to A | A's access list contains B's Bot |
| ST-I03 | revoke that grant | revoke succeeds |
| ST-I04 | after revoke | grantee's list no longer shows the Bot |
| ST-I05 | after revoke | A cannot reach B's Bot (deny) |
| ST-I06 | one-way sharing | revoking A's grant leaves B's own direction untouched |
| ST-I07 | friendship survives a revoke | friend rows stay on both sides |
| ST-I08 | status matches reality | granted flag agrees with the grant list |
| ST-I09 | send after revoke | denied with a reason |
| ST-I10 | invite again | grant restored |
| ST-I11 | removal for recovery | `remove_friend` succeeds |
| ST-I12 | re-add rebuilds grants | inviter direction has a grant again |
| ST-I13 | after recovery | A reaches B's Bot again |
| ST-I14 | after recovery | friend lists agree |
| ST-I15 | approval still works after recovery | hold → approve → delivered |

## ST-F — friends (`node probe-friends.mjs`)

| id | checks | expected |
| --- | --- | --- |
| ST-F01 | A's friend list | contains B, exactly one row |
| ST-F02 | B's friend list | contains A, exactly one row |
| ST-F03 | row carries a relationship id | present |
| ST-F04 | row carries handle and display name | both present |
| ST-F05 | no duplicate rows | relationship ids unique on both sides |
| ST-F06 | no stray pending requests | incoming/outgoing empty |
| ST-F07 | `friends` API, A side | B's Bot appears once |
| ST-F08 | `friends` API, B side | A's Bot appears once |
| ST-F09 | repeat invite while friends | a fresh invite can still be created |
| ST-F10 | join while already friends | no error, `alreadyHave` |
| ST-F11 | after that join | still one row per side |
| ST-F12 | self-join | refused with an explanation |
| ST-F13 | self in own list | absent |
| ST-F14 | remove a friend | `remove_friend` succeeds (`revoked`) |
| ST-F15 | after removal | both lists empty |
| ST-F16 | send right after removal (settled) | denied, never held-and-lost |
| ST-F17 | invite again | peer join succeeds |
| ST-F18 | after re-add | both lists one row |
| ST-F19 | after re-add | inviter direction has a grant (peer side stays 0 by design) |
| ST-F20 | peer send after re-add | deny when the peer shares nothing, hold/send when it does |

## ST-S — share and revoke a Bot (`node probe-share.mjs`)

| id | checks | expected |
| --- | --- | --- |
| ST-S01 | `list_friends` exposes the peer `bot_id` | a `bot_id` comes back for the friend |
| ST-S02 | share before the test | A's Bot already shared with B |
| ST-S03 | revoke | A's grant list empties |
| ST-S04 | send before the roster refreshes | held or denied, never delivered silently |
| ST-S05 | after revoke | B cannot message A's Bot |
| ST-S06 | share list | contains the friend again |
| ST-S07 | share with the friend `bot_id` | success |
| ST-S08 | share by home (fallback) | success |
| ST-S09 | after share | A's grant list restored |
| ST-S10 | after share | B can message again (not denied) |
| ST-S11 | after share | the line is delivered |
| ST-S12 | revoke → share twice | repeatable, pair left healthy |

## ST-A — approval flow (`node probe-approval.mjs`)

| id | checks | expected |
| --- | --- | --- |
| ST-A01 | default policy | a new line is held, with an approval id |
| ST-A02 | card names the person | `recipientName` is the friend, not a Bot handle |
| ST-A03 | reject the card | decision recorded as rejected |
| ST-A04 | after reject | the card leaves the pending list |
| ST-A05 | after reject | the peer receives nothing |
| ST-A06 | Auto-send on | the line leaves with no card |
| ST-A07 | Auto-send on | the line actually arrives (open bug #737) |
| ST-A08 | Auto-send off again | the hold comes back |
| ST-A09 | send right after `remove_friend` | deny, or a hold whose approval fails visibly |
| ST-A10 | approve that held line | delivered, or the card records `failed` with its error (no silent loss, #666) |
| ST-A11 | after that probe | the friendship is restorable |
| ST-A12 | pending request (when the server makes one) | decline works, nothing stays pending |
| ST-A13 | cleanup | no probe approval left pending on Bot Social |

## ST-C — face-to-face room (`node probe-face.mjs`)

| id | checks | expected |
| --- | --- | --- |
| ST-C01 | 5-digit code | refused with a readable reason |
| ST-C02 | 6-digit code | opens a room |
| ST-C03 | same code | peer joins the same room |
| ST-C04 | 2 members | both listed, 2 owners |
| ST-C05 | room message | accepted |
| ST-C06 | peer transcript | contains that line |
| ST-C07 | temporary second Bot | created in the test home only |
| ST-C08 | same code, second Bot | joins the same room |
| ST-C09 | 3 members / 2 owners | counts agree (says nothing about cross-owner isolation) |
| ST-C10 | three room lines | present in both transcripts |
| ST-C11 | leave | both sides cleaned up |
| ST-C12 | temporary Bot deleted | gone, no residue |

## Gaps (no case exists today)

| id | area | why nothing runs today |
| --- | --- | --- |
| ST-G01 | group chat turns and @ | each test home has one Bot; no multi-Bot group |
| ST-G02 | timeline export and alerts | test profile does not enable `@flybot/timeline` |
| ST-G03 | rendered UI and copy | no browser in the container |
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
