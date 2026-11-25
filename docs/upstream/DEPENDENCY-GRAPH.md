# Dependency graph for the first import

```
OpenTeamily management server (openteamily/, manager/)
        │  not wired in this change
        ▼
upstream DS-Bot v0.3.6 runtime (PR #21: runtime/ds-bot-upstream/)
        │  future profile / plugin load
        ▼
runtime/flybot/plugins/social     (@flybot/social customization)
runtime/flybot/docker             (instance entrypoint / health / profile helpers)
        │
        └──protocol──► services/bot-social   (optional module, not a required
                                              third production control plane)

Not imported here:
  runtime/flybot/core/            (old v0.1.5 fork — dropped)
  @flybot/{tree,workflow,project,timeline}
  @deepseek-ai/dsh*               (PR #21 CI installs the pinned DSH for the baseline)
  official FlyBot Dockerfile/compose.yaml
```

`plugins/social` production sources do not import `core/` or the other
plugins. Tests that did import `core/` were removed from this snapshot.

See [SELECTION.md](SELECTION.md) and [OPTIONAL-PLUGINS.md](OPTIONAL-PLUGINS.md).
