"""Workspace automation templates, schedules, and run records."""
import json
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SCHEMA = '''
CREATE TABLE IF NOT EXISTS automations (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 prompt TEXT NOT NULL,
 template_id TEXT NOT NULL,
 schedule TEXT NOT NULL,
 participants TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS automation_workspace ON automations(workspace_id, id);
CREATE TABLE IF NOT EXISTS automation_editors (
 automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
 intent TEXT NOT NULL,
 scope TEXT NOT NULL,
 agents TEXT NOT NULL,
 compiled INTEGER NOT NULL CHECK(compiled IN (0,1)));
'''


TEMPLATES = {
    'custom': {'id': 'custom', 'title': '自定义', 'category': 'custom', 'prompt': ''},
    # One reminder typed on a chat message. It is a real one-shot automation rather than a
    # separate reminder store: the due notification is derived from the run it fires.
    'reminder': {
        'id': 'reminder', 'title': '消息提醒', 'category': 'custom',
        'prompt': '到点提醒我回看一条消息。',
    },
    'meeting_prep': {
        'id': 'meeting_prep', 'title': '会议提醒和准备', 'category': 'work',
        'prompt': '在会议开始前整理议题、参会人和需要准备的材料，并按时提醒。',
    },
    'daily_brief': {
        'id': 'daily_brief', 'title': '每日工作简报', 'category': 'work',
        'prompt': '汇总当天要处理的事项、进度和需要关注的风险，写成简报。',
    },
    'industry_watch': {
        'id': 'industry_watch', 'title': '竞品和行业监测', 'category': 'work',
        'prompt': '跟踪指定竞品和行业动态，整理变化并标出需要跟进的点。',
    },
    'expert_research': {
        'id': 'expert_research', 'title': '专家团队研究', 'category': 'work',
        'prompt': '围绕给定题目组织多角度研究，给出依据和分歧，而不是只给结论。',
    },
    'deck_report': {
        'id': 'deck_report', 'title': '制作演示文稿或报告', 'category': 'work',
        'prompt': '按给定大纲起草演示文稿或书面报告，结构清楚，便于修改。',
    },
    'build_web': {
        'id': 'build_web', 'title': '搭建网页或工具', 'category': 'work',
        'prompt': '按需求搭建一个可用的网页或小工具，并说明如何运行和限制。',
    },
    'task_breakdown': {
        'id': 'task_breakdown', 'title': '拆解并分配任务', 'category': 'work',
        'prompt': '把目标拆成可执行的任务，标出负责人和先后顺序。',
    },
    'reply_in_voice': {
        'id': 'reply_in_voice', 'title': '按我的口吻回复', 'category': 'work',
        'prompt': '按我一贯的语气起草回复，先确认事实，再给出可直接发送的文本。',
    },
    'market_research': {
        'id': 'market_research', 'title': '投资和市场研究', 'category': 'work',
        'prompt': '整理相关市场或投资问题的公开信息，区分事实和判断，并标明不确定之处。',
    },
    'advance_goals': {
        'id': 'advance_goals', 'title': '推进目标', 'category': 'work',
        'prompt': '对照既定目标检查进展，列出下一步和卡住的地方。',
    },
    'inbox_followup': {
        'id': 'inbox_followup', 'title': '收件箱整理与跟进', 'category': 'work',
        'prompt': '整理待回复和待跟进的消息，按紧急程度排序并起草跟进。',
    },
    'timezone_handoff': {
        'id': 'timezone_handoff', 'title': '跨时区接力', 'category': 'work',
        'prompt': '把当前进度、未决问题和交接材料整理成下一时区的人能直接接着做的说明。',
    },
    'birthday_reminder': {
        'id': 'birthday_reminder', 'title': '生日和纪念日提醒', 'category': 'life',
        'prompt': '在日期到来前提醒我，并给出可以参考的礼物建议。',
    },
    'habit_reminder': {
        'id': 'habit_reminder', 'title': '健康和习惯提醒', 'category': 'life',
        'prompt': '在约定的时间提醒我做固定的健康或习惯事项。',
    },
    'family_checkin': {
        'id': 'family_checkin', 'title': '关心家人', 'category': 'life',
        'prompt': '定期问候家人，发现可能的异常时提醒我。',
    },
    'gathering': {
        'id': 'gathering', 'title': '组织聚会', 'category': 'life',
        'prompt': '对照大家的空闲时间，给出聚会时间和地点的建议。',
    },
    'trip_plan': {
        'id': 'trip_plan', 'title': '规划旅行', 'category': 'life',
        'prompt': '整理行程、住宿和预算，方便和同行的人一起改。',
    },
    'visual_post': {
        'id': 'visual_post', 'title': '制作图片或短视频', 'category': 'life',
        'prompt': '按主题生成适合发布的图片或短视频。',
    },
    'interest_brief': {
        'id': 'interest_brief', 'title': '每日兴趣简报', 'category': 'life',
        'prompt': '每天汇总我关注的话题，写成简报。',
    },
    'money_decision': {
        'id': 'money_decision', 'title': '个人理财决策', 'category': 'life',
        'prompt': '一起理清一笔消费或一项财务决定。',
    },
    'skill_practice': {
        'id': 'skill_practice', 'title': '学习一项技能', 'category': 'life',
        'prompt': '为选定的技能安排包含练习和打卡的每周计划。',
    },
    'photo_album': {
        'id': 'photo_album', 'title': '回忆和相册', 'category': 'life',
        'prompt': '把照片整理成可以分享的回忆相册。',
    },
    'listen_to_friend': {
        'id': 'listen_to_friend', 'title': '陪伴朋友', 'category': 'life',
        'prompt': '在朋友情绪低落时，改成以倾听为主的回应。',
    },
    'price_watch': {
        'id': 'price_watch', 'title': '购物比价提醒', 'category': 'life',
        'prompt': '跟踪指定商品的价格，降价时提醒我。',
    },
}
SCOPES = ('once', 'ongoing')
# A reminder is created already enabled: a disabled automation never fires.
REMINDER = 'reminder'
INTENTS = {
    'research': '研究',
    'monitor': '监测',
    'create': '创作',
    'analyze': '分析',
    'plan': '规划',
    'collaborate': '协同',
}

TIME = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')
DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
TITLE = re.compile(r'.*')  # length/control checks are applied separately


def templates():
    return [dict(item) for item in TEMPLATES.values()]


def valid_title(value):
    return (isinstance(value, str) and 1 <= len(value.strip()) <= 80
            and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value)
            and _unicode(value))


def valid_prompt(value):
    return isinstance(value, str) and 1 <= len(value) <= 4000 and '\x00' not in value and _unicode(value)


def _unicode(value):
    try:
        value.encode('utf-8')
    except UnicodeError:
        return False
    return True


def valid_intent(value):
    return value == '' or value in INTENTS


def valid_scope(value):
    return value in SCOPES


def valid_agents(value):
    if not isinstance(value, list) or len(value) > 20:
        return False
    seen = set()
    for name in value:
        if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 64
                or '\x00' in name or name.strip().lower() in seen or not _unicode(name)):
            return False
        seen.add(name.strip().lower())
    return True


def valid_schedule(value):
    if not isinstance(value, dict):
        return False
    kind, zone = value.get('kind'), value.get('time_zone')
    if kind == 'later':
        kind = 'once'
        value = dict(value, kind='once')
    if kind not in ('now', 'once', 'daily', 'weekly', 'monthly', 'weekdays'):
        return False
    if not isinstance(zone, str) or not 1 <= len(zone) <= 64:
        return False
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return False
    if kind == 'now':
        return set(value) == {'kind', 'time_zone'}
    time = value.get('time')
    if not isinstance(time, str) or not TIME.fullmatch(time):
        return False
    keys = {'kind', 'time', 'time_zone'}
    if kind == 'once':
        day = value.get('date')
        if not isinstance(day, str) or not DATE.fullmatch(day):
            return False
        try:
            date.fromisoformat(day)
        except ValueError:
            return False
        keys.add('date')
    if kind == 'weekly':
        weekday = value.get('weekday')
        if type(weekday) is not int or not 1 <= weekday <= 7:
            return False
        keys.add('weekday')
    if kind == 'monthly':
        day = value.get('day')
        if type(day) is not int or not 1 <= day <= 31:
            return False
        keys.add('day')
    return set(value) == keys


def normalize_schedule(value):
    kind = 'once' if value['kind'] == 'later' else value['kind']
    schedule = {'kind': kind, 'time_zone': value['time_zone']}
    if kind != 'now':
        schedule['time'] = value['time']
    if kind == 'once':
        schedule['date'] = value['date']
    if kind == 'weekly':
        schedule['weekday'] = value['weekday']
    if kind == 'monthly':
        schedule['day'] = value['day']
    return schedule


def compile_prompt(template_id, intent, scope, schedule, participants, agents):
    template = TEMPLATES.get(template_id) or TEMPLATES['custom']
    lines = []
    if template['prompt']:
        lines.append(template['prompt'])
    if intent:
        lines.append('意图：' + INTENTS.get(intent, intent))
    lines.append('范围：只运行一次' if scope == 'once' else '范围：长期运行')
    kind = schedule.get('kind')
    zone = schedule.get('time_zone', '')
    if kind == 'now':
        when = '时间：立即运行（只触发一次）'
    elif kind == 'once':
        when = f"时间：在 {schedule.get('date')} {schedule.get('time')}（{zone}）运行一次"
    elif kind == 'daily':
        when = f"时间：每天 {schedule.get('time')}（{zone}）"
    elif kind == 'weekly':
        when = f"时间：每周第 {schedule.get('weekday')} 天 {schedule.get('time')}（{zone}）"
    elif kind == 'monthly':
        when = f"时间：每月 {schedule.get('day')} 日 {schedule.get('time')}（{zone}）"
    elif kind == 'weekdays':
        when = f"时间：工作日 {schedule.get('time')}（{zone}）"
    else:
        when = '时间：按给定安排'
    lines.append(when)
    if agents:
        lines.append('参与的智能体：' + '、'.join(name.strip() for name in agents))
    if participants:
        lines.append('参与的成员：' + '、'.join(participants))
    return '\n'.join(lines)


def valid_usernames(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        return False
    seen = set()
    for name in value:
        if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,63}', name)
                or name.lower() in seen):
            return False
        seen.add(name.lower())
    return True


def view(row):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'prompt': row['prompt'],
        'template_id': row['template_id'],
        'schedule': json.loads(row['schedule']),
        'participants': json.loads(row['participants']),
        'enabled': bool(row['enabled']),
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
    }


RUN_SCHEMA = '''
CREATE TABLE IF NOT EXISTS automation_runs (
 id TEXT PRIMARY KEY,
 automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 due_at INTEGER NOT NULL,
 started INTEGER NOT NULL,
 finished INTEGER,
 status TEXT NOT NULL CHECK(status IN ('queued','succeeded','failed','skipped')),
 error_code TEXT,
 dispatch TEXT NOT NULL,
 UNIQUE(automation_id, due_at));
CREATE INDEX IF NOT EXISTS automation_run_list ON automation_runs(automation_id, id);
CREATE TABLE IF NOT EXISTS automation_run_retries (
 run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
 key_hash TEXT NOT NULL,
 new_run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY (run_id, key_hash));
'''


SCHEMA = SCHEMA + RUN_SCHEMA


def due_at(schedule, now_ts):
    """Return the current slot's unix time if it is due, otherwise None.

    Only the latest slot is considered; missed earlier days are not backfilled.
    """
    try:
        zone = ZoneInfo(schedule['time_zone'])
        now = datetime.fromtimestamp(int(now_ts), zone)
    except (KeyError, TypeError, ValueError, ZoneInfoNotFoundError, OSError):
        return None
    kind = schedule.get('kind')
    if kind == 'now':
        # A single stable slot: the schedule does not repeat.
        return 0
    try:
        hour, minute = (int(part) for part in schedule['time'].split(':'))
    except (KeyError, TypeError, ValueError):
        return None
    if kind == 'once':
        try:
            year, month, day = (int(part) for part in schedule['date'].split('-'))
            moment = datetime(year, month, day, hour, minute, tzinfo=zone)
        except (KeyError, TypeError, ValueError, OSError):
            return None
        ts = int(moment.timestamp())
        return ts if int(now_ts) >= ts else None
    if kind == 'weekly' and now.isoweekday() != schedule.get('weekday'):
        return None
    if kind == 'weekdays' and now.isoweekday() > 5:
        return None
    if kind == 'monthly':
        day = schedule.get('day')
        if type(day) is not int or now.day != day:
            return None
    if kind not in ('daily', 'weekly', 'weekdays', 'monthly'):
        return None
    moment = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    ts = int(moment.timestamp())
    return ts if int(now_ts) >= ts else None


def run_view(row):
    try:
        dispatch = json.loads(row['dispatch'])
    except ValueError:
        dispatch = {}
    if not isinstance(dispatch, dict):
        dispatch = {}
    status = row['status']
    error = row['error_code']
    if error == 'cancelled':
        status = 'cancelled'
    elif error == 'timeout':
        status = 'timeout'
    result = dispatch.get('result')
    visible = None
    if isinstance(result, dict):
        visible = {}
        text = result.get('text')
        if isinstance(text, str):
            visible['text'] = text[:8000]
        if isinstance(result.get('model'), str) and len(result['model']) <= 200:
            visible['model'] = result['model']
        if result.get('source') in ('workspace', 'account', 'platform'):
            visible['source'] = result['source']
        if result.get('cancelled') is True:
            visible['cancelled'] = True
        if isinstance(result.get('error'), str) and 1 <= len(result['error']) <= 200:
            visible['error'] = result['error']
        visible.pop('api_key', None)
        if not visible:
            visible = None
    data = {
        'id': row['id'],
        'automation_id': row['automation_id'],
        'workspace_id': row['workspace_id'],
        'due_at': row['due_at'],
        'started': row['started'],
        'finished': row['finished'],
        'status': status,
        'error_code': error,
        'dispatch': {key: dispatch[key] for key in ('instance_ids', 'backend', 'task_id') if key in dispatch},
    }
    if visible is not None:
        data['result'] = visible
    return data
