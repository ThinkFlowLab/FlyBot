## QA evidence (exact head)

**Head** `{{head40}}` · branch `{{branch}}` · PR #{{pr}} · base `main {{main40}}`
**Issued at** {{UTC}} · **status**: local {{pass / fail}} | CI {{all green / partly pending / red / no run}}
**This evidence holds for the 40-character head above and nothing else. Any further push to the branch voids it at once; re-issue it on the new head.**

### 1. Binding: the bytes I tested are this head (not the author's working copy)
```
$ git ls-remote origin refs/pull/{{pr}}/head
{{head40}}	refs/pull/{{pr}}/head
$ curl -sSLo head.tar.gz https://codeload.github.com/{{owner}}/{{repo}}/tar.gz/refs/pull/{{pr}}/head
$ mkdir head && tar xzf head.tar.gz -C head --strip-components=1 && cd head
$ git init -q . && git add -A -f . && git write-tree
{{tree40}}
$ sha256sum .github/workflows/tests.yml
{{tests_sha256}}
```
`{{tree40}}` equals the `commit.tree.sha` of `/commits/{{head40}}`, so the whole tree matches and this is not a sample; `tests.yml` is {{same as / different from}} main `{{main_sha256}}`.
Diff: {{n}} files {{+a / -d}}; `tests.yml` {{0 entries / changed}} in the diff; vendor `runtime/ds-bot-upstream/**` {{0 files}}.

### 2. Local results (the numbers come from this machine, not from CI)
| Command | Result |
|---|---|
| `node --test '{{glob}}'` | tests {{N}} / pass {{N}} / fail 0 / skipped 0 |
| `grep -rn '{{pattern}}' {{path}}` | {{grep_result}} |
| `{{dry_run_cmd}}` | exit {{code}}, {{dry_run_line}} |

Per file: {{per_file}}

```
{{stdout_tail}}
```

### 3. CI results (as of {{UTC}}, read from `/commits/{{head40}}/check-runs`)
| check | conclusion at that time | run |
|---|---|---|
| {{name1}} | {{conclusion1}} | {{url1}} |
| {{name2}} | {{conclusion2}} | {{url2}} |
| {{name3}} | {{conclusion3}} | {{url3}} |

{{total}} checks in total: {{x}} success / {{y}} not finished / {{z}} absent.

### 4. Not done / not covered
- {{gap1}}
- {{gap2}}
- {{gap3}}

### 5. This evidence is not an acceptance sign-off
This is what I found happened on this head, not a statement that the pull request may be merged: no product acceptance was done, no parity with 0.3.0 is claimed, and the merge is the Lead's call. If the branch is rebased or gets another commit, this evidence is void.

Related #{{issue}}
