# @flybot/workflow

A Workflow is a group-shaped chat of local Bots. The sidebar row opens the run: a pill header, progress, bubbles, a composer, and a flowchart. The same graph is what a drag-drop edit saves and what a run highlights.

This is not the workflow-definition engine (`workflows/<id>.json`, #1272). This plugin does not read or write those files. Settings → Workflows lists these pipelines and opens the same graph.

## What you can do

- Open a template. **发布交付流水线** is Planner → Writer → Coder → (Reviewer ‖ Tester) → Deployer. **每周报告** is a short chain with a Friday label. Each of those nodes names its inputs and outputs.
- Create or edit a graph in the flowchart, or in Settings → Workflow graphs. Drag a local Bot onto the canvas, move a node, draw or drop an edge, and edit each node's system prompt. Both surfaces write the same graph.
- Hand a board task to a Workflow, or to one local Bot, from the assign dialog. A Workflow starts a live run or queues the task. A Bot becomes the card's owner and does not start a run. A remote Bot is refused.
- Let an open card assign itself. The matcher is `src/match.js`, first hit, and only while the card is `open`. A saved Bot claim beats a workflow trigger. Otherwise:
  1. a `workflow:<id or name>` token in the title, note, criteria or tags
  2. `workflowId` or `workflow`
  3. `assignee` naming a workflow
  4. a `bot:<id or name>` token
  5. `assignee` naming a local Bot (a remote Bot never matches)
  6. a workflow trigger contained in the title, note or criteria (longest trigger wins)
- A miss stays unassigned for the manual picker.

## A live run

Assigning a task, `run_workflow`, or a Workflow match starts a live run. One hidden ephemeral Bot is created per node, used for that step, and removed when the run finishes. A node does not need a permanent sidebar Bot. `tools` on the node is what that Bot can use: `github` grants the GitHub connector (pull requests, reviews, comments), `bash` grants a shell at full access, and every step gets at least workspace write. The Main Bot sends that node its step. The node stays `running` until that Bot replies. The reply is the chat line for the step. The next node starts only after that reply, and only along the edges: every predecessor is done first, and nodes that share a rank run together.

A second task does not replace a run that is already going, and it does not release that run's Bots. It waits in a FIFO queue. The stage shows a chip when more than one run is active or the queue is not empty, and it refreshes `workflow/state` while a live run exists. That refresh does not advance the graph. The product UI does not offer a canned demo replay; only live runs advance the graph.

Each workflow allows `maxConcurrent` live runs at once. The default is 2. The value is an integer from 1 to 8, set on create (`maxConcurrent`) or with `workflow/concurrency` (`{ workflowId, maxConcurrent }`). The stage lists the current value under Details. The host runs at most 6 live runs across every workflow. A task that does not fit is queued. When any run finishes, the oldest queued task whose workflow still has room starts, whichever workflow it belongs to. A new assign waits behind a task already queued there. Lowering the cap does not stop a run that has already started. History keeps finished and failed runs only.

## Inputs and outputs

A node may declare up to eight inputs and eight outputs. A name matches `^[a-z][a-z0-9-]{0,40}$`, and the type defaults to `text`. Mark an input `required: true` when the node cannot start without it.

A required input must be an output of the same name on an ancestor. A root node may instead require `task`, `title`, or `brief`, which come from the assignment. Starting a run is refused when a required input has no provider, and any Bots already created for that attempt are removed.

On a live run, a successor stays queued until its required inputs are present. If every predecessor is already done or failed and an input is still missing, that node fails and the run stops. The dispatch text includes `Input <name>: <value>`. The Bot reports outputs as `OUTPUT <name>: <value>`. A node with one declared output may put that value in the reply body.

The delivery template passes `task` → `plan` → `copy` → `patch`, then `review` and `report` into `release`. Coder and Tester name `bash`; Coder, Reviewer and Deployer name `github`. The weekly template passes `task` → `notes` → `metrics` → `report`.

## Branches and loops

An edge may be a condition or a loop. A condition is `when: { output, eq }` on the edge out of the node that produced `output`. The edge is taken only when that output equals `eq`. `when: { else: true }` is the other branch, taken when no `eq` edge matched. A node that no taken edge reaches is skipped. A later join starts once every incoming edge is either taken and done, or skipped.

A loop is `loop: true` on the edge that returns to the body, with `max` from 1 to 8 (default 3) and an optional `until: { output, eq }`. The body runs again while `until` does not match and the run count is still under `max`. A branch the previous pass skipped can be chosen the next time. The forward edges wait until the loop stops. A loop is the only cycle the graph allows. Settings → Workflow graphs can add a link, a condition, or a loop. After a live run finishes, the stage keeps showing that run until a new one starts.

## When a step does not land

A dispatch that does not land — no Main Bot to send from, `ok: false`, or `deny` / `hold` — is not recorded as handed. The Workflow chat names the code, such as `no-sender`, and the node stays open so the next hand-off sends it again. That retry is the next hand-off, not a second send in the same breath, so a burst of 429s is not hammered. The run and its Bots stay until the step is accepted, the run fails for another reason, or it is reset.

A reply that says the model could not answer (`could not answer your message` or `model call failed`) fails that node in the chat. It is not retried in a loop, and its successor does not start. A 429 or a rate-limit mention in an otherwise successful reply does not fail the node.

## Tools

A local Bot uses the same store:

- `run_workflow` — `workflow` (id or exact name) and `brief` (the task). Optional `task` id. This joins the same queue a manual assign uses.
- `define_workflow` — `name`, `nodes` (`{ id, name, prompt?, role?, model?, tools?, botId?, inputs?, outputs?, x?, y? }`), `edges` (`{ from, to, when?, loop?, max?, until? }`). `prompt` is that node's Bot system prompt. `tools` equips the ephemeral Bot (`github`, `bash`, `read`, `edit`). `botId` is optional. `inputs` and `outputs` are `{ name, type?, required? }`. `when` chooses an edge; `loop: true` with `max` is the only cycle. Pass `workflow` to replace one. A friend's Bot is refused. This writes the same graph Settings and the flowchart edit.

## Install

Default, with the core, social and tree:

```sh
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:ThinkFlowLab/FlyBot#main&path:/plugins/workflow"
```

`enabled: false` registers nothing.

## Develop

```sh
npm test
```

Endpoints, all under `flybot/workflow/`: `state`, `templates` (read), `create`, `assign`, `concurrency`, `advance`, `demo-step`, `reset`, `say`, `graph`, `ingest`.

## 中文

Workflow 是一组本地 Bot 的群聊式运行。侧栏打开同一次运行：进度、气泡、流程图。这不是 `workflows/<id>.json` 那套定义引擎（#1272）。

把看板任务交给一个 Workflow，会开始一次真实运行，或在已有运行占满时排进 FIFO 队列。交给一个本地 Bot，只把卡片的负责人设成该 Bot，不会启动 Workflow。远程 Bot 会被拒绝。

一次真实运行会为每个节点创建一个隐藏的临时 Bot，用完即删。节点不必绑定侧栏里的永久 Bot。`tools` 决定这个 Bot 能用什么：`github` 授予 GitHub 连接器（拉取请求、评审、评论），`bash` 授予完整权限的 shell，其余步骤至少可以写工作区。节点一直处于运行中，直到该 Bot 回复。回复写入 Workflow 聊天，下一节点才沿边开始。正在进行的运行不会被新任务替换，也不会因此释放它的 Bot。历史里只留下已完成或已失败的运行。

每个 Workflow 同时运行的上限是 `maxConcurrent`，默认 2，取 1 到 8 的整数，在创建时传入，或调用 `workflow/concurrency`。全部 Workflow 加在一起最多 6 个正在运行的任务。某个运行结束后，所有 Workflow 里最早排队、且自己还有空位的任务会开始。新的分配排在已经排队的任务后面。降低上限不会停掉已经开始的运行。舞台在详情里显示当前上限；有排队或同时多于一个运行时显示队列条。有真实运行时，页面只刷新状态。产品界面不提供预置演示重放，只有真实运行会推进图。

每个节点最多声明 8 个输入和 8 个输出，名字为小写字母开头的短名。必填输入必须由上游同名输出提供；根节点可以用 `task`、`title` 或 `brief`。没有提供者时，运行拒绝开始。Bot 用 `OUTPUT 名字: 值` 交回输出；只声明一个输出时，回复正文即可。

边可以是条件或循环。条件是 `when: { output, eq }`，只有该输出等于 `eq` 才走这条边；`when: { else: true }` 是其余分支。没被选中的节点标为跳过，汇合节点不因此卡住。循环边是 `loop: true`，`max` 为 1 到 8（默认 3），可选 `until: { output, eq }`。在达到 `max` 或 `until` 命中之前，循环体再跑一遍，正向的边先等着。上一轮跳过的分支，下一轮可以再选。只有循环边可以成环。设置页可以添加连线、条件或循环。真实运行结束后，舞台继续显示那次运行，直到有新的真实运行开始。

派发没有送达（例如没有 Main 可发送，`no-sender`）不会记成已交接。聊天里写明原因，节点保持运行，下一次交接再发送。同一次交接里不会连发，避免把 429 打成一串。这次运行和它的 Bot 会留到这一步被接受、运行因别的原因失败，或被重置。回复是「could not answer your message」或「model call failed」时，该节点失败且不自动连试，后续节点不开始。成功回复里提到 429 或 rate limit 不会让节点失败。
