# Corresponding-source pointers for LGPL and cairo libraries

This file records the source URLs that `lovell/sharp-libvips`
`build/posix.sh` at `ebb95f8add54eee8bed840e3fb587e4cbec857d7` (the npm
`gitHead` of `@img/sharp-libvips-linux-x64@1.3.4`) uses for the
libraries that `THIRD-PARTY-NOTICES.md` lists as LGPLv3 or as Mozilla
Public License 1.1 (cairo). Versions come from `versions.properties` at
that same commit. Machine-readable form:
`corresponding-source.json`.

This is not a legal opinion. It does not claim that the pointers are a
sufficient corresponding-source or MPL source offer for a published
image. The prebuilt `.so` is not vendored in this repository. No
reproducible rebuild of `lib/libvips-cpp.so.8.18.7` was performed.

## Libraries

| Library | Version | Notice row | Source URL used by the build script | Tarball sha256 in this repo |
| --- | --- | --- | --- | --- |
| `vips` | `8.18.7` | libvips / LGPLv3 (via later-version of LGPLv2/2.1) | https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz | `5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94` |
| `glib` | `2.90.0` | glib / LGPLv3 | https://download.gnome.org/sources/glib/2.90/glib-2.90.0.tar.xz | not verified here |
| `fribidi` | `1.0.17` | fribidi / LGPLv3 | https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz | not verified here |
| `exif` | `0.6.26` | libexif / LGPLv3 | https://github.com/libexif/libexif/releases/download/v0.6.26/libexif-0.6.26.tar.xz | not verified here |
| `heif` | `1.23.5` | libheif / LGPLv3 | https://github.com/strukturag/libheif/releases/download/v1.23.5/libheif-1.23.5.tar.gz | not verified here |
| `rsvg` | `2.63.2` | librsvg / LGPLv3 | https://download.gnome.org/sources/librsvg/2.63/librsvg-2.63.2.tar.xz | not verified here |
| `pango` | `1.58.2` | pango / LGPLv3 | https://download.gnome.org/sources/pango/1.58/pango-1.58.2.tar.xz | not verified here |
| `proxy-libintl` | `0.5` | proxy-libintl / LGPLv3 | https://github.com/frida/proxy-libintl/archive/0.5.tar.gz | not verified here |
| `cairo` | `1.18.6` | cairo / Mozilla Public License 1.1 | https://cairographics.org/releases/cairo-1.18.6.tar.xz | not verified here |

`without_patch` in that script is `echo "${1%.[[:digit:]]*}"` (so
`2.90.0` becomes `2.90` in the GNOME download path).
`without_prerelease` is `echo "${1%-[[:alnum:]]*}"`.

## Patches applied by the same script

- libvips: https://gist.githubusercontent.com/lovell/313a6901e9db1bf285f2a1f1180499e4/raw/3988223c7dfa4d22745d9392034b0117abef1446/libvips-cpp-soversion.patch
- glib: https://gist.github.com/kleisauke/284d685efa00908da99ea6afbaaf39ae/raw/bdad5489a61c217850631571caf57f5db6ea8b2c/glib-without-gregex.patch
- librsvg: https://github.com/GNOME/librsvg/commit/9106011db93d701728ac2c9da50c9ab2c1bb5dc6.patch

Patch sha256 values and gist-raw stability are not verified here.

## Unresolved preferred-source gaps

- Independent sha256 verification in this repo exists only for the
  libvips 8.18.7 source tarball already recorded in `pins.json`. The
  other tarball and patch hashes were not fetched or verified here.
- No reproducible rebuild of the shipped `.so` from these URLs was
  performed, so correspondence with the 1.3.4 linux-x64 binary remains
  unverified.
- Gist raw and GitHub commit-patch URLs are recorded as used by the
  build script; whether they still return the exact patch applied when
  1.3.4 was built is unverified.
- Other libraries compiled into the same `.so` (see `versions.json`)
  are not tabulated here.
- Whether these pointers satisfy LGPL or MPL for a published image is
  not decided here.
