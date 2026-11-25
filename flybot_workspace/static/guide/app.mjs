export const CATEGORIES = [
  {id: 'all', label: '全部'},
  {id: 'chat', label: '聊天'},
  {id: 'agents', label: '智能体'},
  {id: 'discover', label: '发现'},
  {id: 'automations', label: '自动化'},
  {id: 'memory', label: '记忆'},
  {id: 'artifacts', label: 'Artifacts'},
  {id: 'me', label: '我'},
  {id: 'settings', label: '设置'},
  {id: 'account-menu', label: '头像菜单'},
  {id: 'calls', label: '通话窗口'},
  {id: 'other', label: '其他'},
];

// FlyBot's own catalog. Do not copy Teamily guide prose or its 295-item counts.
export const CATALOG = [
  {id: 'open-chat', href: '/chat', category: 'chat', title: '打开聊天', body: '在左侧应用栏打开「聊天」，查看已经统一的会话列表。人与智能体的会话在同一页，不是单独的消息页。', path: ['应用栏', '聊天']},
  {id: 'conversation-search', href: '/chat', category: 'chat', title: '会话内搜索', body: '在打开的会话标题栏里搜索当前会话中的已授权消息。这不是全站搜索面板。', path: ['聊天', '会话标题栏', '搜索']},
  {id: 'send-shortcut', href: '/settings#send-shortcut', category: 'chat', title: '发送快捷键', body: '在设置里选择用 Enter 还是 Ctrl+Enter 发送消息。换行键会随这项自动互补显示。', path: ['设置', '发送快捷键']},
  {id: 'chat-previews', href: '/chat', category: 'chat', title: '会话列表预览', body: '会话列表会显示该会话最近一条已授权消息的摘要，方便扫读。', path: ['聊天', '会话列表']},
  {id: 'open-agents', href: '/agents', category: 'agents', title: '打开智能体', body: '在「智能体」页管理本工作区的智能体，包括创建和对话入口。', path: ['应用栏', '智能体']},
  {id: 'agent-homepage', href: '/discover?tab=agents#catalog-manage', category: 'agents', title: '公开主页', body: '在「发现 → 发布管理」发布智能体，复制主页地址分享。开启公开聊天后，访客登录即可聊天。选择公开快捷开场后，访客可以点选开场白，编辑后再发送。', path: ['发现', '智能体', '发布管理']},
  {id: 'discover-feed', href: '/discover', category: 'discover', title: '关注与动态', body: '「发现」默认是显示关注账号的动态，也可以浏览公开内容。', path: ['应用栏', '发现']},
  {id: 'discover-catalog', href: '/discover?tab=agents', category: 'discover', title: '发现里的智能体目录', body: '在智能体目录浏览公开智能体。作者开启公开聊天后，可通过卡片的「聊天」打开与你的独立会话。', path: ['发现', '智能体']},
  {id: 'open-automations', href: '/automations', category: 'automations', title: '打开自动化', body: '在「自动化」页查看工作/生活模板和已有自动化。打开模板或已有任务可查看运行选项。', path: ['应用栏', '自动化']},
  {id: 'memory-overview', href: '/memory', category: 'memory', title: '记忆总览', body: '记忆页左侧是目录，中间是图谱，右侧是话题和最近更新。可以新建记忆页，或从近期更新继续查看。', path: ['应用栏', '记忆']},
  {id: 'memory-profile', href: '/memory?page=profile', category: 'memory', title: '我的资料', body: '在「我的资料」中查看和编辑工作画像。修改后选择「保存画像」。', path: ['记忆', '我的资料']},
  {id: 'memory-actions', href: '/memory?page=todos', category: 'memory', title: '下一步行动', body: '查看下一步行动。空态时只显示说明；「新建行动」才会打开已有的表单。', path: ['记忆', '下一步行动']},
  {id: 'memory-dir-collapse', href: '/memory', category: 'memory', title: '收起记忆目录', body: '在「记忆」标题旁可以收起或展开左侧目录。可以再次展开以浏览记忆目录。', path: ['记忆', '收起侧边栏']},
  {id: 'space-library', href: '/space', category: 'artifacts', title: '资料空间', body: '「作品」打开资料空间，可按类型和范围浏览。选择一项即可查看详情。', path: ['应用栏', '作品']},
  {id: 'space-filters', href: '/space', category: 'artifacts', title: '筛选作品', body: '打开筛选面板，查看文件类型、修改时间、创建人和来源会话。来源会话会列出已有会话标题。', path: ['资料空间', '筛选']},
  {id: 'space-dir-collapse', href: '/space', category: 'artifacts', title: '收起资料目录', body: '在「资料空间」标题旁可以收起或展开左侧目录。收起只对当前会话有效。', path: ['资料空间', '收起侧边栏']},
  {id: 'open-profile', href: '/profile', category: 'me', title: '查看我的资料', body: '在「我」页面查看自己的资料，或打开编辑页更新头像和简介。', path: ['应用栏', '我']},
  {id: 'settings-hub', href: '/settings', category: 'settings', title: '所有设置', body: '打开设置总览，进入语言、外观、渠道和消息偏好等设置。', path: ['账户菜单', '所有设置']},
  {id: 'settings-appearance', href: '/settings#appearance', category: 'settings', title: '外观', body: '选择浅色、深色、自动或跟随系统。自动切换的真实日出日落时刻仍明确未计算。', path: ['设置', '外观']},
  {id: 'settings-language', href: '/settings#language-section', category: 'settings', title: '语言', body: '设置系统语言、聊天语言，以及是否自动翻译消息。', path: ['设置', '语言']},
  {id: 'settings-folding', href: '/settings#message-display', category: 'settings', title: '消息折叠', body: '选择长消息预览长度，以及是否把长文档收成卡片。', path: ['设置', '消息折叠']},
  {id: 'settings-privacy', href: '/settings#privacy', category: 'settings', title: '隐私设置', body: '控制点赞列表和收藏列表是否对他人可见。未改动时「保存更改」保持禁用。', path: ['设置', '隐私设置']},
  {id: 'settings-runtimes', href: '/', category: 'settings', title: '运行时', body: '账号使用独立的 DS-Bot，从个人工作区切到团队工作区时继续使用同一个 DS-Bot。', path: ['首页']},
  {id: 'account-menu', href: '/', category: 'account-menu', title: '打开账户菜单', body: '点击应用栏底部的账户按钮，查看资料、创建团队、帮助和退出登录。', path: ['应用栏', '账户']},
  {id: 'create-team', href: '/team', category: 'account-menu', title: '创建团队', body: '从账户菜单打开创建团队向导。打开向导后填写团队资料。', path: ['账户菜单', '创建团队']},
  {id: 'download-runtime', href: '/download', category: 'other', title: '下载', body: '下载页提供浏览器网页入口。对话、技能和自动化在你的 DS-Bot 上运行。', path: ['应用栏', '下载']},
];

const CATEGORY_SUMMARIES = {
  chat: '查看会话、搜索消息和调整发送快捷键。',
  agents: '管理工作区智能体和公开主页。',
  discover: '浏览关注动态和公开智能体。',
  automations: '查看模板、任务和运行记录。',
  memory: '浏览记忆图谱、维护画像和跟进待办。',
  artifacts: '按类型、创建人或来源会话查找作品。',
  me: '查看和编辑账号资料。',
  settings: '调整外观、语言、消息显示和隐私。',
  'account-menu': '打开账号菜单或创建团队。',
  other: '查看浏览器访问方式。',
};

export function categoryLabel(id) {
  const found = CATEGORIES.find((item) => item.id === id);
  return found ? found.label : id;
}

export function countByCategory(items = CATALOG) {
  const counts = {all: items.length};
  for (const category of CATEGORIES) {
    if (category.id === 'all') continue;
    counts[category.id] = items.filter((item) => item.category === category.id).length;
  }
  return counts;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export function filterCatalog(items, {category = 'all', query = ''} = {}) {
  const needle = normalize(query);
  const source = category && category !== 'all'
    ? items.filter((item) => item.category === category)
    : items.slice();
  if (!needle) return source;
  return source.filter((item) => {
    const haystack = [
      item.title,
      item.body,
      categoryLabel(item.category),
      ...(item.path || []),
    ].join(' ');
    return normalize(haystack).includes(needle);
  });
}

// An empty category is not a failed search: name whichever one the user is
// looking at, and say nothing when there is something to list.
export function emptyGuideMessage(items, query) {
  if (items.length > 0) return '';
  return normalize(query) ? '没有匹配的条目。换个词，或按 Esc 清空搜索。' : '这一类还没有指引。';
}

// Split guide text into the runs that match the keyword so the page can mark
// them. Case-insensitive and length-preserving: joining the segments always
// gives the original text back, and an unknown keyword marks nothing.
export function highlightSegments(text, query) {
  const source = String(text || '');
  const needle = normalize(query);
  if (!source) return [];
  if (!needle) return [{text: source, match: false}];
  const haystack = source.toLowerCase();
  const segments = [];
  let start = 0;
  let hit = haystack.indexOf(needle);
  while (hit !== -1) {
    if (hit > start) segments.push({text: source.slice(start, hit), match: false});
    segments.push({text: source.slice(hit, hit + needle.length), match: true});
    start = hit + needle.length;
    hit = haystack.indexOf(needle, start);
  }
  if (start < source.length) segments.push({text: source.slice(start), match: false});
  return segments;
}


export function groupCatalog(items) {
  const groups = [];
  const index = new Map();
  for (const item of items) {
    let group = index.get(item.category);
    if (!group) {
      group = {id: item.category, label: categoryLabel(item.category), items: []};
      index.set(item.category, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export function formatPath(path) {
  return (path || []).join(' › ');
}

// Deep link only: /guide?q=<keyword>, /guide?category=<id>, or both. An empty
// keyword and the 全部 category both go back to a bare /guide, and an unknown
// category id reads as 全部 instead of inventing an empty category.
export function categorySlug(value) {
  const id = String(value || '');
  return CATEGORIES.some((category) => category.id === id) ? id : 'all';
}

export function guideHref(value, category = 'all') {
  const keyword = String(value || '').trim();
  const slug = categorySlug(category);
  const params = new URLSearchParams();
  if (slug !== 'all') params.set('category', slug);
  if (keyword) params.set('q', keyword);
  const search = params.toString();
  return search ? `/guide?${search}` : '/guide';
}

export function guideInitialQuery(search) {
  return new URLSearchParams(search || '').get('q') || '';
}

export function guideInitialCategory(search) {
  return categorySlug(new URLSearchParams(search || '').get('category'));
}

function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

async function request(method, path, body) {
  const headers = {Accept: 'application/json'};
  const options = {method, headers, credentials: 'same-origin'};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json();
  return {status: response.status, body: payload};
}

// Original icons for FlyBot's own catalog. They follow the recorded
// Teamily guide placements (category chip, group title, row) and meanings,
// without copying Teamily artwork or its 295-item catalog.
export const CATEGORY_ICON_PATHS = {
  all: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
  chat: 'M4 4h16v11H8.8L4 19.2V4zm2 2v9.2l2.1-1.7H18V6H6z',
  agents: 'M11 2h2v3h-2V2zM7 6h10v9H7V6zm2.2 2.3h2v2h-2v-2zm5.6 0h2v2h-2v-2zM8 16.2h8V20H8v-3.8zM4.5 8.5h2v5h-2v-5zm13 0h2v5h-2v-5z',
  discover: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.1 5.7-2.1 6.3-6.3 2.1 2.1-6.3 6.3-2.1z',
  automations: 'M13.2 2 5.5 13.2h5.2L9.3 22 18.5 9.6h-5.3L13.2 2z',
  memory: 'M6 3h11a2 2 0 0 1 2 2v16l-7.5-2.4L4 21V5a2 2 0 0 1 2-2zm1.5 3v11.3l4.5-1.4 4.5 1.4V6H7.5z',
  artifacts: 'M12 3 21 8.2 12 13.4 3 8.2 12 3zm-8 8.6 8 4.7 8-4.7 2 1.2-10 5.8L2 12.8l2-1.2zm0 4.2 8 4.7 8-4.7 2 1.2-10 5.8L2 17l2-1.2z',
  me: 'M12 3a4.2 4.2 0 1 1 0 8.4A4.2 4.2 0 0 1 12 3zM4 21v-2.4A7.8 7.8 0 0 1 12 11a7.8 7.8 0 0 1 8 7.6V21H4z',
  settings: 'M11 2h2v3.2l2.2 1.3 2.7-1.6 1.6 2.8-2.2 1.7.1 2.6 2.1 1.7-1.6 2.8-2.7-1.6-2.2 1.3V22h-2v-3.2l-2.2-1.3-2.7 1.6-1.6-2.8 2.2-1.7-.1-2.6-2.1-1.7 1.6-2.8 2.7 1.6L11 5.2V2zm1 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'account-menu': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8.5 9.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zm7 0a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM8 15.2a5.2 5.2 0 0 0 8 0l-1.5-1.2a3.2 3.2 0 0 1-5 0L8 15.2z',
  calls: 'M7.2 3.2c.8-.8 2.1-.8 2.9 0l1.8 1.8c.8.8.8 2.1 0 2.9l-1.3 1.3a11 11 0 0 0 4.2 4.2l1.3-1.3c.8-.8 2.1-.8 2.9 0l1.8 1.8c.8.8.8 2.1 0 2.9l-1.4 1.4c-.9.9-2.3 1.1-3.6.6C9.8 17.8 6.2 14.2 5 8.2c-.5-1.3-.3-2.7.6-3.6L7.2 3.2z',
  other: 'M8.2 4 2 12l6.2 8 1.6-1.2L5 12l4.8-6.8L8.2 4zm7.6 0-1.6 1.2L19 12l-4.8 6.8 1.6 1.2L22 12 15.8 4z',
};

export const ITEM_ICON_PATHS = {
  'open-chat': 'M3 5h16v10.5H8.2L3 19.4V5zm2 2v8.1l1.8-1.4H17V7H5z',
  'conversation-search': 'M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm8.3 13.3-3.4-3.4 1.4-1.4 3.4 3.4-1.4 1.4z',
  'send-shortcut': 'M5 4h12v2H7v5.2h7.3l-1.8-1.8 1.4-1.4 4.2 4.2-4.2 4.2-1.4-1.4 1.8-1.8H5V4z',
  'chat-previews': 'M4 5h16v2.2H4V5zm0 5.9h16V13H4v-2.1zm0 5.9h11V19H4v-2.2z',
  'open-agents': 'M10.8 2.2h2.4v2.4h-2.4V2.2zM6.5 6h11v8.5h-11V6zm2.3 2.4h2.2v2.2H8.8V8.4zm5.2 0h2.2v2.2h-2.2V8.4zM8 15.8h8V20H8v-4.2zM3.8 8.6h2.2v5H3.8v-5zm14.2 0h2.2v5h-2.2v-5z',
  'agent-homepage': 'M12 3.2 21 11h-2.4v9h-5.2v-6.2H10.6V20H5.4v-9H3L12 3.2z',
  'discover-feed': 'M4 4.5h16v4.2H4V4.5zm0 5.4h16v4.2H4V9.9zm0 5.4h16v4.2H4v-4.2z',
  'discover-catalog': 'M3.5 3.5h7.5v7.5H3.5V3.5zm9.5 0h7.5v7.5H13V3.5zM3.5 13h7.5v7.5H3.5V13zM13 13h7.5v7.5H13V13z',
  'open-automations': 'M13 2.2 6.2 13h4.8l-1.2 8.8 7.6-11.6h-4.7L13 2.2z',
  'memory-overview': 'M6.2 6.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zm11.6 0a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM12 14.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM8.4 10.6l2.2 3.8 1.7-1-2.2-3.8-1.7 1zm7.2 0-2.2 3.8 1.7 1 2.2-3.8-1.7-1z',
  'memory-profile': 'M6 3.2h12v17.6H6V3.2zm6 2.4a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8.4 17.6v-1.2A3.6 3.6 0 0 1 12 13a3.6 3.6 0 0 1 3.6 3.4v1.2H8.4z',
  'memory-actions': 'M4 5h16v2.2H4V5zm0 6h11v2.2H4V11zm0 6h16v2.2H4V17zm13.2-7.2 1.4-1.4 2.6 2.6-4.4 4.4-2.6-2.6 1.4-1.4.12.12 1.48-1.48z',
  'memory-dir-collapse': 'M3.5 3.5h7v17h-7v-17zm9 0h8v2.2h-8V3.5zm0 5.2h8v2.2h-8V8.7zm0 5.2h8v2.2h-8v-2.2z',
  'space-library': 'M4 6.2 12 3l8 3.2v2.2L12 5.2 4 8.4V6.2zm0 4.2 8-3.2 8 3.2V18l-8 3.2L4 18v-7.6z',
  'space-filters': 'M3.2 4h17.6l-6.4 7.4V20l-4.8 2v-10.6L3.2 4z',
  'space-dir-collapse': 'M13.5 3.5h7v17h-7v-17zM3.5 3.5h8v2.2h-8V3.5zm0 5.2h8v2.2h-8V8.7zm0 5.2h8v2.2h-8v-2.2z',
  'open-profile': 'M12 3a4.4 4.4 0 1 1 0 8.8A4.4 4.4 0 0 1 12 3zM3.8 21v-2.2A8 8 0 0 1 12 11a8 8 0 0 1 8.2 7.8V21H3.8z',
  'settings-hub': 'M4 6h16v2.2H4V6zm0 5h16v2.2H4V11zm0 5h16v2.2H4v-2.2zM8 5.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zm8 5a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zm-6 5a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z',
  'settings-appearance': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2v14a7 7 0 0 0 0-14z',
  'settings-language': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 2.2v15.5A8 8 0 0 1 6.2 12a8 8 0 0 1 4.6-7.8zm2.4 0A8 8 0 0 1 17.8 12a8 8 0 0 1-4.6 7.7V4.2z',
  'settings-folding': 'M6 3h8l4 4v14H6V3zm8 0v4h4',
  'settings-privacy': 'M8 10V8a4 4 0 1 1 8 0v2h1.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10H8zm2 0h4V8a2 2 0 1 0-4 0v2z',
  'settings-runtimes': 'M3 5h18v12H3V5zm2 2v8h14V7H5zm3 13h8v2H8v-2z',
  'account-menu': 'M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM5 20.2V18A7 7 0 0 1 12 11a7 7 0 0 1 7 7v2.2H5z',
  'create-team': 'M8.2 4.2a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4zm8.2 1a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM2.8 20v-1.8A5.6 5.6 0 0 1 8.2 12.6 5.6 5.6 0 0 1 13.6 18.2V20H2.8zm9.8 0v-1.6a6.8 6.8 0 0 1 2.2-4.9 5 5 0 0 1 5.4 4.8V20h-7.6z',
  'download-runtime': 'M11 3h2v10.2h3.2L12 19l-4.2-5.8H11V3zM4 19.2h16V21H4v-1.8z',
};

export function guideIconPath(kind, id) {
  const table = kind === 'category' ? CATEGORY_ICON_PATHS : ITEM_ICON_PATHS;
  const path = table[id];
  if (!path) throw new Error(`missing ${kind} guide icon for ${id}`);
  return path;
}

function iconNode(kind, id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', guideIconPath(kind, id));
  svg.append(path);
  return svg;
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const whoami = document.getElementById('whoami');
  const form = document.getElementById('login-form');
  const categoriesEl = document.getElementById('guide-categories');
  const listEl = document.getElementById('guide-list');
  const countEl = document.getElementById('guide-count');
  const emptyEl = document.getElementById('guide-empty');
  const searchEl = document.getElementById('guide-search');
  const dialog = document.getElementById('guide-dialog');
  const dialogTitle = document.getElementById('guide-dialog-title');
  const dialogBody = document.getElementById('guide-dialog-body');
  const dialogPath = document.getElementById('guide-dialog-path');
  const dialogAction = document.getElementById('guide-dialog-action');
  const dialogClose = document.getElementById('guide-dialog-close');
  if (!status || !loginPanel || !mainPanel || !form || !categoriesEl || !listEl) return;

  let currentCategory = guideInitialCategory(globalThis.location ? globalThis.location.search : '');
  let currentItemId = '';

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function closeDialog() {
    if (!dialog) return;
    dialog.hidden = true;
    currentItemId = '';
    for (const button of listEl.querySelectorAll('.guide-item')) {
      button.removeAttribute('aria-current');
    }
  }

  // Mark the searched runs with <mark> elements and plain text nodes; the page
  // never writes markup into the document, so a keyword can only ever be text.
  function fillHighlighted(node, text, query) {
    const parts = [];
    for (const segment of highlightSegments(text, query)) {
      if (!segment.text) continue;
      if (segment.match) {
        const mark = document.createElement('mark');
        mark.textContent = segment.text;
        parts.push(mark);
      } else {
        parts.push(document.createTextNode(segment.text));
      }
    }
    node.replaceChildren(...parts);
  }

  function openDialog(item) {
    if (!dialog || !dialogTitle || !dialogBody || !dialogPath || !dialogAction) return;
    const query = searchEl ? searchEl.value : '';
    currentItemId = item.id;
    fillHighlighted(dialogTitle, item.title, query);
    fillHighlighted(dialogBody, item.body, query);
    dialogPath.textContent = formatPath(item.path);
    dialogAction.setAttribute('href', item.href);
    dialogAction.textContent = `去这里 · ${item.title}`;
    dialog.hidden = false;
    if (dialogClose) dialogClose.focus();
    renderList();
  }

  function renderCategories() {
    const counts = countByCategory(CATALOG);
    categoriesEl.replaceChildren();
    for (const category of CATEGORIES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'guide-category';
      button.dataset.category = category.id;
      if (category.id === currentCategory) button.setAttribute('aria-current', 'true');
      const icon = document.createElement('span');
      icon.className = 'cat-icon';
      icon.append(iconNode('category', category.id));
      const label = document.createElement('span');
      label.className = 'cat-label';
      label.textContent = category.label;
      const count = document.createElement('span');
      count.className = 'cat-count';
      count.textContent = String(counts[category.id] || 0);
      button.append(icon, label, count);
      button.addEventListener('click', () => {
        currentCategory = category.id;
        closeDialog();
        render();
        syncQuery(searchEl ? searchEl.value : '');
      });
      categoriesEl.append(button);
    }
  }

  function renderList() {
    const query = searchEl ? searchEl.value : '';
    const items = filterCatalog(CATALOG, {
      category: currentCategory,
      query,
    });
    if (countEl) countEl.textContent = `当前显示 ${items.length} 条`;
    if (emptyEl) {
      emptyEl.hidden = items.length > 0;
      emptyEl.textContent = emptyGuideMessage(items, query);
    }
    listEl.replaceChildren();
    for (const group of groupCatalog(items)) {
      const section = document.createElement('section');
      section.className = 'guide-group';
      const heading = document.createElement('h2');
      heading.className = 'guide-group-title';
      const headingIcon = document.createElement('span');
      headingIcon.className = 'cat-icon';
      headingIcon.append(iconNode('category', group.id));
      const headingLabel = document.createElement('span');
      headingLabel.textContent = group.label;
      heading.append(headingIcon, headingLabel);
      const summary = document.createElement('p');
      summary.className = 'guide-group-summary';
      summary.textContent = CATEGORY_SUMMARIES[group.id];
      section.append(heading, summary);
      for (const item of group.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'guide-item';
        button.dataset.itemId = item.id;
        if (item.id === currentItemId) button.setAttribute('aria-current', 'true');
        const icon = document.createElement('span');
        icon.className = 'item-icon';
        icon.append(iconNode('item', item.id));
        const title = document.createElement('span');
        fillHighlighted(title, item.title, query);
        button.append(icon, title);
        button.addEventListener('click', () => openDialog(item));
        section.append(button);
      }
      listEl.append(section);
    }
  }

  function render() {
    renderCategories();
    renderList();
  }

  function syncQuery(value) {
    const location = globalThis.location;
    const history = globalThis.history;
    if (!location || !history || typeof history.replaceState !== 'function') return;
    const href = guideHref(value, currentCategory);
    if (location.pathname + location.search === href) return;
    history.replaceState(null, '', href);
  }

  if (searchEl) {
    searchEl.value = guideInitialQuery(globalThis.location ? globalThis.location.search : '');
    searchEl.addEventListener('input', () => {
      closeDialog();
      renderList();
      syncQuery(searchEl.value);
    });
  }
  if (dialogClose) dialogClose.addEventListener('click', closeDialog);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (dialog && !dialog.hidden) {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (searchEl && searchEl.value) {
      event.preventDefault();
      searchEl.value = '';
      renderList();
      syncQuery('');
      searchEl.focus();
    }
  });

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      closeDialog();
      show('', '');
      return;
    }
    if (session.status !== 200 || !session.body.user) {
      show('error', messageFor(session.body && session.body.error, '无法读取会话。'));
      return;
    }
    const username = session.body.user.username;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    if (whoami) {
      whoami.dataset.username = username;
      whoami.textContent = username;
    }
    render();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: form.elements.username.value,
      password: form.elements.password.value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body && result.body.error, '无法登录。'));
      return;
    }
    form.reset();
    await load();
  });

  const logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = await request('POST', '/v1/auth/logout', {});
      if (result.status !== 200 && result.status !== 204) {
        show('error', messageFor(result.body && result.body.error, '无法退出登录。'));
        return;
      }
      show('ok', '已退出登录。');
      await load();
    });
  }

  load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
