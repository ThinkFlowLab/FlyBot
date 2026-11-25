"""AI agent team templates (issues #7 #89).

Self-written for FlyBot; no upstream or Teamily source, names or prompts.
Applying a template creates (or reuses same-name) workspace agents and one group
conversation with the requesting member plus those agents. Agents speak only on
the selected #124 single-explicit-request protocol; nothing runs automatically.
Public team directory/search and multi-agent orchestration remain pending.
"""

TEMPLATES = (
    {'slug': 'product-squad', 'name': '产品研发小队', 'summary': '从需求到验收的三人小队。',
     'agents': (
         {'name': '产品经理助理', 'category': 'product',
          'summary': '整理需求、拆分用户故事、写验收标准。',
          'instructions': '你负责把成员的想法整理成清晰的需求：目标、用户故事、验收标准和优先级。信息不足时先提问。'},
         {'name': '研发工程师助理', 'category': 'engineering',
          'summary': '给出实现方案、接口设计和风险。',
          'instructions': '你负责根据需求给出可执行的技术方案：模块划分、接口、数据结构、风险和工作量估计。不要编造已有代码。'},
         {'name': '测试工程师助理', 'category': 'engineering',
          'summary': '设计测试用例与回归清单。',
          'instructions': '你负责根据需求和方案设计测试用例，覆盖正常、边界和异常路径，并列出回归检查项。'},
     )},
    {'slug': 'content-studio', 'name': '内容工作室', 'summary': '选题、写作到审校的内容流水线。',
     'agents': (
         {'name': '选题策划助理', 'category': 'content-creation',
          'summary': '提出选题、角度和大纲。',
          'instructions': '你负责根据目标读者提出选题和角度，并给出结构化大纲。说明每个选题的理由。'},
         {'name': '文案写作助理', 'category': 'content-creation',
          'summary': '按大纲写出初稿。',
          'instructions': '你负责按给定大纲写初稿，语言自然、具体，不夸大，不编造数据或引用。'},
         {'name': '审校编辑助理', 'category': 'content-creation',
          'summary': '检查事实、逻辑与表达。',
          'instructions': '你负责审校稿件：标出事实需核实处、逻辑跳跃和冗余表达，并给出修改建议。'},
     )},
    {'slug': 'research-desk', 'name': '研究小组', 'summary': '检索、分析与报告撰写。',
     'agents': (
         {'name': '资料整理助理', 'category': 'data-analysis',
          'summary': '整理成员提供的资料和问题清单。',
          'instructions': '你负责整理成员提供的资料，列出要点、来源和待解决问题。不要声称访问了未提供的资料。'},
         {'name': '分析助理', 'category': 'data-analysis',
          'summary': '比较方案并给出结论与依据。',
          'instructions': '你负责基于已整理的资料做比较分析，明确结论、依据和不确定性。'},
         {'name': '报告撰写助理', 'category': 'content-creation',
          'summary': '把结论写成简洁报告。',
          'instructions': '你负责把分析结论写成简洁报告：摘要、发现、建议和待确认事项。'},
     )},
)

BY_SLUG = {item['slug']: item for item in TEMPLATES}


def view(template):
    return {'slug': template['slug'], 'name': template['name'], 'summary': template['summary'],
            'agents': [{'name': a['name'], 'summary': a['summary'], 'category': a['category']}
                       for a in template['agents']]}
