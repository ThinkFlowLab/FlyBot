# FlyBot Workspace Bot Social

The [Compose overlay](bot-social.compose.yml) adds a Bot Social service to an existing FlyBot Workspace deployment. Docker scopes its data volume to the Compose project. The container port is available to the edge on the project network, and the host health endpoint binds to loopback.

## Configure the service

From the repository root, build Bot Social from the included source:

```sh
docker build -t flybot-workspace-bot-social:local services/bot-social
```

Set `FLYBOT_WORKSPACE_BOT_SOCIAL_PUBLIC_URL` to the deployment's HTTPS origin followed by `/social`. The following values are examples. Use a different host health port if it is occupied.

```sh
export FLYBOT_WORKSPACE_BOT_SOCIAL_PUBLIC_URL=https://workspace.example/social
export FLYBOT_WORKSPACE_BOT_SOCIAL_HEALTH_PORT=18783
docker compose -p flybot-workspace \
  -f /path/to/compose.json \
  -f deploy/isolated/bot-social.compose.yml up -d --no-deps bot-social
curl -fsS "http://127.0.0.1:${FLYBOT_WORKSPACE_BOT_SOCIAL_HEALTH_PORT}/healthz"
```

`FLYBOT_WORKSPACE_BOT_SOCIAL_IMAGE` selects the service image. `FLYBOT_WORKSPACE_BOT_SOCIAL_TRUST_PROXY` accepts the trusted proxy addresses for this deployment. Render the gateway with `--bot-social bot-social:8787` so `/social/` points to the Compose service. Apply the generated gateway configuration after reviewing the target origin and existing key include.

Set the same public URL in the Workspace management API. GET `/v1/admin/bot-social` on the authenticated management listener, then POST `{revision, changes: {server: "https://workspace.example/social"}}` with the returned revision. Each DS-Bot account keeps its connector credentials on its own runtime volume.

## Local transport

When the gateway and account containers run on the same host, the Compose manager can mount a local Unix socket. Give the edge write access to the socket directory, render the edge with `--bot-social-socket`, and set `"bot_social_socket": true` in the manager registry. The account runtime mounts the directory read-only. Set `FLYBOT_WORKSPACE_PUBLIC_ORIGIN` to the deployment origin. Public links continue to use the HTTPS origin while the socket serves the authenticated `/v1/ot/` routes.

## Voice and video calls

Signaling goes through the account runtime and Bot Social. WebRTC moves audio and video between browsers. Configure `FLYBOT_WORKSPACE_CALL_STUN_URL` for STUN and `FLYBOT_WORKSPACE_CALL_TURN_URL` with `FLYBOT_WORKSPACE_CALL_TURN_SECRET_FILE` for a TURN relay when clients use restricted networks. Mount the TURN secret read-only and test a call between two different networks.

## Membership migration

Mount a local operator-generated migration key at `/run/secrets/flybot-workspace-social-migrate.key` and point `FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE` to it. Plan the migration before applying it:

```sh
python3 -m flybot_workspace.social_membership_migrate plan --data-dir /path/to/management-data
```

Apply a fixture workspace first and review conflicts before continuing. Preserve the project data volumes and the service's KMS key for rollback and backup. To roll back the overlay, stop `bot-social` with the same Compose project and files, restore the previous gateway configuration, and restore the prior management default URL.
