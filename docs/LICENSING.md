# Licensing

This repository contains more than one license. The root [`LICENSE`](../LICENSE)
(MIT) applies to **new FlyBot-authored material only**. It does not
relicense imported upstream trees.

| Tree | License | Binding files | Copyright / notice |
| --- | --- | --- | --- |
| New FlyBot code and docs (`flybot-workspace/`, `manager/`, `tests/`, `docs/` except copied upstream docs, `scripts/` authored here, `runtime/flybot-social-host/`, `runtime/flybot-web-slots/`, `runtime/flybot-image/`) | MIT | [`LICENSE`](../LICENSE) | FlyBot contributors |
| `runtime/flybot/` (except `ORIGIN.md` and `FLYBOT_WORKSPACE.md`) | Apache License 2.0 | [`runtime/flybot/LICENSE`](../runtime/flybot/LICENSE), [`runtime/flybot/NOTICE`](../runtime/flybot/NOTICE) | NOTICE: DS Bot, Copyright 2026 Fei2411 and the DS Bot contributors |
| `services/bot-social/` (except `ORIGIN.md` and `FLYBOT_WORKSPACE.md`) | MIT | [`services/bot-social/LICENSE`](../services/bot-social/LICENSE) | Copyright (c) 2026 Birfy |
| `runtime/ds-bot-upstream/` (except `UPSTREAM.md`) | Apache License 2.0 | [`runtime/ds-bot-upstream/LICENSE`](../runtime/ds-bot-upstream/LICENSE), [`runtime/ds-bot-upstream/NOTICE`](../runtime/ds-bot-upstream/NOTICE) | Unmodified pinned copy of [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot) v0.3.10 (`d104d9ca18d69a35460f14e15dff4d553181433a`); LICENSE and NOTICE retained |

`ORIGIN.md` and `FLYBOT_WORKSPACE.md` files inside imported FlyBot and Bot Social
trees, and `UPSTREAM.md` inside `runtime/ds-bot-upstream/`, are FlyBot
documentation overlays and follow the root MIT license. They do not change the
license of neighboring upstream files.

If you redistribute this repository, include the Apache-2.0 text and NOTICE
with the FlyBot snapshot and with the unmodified `runtime/ds-bot-upstream/`
copy, include the Bot Social MIT copyright notice, and do not describe the
combined work as “all MIT” or “all original to FlyBot.”

A root [`NOTICE`](../NOTICE) points redistributors at the trees above. An
inventory of exactly what this revision ships — in-tree licenses, vendored
npm lockfiles, and the runtime image recipe, with versions and declared
licenses — lives in [`docs/reuse-audit/SHIPPED.md`](reuse-audit/SHIPPED.md)
and [`docs/reuse-audit/shipped-pins.json`](reuse-audit/shipped-pins.json).
The inventory records remaining legal blockers for a public image
(including MPL-2.0 LibreOffice kit obligations and an unenumerated Debian
base-image source offer). It is not a legal opinion, and it is not a public
release of a redistributable image. Related tracking remains open: issue 3.

Corresponding source and notices for `@deepseek-ai/libreoffice-kit@0.1.5`
(and the Linux wasm engine that a default image may install) are offered in
[`runtime/third_party/libreoffice-kit/`](../runtime/third_party/libreoffice-kit/).
Office conversion is retained. That offer is not a legal opinion and is not
clearance to publish a pre-built image. Related tracking remains open: issue 3.

