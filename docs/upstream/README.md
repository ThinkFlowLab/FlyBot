# Upstream snapshots

OpenTeamily-authored documentation for the first FlyBot customization and
Bot Social source import. This is a **needed-set** import, not a
whole-repository copy. It does not vendor FlyBot `core/` (the old v0.1.5
fork); the runtime baseline is upstream DS-Bot v0.3.6 (PR #21).

- [SELECTION.md](SELECTION.md) — include and exclude lists with reasons
- [MIGRATION.md](MIGRATION.md) — pins, layout, verification
- [DEPENDENCY-GRAPH.md](DEPENDENCY-GRAPH.md) — baseline, social, Bot Social, omitted plugins
- [OPTIONAL-PLUGINS.md](OPTIONAL-PLUGINS.md) — Project, Timeline, Tree, Workflow path
- [INTEGRATION.md](INTEGRATION.md) — management-server wiring, not done yet
- [GAPS.md](GAPS.md) — Docker, DSH, and product gaps
- [migration-manifest.json](migration-manifest.json) — counts, pins, exclusion lists, modified files
- [flybot-files.json](flybot-files.json) / [bot-social-files.json](bot-social-files.json) — per-file sha256 and git blob for unmodified files

Verify with `python3 scripts/verify-upstream-migration.py`.
