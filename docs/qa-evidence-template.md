## QA 证据（exact head）

**Head** `{{head40}}` · 分支 `{{branch}}` · PR #{{pr}} · base `main {{main40}}`
**出证时间** {{UTC}} · **状态**：本地 {{通过 / 不通过}} ｜ CI {{全绿 / 部分未跑完 / 有红 / 无 run}}
**本证据只对上面这个 40 位 head 有效。分支再推任何提交，本证据立即作废，需按新 head 重出。**

### 1. 绑定：我测的字节就是这个 head（不是作者的工作副本）
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
`{{tree40}}` 等于 `/commits/{{head40}}` 的 `commit.tree.sha` → 整棵树一致，不是抽样；`tests.yml` 与 main `{{main_sha256}}` {{相同 / 不同}}。
改动面：{{n}} 文件 {{+a / −d}}；`tests.yml` 在 diff 里 {{0 项 / 有改动}}；vendor `runtime/ds-bot-upstream/**` {{0 文件}}。

### 2. 本地结果（数字来自本机，不是 CI）
| 命令 | 结果 |
|---|---|
| `node --test '{{glob}}'` | tests {{N}} / pass {{N}} / fail 0 / skipped 0 |
| `grep -rn '{{pattern}}' {{path}}` | {{grep_result}} |
| `{{dry_run_cmd}}` | exit {{code}}，{{dry_run_line}} |

逐文件：{{per_file}}

```
{{stdout_tail}}
```

### 3. CI 结果（截至 {{UTC}}，拉的是 `/commits/{{head40}}/check-runs`）
| check | 当时的结论 | run |
|---|---|---|
| {{name1}} | {{conclusion1}} | {{url1}} |
| {{name2}} | {{conclusion2}} | {{url2}} |
| {{name3}} | {{conclusion3}} | {{url3}} |

合计 {{total}} 个 check：{{x}} success ／ {{y}} 未跑完 ／ {{z}} 不存在。

### 4. 没做到 / 没覆盖到的
- {{gap1}}
- {{gap2}}
- {{gap3}}

### 5. 本证据不构成验收通过
这是我核到的「这个 head 上发生了什么」，不是「这个 PR 可以合并」：没有做产品验收，没有声明与 0.3.0 parity；合并由 Lead 决定。合并后若 rebase 或补提交，本证据作废。

Related #{{issue}}
