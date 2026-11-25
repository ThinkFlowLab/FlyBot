# sharp-libvips notices and source pointers

The default FlyBot runtime image installs
`@img/sharp-libvips-linux-x64@1.3.4` (declared `LGPL-3.0-or-later`) as a
dependency of `sharp@0.35.5` under the global DSH tree. The published
npm tarball contains `lib/libvips-cpp.so.8.18.7`, `versions.json`,
`package.json`, and a README license table. It does **not** contain a
`LICENSE` or `THIRD-PARTY-NOTICES.md` file. The #56 inventory therefore
listed no license files next to that package.

This directory is a notice and source-pointer offer for that prebuilt
library. It is not a legal opinion, and it does not claim that the offer
satisfies LGPL or MPL for a published image. The `.so` binary is not
vendored here. Office and image-processing functionality stay enabled;
this tree does not remove sharp or libvips from the image.

## What is in this tree

| File | What it is |
| --- | --- |
| `npm-README.md` | The README from the npm tarball (license table as shipped with the binary). sha256 `b4fb1a9f5909cfd58edb4177c2028ce3033cf8651aef740a554c1dc58b3c5ee3` (4331 bytes). |
| `THIRD-PARTY-NOTICES.md` | The same table from `lovell/sharp-libvips` at `ebb95f8add54eee8bed840e3fb587e4cbec857d7` (the npm `gitHead`). sha256 `6f0d5086e3bcbee12bcdacf5878b31d1104002aeecaeb241d3fff466108082fe`. |
| `PACKAGING-LICENSE` | Apache License 2.0 for the sharp-libvips packaging scripts, from that same commit. sha256 `b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1`. |
| `LGPL-3.0.txt` | Official GNU LGPL version 3 text from gnu.org. sha256 `e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118`. |
| `libvips-LGPL-2.1.txt` | The `LICENSE` file of libvips `v8.18.7` (GNU LGPL 2.1). sha256 `dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551`. Upstream README says LGPLv3 use is via the “any later version” clause of LGPLv2/LGPLv2.1. |
| `versions.json` / `versions.properties` | Exact library versions compiled into the 1.3.4 linux-x64 binary, including `vips` 8.18.7. |

The image recipe copies this tree to `/opt/licenses/sharp-libvips` and
also drops the notices next to the installed npm package, which otherwise
has none.

## Corresponding-source pointers (not hosted in this repository)

- Packaging scripts: https://github.com/lovell/sharp-libvips/tree/ebb95f8add54eee8bed840e3fb587e4cbec857d7
- npm tarball: https://registry.npmjs.org/@img/sharp-libvips-linux-x64/-/sharp-libvips-linux-x64-1.3.4.tgz
  sha256 `e371cb713fc8822c96a0d3fb60a3d092799d0aefab6d7f1fb3b72d8d75f1d109`
  integrity `sha512-GJ//SSXbnwSDes02umB3nDJLFcQzw8a18V8fyhqr6tV515tOEMdImjjxj1AoafMRz56F3PHgftnj1QEKSU1zkw==`
- libvips 8.18.7 source tarball:
  https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz
  sha256 `5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94`
- Other libraries compiled into the same `.so` are listed with versions in
  `versions.json`. Exact source URLs that `build/posix.sh` at the npm
  `gitHead` uses for the LGPL-listed libraries and for cairo 1.18.6 are
  recorded in `CORRESPONDING-SOURCE.md` and `corresponding-source.json`.
  Independent sha256 verification in this repo exists only for the libvips
  8.18.7 tarball. No reproducible rebuild of the shipped `.so` was
  performed. Sufficiency of those pointers as a corresponding-source or
  MPL offer is not decided here.

`scripts/fetch-sharp-libvips-sources.py` can verify these pins offline,
or download the libvips source tarball with `--fetch` into a directory
you name (not into the git tree).
