# 快速开始

这个页面提供两条路径。本地预览适合查看界面和开发管理端。完整部署适合体验实际的智能体回复、多用户协作与独立容器。

## 本地预览

准备 Git 和 Python 3.11 或更高版本。下面的命令启动一个只监听本机的管理服务，使用单独的临时数据库。

```sh
git clone https://github.com/ThinkFlowLab/FlyBot.git
cd FlyBot

preview_data="$(mktemp -d)"
preview_data="$(cd "$preview_data" && pwd -P)"
python3 -m flybot_workspace.server \
  --data-dir "$preview_data" \
  --origin http://127.0.0.1:8787 \
  --port 8787 \
  --insecure-local \
  --open-registration
```

在浏览器打开 [本地登录页](http://127.0.0.1:8787/login)，注册一个开发账号。可以查看账号和工作区界面。试用真实智能体需要完成下一节的运行时部署。用 Ctrl+C 停止服务。临时目录路径可用于复查本次开发数据。

## 完整部署

在 Linux 主机准备 Docker Engine、Compose v2 和支持额外构建上下文的 BuildKit。先从当前仓库构建运行时镜像。

```sh
dsh_version="$(python3 -c 'import json; print(json.load(open("runtime/ds-bot-upstream.pin.json"))["dsh"])')"
docker build \
  --build-context flybot-workspace-static=flybot_workspace/static \
  --build-arg "DSH_VERSION=$dsh_version" \
  -f runtime/flybot-image/Dockerfile \
  -t flybot-workspace-runtime:local runtime
```

1. 将镜像推送到自有镜像仓库，记录返回的不可变镜像摘要。为管理服务和管理器配置同一个 `repository@sha256:…` 引用，照 [Compose 管理器说明](COMPOSE_MANAGER.md) 设置授权、存储和自动开通。
2. 照 [Bot Social 部署说明](../deploy/isolated/BOT_SOCIAL_DEPLOY.md) 配置共享服务、网关路由与独立容器之间的通信。对外入口使用 HTTPS。
3. 通过操作员授权配置平台默认模型 API。模型密钥由操作员配置或用户容器保管。对照 [管理 API](MANAGEMENT_API.md) 中的平台模型配置说明填写模型供应商、接口地址与模型标识。
4. 用两个测试账号验证注册、首次聊天、跨工作区复用容器、账号数据隔离和重启后私聊保留。可以参考 [验收记录](ACCEPTANCE.md) 的步骤。

管理服务、用户容器和 Bot Social 的边界见 [系统架构](ARCHITECTURE.md)。版本升级前备份管理数据、Bot Social 数据和用户数据卷。

## 创建第一个智能体

在「发现 → 智能体」打开「创建智能体」，描述你想交给它的工作。点击「生成草稿」后，可以修改名称、简介、说明和快捷开场，也可以选择头像。核对后点击「创建」，再从智能体卡片打开聊天。草稿由当前账号的 DS-Bot 使用已配置的模型生成。

## 开发时验证改动

在仓库根目录运行管理端用例。运行 DS-Bot 插件测试时使用 Node.js 22 或 24。

```sh
python3 -m unittest discover -s tests
node --test tests/chat_page.test.mjs tests/discover_page.test.mjs
node --test runtime/flybot-workspace-web/test/*.test.js
```

在桌面与手机宽度各走一次受影响的路径。记录操作前后截图、真实网络响应和错误分支。仓库的 [Chromium 工作流](../.github/workflows/ui-screenshots.yml) 与 [镜像工作流](../.github/workflows/flybot-runtime-image.yml) 可用于复核。
