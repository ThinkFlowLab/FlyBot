# Review of the vendored DS-Bot v0.3.6 NOTICE

Reviewed: 2026-11-16 (Asia/Shanghai).  
File: [`runtime/ds-bot-upstream/NOTICE`](../../runtime/ds-bot-upstream/NOTICE), sha256 `4c7d3e4e7607f02ed9e4fb940442be7d0d107b57beb54660e1526a7be07c2aad` (15557 bytes). This is an attribution-file review, not a legal opinion and not clearance of every listed project or of a published image. Related tracking remains open: issue 3.

The file is longer than the historical FlyBot / DS-Bot NOTICE `94f05bc4…` (3835 bytes). The added length is additional third-party attribution, not a change of the Apache-2.0 project license declared at the top.

## What the NOTICE itself says

- DS Bot is Apache License 2.0, Copyright 2026 Fei2411 and the DS Bot contributors.
- A “Third-party code in this repository” section names, with licenses and path-level notes:
  - DeepSeek Harness, MIT, Copyright (c) 2026 DeepSeek, including an inlined MIT grant and a list of adapted desktop, office, profile, and skill files.
  - Simple Icons 16.36.0, CC0 1.0, used for connector marks.
  - Context7 (Upstash), MIT, for a connector mark; it points back to the inlined MIT text.
  - Microsoft Playwright and Playwright MCP, Apache-2.0; the NOTICE says the playwright package is loaded at run time and is not bundled in the DS-Bot tree.
  - DSH Remote (commit 4d888ad), MIT, for the phone-link adaptation, with a note that the resulting protocol is DS Bot’s own.
  - dsh-im (xmanrui), MIT, for Telegram, Discord, and Slack mapping.
- It then states that no other third-party code is copied into the repository, and that the plugin uses `@deepseek-ai/*` packages from the DeepSeek Harness install at run time, plus named runtime/build libraries (with MIT/Apache copyrights) for the phone link and mobile app.
- A “Projects that gave us ideas (no code copied)” section follows.
- A closing “Agent logos” paragraph says Claude (Anthropic), Cursor, Gemini, OpenCode, Cline, Qwen, Devin, and OpenAI are trademarks of their owners, and that some marks come from Simple Icons (CC0) or vendor application icons. This is trademark attribution, not a license for Anthropic’s Claude Code or `@anthropic-ai/claude-agent-sdk`.

## What this review does not treat as the same thing

- The MIT `@anthropic-ai/sdk@0.129.0` found in the #56 image inventory is not mentioned in this NOTICE. That SDK’s own LICENSE is recorded separately under `runtime/third_party/anthropic-sdk/`. Do not read this NOTICE’s trademark line for “Claude (Anthropic)” as those SDK terms, and do not read it as the official Claude Code terms (those payloads were not in the scanned image trees).
- KaTeX fonts and Montserrat live in the DSH install, not in this NOTICE. Font notices are under `runtime/third_party/font-notices/` and, for Montserrat, already next to the payloads as `Montserrat-OFL.txt`.
- Playwright Codicon `.ttf` files were observed in the image under `playwright-core`. This NOTICE covers Playwright Apache-2.0 for the integration pattern; it is not a separate font-license review of Codicon.
- The inlined MIT grant under DeepSeek Harness is the standard MIT permission text. This review records that it is present; it is not a completeness audit of every DSH file named in the bullet list.

The vendored tree remains unmodified Apache-2.0 + this NOTICE. Redistributors must keep both.

## v0.3.8 addendum (2026-11-17, Asia/Shanghai)

File now sha256 `9950f67d1743a33a420581e44e8f7473e6ab78b69c7e55ea8a84b476c3cf2a39` (15675 bytes), still an unmodified copy of the upstream NOTICE at Fei2411/DS-Bot v0.3.8 (`5e9b7da8882da3b68d8a0624342708c2150a9156`).

The only change from the v0.3.6 text reviewed above is the closing “Agent logos” paragraph: it now also names Antigravity (Google), GitHub Copilot (GitHub), Kimi (Moonshot AI), MiniMax (MiniMax), and Mistral AI, and says Antigravity marks (with Devin and OpenAI) come from the vendors' application icons. This remains trademark attribution, not a license grant and not a re-review of every earlier NOTICE section.

## v0.3.9 addendum (2026-11-23, Asia/Shanghai)

The upstream NOTICE at Fei2411/DS-Bot v0.3.9 (`881b57b54046fb355095e9c11f7918bd62b8bf1e`) is 15883 bytes, with SHA-256 `7183b18ec5bd153cb7b207c0c0d8c9c8d83dc5f0add15c116f13027b5dd95050`. The difference from v0.3.8 adds DSH FishLogo attribution for the mobile app and narrows the DSH Remote key helper attribution to the key pair and Base64URL functions.
