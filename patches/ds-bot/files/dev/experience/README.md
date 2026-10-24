# Experience library (#874 Step 2)

Dated lessons keyed by repository and tech stack. This is a Harness²-style **library only**. It does not rewrite Lite, Medium, or Heavy while a task runs, and it does not call a model. Root [LESSONS.md](../../../LESSONS.md) stays the global agent log. This tree does not replace it, and a harness tier does not inject either one.

## Layout

```
core/dev/experience/
  repos/<owner>/<name>/<id>.json
  stacks/<techStack>/<id>.json
```

A file under `repos/` must say `"repo": "<owner>/<name>"`. It may list `techStacks`. Those tags stay inside that repo.

A file under `stacks/` must say `"repo": null` and `"techStacks": ["<techStack>"]`. That is the only shared scope. Another repo's file is never opened for a lookup that did not name it.

Each entry has `id`, `date` (`YYYY-MM-DD`), `trigger`, `wrong`, and `right`. `seen` and `refs` (`#123`) are optional.

## Read

`lookupExperience({ repo, techStack, query, root })` in `core/src/host/experience.js`:

| Call | Result |
| --- | --- |
| `repo` only | That repo's files |
| `techStack` only | Shared files under `stacks/<techStack>/` |
| both | That repo's entries tagged with the stack, plus the shared stack entries |
| neither | No entries |

`query` filters `id`, `trigger`, `wrong`, and `right` after the scope is fixed. Results sort by `date` descending, then `id` ascending.

`harnessExperience` on the host harness is that read. `resolveHarness` does not attach lessons. `applied` stays false.

The npm package does not ship `core/dev/`. A packaged install's default read returns no entries.

## Write

Add or edit a JSON file and commit it.

```sh
node core/dev/experience/check.mjs
node core/dev/experience/check.mjs add --repo ThinkFlowLab/FlyBot --id <id> \
  --date YYYY-MM-DD --trigger '...' --wrong '...' --right '...'
node core/dev/experience/check.mjs add --tech-stack node-host --id <id> \
  --date YYYY-MM-DD --trigger '...' --wrong '...' --right '...'
```

`add` writes one new file and refuses to overwrite. It does not edit harness configs. `check` exits non-zero when a path and its fields disagree.
