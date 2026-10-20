# 用 Docker 运行 FlyBot

[English](docker.md)

每人在一台一直开着的 Linux 机器上运行一个 FlyBot，合上笔记本后 Bot 和定时任务照常工作。容器里运行 `dsh web`（DSH 0.2.0-rc.2，与 README 相同），带上你构建所用代码里的 FlyBot 核心以及 social、tree、timeline 插件。实例之间只通过 [Bot Social](https://github.com/Birfy/bot-social) 通信；Bot Social 不在镜像里，需要你自己部署。

镜像由你自己构建，FlyBot 不发布镜像。

## 包含什么

- **一个数据卷** `/data`：DSH 目录（Bot、会话、设置、凭据）、Bot 的工作目录 `/data/workspace` 和 pnpm 缓存。
- **普通用户运行**，不是 root（uid 1000）。
- **镜像里没有密钥。** DeepSeek Key 在运行时提供。
- **端口只绑定 `127.0.0.1`。** 从别的机器访问请用你自己的 HTTPS 反向代理或 SSH 隧道。不要把端口暴露到公网：拿到登录链接的人就能控制你的 Bot，而 Bot 能执行命令。
- **健康检查**：Web 服务能响应后，`docker compose ps` 显示 `healthy`。

## 启动

需要 Docker（带 compose 插件）和本仓库的代码。

```sh
git clone https://github.com/ThinkFlowLab/FlyBot && cd FlyBot
git checkout vX.Y.Z                # 某个发布版本（见 Releases）；main 也可以
FLYBOT_TAG=$(git describe --tags) docker compose up -d --build
docker compose logs flybot | grep token=
```

`FLYBOT_TAG` 用构建的版本给镜像命名，这样旧镜像会保留下来，方便回滚。不设置时镜像名是 `flybot:local`；想让以后的 `docker compose up` 也用这个版本，把 `FLYBOT_TAG=…` 这一行也写进 `.env`。

打开打印出的 `http://127.0.0.1:3080/?token=…`。每次启动链接都会变；第一次打开后浏览器会保持登录。如果用 `FLYBOT_PORT` 换了主机端口，把链接里的端口一起改掉。

**DeepSeek Key。** 可以在应用里填写（保存在数据卷上，见 [Set a DeepSeek API key](deepseek-api-key.md)，英文），也可以在 `compose.yaml` 旁边建一个 `.env` 文件写上 `DEEPSEEK_API_KEY=sk-…`（不要提交到仓库），然后再运行一次 `docker compose up -d`。环境变量里的 Key 优先，并且不能在应用里修改。

**Bot Social。** 按 README 的方式在 `/data/profiles/web/cordis.patch.yml` 里设置服务器：

```sh
docker compose exec -T flybot sh -c 'cat >> /data/profiles/web/cordis.patch.yml' <<'YAML'
- id: flybot-social
  config:
    server: https://your-server.example.com
    displayName: Your Name
YAML
docker compose restart flybot
```

**从别的机器访问。** SSH 隧道不需要在服务器上装任何东西：

```sh
ssh -N -L 3080:127.0.0.1:3080 you@your-server
```

然后在自己的电脑上打开日志里的链接。也可以在服务器上用反向代理（Caddy、nginx）：配置 HTTPS，转发到 `127.0.0.1:3080`，并让 DSH 信任这个域名，例如在 `compose.yaml` 的 `flybot` 下加上 `command: ["--trusted-host", "flybot.example.com"]`。

**一台机器上多人使用。** 每人一个项目名、端口和数据卷：

```sh
FLYBOT_PORT=3081 docker compose -p alice up -d --build
FLYBOT_PORT=3082 docker compose -p bob up -d
```

## 停止

```sh
docker compose stop        # 停止；再启动用 docker compose start
docker compose down        # 删除容器；数据卷保留
```

`docker compose down -v` 会连数据卷一起删除，所有 Bot 都会丢失。请先备份。

## 升级

先备份（见下文），再构建新的版本。FlyBot 的代码来自镜像，所以新镜像就是新版本的 FlyBot；你的设置和自己添加的插件留在数据卷上。

```sh
git fetch --tags && git checkout vX.Y.Z      # 新版本
FLYBOT_TAG=$(git describe --tags) docker compose up -d --build
```

## 回滚

之前的镜像仍然以原来的标签保留着（`docker image ls flybot` 可以列出）：

```sh
FLYBOT_TAG=vX.Y.Z docker compose up -d      # 之前的版本
```

如果新版本已经改动了数据卷里的数据，请恢复升级前的备份。

## 备份与恢复

先停止实例，把数据卷打包成文件，再启动：

```sh
docker compose stop
docker compose run --rm -T --no-deps --entrypoint tar flybot -czf - -C /data . > flybot-backup.tgz
docker compose start
```

恢复到数据卷（空的或旧的）：

```sh
docker compose stop
docker compose run --rm -T --no-deps --entrypoint sh flybot -c 'find /data -mindepth 1 -delete && tar -xzf - -C /data' < flybot-backup.tgz
docker compose start
```

备份里有你的凭据（模型 Key、Bot Social 登录信息），请妥善保管。

## 这个镜像不包含

- 发布到镜像仓库，以及部署。
- 仅桌面版才有的功能（DSH Desktop、用本地应用打开文件）。
