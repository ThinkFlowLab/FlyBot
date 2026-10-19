// Role profiles and role similarity for the tree's self-organization (#446). Deterministic: a Bot's
// role is read from its name, role label, tree role (description), its own prompt text and the
// tools it used recently, and matched against a small domain vocabulary. No model call: the
// codebase has no pattern for plugins to call the Bot's model, so `config.classify` is the hook
// for a smarter classifier (it may return { domain, project } for a profile; see README).
//
// Group keys, most specific first (a lead is found or made for one key):
//   project:<word>  a name word two Bots at one level share that is not a domain or generic word
//                   ("FlyBot Dev", "FlyBot Test" → project:flybot, lead "FlyBot Lead")
//   domain:<id>     the Bot's best domain (dev, life, writing, ...)
//   word:<word>     a role word two Bots share (name or description), when nothing above groups them
//   area:<id>       the domain's broad area: work, life, or other (unknown roles); only for a full level

export const DOMAINS = Object.freeze([
  { id: 'dev', label: 'Dev', area: 'work', words: ['dev', 'develop', 'code', 'coding', 'coder', 'program', 'engineer', 'software', 'test', 'qa', 'e2e', 'repo', 'git', 'github', 'pull', 'pr', 'review', 'maint', 'bug', 'fix', 'ci', 'build', 'release', 'deploy', 'devops', 'ops', 'backend', 'frontend', 'api', 'debug', 'refactor', 'issue', 'bash', 'shell', 'npm', 'node', 'python', 'script'], cjk: ['开发', '测试', '代码', '程序', '仓库', '维护', '编程', '工程师', '运维', '部署', '发布', '修复'] },
  { id: 'life', label: 'Life', area: 'life', words: ['cook', 'recipe', 'food', 'meal', 'chef', 'kitchen', 'diet', 'nutrition', 'shop', 'grocer', 'buy', 'purchase', 'home', 'house', 'clean', 'chore', 'family', 'kid', 'pet', 'garden', 'plant', 'health', 'fitness', 'workout', 'sleep', 'travel', 'trip', 'flight', 'hotel', 'vacation', 'restaurant', 'wardrobe', 'fashion'], cjk: ['做饭', '烹饪', '菜谱', '厨', '美食', '饮食', '购物', '买菜', '采购', '家务', '生活', '健康', '健身', '旅行', '旅游', '出行', '酒店', '宠物', '园艺'] },
  { id: 'writing', label: 'Writing', area: 'work', words: ['write', 'writer', 'writing', 'copy', 'edit', 'editor', 'proofread', 'blog', 'article', 'content', 'translat', 'docs', 'documentation', 'story', 'novel', 'poem', 'poet'], cjk: ['写作', '文案', '编辑', '翻译', '文档', '文章', '校对', '小说'] },
  { id: 'research', label: 'Research', area: 'work', words: ['research', 'analy', 'data', 'stat', 'survey', 'study', 'investigat', 'insight', 'report', 'search', 'web_search', 'scholar', 'paper'], cjk: ['研究', '分析', '数据', '调研', '报告', '统计', '论文'] },
  { id: 'finance', label: 'Finance', area: 'work', words: ['finance', 'money', 'budget', 'invest', 'stock', 'tax', 'account', 'bank', 'expense', 'invoice', 'price', 'crypto'], cjk: ['财务', '理财', '预算', '投资', '股票', '税', '记账', '会计'] },
  { id: 'design', label: 'Design', area: 'work', words: ['design', 'ui', 'ux', 'art', 'image', 'logo', 'illustrat', 'video', 'photo', 'music'], cjk: ['设计', '美术', '图片', '视频', '音乐', '绘画'] },
  { id: 'business', label: 'Business', area: 'work', words: ['market', 'sales', 'sell', 'customer', 'support', 'business', 'product', 'project', 'manage', 'plan', 'schedule', 'calendar', 'email', 'meeting', 'hr', 'recruit', 'legal', 'contract'], cjk: ['市场', '营销', '销售', '客服', '产品', '项目', '日程', '邮件', '会议', '招聘', '法务', '合同'] },
  { id: 'learning', label: 'Learning', area: 'life', words: ['learn', 'tutor', 'teach', 'lesson', 'language', 'english', 'math', 'homework', 'exam', 'course'], cjk: ['学习', '教学', '辅导', '语言', '英语', '数学', '作业', '考试', '课程'] },
])
const BY_ID = new Map(DOMAINS.map(d => [d.id, d]))
export const AREAS = Object.freeze({ work: 'Work', life: 'Personal', other: 'General' })

// Words that say nothing about a role (names like "Chief's helper bot").
const GENERIC = new Set(`bot bots agent agents team the and for of to in on with my your ai main new old assistant helper specialist expert member general misc other group all stuff things work task tasks you are is a an this that it its be by or as at from who what`.split(' '))
const LEAD_WORDS = new Set(['lead', 'leader', 'manager', 'coordinator', 'head', 'director', 'captain', 'boss', 'supervisor'])
const LEAD_CJK = ['负责人', '主管', '组长', '经理', '总管', '统筹']
// Tools every Bot uses: they say nothing about its role.
const COMMON_TOOLS = new Set(['message_bot', 'list_children', 'create_child_bot', 'create_bot', 'list_bots', 'stop_bot', 'reply', 'think', 'todo', 'memory', 'read', 'write'])
const CJK = /[\u3400-\u9fff]/

export const norm = s => String(s ?? '').trim().toLowerCase()
export const wordsOf = text => norm(text).split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
const isRoleWord = w => w.length >= 2 && !GENERIC.has(w) && !LEAD_WORDS.has(w)
const vocabHit = (word, domain) => domain.words.some(v => (v.length <= 3 ? word === v || word === `${v}s` || word === `${v}es` : word.startsWith(v)))
const domainOfWord = word => DOMAINS.find(d => vocabHit(word, d))

/**
 * The role profile of a Bot: { id, name, words (name words), text (all role text), domain, area,
 * leadWord }. `info` = { id, name, role (label), treeRole, prompt (own text, no tree block),
 * tools (recent tool names) }. `classify(profile)` may override { domain, project }.
 */
export function profileOf(info, classify) {
  const name = String(info.name ?? '')
  const nameWords = wordsOf(name).filter(isRoleWord)
  const roleText = [info.role, info.treeRole].filter(Boolean).join(' ')
  const prompt = String(info.prompt ?? '').slice(0, 600)
  const tools = (info.tools ?? []).filter(t => !COMMON_TOOLS.has(norm(t)))
  // Name counts most, then the role label and description, then the own prompt and tools.
  const weighted = [[nameWords, 3], [wordsOf(roleText), 2], [wordsOf(prompt), 1], [tools.flatMap(wordsOf), 1]]
  const score = new Map()
  for (const [list, w] of weighted) for (const word of list) { const d = isRoleWord(word) && domainOfWord(word); if (d) score.set(d.id, (score.get(d.id) ?? 0) + w) }
  for (const [text, w] of [[name, 3], [roleText, 2], [prompt, 1]]) {
    if (!CJK.test(text)) continue
    for (const d of DOMAINS) for (const c of d.cjk) if (text.includes(c)) score.set(d.id, (score.get(d.id) ?? 0) + w)
  }
  let domain = null, best = 0
  for (const d of DOMAINS) { const s = score.get(d.id) ?? 0; if (s > best) { best = s; domain = d.id } }
  const lowerName = norm(name)
  const leadWord = wordsOf(name).some(w => LEAD_WORDS.has(w)) || LEAD_CJK.some(c => name.includes(c))
  // Project words: name words that are not domain words (e.g. "flybot" in "FlyBot Dev"); CJK names keep whole.
  const projects = nameWords.filter(w => !domainOfWord(w) && (CJK.test(w) ? !DOMAINS.some(d => d.cjk.some(c => w.includes(c))) && w.length >= 2 : w.length >= 3))
  const terms = [...new Set([...nameWords, ...wordsOf(roleText).filter(isRoleWord)])].filter(w => w.length >= 3 && !CJK.test(w))
  const base = { id: info.id, name, lowerName, words: nameWords, projects, terms, domain, area: domain ? BY_ID.get(domain).area : 'other', leadWord, roleText: norm(roleText) }
  if (typeof classify === 'function') {
    try {
      const over = classify({ ...base, info }) ?? {}
      if (typeof over.domain === 'string' && BY_ID.has(over.domain)) { base.domain = over.domain; base.area = BY_ID.get(over.domain).area }
      if (typeof over.project === 'string' && over.project.trim()) base.projects = [norm(over.project)]
    } catch { /* a failing hook keeps the built-in profile */ }
  }
  return base
}

/** Every key a profile can be grouped by, most specific first. */
export function keysOf(p) {
  return [...p.projects.map(w => `project:${w}`), ...(p.domain ? [`domain:${p.domain}`] : []), ...p.terms.map(w => `word:${w}`), `area:${p.area}`]
}
export const kindOf = key => key.split(':')[0]
export const KIND_RANK = Object.freeze({ project: 0, domain: 1, word: 2, area: 3 })

/** The display label of a group key ("FlyBot", "Dev", "Life"); `names` give a project word its original casing. */
export function labelOf(key, names = []) {
  const [kind, id] = [kindOf(key), key.slice(key.indexOf(':') + 1)]
  if (kind === 'domain') return BY_ID.get(id)?.label ?? id
  if (kind === 'area') return AREAS[id] ?? id
  for (const n of names) {
    const hit = String(n).split(/[^\p{L}\p{N}_]+/u).find(w => norm(w) === id)
    if (hit) return hit
  }
  return id.charAt(0).toUpperCase() + id.slice(1)
}
export const leadNameOf = label => `${label} Lead`

/** True when a Bot can lead group `key`: already its lead, already coordinating it, or named for it / as a lead. */
export function canLead(p, key, { lead, hasChildren = false, names = [] } = {}) {
  if (lead?.key === key) return true
  const label = norm(labelOf(key, names))
  if (p.lowerName === label || p.lowerName === norm(leadNameOf(label))) return true
  if (!keysOf(p).includes(key)) return false
  // A broad area or a shared word is a lead's group only when it was made or named for it.
  if (kindOf(key) === 'area' || kindOf(key) === 'word') return false
  return p.leadWord || hasChildren
}

const strip = p => p.words.filter(w => !LEAD_WORDS.has(w)).sort().join(' ')
const jaccard = (a, b) => {
  const A = new Set(wordsOf(a).filter(isRoleWord)), B = new Set(wordsOf(b).filter(isRoleWord))
  if (!A.size || !B.size) return 0
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n / (A.size + B.size - n)
}
/**
 * Two Bots with essentially the same role: the same name once generic words are dropped
 * ("Editor" / "editor bot") with no conflicting description, or near-identical descriptions in
 * one domain.
 */
export function sameRole(a, b) {
  const sa = strip(a), sb = strip(b)
  if (sa && sa === sb) return !a.roleText || !b.roleText || jaccard(a.roleText, b.roleText) >= 0.5
  if (a.domain && a.domain === b.domain && wordsOf(a.roleText).length >= 4 && jaccard(a.roleText, b.roleText) >= 0.8) return true
  return false
}
