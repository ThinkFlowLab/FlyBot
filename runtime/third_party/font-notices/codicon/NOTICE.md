# Codicon font notices

This directory holds the license text that ships next to the Codicon
font in the Playwright source revision whose built font payloads match
the files in a default FlyBot runtime image. It is not a legal opinion.

## What was found in the image

The #60 inventory listed three `codicon*.ttf` files (80,340 bytes each,
sha256 `0f1d5219934e96e83b8db162d60b4d8c09b5de1e7d38031cbafe4a3c0f2889c9`)
under `playwright-core@1.64.1`:

- `/opt/dsh-template/profiles/web/node_modules/ds-bot/node_modules/playwright-core/lib/vite/dashboard/assets/codicon-DCmgc-ay.ttf`
- `/opt/dsh-template/profiles/web/node_modules/ds-bot/node_modules/playwright-core/lib/vite/recorder/assets/codicon-DCmgc-ay.ttf`
- `/opt/dsh-template/profiles/web/node_modules/ds-bot/node_modules/playwright-core/lib/vite/traceViewer/codicon.DCmgc-ay.ttf`

The npm tarball `playwright-core-1.64.1.tgz` (sha256
`3af03703c967c95037454f2283f709d53ce804a4776d4219d319f5bbcc2a0185`)
contains the same three font payloads, byte-identical to the image. It
ships Apache-2.0 `LICENSE` and a short `NOTICE` for Playwright itself,
plus `ThirdPartyNotices.txt`, which lists the source paths
`packages/web/src/third_party/vscode/codicon.ttf` and `codicon.css` but
does not include the font license text. There is no license file next to
the bundled `.ttf` files in the npm package.

## Source revision

`playwright-core@1.64.1` has npm `gitHead` and git tag `v1.64.1` at
commit `cfe490d941f992655948eee8fd4fd94e1c4234bf`. In that tree:

- `packages/web/src/third_party/vscode/codicon.ttf` is byte-identical to
  the image/npm payloads (same sha256 as above).
- `packages/web/src/third_party/vscode/LICENSE.txt` is the only license
  file in that directory. It is the MIT text with
  "Copyright (c) 2015 - present Microsoft Corporation", 1087 bytes,
  sha256 `20535828272932407c2f5172aeb714ac7b374a34e5ecb1825af509f2902cde54`.

This tree copies that `LICENSE.txt`. Font binaries are not vendored
here. The image recipe copies the license to
`/opt/licenses/font-notices/codicon/` and beside any `codicon*.ttf`
payloads as `Codicon-LICENSE.txt`.

Whether a separate vscode-codicons Creative Commons term also applies is
not decided here; that text is not in the Playwright directory that
ships this font at v1.64.1.
