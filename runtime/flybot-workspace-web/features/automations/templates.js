// Generated from flybot_workspace/automations.py TEMPLATES/INTENTS (kept in step by
// test/automations.test.js, which compares against the Python source text).
export const TEMPLATES = {
  "custom": {
    "id": "custom",
    "title": "自定义",
    "category": "custom",
    "prompt": ""
  },
  "reminder": {
    "id": "reminder",
    "title": "消息提醒",
    "category": "custom",
    "prompt": "到点提醒我回看一条消息。"
  },
  "meeting_prep": {
    "id": "meeting_prep",
    "title": "会议提醒和准备",
    "category": "work",
    "prompt": "在会议开始前整理议题、参会人和需要准备的材料，并按时提醒。"
  },
  "daily_brief": {
    "id": "daily_brief",
    "title": "每日工作简报",
    "category": "work",
    "prompt": "汇总当天要处理的事项、进度和需要关注的风险，写成简报。"
  },
  "industry_watch": {
    "id": "industry_watch",
    "title": "竞品和行业监测",
    "category": "work",
    "prompt": "跟踪指定竞品和行业动态，整理变化并标出需要跟进的点。"
  },
  "expert_research": {
    "id": "expert_research",
    "title": "专家团队研究",
    "category": "work",
    "prompt": "围绕给定题目组织多角度研究，给出依据和分歧，而不是只给结论。"
  },
  "deck_report": {
    "id": "deck_report",
    "title": "制作演示文稿或报告",
    "category": "work",
    "prompt": "按给定大纲起草演示文稿或书面报告，结构清楚，便于修改。"
  },
  "build_web": {
    "id": "build_web",
    "title": "搭建网页或工具",
    "category": "work",
    "prompt": "按需求搭建一个可用的网页或小工具，并说明如何运行和限制。"
  },
  "task_breakdown": {
    "id": "task_breakdown",
    "title": "拆解并分配任务",
    "category": "work",
    "prompt": "把目标拆成可执行的任务，标出负责人和先后顺序。"
  },
  "reply_in_voice": {
    "id": "reply_in_voice",
    "title": "按我的口吻回复",
    "category": "work",
    "prompt": "按我一贯的语气起草回复，先确认事实，再给出可直接发送的文本。"
  },
  "market_research": {
    "id": "market_research",
    "title": "投资和市场研究",
    "category": "work",
    "prompt": "整理相关市场或投资问题的公开信息，区分事实和判断，并标明不确定之处。"
  },
  "advance_goals": {
    "id": "advance_goals",
    "title": "推进目标",
    "category": "work",
    "prompt": "对照既定目标检查进展，列出下一步和卡住的地方。"
  },
  "inbox_followup": {
    "id": "inbox_followup",
    "title": "收件箱整理与跟进",
    "category": "work",
    "prompt": "整理待回复和待跟进的消息，按紧急程度排序并起草跟进。"
  },
  "timezone_handoff": {
    "id": "timezone_handoff",
    "title": "跨时区接力",
    "category": "work",
    "prompt": "把当前进度、未决问题和交接材料整理成下一时区的人能直接接着做的说明。"
  },
  "birthday_reminder": {
    "id": "birthday_reminder",
    "title": "生日和纪念日提醒",
    "category": "life",
    "prompt": "在日期到来前提醒我，并给出可以参考的礼物建议。"
  },
  "habit_reminder": {
    "id": "habit_reminder",
    "title": "健康和习惯提醒",
    "category": "life",
    "prompt": "在约定的时间提醒我做固定的健康或习惯事项。"
  },
  "family_checkin": {
    "id": "family_checkin",
    "title": "关心家人",
    "category": "life",
    "prompt": "定期问候家人，发现可能的异常时提醒我。"
  },
  "gathering": {
    "id": "gathering",
    "title": "组织聚会",
    "category": "life",
    "prompt": "对照大家的空闲时间，给出聚会时间和地点的建议。"
  },
  "trip_plan": {
    "id": "trip_plan",
    "title": "规划旅行",
    "category": "life",
    "prompt": "整理行程、住宿和预算，方便和同行的人一起改。"
  },
  "visual_post": {
    "id": "visual_post",
    "title": "制作图片或短视频",
    "category": "life",
    "prompt": "按主题生成适合发布的图片或短视频。"
  },
  "interest_brief": {
    "id": "interest_brief",
    "title": "每日兴趣简报",
    "category": "life",
    "prompt": "每天汇总我关注的话题，写成简报。"
  },
  "money_decision": {
    "id": "money_decision",
    "title": "个人理财决策",
    "category": "life",
    "prompt": "一起理清一笔消费或一项财务决定。"
  },
  "skill_practice": {
    "id": "skill_practice",
    "title": "学习一项技能",
    "category": "life",
    "prompt": "为选定的技能安排包含练习和打卡的每周计划。"
  },
  "photo_album": {
    "id": "photo_album",
    "title": "回忆和相册",
    "category": "life",
    "prompt": "把照片整理成可以分享的回忆相册。"
  },
  "listen_to_friend": {
    "id": "listen_to_friend",
    "title": "陪伴朋友",
    "category": "life",
    "prompt": "在朋友情绪低落时，改成以倾听为主的回应。"
  },
  "price_watch": {
    "id": "price_watch",
    "title": "购物比价提醒",
    "category": "life",
    "prompt": "跟踪指定商品的价格，降价时提醒我。"
  }
}
export const INTENTS = {
  "research": "研究",
  "monitor": "监测",
  "create": "创作",
  "analyze": "分析",
  "plan": "规划",
  "collaborate": "协同"
}
