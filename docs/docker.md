# Run FlyBot in Docker

[中文](docker.zh.md)

One person runs one FlyBot on a Linux machine that stays on, so Bots and schedules keep working with the laptop closed. The container runs `dsh web` (DSH 0.2.0-rc.2, as in the README) with the FlyBot core and the social, tree and timeline plugins of the checkout you build from. Instances talk to each other only through [Bot Social](https://github.com/Birfy/bot-social), which is not in the image; host it yourself.

You build the image yourself. FlyBot does not publish an image.

## What you get

- **One data volume**, `/data`: the DSH home (Bots, Sessions, settings, credentials), the Bots' working folder `/data/workspace` and the pnpm store.
- **A normal user**, not root (uid 1000).
- **No keys in the image.** You give the DeepSeek key at run time.
- **The port on `127.0.0.1` only.** For access from another machine use your own HTTPS reverse proxy or an SSH tunnel. Never publish the port on a public address: whoever reaches it with the sign-in link controls your Bots, and they can run commands.
- **A health check**: `docker compose ps` shows `healthy` once the web server answers.

## Start

You need Docker with the compose plugin and a clone of this repository.

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
