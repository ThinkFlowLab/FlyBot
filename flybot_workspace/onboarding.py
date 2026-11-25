"""Work-context onboarding for industry and role.

The stored context supports later workspace recommendations.
"""
import json
import re

from . import automations

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_onboarding (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 industry TEXT NOT NULL,
 role TEXT NOT NULL,
 completed INTEGER NOT NULL CHECK(completed IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
'''

INDUSTRIES = {
    '科技与软件': ['软件工程师', '产品经理', 'AI 工程师', '数据分析师 / 工程师', '产品设计师', '创始人 / CEO', 'QA / 测试工程师', '安全工程师', '学生', '其他'],
    '广告与营销': ['增长营销师', '内容创作者', '文案', 'SEO 专员', '品牌策略师', '平面设计师', '公关专员', '市场分析师', '活动策划', '代理公司老板', '学生'],
    '媒体与娱乐': ['内容创作者', '主播', '设计师', '音乐人', '艺术家', '作家', '学生', '内容制作', '记者', '编辑'],
    '金融服务': ['财务分析师', '投资分析师', '会计师', '财务顾问', '风险与合规分析师', '产品经理', '交易员', '保险代理人'],
    '教育': ['老师', '大学教授', '研究员', '学生', '学校辅导员', '学校管理者', '学术顾问', '教学设计师', '教育机构创办人', '教育顾问', '项目协调员'],
    '电子商务与零售': ['店主', '电商运营', '增长营销师', '买手', '商品企划', '产品经理', '供应链分析师', '数据分析师'],
    '咨询与专业服务': ['管理顾问', '战略顾问', '业务分析师', '科技顾问', '运营顾问', '项目经理', '客户服务专员', '法律专业人士'],
    '游戏': ['电竞选手', '游戏制作人', '主播', '内容创作者', '游戏设计师', '动画师', '独立开发者', 'QA 测试员'],
    '旅游与酒店': ['旅行顾问', '活动统筹', '营收分析师', '宾客体验专员', '市场专员', '餐饮专员', '旅游业经营者', '酒店专业人士'],
    '医疗健康': ['医生', '护士', '心理学家', '医学生', '药剂师', '治疗师', '牙医', '放射科医生', '营养师', '照护者', '医学检验科学家'],
    '时尚与服装': ['时装设计师', '商品企划', '买手', '产品开发', '精品店店主', '市场专员'],
    '房地产与租赁': ['房产经纪人', '物业经理', '评估师', '房贷经纪人', '房产投资人', '房产营销师'],
    '农业与种养': ['农夫', '牧场主', '农场经理', '农业工人', '农场主'],
    '运输与物流': ['个体司机 / 司机', '车队经理', '仓库经理', '物流协调员', '供应链分析师', '运输规划师', '货运经纪人', '运输业经营者'],
    '建筑与家居服务': ['总承包商', '技工', '家庭服务专业人员', '建筑项目经理', '建筑师', '建筑 / 家居服务业经营者', '机械 / 电气工程师'],
    '其他': []
}

OTHER = '其他'
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
ROLE_MAX = 40


def valid_industry(value):
    return value == '' or (isinstance(value, str) and len(value.strip()) <= 40
                           and not CONTROL.search(value))


def valid_role(value):
    return value == '' or (isinstance(value, str) and len(value.strip()) <= ROLE_MAX
                           and not CONTROL.search(value))


def view(row):
    return {
        'industry': row['industry'],
        'role': row['role'],
        'completed': bool(row['completed']),
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
    }


def industries_view():
    return [{'name': name, 'roles': list(roles)} for name, roles in INDUSTRIES.items()]


GROUPS = (
    (('产品', '项目'), ('deck_report', 'task_breakdown', 'industry_watch', 'daily_brief', 'meeting_prep')),
    (('工程', '开发', '技术', 'AI', '数据'), ('task_breakdown', 'build_web', 'daily_brief', 'meeting_prep')),
    (('营销', '内容', '设计', '创作', '媒体'), ('industry_watch', 'deck_report', 'inbox_followup', 'daily_brief')),
    (('财务', '会计', '投资', '金融'), ('market_research', 'inbox_followup', 'daily_brief', 'meeting_prep')),
    (('研究', '学生', '科学', '教育'), ('expert_research', 'daily_brief', 'task_breakdown', 'meeting_prep')),
    (('销售', '客户', '运营', '服务'), ('inbox_followup', 'daily_brief', 'task_breakdown', 'meeting_prep')),
)
DEFAULT_TEMPLATES = ('daily_brief', 'task_breakdown', 'meeting_prep', 'inbox_followup')


def recommended_template_ids(role):
    text = role or ''
    for keys, ids in GROUPS:
        if any(key in text for key in keys):
            return list(ids)
    return list(DEFAULT_TEMPLATES)


def automation_recommendations(role):
    items = []
    for template_id in recommended_template_ids(role):
        template = automations.TEMPLATES.get(template_id)
        if template is None:
            continue
        items.append({'template_id': template_id, 'title': template['title'], 'prompt': template['prompt']})
    return items


def load(db, user_id):
    return db.execute('SELECT * FROM user_onboarding WHERE user_id=?', (user_id,)).fetchone()


# App suggestions, automation picks, and the Personal Agent's appearance.
# A separate opt-in action creates paused automation templates.
STEPS_SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_onboarding_steps (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 picks TEXT NOT NULL,
 look TEXT,
 updated INTEGER NOT NULL);
'''
SCHEMA += STEPS_SCHEMA

APPS = (('gmail', 'Gmail'), ('outlook', 'Outlook'), ('google-calendar', 'Google Calendar'), ('github', 'GitHub'),
        ('google-drive', 'Google Drive'), ('notion', 'Notion'), ('google-sheets', 'Google Sheets'),
        ('google-docs', 'Google Docs'))

GENERAL = (
    ('daily-brief', 'routine', '每日工作早报', '每天早上汇总待办和需要回复的消息。'),
    ('meeting-notes', 'task', '整理会议纪要', '把会议记录整理成结论和行动项。'),
    ('weekly-review', 'routine', '每周复盘', '每周五总结本周进展和下周重点。'),
    ('draft-reply', 'task', '起草回复', '根据上下文起草邮件或消息回复。'),
)
BY_INDUSTRY = {
    '科技与软件': (('release-notes', 'task', '撰写发布说明', '根据变更记录起草版本发布说明。'),
                ('issue-triage', 'routine', '每日问题分拣', '每天整理新问题并标出优先级。')),
    '广告与营销': (('social-copy', 'task', '社媒文案', '为一次活动写几版社媒文案。'),
                ('campaign-watch', 'routine', '活动数据周报', '每周汇总投放和互动数据。')),
    '教育': (('lesson-outline', 'task', '课程大纲', '为一节课准备大纲和练习。'),
           ('homework-feedback', 'routine', '作业反馈提醒', '每周提醒整理作业反馈。')),
    '电子商务与零售': (('listing-copy', 'task', '商品详情文案', '为商品写标题和卖点。'),
                ('stock-check', 'routine', '库存日报', '每天汇总低库存商品。')),
}
PICK_MAX = 6

LOOK_OPTIONS = {
    'color': ('珊瑚橙', '天空蓝', '薄荷绿', '葡萄紫', '柠檬黄', '石墨灰'),
    'expression': ('微笑', '专注', '好奇', '酷'),
    'headwear': ('无', '棒球帽', '耳机', '贝雷帽'),
    'glasses': ('无', '圆框眼镜', '墨镜'),
    'hand': ('无', '咖啡杯', '笔记本', '魔法棒'),
}


def recommendations(industry):
    return [{'key': key, 'kind': kind, 'title': title, 'summary': summary}
            for key, kind, title, summary in BY_INDUSTRY.get(industry, ()) + GENERAL]


def all_recommendation_keys():
    keys = {item[0] for item in GENERAL}
    for items in BY_INDUSTRY.values():
        keys.update(item[0] for item in items)
    return keys


def valid_look(look):
    return (isinstance(look, dict) and set(look) == set(LOOK_OPTIONS)
            and all(look[name] in options for name, options in LOOK_OPTIONS.items()))


def load_steps(db, user_id):
    return db.execute('SELECT * FROM user_onboarding_steps WHERE user_id=?', (user_id,)).fetchone()


def load_look(db, user_id):
    """Return the saved Personal Agent look only when it still matches the options."""
    row = load_steps(db, user_id)
    if row is None or not row['look']:
        return None
    try:
        look = json.loads(row['look'])
    except (TypeError, ValueError):
        return None
    return look if valid_look(look) else None


def steps_view(row, industry):
    return {
        'apps': [{'key': key, 'name': name, 'connected': False} for key, name in APPS],
        'recommendations': recommendations(industry),
        'look_options': {name: list(options) for name, options in LOOK_OPTIONS.items()},
        'picks': json.loads(row['picks']) if row is not None else [],
        'look': json.loads(row['look']) if row is not None and row['look'] else None,
        'compared': False,
    }
