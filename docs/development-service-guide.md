# Project 协作与开发流程

[快速开始](../README.md) · [API](development-service-api.md) · [部署与执行配置](backend-operations.md)

## 先区分对象

| 对象 | 长期身份与用途 | 不应混淆的边界 |
| --- | --- | --- |
| User / PersonalAgent | 人类及独立于Project的内部/外部个人代理 | 加入Project形成participation，不把代理绑定为某个项目的永久子对象 |
| Project | 项目定位、成员/权限、仓库关联、角色治理和历史 | 仓库不是Project；可无仓库、多仓库，一个仓库也可被多项目关联 |
| Role | 人设、职责、Skills、长期记忆引用、Harness/Resource约定 | Chief是常驻项目角色；Dev/Reviewer/Tester等按Task工作。角色名不授予权限 |
| Task | 对项目产生直接/间接影响的工作承诺、要求版本、依赖和结果 | 咨询不是Task；一次失败Attempt不等于Task被取消或关闭 |
| Attempt / Session | 一次执行尝试及该Task/角色的逻辑与物理上下文 | 同Task打回恢复原角色Session；新Task另建。不能因重启而重复外部动作 |
| Handoff | 可持久化交接契约：源/目标、Task/上下文版本、receipt和主动权 | 发出、对方接手和完成是不同状态；不是一次无回执的消息或固定DAG边 |
| Consultation | 私有咨询/回复/问题升级，有独立receipt | 不转移Task主动权；默认优先个人代理，需要人类决定才升级到对应的人 |
| Execution / Harness / Resource | 原宿主/SDK执行、环境/容量、lease/退出证明 | 分配资源不等于已启动；Bot/PID消失不等于已退出 |

默认Chief/Dev/Reviewer/Tester可扩展。Chief增加、修改、删除角色需Maintainer/Owner批准精确提案；退休保留历史，活动工作不被悄悄改派。
个人Chief、个人Bot、原生群聊可不参与任何Project。加入/关联项目不公开私有聊天和记忆；公共Bot只展示授权公开的人设与角色记忆。

## 一次咨询

使用consultation.ask，说“解释当前设计”或“帮我判断这个问题”。返回私有咨询receipt，异步回答通过consultation.get/list读取。
框架不为提问发布Task，不借问答触发代码修改。个人代理对外代表你时，来源和返回收件人绑定独立身份，其他项目成员不能读取这段私聊。
若咨询最终形成代码变更、技术方案采纳、版本发布等影响项目的行动，再经授权发布Task；对已有Task的补充走input.publish。

## 首个代码任务

以下是正常服务操作路径，不创建测试模型/样例仓库。把实际ID、仓库、测试命令和资源填入[执行配置](backend-operations.md#执行配置)。

1. 在启动配置中登记你可访问的Git仓库、真实testCommand、允许路径；为Chief配置真实模型，执行角色配置可用Harness/Resource。若要PR写入，配置准确账户的GitHub凭据并验证登录。重启只作用于你部署的实例，健康活动工作先到检查点。
2. `request project-create --json '{"name":"My project","repository":"YOUR_ORG/YOUR_REPO"}'`，保存返回project.id。已有项目可通过project-repository-link关联；当前交付仍使用项目选定的执行仓库，关联多仓库不等于一个Attempt跨仓库修改。
3. `query roles --project PROJECT_ID` 查看当前角色；`query execution.boundary --project PROJECT_ID` 查看真实readiness，再通过原runtime-check验证SDK身份。Owner/Maintainer可通过原project-agent-definition授权配置现有角色的Harness/资源；Chief提出角色变更则需治理批准。所有变更均不得覆盖活动Task的固定快照。
4. `command chief.configure --project PROJECT_ID --request-id enable-chief-1 --json '{"enabled":true,"inspection":{"enabled":true,"when":{"kind":"every","seconds":1800}}}'` 启用Chief及巡检配置。先确认你的后台授权仍有效；平台模式无人值守需principal checker。
5. `command task.propose --project PROJECT_ID --request-id fix-1 --json '{"title":"修复明确缺陷","criteria":"复现、必要回归和独立Review通过","impact":"恢复项目功能"}'`。从result.id取得Task ID；Chief判断要求充分后接纳并提交task.start。
6. 用`query task --project PROJECT_ID --json '{"taskId":"TASK_ID"}'`、pools及events观察。task.run可对同Task请求启动；未接纳时仍等待Chief，不能用手动run越过接纳或资源边界。
7. Dev取得当前Task/角色上下文，决定执行、打回或转交；产物交下游，宿主验证候选、真实测试、Review与SHA。打回同Task时resume前次上下文，不能偷偷换一条空白SDK线程。
8. Bot认为完成或不确定时交Chief裁定。Chief可让下一角色补证据、返工、询问个人代理/人类，满足证据后才关闭Task。PR发布、合并、版本发布和部署各需对应权限与动作，不能把Task关闭当自动合并部署。

命令前均加`node scripts/backend.mjs`，自定义home时所有命令传同一个--home。详细CLI信封/字段见[API](development-service-api.md)。
仓库、凭据、模型或可用Resource缺失时阻塞是实际状态，不能写作“已自动开发”。decision/release可建Task，但不会绕过执行/证据要求；未配置的发布验证器会明确拒绝。

## 单线、并行与持久交接

单线工作只保留一个当前主动权。Bot通过已绑定的执行回调选择下一角色，宿主先确认旧工作退出与产物，再提交Handoff；下游从自己的池中接受，确认后才持有新的claim。
Handoff保留predecessor、上下文引用、要求版本、授权来源和接受/处理回执，恢复与重放读取原契约。

可并行时，原Task进入waiting-children，先释放原执行资源，再由原Task契约开有限子Task。
子Task分别接纳、执行和Chief裁定；失败/取消不自动算成功。Chief可明确豁免或替代并留证。
必要子结果完成且集成源/测试/Review被宿主验证后，父Task仅重新入列一次，恢复原角色Session继续集成。
原任务的依赖、主动权和状态仍在同一个Task记录中，不由前端DAG推断。

Chief巡检是原定时任务的一项可配置工作，30分钟是策略默认值，不是框架硬编码的常驻派活循环。
长时间无进展、重复打回/转交、执行过长或无法确认退出可升级给Chief；它受当前治理授权和证据约束，不可把未知退出改成“资源空闲”。

## 安全代理与值守代理

安全模式允许代理私下整理提案和咨询，但发布共享Task需用户授权。
外部代理用personal-agent-create/join、token-create获得Project限定连接；safe proposal保留title/criteria/impact/scope，由人类proposal.publish变成原Task。
值守模式由本人显式授权，代理在当前用户权限范围内自主发布/控制；不因改名、换carrier或默认代理而扩权。
撤销连接、退出项目、停用账号或撤销watch立即阻止新操作，并通过原执行停止/退出确认机制处理活动工作。

Owner关闭项目采用prepare/confirm二次检查。Maintainer或个人代理可建议；不能代Owner本人确认。
关闭保留历史、最终记录和未完成Task引用，不要求先清空Task池。

## 状态由谁承载和更新

原Store和同一领域服务持有Project、Task、Attempt、Session、Handoff、Effects与角色记录；默认部署选SQLite，支持显式JSON模式。
任务创建/接纳/claim/交接/退出/证据/裁定等确定性业务动作在提交时更新相应事实；事务失败不能对外宣称已执行。
读取、每条聊天、每个工具调用不会问Bot“是否要改项目定位”。定位/范围的语义变化由授权主体明确提出并经过治理。
概览/TaskView是已提交事实的派生视图，摘要是有来源和版本的辅助材料，都不是另一套可写Task状态。
Effects先持久提交意图，后调用已有执行器/外部服务，结果也留回执。未知结果需核对，不凭超时猜测失败后重发。

## 控制上下文和历史增长

- Chief保留长期身份、精简工作摘要和作用域长期记忆；完整日志留存为源，不逐轮塞入提示词。
- 角色Session按Task隔离，返工resume；固定人设/Skills/要求/模型快照，当前权限另行重验。
- 预算按操作者→Harness→模型能力选择，计入最终系统/输入/工具结果；大内容按限定来源和SHA分页。
- 长期记忆有revision、来源、回滚与精简约束；高频事件不自动写成永久记忆。summary不能冒充正式事实或丢掉未决承诺。
- 事件流有界保留；完整Task/交接/证据历史按引用读取。SQLite解决事务和索引，不等于自动解决上下文或无限存储增长。

源码仍整体hydrate状态，未实现通用历史GC；不要把数据库引入理解为所有文档/上下文都已无限扩容。
工具输入与模型结果的实际占用/compaction能力分别记录；SDK累计usage不是当前上下文窗口。

## 验证与未覆盖范围

生产启动工具是scripts/backend.mjs；原型/fixture launcher不是部署方法。
本轮覆盖独立home的正常安装、HTTP登录/Project/Task创建、持久重启/同回执重放，以及通过生产启动入口的原生认证、私有咨询、外部FBA安全/值守、撤权和SSE。
测试供应商使用确定性模型，不能算真实供应商自主完成代码开发。
既有DSH native交接/返工/SQLite探针与真实Codex延续证据各有自己的提交和报告；没有借这些记录声称新分支已做完整真实模型、浏览器/桌面、生产迁移或上线验收。
