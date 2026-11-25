# Before/after screenshots (`scripts/shots.mjs`)

One command captures the same management-UI view on two revisions — a base and
a pull-request tip — in a fixed matrix, then reports the pixel difference. It
is evidence for review, not product acceptance: the fixture data is synthetic
and no Teamily comparison is claimed.

This wrapper sits on top of the existing CI screenshot harness. It does not
re-implement browser driving or fixture seeding:

| Piece | Role |
|---|---|
| `scripts/ci_ui_screenshots.py --serve` | Starts a throwaway loopback app with synthetic fixtures and writes `ready.json` (origin + 0600 login file). Reused unchanged as each side's server. |
| `scripts/ci_ui_screenshots.mjs` | The CI suite: one origin, 81 fixed shots, hard/soft checks. Not used here; it has no before/after or route selection. |
| `scripts/shots.mjs` | Two-arm orchestration: optional worktrees/refs, named state actions, viewport × locale × theme matrix, pixel and text diff. |

## Quick start

```sh
# two commits (each side gets a detached worktree + seeded fixture app)
node scripts/shots.mjs --slug help-center \
  --before 310d468 --after <pr-tip> --routes /chat --states account-menu-open

# two already-running loopback servers
FLYBOT_WORKSPACE_USERNAME=... FLYBOT_WORKSPACE_PASSWORD=... \
node scripts/shots.mjs --slug help-center \
  --before http://127.0.0.1:8101 --after http://127.0.0.1:8102 \
  --routes /chat
```

`--before/--after` accept either a git ref (any ref `git worktree add` accepts)
or an `http://127.0.0.1:<port>` URL. Ref mode is the normal path: it starts
each side from its own checkout, so `before` really runs base code and `after`
really runs the PR tip.

### Why the fixtures are seeded once

The CI fixture seeds random workspace and conversation ids, and the chat page
opens the first workspace returned by an id-ordered API. Two independent seeds
therefore land on different default workspaces (for example 3 conversations on
one side and 0 on the other), and that noise swamps the real UI change: a
one-line `/guide` link once measured 20% changed pixels for the wrong reason.

Ref mode therefore seeds with `before`'s checkout exactly once, copies the
resulting private data directory to both sides, and starts a plain management
server per side against its own copy on `--before-port`/`--after-port`. Only
the code under test differs; ids, timestamps and transcripts are identical.
The copies are made private again (0700) before the server starts.

Measured on a local simulation of issue #128 (帮助中心 dead entry → `/guide`):

| Viewport | changed | bbox |
|---|---|---|
| 1440x900 light/dark | 0.036% | `x=95 y=528 60x15` |
| 390x844 light/dark | 0.142% | `x=95 y=472 60x15` |

An identical-ref control run reports `0.000%`, `bbox=null`, `textLinesChanged=0`,
and repeating the same URL for both arms also reports `0.000%` on all 14 routes
(the capture itself is deterministic).

## Output

```
.shots/<slug>/
  before/<locale>__<theme>__<viewport>__<route>[_<state>].png
  after/…same names…
  diff.json
```

Defaults: viewports `1440x900,390x844`, locales `zh-CN,en`, themes
`light,dark`, states `default`. Example: `zh-CN__dark__390x844__chat__account-menu-open.png`.
A `default` state has no state suffix.

`diff.json` holds one entry per matched pair: `width/height/total/changed`,
`ratio` (changed pixels ÷ total), `bbox {x,y,width,height}` in CSS pixels, and a
text diff (`changedLines`, first differing lines). A size mismatch is reported
explicitly instead of a ratio.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--slug` | required | Output folder name. |
| `--before`, `--after` | — | Git ref or loopback URL per side. One side is enough. |
| `--base-url` | — | Single running server instead of a pair. |
| `--routes` | `/` | Comma list, e.g. `/chat,/settings,/members`. |
| `--states` | `default` | Comma list of state actions (below). |
| `--viewports` | `1440x900,390x844` | `WIDTHxHEIGHT`. |
| `--locales` | `zh-CN,en` | Only these two are sent to `/v1/settings`. |
| `--themes` | `light,dark` | `appearance` value written per capture. |
| `--out` | `.shots` | Output root. |
| `--login-file` | — | `username=…`/`password=…` lines (URL mode). |
| `--register` | off | Register the account if login returns 401 (URL mode). |
| `--before-port`, `--after-port` | `8101`,`8102` | Fixture ports for ref mode; the port must be free. |
| `--start-timeout` | `180000` | Milliseconds allowed for worktree + fixture startup. |
| `--full-page` | off | Full-page instead of viewport screenshots. |
| `--no-diff` | off | Skip the pixel diff. |
| `--json` | off | Include per-image diagnostics in stdout. |
| `--browser` | — | Chromium executable path (or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`). |
| `--state-file` | — | Module exporting extra states (see below). |

Credentials are never printed. Ref mode reads the seeded `login_file` from
`ready.json`; URL mode needs `FLYBOT_WORKSPACE_USERNAME`/`FLYBOT_WORKSPACE_PASSWORD` or `--login-file`.
One login per side is reused by every context, because `/v1/auth/login` is
rate-limited per username and peer address (10 per 10 minutes) by design.

## Setup

- Node 22.
- Playwright is not vendored in this repo. Use a CI runner image that has it,
  or `npm i --no-save playwright`, or point `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
  at a Chromium/headless-shell binary.
- Python 3.11+ for the fixture server (`SHOTS_PYTHON` overrides `python3.11`).
- Run against loopback only. The script writes `.shots/`, `../.shots-servers/`
  and `../.shots-state/`; nothing else in the checkout changes.

## States

States model the UI condition a PR affects, not just a URL. Built in:

| State | Action |
|---|---|
| `default` | Screenshot the loaded page as-is. |
| `account-menu-open` | Open the shared account menu; if a help submenu exists, open it too (this is where「帮助中心」lives). |
| `help-menu-open` | Same, but fail if the page has no `#help-menu-button`. |

Extend without touching the script:

```js
// my-states.mjs
export const states = {
  'confirm-dialog': async (page) => {
    await page.getByRole('button', { name: '删除' }).click();
  },
};
```

```sh
node scripts/shots.mjs --slug delete --base-url http://127.0.0.1:8101 \
  --routes /artifacts --states confirm-dialog --state-file ./my-states.mjs
```

## Language and theme consumers

- Theme is an account preference (`appearance`), written through
  `/v1/settings` before each capture. All signed-in pages include the shared
  shell, which resolves `data-theme-resolved`; the script verifies that the
  resolved theme matches the requested one and fails the image otherwise.
- Language is also an account preference, but this slice has **no translation
  catalogue** (`docs/SETTINGS.md`). `en` and `zh-CN` therefore have identical
  body copy and pixels on current pages; only `html.lang` changes. The matrix
  still produces both so a later i18n change is visible, but do not read equal
  `en`/`zh-CN` bytes as "language verified".
- `colorScheme` is set on the browser context as well, so pages that only use
  `prefers-color-scheme` still render the requested appearance.

## Reading a failure

Exit code `1` means at least one requested image failed; `2` is a usage or
startup error. stderr lines look like
`fail after zh-CN dark 1440x900: GET /chat HTTP 404` or
`theme resolved to light, expected dark`.

- `port … is busy` — nothing was started; free the port or pass
  `--before-port/--after-port`.
- `fixture exited after ready … log=…` — the seeded app died; the log tail is
  the fixture's stderr.
- Timeout in `waitForSelector('#account-menu…')` — the page has not finished
  its session fetch, or the state does not apply to that route.
- `rendered almost no text` — the page returned HTML but the app failed to
  render; treat the image as invalid rather than reporting it.

Ref-mode runtime artifacts: worktree under `../.shots-servers/<side>-<ref>`,
the one-time seed under `../.shots-state/seed/`, and per-side copies plus
server logs under `../.shots-state/<side>-<ref>/`. Worktrees are removed and
servers stopped at the end of a run; a killed run leaves them for inspection.

## Known noise

- `/download` and `/runtimes` print the loopback origin in their daemon command
  (`--origin http://127.0.0.1:8101`). With two ports those lines differ by
  design: on an all-page sweep `/download` measured `0.040%` with bbox
  `530x61` for a change that did not touch it. Treat origin-text pixels as
  framing, not as part of the PR diff, or run the two arms on one origin.
- `/automations` can carry a `0.03–0.04%` time-based strip (75x282 at
  1440x900) from progress and time labels.
- The capture interleaves the two sides inside each combo (viewport × locale ×
  theme) so runtime heartbeat and countdown snapshots are seconds apart.

## What this is not

No agent daemon or fake model provider runs during the capture itself: the
transcript was frozen when the fixtures were seeded, so live-runtime status
pages render the same (offline) state on both sides. That is deliberate — it
keeps the two arms comparable — but it means a PR about live runtime status
needs a different setup.


Not a product or Teamily-parity acceptance, not a substitute for the 81-shot
CI suite's hard checks, and not evidence that a screenshot shows the only
affected state. It captures synthetic fixture data on a loopback development
server. A UI PR still needs its own description of affected states, and a real
comparison still belongs in `docs/ACCEPTANCE.md` records.
