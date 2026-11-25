# features/team-runs (B2)

Port of #378 team task runs. DAG state, dependency resolution, cancel/retry and the executor run in this
DS-Bot (`team-runs.sqlite3`); each runnable step is one native DS-Bot turn of its agent via `agents/turn`
(session `team-run:<run>:<step>:<attempt>`). `step-artifact` saves an output through `artifacts/create` (B3).
Sharing a run with a team goes through Bot Social (phase C).
