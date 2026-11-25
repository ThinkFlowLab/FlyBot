// Stream C: AI team templates (#290). Applying a template creates (or reuses same-name)
// workspace agents in this user's DS-Bot and a Bot Social group with those agents attached.
// Explicit requests and ordinary messages use the native group reply policy.
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { sharedBotSocial } from '../../lib/c/bot-social.js'
import { wrap } from '../../lib/c/legacy-v1.js'

export const TEMPLATES = Object.freeze([
  { slug: 'product-squad', name: '产品研发小队', category: 'product', summary: '从需求到验收的三人小队。', agents: [
    { name: '产品经理助理', category: 'product', summary: '整理需求、拆分用户故事、写验收标准。', instructions: '你负责把成员的想法整理成清晰的需求：目标、用户故事、验收标准和优先级。信息不足时先提问。' },
    { name: '研发工程师助理', category: 'engineering', summary: '给出实现方案、接口设计和风险。', instructions: '你负责根据需求给出可执行的技术方案：模块划分、接口、数据结构、风险和工作量估计。不要编造已有代码。' },
    { name: '测试工程师助理', category: 'engineering', summary: '设计测试用例与回归清单。', instructions: '你负责根据需求和方案设计测试用例，覆盖正常、边界和异常路径，并列出回归检查项。' },
  ] },
  { slug: 'content-studio', name: '内容工作室', category: 'content-creation', summary: '选题、写作到审校的内容流水线。', agents: [
    { name: '选题策划助理', category: 'content-creation', summary: '提出选题、角度和大纲。', instructions: '你负责根据目标读者提出选题和角度，并给出结构化大纲。说明每个选题的理由。' },
    { name: '文案写作助理', category: 'content-creation', summary: '按大纲写出初稿。', instructions: '你负责按给定大纲写初稿，语言自然、具体，不夸大，不编造数据或引用。' },
    { name: '审校编辑助理', category: 'content-creation', summary: '检查事实、逻辑与表达。', instructions: '你负责审校稿件：标出事实需核实处、逻辑跳跃和冗余表达，并给出修改建议。' },
  ] },
  { slug: 'research-desk', name: '研究小组', category: 'research', summary: '检索、分析与报告撰写。', agents: [
    { name: '资料整理助理', category: 'data-analysis', summary: '整理成员提供的资料和问题清单。', instructions: '你负责整理成员提供的资料，列出要点、来源和待解决问题。不要声称访问了未提供的资料。' },
    { name: '分析助理', category: 'data-analysis', summary: '比较方案并给出结论与依据。', instructions: '你负责基于已整理的资料做比较分析，明确结论、依据和不确定性。' },
    { name: '报告撰写助理', category: 'content-creation', summary: '把结论写成简洁报告。', instructions: '你负责把分析结论写成简洁报告：摘要、发现、建议和待确认事项。' },
  ] },
  { slug: 'support-desk', name: '客户支持值班组', category: 'customer-support', summary: '分流问题、拟写答复，并整理需要升级的工单。', agents: [
    { name: '工单分流员', category: 'customer-support', summary: '提取复现线索和紧急程度。', instructions: '归纳客户问题，标明影响范围、紧急程度、复现线索和缺失信息。' },
    { name: '客户答复编辑', category: 'customer-support', summary: '基于已确认信息拟写客户答复。', instructions: '用清楚、体贴的语言拟写回复。只承诺已经确认的处理措施，指出仍需核实的细节。' },
    { name: '支持问题复盘员', category: 'operations', summary: '汇总重复出现的问题和升级事项。', instructions: '整合已提供的工单，按主题标记重复问题，列出升级理由及后续处理建议。' },
  ] },
  { slug: 'lesson-planning', name: '课程备课组', category: 'education', summary: '把学习目标整理成教学活动、示例和练习。', agents: [
    { name: '教学目标规划员', category: 'education', summary: '设计可观察的学习目标和课堂顺序。', instructions: '根据学生的先备知识和课时设计学习目标，安排讲解、讨论和复习的顺序。' },
    { name: '课堂活动设计员', category: 'education', summary: '为关键概念设计示例和练习。', instructions: '为给定概念设计循序渐进的课堂示例和练习，并给出预期答案及常见误解。' },
    { name: '学习评估员', category: 'education', summary: '检查练习与学习目标是否一致。', instructions: '审核练习与学习目标的对应关系，给出难度范围、评分依据和可访问性建议。' },
  ] },
  { slug: 'release-readiness', name: '发布准备组', category: 'engineering', summary: '梳理变更、发布核对项和回滚条件。', agents: [
    { name: '变更协调员', category: 'engineering', summary: '梳理影响范围、依赖与发布顺序。', instructions: '根据已提供的变更记录找出依赖、影响组件和发布顺序。对未知信息单独列出待确认项。' },
    { name: '发布验收员', category: 'engineering', summary: '补全上线和回滚验收项目。', instructions: '列出发布前检查、发布后验证、停止条件和回滚步骤，明确每项的可观察证据。' },
    { name: '版本公告编辑', category: 'content-creation', summary: '把已确认的变更写成发布公告。', instructions: '从确认过的变更提取用户能感知的改进、已知限制和升级步骤，避免泄露内部信息。' },
  ] },
  { slug: 'concept-review', name: '体验方案评审组', category: 'design', summary: '核对操作路径、界面文案和可访问性。', agents: [
    { name: '操作路径评审员', category: 'design', summary: '查找任务路径中的遗漏和障碍。', instructions: '按用户目标追踪入口、反馈、错误处理和返回路径，每个问题指出触发条件和影响。' },
    { name: '界面文案编辑', category: 'content-creation', summary: '为界面动作和反馈提供简洁文本。', instructions: '根据操作意图拟写按钮、状态和错误提示。让每条文案说明可执行的下一步。' },
    { name: '无障碍评审员', category: 'design', summary: '检查键盘、窄屏与辅助技术场景。', instructions: '按给定页面结构检查焦点顺序、语义、对比和缩放。区分材料中观察到的问题和需要实测的问题。' },
  ] },
  { slug: 'campaign-planning', name: '传播策划组', category: 'marketing', summary: '明确受众和渠道，准备推广内容与效果指标。', agents: [
    { name: '受众策略员', category: 'marketing', summary: '梳理受众、信息需求和渠道。', instructions: '根据材料划分受众，概括每组关心的内容和适合的渠道。将需要调研的猜测单独标记。' },
    { name: '推广内容编辑', category: 'content-creation', summary: '把信息改写成各渠道可发布的稿件。', instructions: '按渠道和读者需求写出推广稿、行动提示和简短变体，只引用用户已提供的事实。' },
    { name: '传播效果分析员', category: 'data-analysis', summary: '选定指标并规划如何收集反馈。', instructions: '把传播目标对应到可测量指标，写出测量周期、数据需求和比较方式。' },
  ] },
  { slug: 'operations-review', name: '运营周会组', category: 'operations', summary: '整理运营数据、追踪异常并形成下一周期的行动清单。', agents: [
    { name: '运营简报整理员', category: 'operations', summary: '汇总近期进展和待决事项。', instructions: '把已提供的运营材料整理成进展、风险、待决事项，并保留来源和统计口径。' },
    { name: '指标排查员', category: 'data-analysis', summary: '定位异常指标并提出核查步骤。', instructions: '检查数值、单位和时间范围，按事实和假设区分异常原因并列出验证所需的信息。' },
    { name: '行动跟进员', category: 'operations', summary: '把会议决定整理成有负责人和截止日的任务。', instructions: '根据明确的决定整理行动项、负责人和期限。没有给出的负责人或日期标为待确认。' },
  ] },
])

const publicView = ({ slug, name, category, summary, agents }) => ({
  slug, name, category, summary,
  agents: agents.map(({ name, summary, category }) => ({ name, summary, category })),
})
const hash = value => createHash('sha256').update(value).digest('hex')
const roleConflict = name => new Fault(409, 'team_template_role_conflict',
  `“${name}”已归档或名称被占用。请到智能体页面恢复或重命名后再试。`)

async function socialRequest(request) {
  try { return await request() } catch (error) {
    const code = error?.code
    if (['social/not-connected', 'social/not-configured', 'social/unreachable'].includes(code) ||
        (code?.startsWith('social/') && error.status >= 500)) {
      throw new Fault(503, 'service_unavailable', '群聊服务暂时不可用，请重试。')
    }
    if (code?.startsWith('social/') && error.status >= 400 && error.status < 500) {
      return wrap(() => { throw error })
    }
    throw error
  }
}

export default function teamTemplates(host) {
  const bs = () => sharedBotSocial(host)
  const endpoints = {
      list: async () => ({ templates: TEMPLATES.map(publicView), create_entry: '/agents?tab=teams&new=1' }),
      async apply(p, call) {
        if (!call?.internal) throw new Fault(404, 'not_found', 'Internal endpoint')
        const tmpl = TEMPLATES.find((t) => t.slug === p?.slug)
        if (!tmpl) throw new Fault(404, 'not_found', '找不到这个群聊模板。')
        const workspace_id = p.workspace_id
        const { items: existing = [] } = await host.call('agents/templateRoles', {
          workspace_id, names: tmpl.agents.map(a => a.name),
        }).catch(error => {
          if (error?.code === 'agents/conflict') {
            throw new Fault(409, 'team_template_role_conflict', '模板角色名称有冲突，请到智能体页面检查后再试。')
          }
          throw error
        })
        for (const agent of existing) {
          if (agent.archived || agent.native_deleted) throw roleConflict(agent.name)
        }
        const byName = new Map(existing.map(agent => [agent.name, agent]))
        const roles = tmpl.agents.filter(role => !byName.has(role.name)).map(role => ({
          ...role, idempotency_key: hash(JSON.stringify(['team-template-role', workspace_id, tmpl.slug, role.name, p.idempotency_key])),
        }))
        if (roles.length) {
          const {items} = await host.call('agents/createTemplateRoles', {workspace_id, roles}).catch(error => {
            if (error?.code === 'agents/template-role-conflict') throw roleConflict(error.roleName)
            if (error?.code === 'agents/quota') {
              throw new Fault(429, 'team_template_agent_quota', '这个工作区已达到智能体数量上限。')
            }
            throw error
          })
          for (const agent of items) byName.set(agent.name, agent)
        }
        const agents = tmpl.agents.map(role => byName.get(role.name))
        const group = await socialRequest(() => bs().post('/v1/ot/conversations', {
          kind: 'group', title: p?.title || tmpl.name, team_id: p?.team_id || undefined,
          account_group: p?.account_group === true, members: p?.members ?? [],
          agents: agents.map(agent => ({agent_ref:agent.id, name:agent.name})),
          idempotency_key: p?.idempotency_key,
        }))
        return { template: publicView(tmpl), agents: agents.map((a) => ({ id: a.id, name: a.name, category: a.category })), conversation: group }
      },
  }
  const file = join(host.featureDir(), 'requests.json')
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return {}; throw e } }
  let queue = Promise.resolve()
  endpoints.v1 = compatHandler([
    { method: 'GET', path: /^\/v1\/team-templates$/, handle: async () => [200, { items: TEMPLATES.map(publicView) }] },
    { method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/team-templates\/([a-z0-9-]{3,40})$/,
      async handle({ match, body = {}, idempotency_key }) {
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(idempotency_key || '')) throw new Fault(400, 'invalid', 'Supply an Idempotency-Key')
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Fault(400, 'invalid', 'Invalid request')
        if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80)) throw new Fault(400, 'invalid', 'Invalid title')
        if (body.member_ids !== undefined && (!Array.isArray(body.member_ids) || body.member_ids.length > 49 ||
            body.member_ids.some(id => typeof id !== 'string' || !id))) throw new Fault(400, 'invalid', 'Invalid members')
        const task = async () => {
          const binding = await host.call('agents/personal-binding', {})
          const personal = binding?.workspace_id === match[1]
          const team = personal ? null : await socialRequest(() => bs().get('/v1/ot/teams/by-workspace/' + match[1]))
          if (!personal && (!team?.id || !['owner', 'admin'].includes(team.role))) {
            throw new Fault(403, 'forbidden', '只有工作区所有者和管理员可以使用群聊模板。')
          }
          const key = hash(match[1] + ':' + idempotency_key)
          const fingerprint = JSON.stringify([match[2], body.title || '', [...(body.member_ids || [])].sort()])
          const requests = load()
          if (requests[key]) {
            if (requests[key].fingerprint !== fingerprint) throw new Fault(409, 'conflict', 'Idempotency key already used')
            return [200, requests[key].result]
          }
          let handles = body.member_ids || []
          if (handles.length && team) {
            const {members = []} = await socialRequest(() => bs().get('/v1/ot/teams/' + encodeURIComponent(team.id) + '/members'))
            handles = handles.map(id => {
              const member = members.find(m => !m.suspended && [m.platform_user_id, m.owner_id, m.handle].includes(id))
              if (!member) throw new Fault(400, 'invalid', 'Every member must belong to this workspace')
              return member.handle
            })
          }
          const result = await endpoints.apply({workspace_id:match[1], team_id:team?.id, account_group:personal, slug:match[2],
            title:body.title, members:handles, idempotency_key:key}, {internal:true})
          const out = { conversation: { ...result.conversation, workspace_id: match[1] }, created_agents: result.agents.map(a => a.id) }
          requests[key] = { fingerprint, result: out }
          writeFileSync(file + '.tmp', JSON.stringify(requests), { mode: 0o600 }); renameSync(file + '.tmp', file)
          return [201, out]
        }
        const next = queue.then(task, task); queue = next.catch(() => {}); return next
      } },
  ])
  return { endpoints }
}
