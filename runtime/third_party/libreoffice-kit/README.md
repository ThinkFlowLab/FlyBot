# LibreOffice Kit corresponding-source offer

Date: 2026-11-16 (Asia/Shanghai).

This directory is OpenTeamily's offer of corresponding source and notices
for `@deepseek-ai/libreoffice-kit@0.1.5` and, on Linux, the optional
`@deepseek-ai/libreoffice-kit-wasm@0.1.5` engine that a default FlyBot
image may install through `dsh-skill-office`. Office document conversion
is **kept**. This is not an exclusion of that skill, and it is **not** a
legal opinion or a public-image clearance.

Machine-readable pins: [pins.json](pins.json). Related tracking remains
open: issue 3.

## What is in this tree

| Path | What it is | Evidence class |
| --- | --- | --- |
| `entry/` | Exact contents of the npm tarball `@deepseek-ai/libreoffice-kit@0.1.5` (compiled `lib/*.js`, typings, `LICENSE`, `NOTICE`, READMEs) | **Verified files** copied from the tarball whose integrity is recorded in `pins.json` |
| `entry/LICENSE` | Mozilla Public License 2.0 | **Verified license text** (sha256 `1f256eca…`); byte-identical to the LICENSE on the public kit repo's default branch |
| `entry/NOTICE` | NOTICE from that same 0.1.5 tarball | **Verified file**; *not* byte-identical to current public master NOTICE |
| `wasm/licenses/` | LICENSE bundle, NOTICE, and DeepSeek Harness MIT text from the 0.1.5 wasm tarball | **Verified files** from that tarball. The large `licenses/LICENSE` is LibreOffice's third-party license bundle; it has not been independently re-read term-by-term |
| `wasm/sources/` | Build scripts, patches, `lok.cxx`, and source pins shipped *inside* the 0.1.5 wasm package | **Verified files** from that tarball |
| `wasm/sources/core-source.json` | LibreOffice/core revision `bce0998afefdbc355585ca324285661a2170ba77` | **Verified declaration** in the wasm package. The core tree itself is *not* vendored here (it is large and already public) |
| `wasm/sources/engine/wasm-source/source.json` | Declares TDF source archive `libreoffice-26.8.0.3` and an emsdk commit | **Verified declaration** in the wasm package. Those upstream archives were not re-downloaded or hashed in this offer |
| npm `license` fields (`MPL-2.0`) | Registry metadata | **Metadata declaration**, corroborated by the entry `LICENSE` file |

`soffice.wasm`, `soffice.data`, and other engine binaries from `assets/`
are **not** stored in this repository. Recipients who already have the
npm package have those binaries; this tree is the source and notices
offer that package ships alongside them.

## How to obtain the rest of the corresponding source

1. The Node API package is identical to `entry/` and can also be
   re-fetched with
   `python3 scripts/fetch-libreoffice-kit-sources.py --fetch`.
   That command checks the recorded npm integrity values and compares
   `LICENSE` / `NOTICE` / `sources/` against this tree.
2. The wasm engine's preferred corresponding sources that were included
   in the npm package are in `wasm/sources/` and `wasm/licenses/`.
3. The upstream LibreOffice engine source is the public git revision
   recorded in `wasm/sources/core-source.json`:
   <https://github.com/LibreOffice/core/tree/bce0998afefdbc355585ca324285661a2170ba77>
   The wasm package also names the Document Foundation source archive
   `https://download.documentfoundation.org/libreoffice/src/26.8.0/libreoffice-26.8.0.3.tar.xz`.
   OpenTeamily does not host a second copy of that tree in this
   repository.

## What remains unresolved

- **No public git tag or commit for entry 0.1.5 was found.** The public
  [deepseek-ai/dsh-libreoffice-kit](https://github.com/deepseek-ai/dsh-libreoffice-kit)
  default branch (`b19bb73c74ed893b8a5d1716d32df32a113ed31b`) declares
  version 0.1.3. Registry metadata for 0.1.5 has no `gitHead`. Preferred
  TypeScript form for the exact 0.1.5 revision is therefore not pinned
  to a public git object.
- Whether this offer plus the public LibreOffice/core pin satisfies MPL
  3.2 / 3.3 for a redistributed FlyBot image is a **legal interpretation
  that this project has not made**. Until that is resolved, this
  repository still does not claim a public redistributable image.
- Whether a given built image actually contains the wasm optional package
  has not been file-listed from a Docker daemon on the authoring machine
  (none was available). The 0.1.5 entry package lists the wasm engine as
  an optional dependency for Linux and does not list a linux-x64 native
  engine.

Do not treat npm `license` fields, this README, or the presence of these
files as clearance to publish a pre-built image.
