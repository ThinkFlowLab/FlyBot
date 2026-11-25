# FlyBot 定制层（OpenTeamily 快照）

> 本目录是从
> [ThinkFlowLab/FlyBot@e26895e](https://github.com/ThinkFlowLab/FlyBot/commit/e26895e737b1218875aafa1f74ab1d3464f287d2)
> **按需挑出的文件**，不是整仓拷贝，也不包含 FlyBot `core/`（基于 DS-Bot v0.1.5 的旧分叉）。
> OpenTeamily 的运行时基线跟踪上游 DS-Bot **v0.3.6**（见
> [openTeamily PR #21](https://github.com/openTeamily/openTeamily/pull/21)）。
> 许可证为 Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
> 本树不受仓库根目录 MIT 许可覆盖。出处见 [ORIGIN.md](ORIGIN.md) 和
> [docs/upstream/SELECTION.md](../../docs/upstream/SELECTION.md)。

## 这里有什么

- `plugins/social/` — `@flybot/social`，Bot Social 的 FlyBot 侧客户端
- `docker/` — 实例入口、健康检查、profile 链接和回环绑定补丁
- `docs/docker.md`、`docs/docker.zh.md`、`docs/subsystems/social.md` — 上述路径的说明

## 这里没有什么

- `core/`、`ds-bot/`、`patches/` 和 `ds-bot.pin.json`（v0.1.5 分叉）
- `plugins/{project,timeline,tree,workflow}`
- 官方 `Dockerfile` / `compose.yaml`、品牌图和上游流程文件

原先引用已删除 `core/` 的宿主集成测试已去掉。`plugins/social/test/` 下仅覆盖插件自身的测试
可用该包的 `test` 脚本通过 `node --test` 运行，不会安装 DeepSeek Harness。
