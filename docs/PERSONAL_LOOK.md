# Personal Agent look rendering

Related: [#130](https://github.com/openTeamily/openTeamily/issues/130), [#157](https://github.com/openTeamily/openTeamily/issues/157), [#1](https://github.com/openTeamily/openTeamily/issues/1).

The four-step onboarding already stores a Personal Agent look (colour, expression,
headwear, glasses and hand item) from self-written choices. This slice renders that
saved look as an original CSS avatar; it does **not** generate an image, call an
image vendor, or copy Teamily artwork.

## Where it appears

- `/onboarding` step 4 keeps its live preview.
- `/agents` shows the look avatar on the current user's Personal Agent card in
  the personal workspace instead of a two-letter monogram.
- `/chat` uses the same avatar in the Personal Agent session row and the open
  conversation header.

Every other agent and human keeps the existing monogram avatar. The look is
decorative (`aria-hidden="true"`); the agent name beside it carries the label.

## API

`GET`/`POST /v1/personal-agent` now include `personal_agent.look`:

```json
{
  "personal_agent": {
    "workspace": {"id": "...", "name": "个人空间", "kind": "personal"},
    "agent": {"id": "...", "name": "<username>'s Personal Agent"},
    "look": {"color": "天空蓝", "expression": "微笑", "headwear": "耳机", "glasses": "无", "hand": "咖啡杯"}
  }
}
```

`look` is `null` until onboarding step 4 is saved. The read is session-scoped and
never exposes another user's look. A stored value is returned only when all five
fields still match the server option allowlist; a corrupt row falls back to
`null` instead of rendering arbitrary values.

## Implementation

- `flybot_workspace/static/look/app.mjs` validates the five allowed fields and builds
  the avatar from plain DOM nodes. It does not use `innerHTML` or accept text.
- `flybot_workspace/static/look/app.css` is original CSS art (one shared asset served
  at `/look/app.css`); shapes are driven by `data-color`, `data-expression`,
  `data-headwear`, `data-glasses` and `data-hand`.
- `/agents` and `/chat` import the shared module and link the shared stylesheet.
- The server helper `onboarding.load_look` re-validates the stored JSON.

## Explicitly not in this slice

- Generated bitmap avatars, image upload/provider calls, or a vendor image model.
- Editing the look outside onboarding (the existing step 4 form still owns writes).
- Applying the look to built-in agents, other users, public homepages, or social
  profiles. Those still use monograms.
- Teamily or Impeccable comparison acceptance. The shared CSS art is original and
  is not claimed to match Teamily's avatar art.

## Screenshot

The source project contains synthetic `/agents` and `/chat` captures with one
seeded look. They are review material, not browser E2E or Teamily comparison.

## Tests

`tests/test_personal_agent.py` checks owner-only exposure and the null default;
`tests/test_look_avatar.py` serves the shared assets with strict headers;
`tests/look_avatar.test.mjs` checks the allowlist, data attributes and DOM parts.
These are in-process/unit tests, not browser E2E or real-vendor acceptance.
