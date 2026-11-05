# Run FlyBot in Docker

[中文](docker.zh.md)

One person runs one FlyBot on a Linux machine that stays on, so Bots and schedules keep working with the laptop closed. The container runs `dsh web` (DSH 0.2.1-rc.2, as in the README) with the FlyBot core and the social, tree, workflow and timeline plugins of the checkout you build from. Instances talk to each other only through [Bot Social](https://github.com/Birfy/bot-social), which is not in the image; host it yourself.

You build the image yourself. FlyBot does not publish an image.

## What you get

- **One data volume**, `/data`: the DSH home (Bots, Sessions, settings, credentials), the Bots' working folder `/data/workspace` and the pnpm store.
- **A normal user**, not root (uid 1000).
- **The core's runtime libraries.** The profile links the FlyBot packages, and a link installs none of a package's own dependencies, so the image carries them: the Feishu long-connection SDK and the Claude and Codex executor SDKs, at the versions in `core/package-lock.json`. The build stops if one is missing.
- **No keys in the image.** You give the DeepSeek key at run time.
- **The port on `127.0.0.1` only.** The container shares the host's network (`network_mode: host`) and the web server binds that loopback itself, because DSH 0.2.1 refuses a wildcard host. For access from another machine use your own HTTPS reverse proxy or an SSH tunnel. Never publish the port on a public address: whoever reaches it with the sign-in link controls your Bots, and they can run commands.
- **A health check**: `docker compose ps` shows `healthy` once the web server answers.

## Start

You need Docker with the compose plugin on Linux — Docker Desktop for macOS and Windows does not route host networking, so `network_mode: host` there does not reach your machine — and a clone of this repository.

```sh
git clone https://github.com/ThinkFlowLab/FlyBot && cd FlyBot
git checkout vX.Y.Z                # a release tag (see Releases); main also works
FLYBOT_TAG=$(git describe --tags) docker compose up -d --build
docker compose logs flybot | grep token=
```

`FLYBOT_TAG` names the image after the version you built, so an older one stays available for a roll back. Without it the image is `flybot:local`; to keep the version for later `docker compose up` runs, also write the `FLYBOT_TAG=…` line into `.env`.

Open the printed `http://127.0.0.1:3080/?token=…` link. The link changes on every start; the browser stays signed in after the first visit. With another host port (`FLYBOT_PORT`), change the port in the link.

**DeepSeek key.** Either enter it in the app (it is saved on the data volume; see [Set a DeepSeek API key](deepseek-api-key.md)), or put `DEEPSEEK_API_KEY=sk-…` in a `.env` file next to `compose.yaml` (never commit it) and run `docker compose up -d` again. A key from the environment wins and cannot be changed in the app.

**Bot Social.** Set the server as in the README, in `/data/profiles/web/cordis.patch.yml`:

```sh
docker compose exec -T flybot sh -c 'cat >> /data/profiles/web/cordis.patch.yml' <<'YAML'
- id: flybot-social
  config:
    server: https://your-server.example.com
    displayName: Your Name
YAML
docker compose restart flybot
```

**From another machine.** An SSH tunnel needs nothing on the server:

```sh
ssh -N -L 3080:127.0.0.1:3080 you@your-server
```

Then open the link from the logs on your own machine. A reverse proxy (Caddy, nginx) on the server works too; give it HTTPS, forward to `127.0.0.1:3080`, and start DSH with that name trusted, for example by adding to `compose.yaml` under `flybot`: `command: ["--trusted-host", "flybot.example.com"]`.

**Local network deployment.** The optional `docker/compose.local.yaml` override publishes the console on all host interfaces through a TCP relay. Set `FLYBOT_TRUSTED_HOST` to the exact hostname or IP and public port used in the browser; replace the example address with this machine's local address:

```sh
FLYBOT_TRUSTED_HOST=192.168.1.10:3080 docker compose -f compose.yaml -f docker/compose.local.yaml up -d --build
```

Keep the same Compose project name when updating an existing deployment so it reuses the data volume. `FLYBOT_PUBLIC_PORT` changes the console's published port; `FLYBOT_FEISHU_PUBLIC_PORT` changes the separate Feishu event port (default 3082). Publishing a port alone does not authorize browser API requests: without the trusted host, the sign-in page can open while `/api/bot` and WebSocket requests return HTTP 403. The override requires an explicit trusted host to prevent that incomplete setup. Verify a signed-in API request from the actual browser address, in addition to container health. Cookie authentication and rejection of other hosts and cross-origin requests remain enabled.

**More people on one machine.** One project name, port and volume each:

```sh
FLYBOT_PORT=3081 docker compose -p alice up -d --build
FLYBOT_PORT=3082 docker compose -p bob up -d
```

## Stop

```sh
docker compose stop        # stop; start again with: docker compose start
docker compose down        # remove the container; the data volume stays
```

`docker compose down -v` also deletes the data volume, with every Bot. Back up first.

## Upgrade

Back up first (see below), then build the new tag. The FlyBot packages come from the image, so a new image is a new FlyBot; your settings and any plugin you added stay on the volume.

```sh
git fetch --tags && git checkout vX.Y.Z      # the new tag
FLYBOT_TAG=$(git describe --tags) docker compose up -d --build
```

## Roll back

The previous image is still there under its tag (`docker image ls flybot` lists them):

```sh
FLYBOT_TAG=vX.Y.Z docker compose up -d      # the previous tag
```

If the newer version already changed data on the volume, restore the backup you made before the upgrade.

## Back up and restore

Stop the instance, copy the volume to a file, start again:

```sh
docker compose stop
docker compose run --rm -T --no-deps --entrypoint tar flybot -czf - -C /data . > flybot-backup.tgz
docker compose start
```

Restore into the (empty or old) volume:

```sh
docker compose stop
docker compose run --rm -T --no-deps --entrypoint sh flybot -c 'find /data -mindepth 1 -delete && tar -xzf - -C /data' < flybot-backup.tgz
docker compose start
```

The backup holds your credentials (model keys, Bot Social login): keep it private.

## Not in this image

- Publishing to an image registry, and deploying.
- Desktop-only features (DSH Desktop, opening files in local apps).
