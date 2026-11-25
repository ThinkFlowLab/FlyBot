# Comprehensive UI repair: evidence, changes and unverified states

Related #14 #1 #4 #6 #8 #9 #10 #12 #86 #87 #88 #89 #90 #130 #157.

This is the distinct UI PR after the consolidated functional PR #214. Its UI-only commit is based
on functional head `b6d43c15b2355be275cfb8bad15a984a94738274`; that dependency must reach main first.
No backend route, storage, authorization, model call, reply protocol or external account is changed.
The goal is an evidence-led Operate interface, not another visual concept or a parity declaration.

## Visual authority and limits

Only the previously captured read-only Teamily screenshots and the 2026-11-18 Assessment A notes
were used. They remain private on the box; no screenshot pixels, private account text, proprietary
icons, logos, fonts or prompts enter this repository. Icons here are original geometric SVG paths.
FlyBot branding remains. Credits/plans/usage/rewards are not brought back.

The shared spatial thesis is: narrow icon rail → compact task directory → primary canvas. The
canvas, not a disclaimer card, gets most space. Adjacent controls share alignment; secondary
information is smaller but still legible. Original details/unsupported capabilities remain labeled.
A 0.5rem base interval, a 3.5rem rail and an 18rem chat list keep density consistent. Light/dark
preferences remain the existing account preference, not a new forced theme. Green/neutral tokens
are original authored values; they are not claimed to be measured Teamily colors.

## Page-by-page evidence and implementation

Paths below identify private capture filenames, not files copied into this repository.

| Page | Existing evidence | Changed in this UI PR | Limits / not claimed |
|---|---|---|---|
| Shared shell/navigation | `2026-11-17-recapture-pm/chat-list.png`, `discover-agents.png`; `2026-11-17-recapture/artifacts-all.png` | Narrow, quiet icon rail; named accessible links; inset content canvas; consistent light/dark tokens, focus and hover/expanded contrast; bounded account menus and small-screen login forms | No new navigation destinations or account permissions. Menu text stays visible; icons are not proprietary brand assets |
| Chat list/header/composer | `2026-11-17-recapture-pm/chat-list.png`, `chat-new-menu.png`; Assessment A S5 | Denser rows; real existing pins/direct/group sections; Hong Kong calendar-relative timestamps with full timestamp title; light header; named SVG action/tool icons; attachment picker in bottom toolbar with workspace-visibility warning; quiet composer; disabled tools still disabled | Message bubbles, new action states and mobile behavior are original adaptations. Explicit Send remains for keyboard/touch accessibility rather than copying an absent button. No fake avatar/status/verified badge, typing, call or invitation completion |
| Chat search | `2026-11-17-recapture-pm/chat-search.png`; Assessment A S8 | Styles the existing separate conversation search panel and its result/pagination hierarchy without changing API scope; keeps original sidebar action available | Exact Teamily independent-panel empty/result states need new read-only evidence; no matched-state acceptance |
| Discover works | `2026-11-17-recapture-pm/discover.png` | Compact category strip; four-column desktop hierarchy with responsive two/one-column flow; real listed image covers from the existing revocable public bytes route; actual author/count/actions grouped below title | Non-image works use an honest type cover, not a fabricated screenshot; no invented recommendations, logos, totals or popularity. Following/collection states come from #214 |
| Discover agent directory | `2026-11-17-recapture-pm/discover-agents.png` | Dense three-column rows, two-line summaries, restrained borders, compact search/chips and neutral initial avatars; removes floating purple/gradient styling | Chat/create remain unavailable where backend is absent; AI-team populated-grid evidence is missing; no template cards or fake connected states |
| Works/library | `2026-11-17-recapture/artifacts-all.png`, `artifacts-filter-panel.png` and other captured directory/filter variants | Narrow directory and quieter main pane; existing grid/list toggle now actually changes presentation; tiles/list rows use real title/type/author data; responsive columns and bounded editor | Populated tile composition is an ORIGINAL adaptation because captured Teamily evidence is empty-state chrome. Type tiles are not invented previews. This caveat remains visible in the page |
| Memory overview/profile | `inventory/memory-overview.png`, `2026-11-17-recapture/memory-profile.png`, `memory-todos.png` | Graph-first layout with narrower directory/side panel; more room for canvas; restrained panels and readable hint; editing typography for #214's actual three-section profile; stacked narrow layout | No fake wiki text/generated profile/dreaming. Hover/open-page and mobile layouts lack same-state Teamily evidence; no graph acceptance claim |
| Settings overview/subpages | `2026-11-17-recapture/settings.png`; pm `settings-language.png`, `settings-shortcuts.png`, `settings-appearance.png`, privacy/folding; inventory connectors | Narrow centered grouped rows, less elevation, left-label/right-control alignment, distinct original model/skill icons, quieter connector rows and actual unconnected labels | Settings lower half remains incompletely captured; OAuth is not implemented. No proprietary connector logos copied. Stored toggles are not asserted to have unimplemented effects |
| Onboarding/work background | Existing implemented step-one form; audit explicitly lacks later-step captures | Form width, spacing, role choices, label/control and action alignment only | This adaptation is NOT a Teamily visual match. No steps2–4, recommendation/progress completion or invented later-step interface |
| Guide/runtime/profile/members/automations/team | Existing shell evidence and Assessment A; existing page-specific implementations retained | Shared icon rail, colors, focus and menu repair only; removes nested mode-selector card border in team wizard after detector finding | Their content/layout is not newly compared. Public social profile, guide graph and later team states remain missing/unverified. Public Agent homepage is unchanged; no fake LIVE status |

## Tests and verification boundaries

- Full local Python suite: 421 passed. Focused page contracts were rerun after final HTML moves.
- Full first-party Node plus compose-planner suite: 223 passed, zero failures/skips.
- Added tests cover actual grid/list state, stable real pin/direct/group presentation, Hong Kong
  day boundaries, accessible icon links and visible menu text, disabled/attachment truth, actual
  same-origin image covers vs type fallbacks, and light/dark text/hover contrast pairs.
- Existing CI browser script now additionally checks compact rail/chat geometry, lack of horizontal
  shell overflow and real grid/list presentation switching. Existing functional assertions remain.
- Impeccable context loaded; changed-file mechanical detector initially found hover contrast and
  nested/cramped-card issues. They were corrected (including the skip-link hover); final JSON `[]`.
  This is a mechanical changed-source scan, not a new two-assessor rendered review. Missing project
  context/hook setup was reported, not repaired as a side effect.
- No local browser or browser subagent was used. Updated rendered screenshots come from CI after
  push. The final result has NOT been visually verified at shipped sizes yet, so the PR stays draft
  until its functional dependency and rendered review are handled. A clean detector or CI is NOT
  Teamily + Impeccable acceptance. All umbrella/unaccepted issues stay open.

## Exact next read-only evidence / acceptance work

Parent should retrieve exact-head UI CI screenshots (desktop, 900px intermediate, 390px narrow,
light and dark). Compare them against the private captures above and run a fresh independent
Impeccable Assessment A (paired rendered review) and Assessment B (mechanical/runtime a11y scan).
Check focus/tab order, zoom/localization, long names, empty/populated lists, menus, hover, disabled,
error and loading states. In particular, verify composer controls, graph hint/zoom separation,
attachment popup privacy text and account menus are fully visible at narrow sizes.

Additional read-only Teamily captures still needed:
1. Independent in-conversation search empty AND result panels; message tools/attachment/pin/unread
   menus only if opening them does not send, upload, create, invite or connect.
2. Full settings lower half; complete group-create dialog/member/footer; graph hover/open-page states.
3. Populated AI-team directory, creator/category expanded states, populated works grid if available.
4. Public social-profile tabs/posts/followers, Guide graph view and onboarding steps2–4 without save/connect.
5. Public Agent homepage same-state conversation/starting prompt; no model or side-effect action is authorized.

Do not perform Teamily writes, connect accounts, discover credentials or infer parity from absent
evidence. External functional gaps remain in [FUNCTIONAL_COMPLETION.md](FUNCTIONAL_COMPLETION.md).
