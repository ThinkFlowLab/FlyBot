# Product roadmap

FlyBot runs its product pages and execution inside each account's own
DS-Bot. The platform handles login, provisioning and authenticated routing.
Bot Social handles shared activity across accounts. DS-Bot v0.3.10 has passed
the [two-account container upgrade and Chromium checks](ACCEPTANCE.md#verified-ds-bot-v0310-upgrade).

The product goal is usable everyday workflows with responsive pages, clear
controls and fast interaction feedback. [Acceptance records](ACCEPTANCE.md)
identify which flows have passed and the exact revisions tested.

## Functional domains

1. Conversations, sharing, invitations, approval and revocation semantics.
2. Agent creation, configuration, modes, directory/public profiles and execution.
3. Messages, attachments, interaction tools and authorized historical search/context.
4. Automation, scheduling, time zones, execution output and failure recovery.
5. Memory, relationship graph, user profile, actions and editing.
6. Artifacts: persistent creation, browsing, editing, versions, export and sharing.
7. Workspaces, teams, membership/roles and multi-Agent collaboration.
8. Channels, app connectors, OAuth/secrets, MCP and skills.
9. Agent API, account provisioning, gateway routing and scoped access.
10. Settings, appearance, language, shortcuts and message folding.
11. Discovery, profiles, downloads, calls, guides, help and notifications.
12. Workspace seats, invitations, usage visibility and resource limits for self-hosting.
13. Browser acceptance, accessibility, keyboard/input methods, responsive layouts and interaction states across all domains.

Credit balances, purchases, billing and credit-based rewards are outside the
current product scope. Account invitations and runtime resource limits are
independent features.

## Current priorities

- Complete end-to-end workflows in conversation, group collaboration, agents,
  automation, memory, artifacts and shared workspaces. Keep execution on the
  owning DS-Bot.
- Improve opening time, message send feedback, streaming, and recovery from
  interrupted requests. Verify mobile layouts and desktop keyboard access in
  Chromium alongside API tests.
- Verify runtime upgrades with retained volumes and separate account sessions.
  Keep deployment and browser evidence tied to tested revisions.

## Existing planning input (historical, read-only)

[FlyBot #3110](https://github.com/ThinkFlowLab/FlyBot/issues/3110) and #3113–#3123 record the earlier requirement inventory and work packages. Use them as historical reference for how the current scope was developed.

The earlier inventory provides functional requirements. Use the
[architecture](DSBOT_PLUGIN_ARCHITECTURE.md) for current plugin boundaries and
the [licensing notes](LICENSING.md) for reused components.
