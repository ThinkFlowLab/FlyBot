# KaTeX font notices

This directory holds the license text that ships with the KaTeX package
whose font payloads match the files in a default FlyBot runtime image.
It is not a legal opinion, and it does not invent a font license that
the upstream package does not itself ship.

## What was found in the image

The #56 inventory of `openteamily-flybot:test` listed 19 `KaTeX_*.woff2`
files under:

`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/fonts/`

Those files had no adjacent OFL or KaTeX license text. The only nearby
font notice in that directory was `Montserrat-OFL.txt`.

## Byte correspondence

The woff2 payloads are byte-identical to `package/dist/fonts/*.woff2` in
both `katex@0.18.7` and `katex@0.16.47` on the npm registry (the three
spot-checked files, including `KaTeX_Main-Regular.woff2`, matched both
tarballs). DeepSeek Harness `dsh-v0.2.2-rc.1` pins `katex@^0.18.7` from
`packages/client/ui-primitives`, resolving to `0.18.7`. `katex@0.16.47`
is also in that lock (via mermaid / micromark-extension-math). The fonts
in those two tarballs matched each other for the checked files.

`katex@0.18.7` tarball sha256
`9a80a3fba2367e99bf67b52bfff52e9534c8c7f198e4eaa12699e4f1df9a0bda`
integrity `sha512-h+UCwkZ+4Jz8WQ7MLGfj7UVFrRCizGb912fwF4luGdYsC5paYG1vx+jy+KRcC/XkpjGva/P7nAWuxNnPzRvzHw==`

The official `katex@0.18.7` package and the KaTeX git tag `v0.18.7` ship
the fonts next to the MIT `LICENSE` only. There is no `OFL.txt` in that
package or in the `v0.18.7` git tree. DSH `THIRD_PARTY_NOTICES.md` lists
`katex` as MIT. This tree therefore copies that MIT LICENSE, not an OFL
text taken from somewhere else. Whether a separate SIL OFL still applies
to historical Computer Modern / Latin Modern ancestors is not decided
here.

`LICENSE` in this directory is the `katex@0.18.7` MIT text, sha256
`766ccc1f306c885aa45542a9846bbd0a505b27a0374f146778171c2254ce18e3`
(1107 bytes).

The image recipe copies this LICENSE (as `KaTeX-LICENSE.txt`) and this
NOTICE into `/opt/licenses/font-notices/katex/` and into any directory
in the image that already contains `KaTeX_*.woff2` payloads, so the
notice travels with the fonts. Font binaries are not vendored here.
