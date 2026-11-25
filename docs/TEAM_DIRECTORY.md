# Public team directory

Related: [#5](https://github.com/openTeamily/openTeamily/issues/5), [#7](https://github.com/openTeamily/openTeamily/issues/7), [#89](https://github.com/openTeamily/openTeamily/issues/89).

Functional flow, not compared with Teamily (no layout evidence for this surface).

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET/POST | `/v1/workspaces/{wid}/directory` | owner/admin read, owner write | `{listed, summary≤200}`. Unlisting revokes the listing's invite. |
| GET | `/v1/team-directory?q=&limit=` | any signed-in account | Search listed teams by name or summary (LIKE-escaped, ≤60 chars, ≤50 rows). Returns name, summary, member count and the caller's membership (`member`/`pending`/`null`). |
| POST | `/v1/team-directory/{wid}/join` | signed-in, not a member | Creates a pending join request through the existing approval queue (`202`, replay `200`). Backed by one approval-required member invite owned by the listing and renewed when spent or expired. |

Anonymous visitors see nothing. The members page has 「团队目录」 (owner) and 「发现团队」 sections.
