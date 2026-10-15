# Changelog fragments

One file per user-visible change, so two PRs never edit the same lines of `CHANGELOG.md`.

Name: `changelog.d/<issue-or-slug>.<kind>.md`, with `kind` one of `added`, `changed`, `deprecated`,
`removed`, `fixed`, `security`. Example: `changelog.d/92-face-to-face.added.md`.

Content: the entry text only, as one paragraph, with no leading `- ` and no heading (the bullet and the
`### Added` heading are added when the release is assembled). Put the issue link in the text, like the
entries in `CHANGELOG.md`.

```sh
node .github/scripts/changelog.mjs check       # CI runs this: names and content are well formed
node .github/scripts/changelog.mjs preview     # what the fragments will add
```

Release (a maintainer, in the release PR; the `v*` tag needs the `## [x.y.z]` section on `main`):

```sh
node .github/scripts/changelog.mjs release 0.1.1 --date 2026-10-20   # add --dry-run to look first
```

It moves the entries still written under `## [Unreleased]` in `CHANGELOG.md` and every fragment into
`## [0.1.1] - 2026-10-20` (merged per kind, hand-written entries first, fragments in file-name order),
deletes the fragment files and leaves `[Unreleased]` empty. A change that users cannot see needs no fragment.
