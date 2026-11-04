# Reviewed Project host merge

Owner decision recorded in [#2331](https://github.com/ThinkFlowLab/FlyBot/issues/2331):
valid Reviewer approval of the exact current candidate automatically enters the
host merge flow within explicitly configured Project/repository/branch/check scope,
without another per-PR Owner/Chief permission click. Host uses original selected
broker identity and Effects; GitHub protection/required review/queue still applies.
Candidate recommendation is not signed forge Review or actual merged evidence.
Chief independently judges Task acceptance. No release, deployment, credential,
repository-rule change or arbitrary live PR merge is granted by this decision.
Current [implementation contract](../docs/project-merge.md) describes boundaries.
