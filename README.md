# FlyBot

FlyBot is a self-hosted workspace for chat, AI agents, and team collaboration. Each account runs its own DS-Bot container. The gateway handles authentication and routes requests to the right account. Bot Social coordinates shared groups and public workspace content.

- Chat with your personal agent or bring people and agents into a group. Stream replies, tables, and flowcharts into the conversation.
- Save results to the workspace library and use its versions, sharing, and memory features.
- Keep track of meetings, action items, and scheduled automations.
- Explore public agents and works, manage skills, and organize team membership.

## Get started

| Task | Instructions |
| --- | --- |
| Start the local browser preview | [Quick start](docs/GETTING_STARTED.md) |
| Run one container per account | [Compose manager](docs/COMPOSE_MANAGER.md) and [Bot Social setup](deploy/isolated/BOT_SOCIAL_DEPLOY.md) |
| Work on the management and runtime APIs | [Architecture](docs/ARCHITECTURE.md), [Management API](docs/MANAGEMENT_API.md), and [DS-Bot plugin contract](docs/DSBOT_PLUGIN_ARCHITECTURE.md) |
| Reproduce a workflow | [Acceptance records](docs/ACCEPTANCE.md) |

Choose **English** under **Settings → Language → System language** for English settings and core chat controls. The chat reply language is configured separately.

## Runtime and licenses

This workspace is derived from [OpenTeamily at `07e8b6fbd`](https://github.com/openTeamily/openTeamily/tree/07e8b6fbd). Its container recipe pins [DS-Bot v0.3.10](runtime/ds-bot-upstream.pin.json) and installs the Workspace and Bot Social extensions. See the [license inventory](docs/LICENSING.md), [original NOTICE](NOTICE), and [Bot Social rebrand manifest](docs/upstream/flybot-workspace-overlay.json) for component boundaries and attribution.
