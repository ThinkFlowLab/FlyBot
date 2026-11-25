const WORK_TOPICS = {
  productivity: '效率工具',
  entertainment: '娱乐',
  technology: '科技与 AI',
  beauty: '美容护肤',
  fashion: '时尚穿搭',
  food: '美食饮品',
  travel: '旅行',
  wellness: '健身养生',
  education: '教育学习',
  creative: '创意艺术',
  games: '游戏与二次元',
  finance: '财经投资',
  career: '职场商业',
  life: '生活方式',
};

export function isWorkTopic(value) {
  return typeof value === 'string' && Object.hasOwn(WORK_TOPICS, value);
}

export function appendWorkTopics(document, select) {
  if (!select) return;
  for (const [value, label] of Object.entries(WORK_TOPICS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
}
