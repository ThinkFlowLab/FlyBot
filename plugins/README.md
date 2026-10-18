# FlyBot plugins

Peer plugin packages at the repository root: `social` (`@flybot/social`), `tree`
(`@flybot/tree`) and `timeline` (`@flybot/timeline`). They are not part of `core/` and are not carried by any
`patches/ds-bot/` patch.

## Install doctor

Before publishing or handing out install commands, run the doctor from `core/`:

```sh
cd core
npm run install:doctor
```

It checks the Node floor and the four packages the clean-profile install needs
(`core`, `plugins/social`, `plugins/tree`, `plugins/timeline`) and prints the `dsh plugin add`
commands with the `path:/core`, `path:/plugins/social`, `path:/plugins/tree` and
`path:/plugins/timeline` paths the README documents. It reads the filesystem only: no network, no tokens,
no `~/.dsh`.
