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

It checks the Node floor and the four packages in the repository
(`core`, `plugins/social`, `plugins/tree`, `plugins/timeline`) and prints the `dsh plugin add`
commands for the clean-profile install: `path:/core`, `path:/plugins/social` and `path:/plugins/tree`.
`@flybot/timeline` is opt-in (off by default), so its command is not in that list; see the README. It reads the filesystem only: no network, no tokens,
no `~/.dsh`.
